use std::{
    future::Future,
    io,
    net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener},
    pin::Pin,
    sync::{Arc, Mutex, RwLock},
};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
};

const MAX_REQUEST_HEAD_BYTES: usize = 32 * 1024;
const MAX_CHUNK_LINE_BYTES: usize = 8 * 1024;
const MAX_PROXY_CONNECTIONS: usize = 64;
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const REQUEST_HEAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const REQUEST_BODY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ProxyTarget {
    pub(super) host: String,
    pub(super) port: u16,
}

#[derive(Debug, PartialEq, Eq)]
enum ProxyRequest {
    Connect {
        target: ProxyTarget,
    },
    Forward {
        target: ProxyTarget,
        request_head: Vec<u8>,
        body: RequestBody,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestBody {
    None,
    ContentLength(u64),
    Chunked,
}

pub(super) trait ProxyIo: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> ProxyIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

pub(super) type ProxyStream = Box<dyn ProxyIo>;
pub(super) type ConnectFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ProxyStream, String>> + Send + 'a>>;

pub(super) trait ProxyConnector: Send + Sync {
    fn connect<'a>(&'a self, target: &'a ProxyTarget) -> ConnectFuture<'a>;
}

struct DirectConnector;

impl ProxyConnector for DirectConnector {
    fn connect<'a>(&'a self, target: &'a ProxyTarget) -> ConnectFuture<'a> {
        Box::pin(async move {
            let stream = TcpStream::connect((target.host.as_str(), target.port))
                .await
                .map_err(|error| format!("direct connection failed: {error}"))?;
            Ok(Box::new(stream) as ProxyStream)
        })
    }
}

#[derive(Clone)]
enum ProxyRoute {
    Direct,
    Blocked(String),
    Tunnel(Arc<dyn ProxyConnector>),
}

pub(super) struct ProxyRouter {
    route: RwLock<ProxyRoute>,
    generation: watch::Sender<u64>,
}

impl ProxyRouter {
    fn new() -> Self {
        let (generation, _) = watch::channel(0);
        Self {
            route: RwLock::new(ProxyRoute::Direct),
            generation,
        }
    }

    fn subscribe(&self) -> watch::Receiver<u64> {
        self.generation.subscribe()
    }

    fn set_route(&self, route: ProxyRoute) {
        *self.route.write().expect("plugin VPN proxy route lock") = route;
        self.generation.send_modify(|generation| {
            *generation = generation.wrapping_add(1);
        });
    }

    async fn connect(&self, target: &ProxyTarget) -> Result<ProxyStream, String> {
        let connector = match self
            .route
            .read()
            .expect("plugin VPN proxy route lock")
            .clone()
        {
            ProxyRoute::Direct => Arc::new(DirectConnector) as Arc<dyn ProxyConnector>,
            ProxyRoute::Blocked(reason) => return Err(reason),
            ProxyRoute::Tunnel(connector) => connector,
        };
        tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(target))
            .await
            .map_err(|_| "proxy connection timed out".to_string())?
    }
}

pub(super) struct LocalProxy {
    address: SocketAddr,
    listener: Mutex<Option<StdTcpListener>>,
    router: Arc<ProxyRouter>,
}

impl LocalProxy {
    pub(super) fn bind() -> Result<Self, String> {
        let listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("could not bind the plugin VPN proxy: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("could not configure the plugin VPN proxy: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("could not read the plugin VPN proxy address: {error}"))?;
        Ok(Self {
            address,
            listener: Mutex::new(Some(listener)),
            router: Arc::new(ProxyRouter::new()),
        })
    }

    pub(super) fn address(&self) -> SocketAddr {
        self.address
    }

    pub(super) fn start(&self) -> Result<(), String> {
        let listener = self.take_listener()?;
        let router = self.router();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = serve(listener, router).await {
                log::error!("plugin VPN proxy stopped: {error}");
            }
        });
        Ok(())
    }

    pub(super) fn direct(&self) {
        self.router.set_route(ProxyRoute::Direct);
    }

    pub(super) fn block(&self, reason: impl Into<String>) {
        self.router.set_route(ProxyRoute::Blocked(reason.into()));
    }

    pub(super) fn tunnel(&self, connector: Arc<dyn ProxyConnector>) {
        self.router.set_route(ProxyRoute::Tunnel(connector));
    }

    fn take_listener(&self) -> Result<StdTcpListener, String> {
        self.listener
            .lock()
            .expect("plugin VPN proxy listener lock")
            .take()
            .ok_or_else(|| "plugin VPN proxy is already running".to_string())
    }

    fn router(&self) -> Arc<ProxyRouter> {
        self.router.clone()
    }
}

async fn serve(listener: StdTcpListener, router: Arc<ProxyRouter>) -> io::Result<()> {
    let listener = TcpListener::from_std(listener)?;
    let permits = Arc::new(Semaphore::new(MAX_PROXY_CONNECTIONS));
    loop {
        let (stream, _) = listener.accept().await?;
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let router = router.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let mut route_changes = router.subscribe();
            tokio::select! {
                result = handle_connection(stream, router) => {
                    if let Err(error) = result {
                        log::debug!("plugin VPN proxy connection ended: {error}");
                    }
                }
                _ = route_changes.changed() => {}
            }
        });
    }
}

async fn handle_connection(mut client: TcpStream, router: Arc<ProxyRouter>) -> io::Result<()> {
    let (request_head, trailing) =
        match read_request_head_with_timeout(&mut client, REQUEST_HEAD_TIMEOUT).await {
            Ok(request) => request,
            Err(error) => {
                write_status(&mut client, 400, "Bad Request").await?;
                return Err(io::Error::new(io::ErrorKind::InvalidData, error));
            }
        };
    let request = match parse_request_head(&request_head) {
        Ok(request) => request,
        Err(error) => {
            write_status(&mut client, 400, "Bad Request").await?;
            return Err(io::Error::new(io::ErrorKind::InvalidData, error));
        }
    };
    let target = match &request {
        ProxyRequest::Connect { target } | ProxyRequest::Forward { target, .. } => target,
    };
    let mut upstream = match router.connect(target).await {
        Ok(stream) => stream,
        Err(error) => {
            write_status(&mut client, 502, "Bad Gateway").await?;
            return Err(io::Error::new(io::ErrorKind::ConnectionRefused, error));
        }
    };

    match request {
        ProxyRequest::Connect { .. } => {
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
            if !trailing.is_empty() {
                upstream.write_all(&trailing).await?;
            }
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        }
        ProxyRequest::Forward {
            request_head, body, ..
        } => {
            upstream.write_all(&request_head).await?;
            forward_request_body_with_timeout(
                &mut client,
                &mut upstream,
                trailing,
                body,
                REQUEST_BODY_TIMEOUT,
            )
            .await?;
            tokio::io::copy(&mut upstream, &mut client).await?;
        }
    }
    Ok(())
}

async fn forward_request_body_with_timeout<R, W>(
    client: &mut R,
    upstream: &mut W,
    trailing: Vec<u8>,
    body: RequestBody,
    timeout: std::time::Duration,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    tokio::time::timeout(
        timeout,
        forward_request_body(client, upstream, trailing, body),
    )
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "proxy request body timed out"))?
}

async fn forward_request_body<R, W>(
    client: &mut R,
    upstream: &mut W,
    trailing: Vec<u8>,
    body: RequestBody,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut input = io::Cursor::new(trailing).chain(client);
    match body {
        RequestBody::None => Ok(()),
        RequestBody::ContentLength(length) => {
            let copied = tokio::io::copy(&mut (&mut input).take(length), upstream).await?;
            if copied != length {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "proxy request body ended early",
                ));
            }
            Ok(())
        }
        RequestBody::Chunked => forward_chunked_request_body(&mut input, upstream).await,
    }
}

async fn forward_chunked_request_body<R, W>(input: &mut R, upstream: &mut W) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let line = read_crlf_line(input, MAX_CHUNK_LINE_BYTES).await?;
        let size_text = std::str::from_utf8(&line[..line.len() - 2])
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size"))?;
        let size = size_text
            .split(';')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|value| u64::from_str_radix(value, 16).ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid chunk size"))?;
        upstream.write_all(&line).await?;

        if size == 0 {
            let trailer_end = read_crlf_line(input, MAX_REQUEST_HEAD_BYTES).await?;
            if trailer_end != b"\r\n" {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "chunked request trailers are not supported",
                ));
            }
            upstream.write_all(&trailer_end).await?;
            return Ok(());
        }

        let copied = tokio::io::copy(&mut (&mut *input).take(size), upstream).await?;
        if copied != size {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "proxy request chunk ended early",
            ));
        }
        let mut ending = [0; 2];
        input.read_exact(&mut ending).await?;
        if ending != *b"\r\n" {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid proxy request chunk ending",
            ));
        }
        upstream.write_all(&ending).await?;
    }
}

async fn read_crlf_line<R>(input: &mut R, limit: usize) -> io::Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut line = Vec::new();
    while line.len() < limit {
        let byte = input.read_u8().await?;
        line.push(byte);
        if line.ends_with(b"\r\n") {
            return Ok(line);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "proxy request chunk line is too large",
    ))
}

async fn read_request_head_with_timeout<R>(
    stream: &mut R,
    timeout: std::time::Duration,
) -> Result<(Vec<u8>, Vec<u8>), String>
where
    R: AsyncRead + Unpin,
{
    tokio::time::timeout(timeout, read_request_head(stream))
        .await
        .map_err(|_| "proxy request headers timed out".to_string())?
}

async fn read_request_head<R>(stream: &mut R) -> Result<(Vec<u8>, Vec<u8>), String>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(4096);
    loop {
        let mut chunk = [0; 4096];
        let count = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("could not read proxy request: {error}"))?;
        if count == 0 {
            return Err("proxy connection closed before request headers".to_string());
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let head_end = end + 4;
            if head_end > MAX_REQUEST_HEAD_BYTES {
                return Err("proxy request headers are too large".to_string());
            }
            let trailing = bytes.split_off(head_end);
            return Ok((bytes, trailing));
        }
        if bytes.len() > MAX_REQUEST_HEAD_BYTES {
            return Err("proxy request headers are too large".to_string());
        }
    }
}

async fn write_status(stream: &mut TcpStream, code: u16, reason: &str) -> io::Result<()> {
    stream
        .write_all(
            format!("HTTP/1.1 {code} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
}

fn parse_request_head(bytes: &[u8]) -> Result<ProxyRequest, String> {
    if bytes.len() > MAX_REQUEST_HEAD_BYTES {
        return Err("proxy request headers are too large".to_string());
    }
    if !bytes.ends_with(b"\r\n\r\n") {
        return Err("proxy request headers are incomplete".to_string());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "proxy request headers must be UTF-8 text".to_string())?;
    let mut lines = text[..text.len() - 4].split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "proxy request line is missing".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "proxy request method is missing".to_string())?;
    let request_target = request_parts
        .next()
        .ok_or_else(|| "proxy request target is missing".to_string())?;
    let version = request_parts
        .next()
        .ok_or_else(|| "proxy HTTP version is missing".to_string())?;
    if request_parts.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return Err("invalid proxy request line".to_string());
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        return Ok(ProxyRequest::Connect {
            target: parse_authority(request_target, None)?,
        });
    }

    let (target, origin_form) = parse_absolute_http_target(request_target)?;
    let headers = lines
        .map(|line| {
            if line.starts_with(' ') || line.starts_with('\t') {
                return Err("folded proxy request headers are not supported".to_string());
            }
            let (name, value) = line
                .split_once(':')
                .ok_or_else(|| "invalid proxy request header".to_string())?;
            Ok((name, value.trim(), line))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut content_length = None;
    let mut transfer_encoding = None;
    let mut connection_headers = Vec::new();
    for (name, value, _) in &headers {
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err("duplicate proxy request content length".to_string());
            }
            content_length = Some(
                value
                    .parse::<u64>()
                    .map_err(|_| "invalid proxy request content length".to_string())?,
            );
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            if transfer_encoding.replace(*value).is_some() {
                return Err("duplicate proxy request transfer encoding".to_string());
            }
        } else if name.eq_ignore_ascii_case("connection") {
            connection_headers.extend(
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            );
        } else if name.eq_ignore_ascii_case("expect") || name.eq_ignore_ascii_case("upgrade") {
            return Err("unsupported proxy request upgrade or expectation".to_string());
        }
    }
    if content_length.is_some() && transfer_encoding.is_some() {
        return Err("ambiguous proxy request body framing".to_string());
    }
    if connection_headers.iter().any(|header| {
        header.eq_ignore_ascii_case("content-length")
            || header.eq_ignore_ascii_case("transfer-encoding")
    }) {
        return Err("invalid proxy request connection header".to_string());
    }
    let body = match (content_length, transfer_encoding) {
        (Some(0) | None, None) => RequestBody::None,
        (Some(length), None) => RequestBody::ContentLength(length),
        (None, Some(value)) if value.eq_ignore_ascii_case("chunked") => RequestBody::Chunked,
        (None, Some(_)) => return Err("unsupported proxy request transfer encoding".to_string()),
        (Some(_), Some(_)) => unreachable!("ambiguous framing rejected above"),
    };

    let mut request_head = format!("{method} {origin_form} {version}\r\n").into_bytes();
    for (name, _, line) in headers {
        if name.eq_ignore_ascii_case("proxy-authorization")
            || name.eq_ignore_ascii_case("proxy-connection")
            || name.eq_ignore_ascii_case("proxy-authenticate")
            || name.eq_ignore_ascii_case("connection")
            || name.eq_ignore_ascii_case("keep-alive")
            || name.eq_ignore_ascii_case("te")
            || name.eq_ignore_ascii_case("trailer")
            || connection_headers
                .iter()
                .any(|header| name.eq_ignore_ascii_case(header))
        {
            continue;
        }
        request_head.extend_from_slice(line.as_bytes());
        request_head.extend_from_slice(b"\r\n");
    }
    request_head.extend_from_slice(b"Connection: close\r\n");
    request_head.extend_from_slice(b"\r\n");

    Ok(ProxyRequest::Forward {
        target,
        request_head,
        body,
    })
}

fn parse_absolute_http_target(value: &str) -> Result<(ProxyTarget, String), String> {
    let remainder = value
        .strip_prefix("http://")
        .ok_or_else(|| "proxy request target must use absolute HTTP form".to_string())?;
    if remainder.contains('#') {
        return Err("proxy request target must not contain a fragment".to_string());
    }
    let target_start = remainder.find(['/', '?']).unwrap_or(remainder.len());
    let authority = &remainder[..target_start];
    let suffix = &remainder[target_start..];
    let origin_form = if suffix.is_empty() {
        "/".to_string()
    } else if suffix.starts_with('?') {
        format!("/{suffix}")
    } else {
        suffix.to_string()
    };
    Ok((parse_authority(authority, Some(80))?, origin_form))
}

fn parse_authority(value: &str, default_port: Option<u16>) -> Result<ProxyTarget, String> {
    if value.is_empty()
        || value.contains('@')
        || value
            .chars()
            .any(|character| character.is_ascii_control() || character.is_whitespace())
    {
        return Err("invalid proxy target authority".to_string());
    }

    let (host, port) = if let Some(bracketed) = value.strip_prefix('[') {
        let closing = bracketed
            .find(']')
            .ok_or_else(|| "invalid IPv6 proxy target".to_string())?;
        let host = &bracketed[..closing];
        let remainder = &bracketed[closing + 1..];
        let port = if let Some(port) = remainder.strip_prefix(':') {
            parse_port(port)?
        } else if remainder.is_empty() {
            default_port.ok_or_else(|| "proxy target port is missing".to_string())?
        } else {
            return Err("invalid IPv6 proxy target".to_string());
        };
        (host, port)
    } else if let Some((host, port)) = value.rsplit_once(':') {
        if host.contains(':') {
            return Err("IPv6 proxy targets must use brackets".to_string());
        }
        (host, parse_port(port)?)
    } else {
        (
            value,
            default_port.ok_or_else(|| "proxy target port is missing".to_string())?,
        )
    };

    if host.is_empty() {
        return Err("proxy target host is missing".to_string());
    }
    Ok(ProxyTarget {
        host: host.to_string(),
        port,
    })
}

fn parse_port(value: &str) -> Result<u16, String> {
    let port = value
        .parse::<u16>()
        .map_err(|_| "invalid proxy target port".to_string())?;
    if port == 0 {
        return Err("invalid proxy target port".to_string());
    }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct FixedConnector {
        stream: Mutex<Option<tokio::io::DuplexStream>>,
    }

    impl ProxyConnector for FixedConnector {
        fn connect<'a>(&'a self, _: &'a ProxyTarget) -> ConnectFuture<'a> {
            let stream = self.stream.lock().expect("connector stream").take();
            Box::pin(async move {
                stream
                    .map(|stream| Box::new(stream) as ProxyStream)
                    .ok_or_else(|| "test connector already used".to_string())
            })
        }
    }

    #[test]
    fn parses_connect_authorities() {
        let request = parse_request_head(
            b"CONNECT vpn.example.test:443 HTTP/1.1\r\nHost: vpn.example.test:443\r\n\r\n",
        )
        .expect("CONNECT request");

        assert_eq!(
            request,
            ProxyRequest::Connect {
                target: ProxyTarget {
                    host: "vpn.example.test".to_string(),
                    port: 443,
                },
            }
        );

        let ipv6 = parse_request_head(b"CONNECT [2001:db8::1]:8443 HTTP/1.1\r\n\r\n")
            .expect("IPv6 CONNECT request");
        assert_eq!(
            ipv6,
            ProxyRequest::Connect {
                target: ProxyTarget {
                    host: "2001:db8::1".to_string(),
                    port: 8443,
                },
            }
        );
    }

    #[test]
    fn rewrites_absolute_http_requests_and_removes_proxy_credentials() {
        let request = parse_request_head(
            b"GET http://novels.example.test:8080/chapter?id=3 HTTP/1.1\r\nHost: novels.example.test:8080\r\nConnection: keep-alive, X-Remove\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic secret\r\nX-Remove: private\r\nAccept: text/html\r\n\r\n",
        )
        .expect("absolute HTTP request");

        assert_eq!(
            request,
            ProxyRequest::Forward {
                target: ProxyTarget {
                    host: "novels.example.test".to_string(),
                    port: 8080,
                },
                request_head: b"GET /chapter?id=3 HTTP/1.1\r\nHost: novels.example.test:8080\r\nAccept: text/html\r\nConnection: close\r\n\r\n".to_vec(),
                body: RequestBody::None,
            }
        );
    }

    #[test]
    fn rejects_non_proxy_and_malformed_targets() {
        for request in [
            b"GET /relative HTTP/1.1\r\nHost: example.test\r\n\r\n".as_slice(),
            b"CONNECT example.test HTTP/1.1\r\n\r\n".as_slice(),
            b"CONNECT example.test:0 HTTP/1.1\r\n\r\n".as_slice(),
            b"GET https://example.test/path HTTP/1.1\r\n\r\n".as_slice(),
        ] {
            assert!(parse_request_head(request).is_err());
        }
    }

    #[test]
    fn request_headers_have_a_deadline() {
        test_runtime().block_on(async {
            let (_writer, mut reader) = tokio::io::duplex(1);
            let result =
                read_request_head_with_timeout(&mut reader, std::time::Duration::from_millis(1))
                    .await;

            assert_eq!(result.unwrap_err(), "proxy request headers timed out");
        });
    }

    #[test]
    fn request_bodies_have_a_deadline() {
        test_runtime().block_on(async {
            let (_writer, mut client) = tokio::io::duplex(1);
            let mut upstream = tokio::io::sink();
            let result = forward_request_body_with_timeout(
                &mut client,
                &mut upstream,
                Vec::new(),
                RequestBody::ContentLength(1),
                std::time::Duration::from_millis(1),
            )
            .await;

            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        });
    }

    #[test]
    fn local_proxy_forwards_direct_http_when_vpn_is_disabled() {
        test_runtime().block_on(async {
            let origin = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("origin listener");
            let origin_address = origin.local_addr().expect("origin address");
            let origin_task = tokio::spawn(async move {
                let (mut stream, _) = origin.accept().await.expect("origin connection");
                let mut request = vec![0; 4096];
                let count = stream.read(&mut request).await.expect("origin request");
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .expect("origin response");
                request.truncate(count);
                request
            });

            let proxy = LocalProxy::bind().expect("local proxy");
            let proxy_address = proxy.address();
            let proxy_task = tokio::spawn(serve(proxy.take_listener().expect("proxy listener"), proxy.router()));
            let mut client = tokio::net::TcpStream::connect(proxy_address)
                .await
                .expect("proxy connection");
            client
                .write_all(
                    format!(
                        "GET http://{origin_address}/chapter HTTP/1.1\r\nHost: {origin_address}\r\nProxy-Connection: keep-alive\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("proxy request");
            let mut response = Vec::new();
            client.read_to_end(&mut response).await.expect("proxy response");

            assert!(response.starts_with(b"HTTP/1.1 204"));
            assert_eq!(
                origin_task.await.expect("origin task"),
                format!(
                    "GET /chapter HTTP/1.1\r\nHost: {origin_address}\r\nConnection: close\r\n\r\n"
                )
                .into_bytes()
            );
            proxy_task.abort();
        });
    }

    #[test]
    fn local_proxy_does_not_forward_a_pipelined_plain_http_request() {
        test_runtime().block_on(async {
            let origin = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("origin listener");
            let origin_address = origin.local_addr().expect("origin address");
            let expected_request = format!(
                "POST /first HTTP/1.1\r\nHost: {origin_address}\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody"
            )
            .into_bytes();
            let origin_expected_request = expected_request.clone();
            let origin_task = tokio::spawn(async move {
                let (mut stream, _) = origin.accept().await.expect("origin connection");
                let mut request = vec![0; origin_expected_request.len()];
                stream
                    .read_exact(&mut request)
                    .await
                    .expect("origin request");
                assert_eq!(request, origin_expected_request);
                assert!(
                    tokio::time::timeout(
                        std::time::Duration::from_millis(100),
                        stream.read_u8(),
                    )
                    .await
                    .is_err(),
                    "proxy forwarded another request or closed before the response"
                );
                stream
                    .write_all(
                        b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await
                    .expect("origin response");
                request
            });

            let proxy = LocalProxy::bind().expect("local proxy");
            let proxy_address = proxy.address();
            let proxy_task = tokio::spawn(serve(
                proxy.take_listener().expect("proxy listener"),
                proxy.router(),
            ));
            let mut client = tokio::net::TcpStream::connect(proxy_address)
                .await
                .expect("proxy connection");
            client
                .write_all(
                    format!(
                        "POST http://{origin_address}/first HTTP/1.1\r\nHost: {origin_address}\r\nContent-Length: 4\r\n\r\nbodyGET http://unrelated.invalid/second HTTP/1.1\r\nHost: unrelated.invalid\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("proxy requests");
            let mut response = Vec::new();
            client.read_to_end(&mut response).await.expect("proxy response");

            assert!(response.starts_with(b"HTTP/1.1 204"));
            assert_eq!(origin_task.await.expect("origin task"), expected_request);
            proxy_task.abort();
        });
    }

    #[test]
    fn local_proxy_keeps_tunnel_response_direction_open_for_plain_http() {
        test_runtime().block_on(async {
            let (proxy_stream, mut origin_stream) = tokio::io::duplex(4096);
            let expected_request = b"POST /chapter HTTP/1.1\r\nHost: tunnel.example.test\r\nContent-Length: 4\r\nConnection: close\r\n\r\nbody";
            let origin_task = tokio::spawn(async move {
                let mut request = vec![0; expected_request.len()];
                origin_stream
                    .read_exact(&mut request)
                    .await
                    .expect("tunnel request");
                assert_eq!(request, expected_request);
                assert!(
                    tokio::time::timeout(
                        std::time::Duration::from_millis(100),
                        origin_stream.read_u8(),
                    )
                    .await
                    .is_err(),
                    "proxy closed the tunnel request direction before the response"
                );
                origin_stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await
                    .expect("tunnel response");
            });

            let proxy = LocalProxy::bind().expect("local proxy");
            proxy.tunnel(Arc::new(FixedConnector {
                stream: Mutex::new(Some(proxy_stream)),
            }));
            let proxy_address = proxy.address();
            let proxy_task = tokio::spawn(serve(
                proxy.take_listener().expect("proxy listener"),
                proxy.router(),
            ));
            let mut client = tokio::net::TcpStream::connect(proxy_address)
                .await
                .expect("proxy connection");
            client
                .write_all(
                    b"POST http://tunnel.example.test/chapter HTTP/1.1\r\nHost: tunnel.example.test\r\nContent-Length: 4\r\n\r\nbody",
                )
                .await
                .expect("proxy request");
            let mut response = Vec::new();
            client.read_to_end(&mut response).await.expect("proxy response");

            assert!(response.ends_with(b"\r\n\r\nok"));
            origin_task.await.expect("origin task");
            proxy_task.abort();
        });
    }

    #[test]
    fn local_proxy_fails_closed_while_vpn_route_is_blocked() {
        test_runtime().block_on(async {
            let proxy = LocalProxy::bind().expect("local proxy");
            proxy.block("VPN is connecting");
            let proxy_address = proxy.address();
            let proxy_task = tokio::spawn(serve(
                proxy.take_listener().expect("proxy listener"),
                proxy.router(),
            ));
            let mut client = tokio::net::TcpStream::connect(proxy_address)
                .await
                .expect("proxy connection");
            client
                .write_all(b"CONNECT example.test:443 HTTP/1.1\r\n\r\n")
                .await
                .expect("proxy request");
            let mut response = Vec::new();
            client
                .read_to_end(&mut response)
                .await
                .expect("proxy response");

            assert!(response.starts_with(b"HTTP/1.1 502"));
            assert!(!String::from_utf8_lossy(&response).contains("VPN is connecting"));
            proxy_task.abort();
        });
    }

    fn test_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }
}
