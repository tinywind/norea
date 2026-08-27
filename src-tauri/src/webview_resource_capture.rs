use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_CAPTURED_RESOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CAPTURED_TOTAL_BYTES: usize = 256 * 1024 * 1024;

#[cfg(any(test, target_os = "windows"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResponseCapturePolicy {
    TrustedMedia,
    RequireWebpSignature,
}

#[cfg(any(test, target_os = "windows"))]
fn response_capture_policy(
    url: &str,
    headers: &HashMap<String, String>,
    request_destination: Option<&str>,
) -> Option<ResponseCapturePolicy> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return None;
    }
    let content_type = headers
        .get("content-type")
        .map(|value| value.split(';').next().unwrap_or("").trim())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(content_type.as_str(), "text/html" | "application/xhtml+xml")
        && (content_type.starts_with("image/")
            || content_type.starts_with("audio/")
            || content_type.starts_with("video/")
            || matches!(
                content_type.as_str(),
                "application/octet-stream" | "application/pdf"
            ))
    {
        return Some(ResponseCapturePolicy::TrustedMedia);
    }
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if !matches!(content_type.as_str(), "text/html" | "application/xhtml+xml")
        && [
            ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp", ".aac", ".flac",
            ".m4a", ".mp3", ".ogg", ".wav", ".m4v", ".mp4", ".webm", ".pdf",
        ]
        .iter()
        .any(|extension| path.ends_with(extension))
    {
        return Some(ResponseCapturePolicy::TrustedMedia);
    }
    request_destination
        .filter(|destination| destination.eq_ignore_ascii_case("image"))
        .map(|_| ResponseCapturePolicy::RequireWebpSignature)
}

#[cfg(any(test, target_os = "windows"))]
fn has_webp_signature(body: &[u8]) -> bool {
    body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP"
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedResource {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub final_url: String,
    pub body: Vec<u8>,
}

#[derive(Default)]
struct CaptureSession {
    id: u64,
    active: bool,
    activity: u64,
    pending: usize,
    total_bytes: usize,
    resources: HashMap<String, CapturedResource>,
}

#[derive(Default)]
pub struct CapturedResourceStore {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, CaptureSession>>,
}

impl CapturedResourceStore {
    pub fn begin(&self, executor: &str) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .insert(
                executor.to_string(),
                CaptureSession {
                    id,
                    active: true,
                    ..CaptureSession::default()
                },
            );
        id
    }

    pub fn claim(&self, executor: &str) -> Option<u64> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let session = sessions.get_mut(executor)?;
        if !session.active {
            return None;
        }
        session.activity = session.activity.wrapping_add(1);
        session.pending += 1;
        Some(session.id)
    }

    pub fn complete(&self, executor: &str, capture_id: u64, resource: Option<CapturedResource>) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let Some(session) = sessions.get_mut(executor) else {
            return;
        };
        if session.id != capture_id {
            return;
        }
        session.activity = session.activity.wrapping_add(1);
        session.pending = session.pending.saturating_sub(1);
        let Some(resource) = resource else {
            return;
        };
        if resource.body.len() > MAX_CAPTURED_RESOURCE_BYTES {
            return;
        }
        let key = normalized_resource_url(&resource.final_url);
        let replaced_bytes = session
            .resources
            .get(&key)
            .map(|existing| existing.body.len())
            .unwrap_or(0);
        let next_total = session
            .total_bytes
            .saturating_sub(replaced_bytes)
            .saturating_add(resource.body.len());
        if next_total > MAX_CAPTURED_TOTAL_BYTES {
            return;
        }
        session.total_bytes = next_total;
        session.resources.insert(key, resource);
    }

    pub fn finish(&self, executor: &str, capture_id: u64) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        if let Some(session) = sessions.get_mut(executor) {
            if session.id == capture_id {
                session.active = false;
            }
        }
    }

    pub fn stop(&self, executor: &str) {
        if let Some(session) = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex")
            .get_mut(executor)
        {
            session.active = false;
        }
    }

    pub async fn wait_until_settled(
        &self,
        executor: &str,
        capture_id: u64,
        quiet_period: Duration,
        timeout: Duration,
    ) {
        let started = Instant::now();
        let Some(mut observed_activity) = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex")
            .get(executor)
            .filter(|session| session.id == capture_id)
            .map(|session| session.activity)
        else {
            return;
        };
        let mut quiet_started = Instant::now();
        loop {
            let state = self
                .sessions
                .lock()
                .expect("captured resource sessions mutex")
                .get(executor)
                .filter(|session| session.id == capture_id)
                .map(|session| (session.pending, session.activity));
            let Some((pending, activity)) = state else {
                return;
            };
            if activity != observed_activity {
                observed_activity = activity;
                quiet_started = Instant::now();
            }
            if (pending == 0 && quiet_started.elapsed() >= quiet_period)
                || started.elapsed() >= timeout
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub fn take(&self, executor: &str, url: &str) -> Option<CapturedResource> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let session = sessions.get_mut(executor)?;
        let resource = session.resources.remove(&normalized_resource_url(url))?;
        session.total_bytes = session.total_bytes.saturating_sub(resource.body.len());
        Some(resource)
    }

    pub fn clear(&self, executor: &str) {
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .remove(executor);
    }
}

fn normalized_resource_url(url: &str) -> String {
    url.split_once('#')
        .map(|(without_fragment, _)| without_fragment)
        .unwrap_or(url)
        .to_string()
}

pub struct CaptureGuard {
    store: Arc<CapturedResourceStore>,
    executor: String,
    enabled: bool,
}

impl CaptureGuard {
    pub fn new(store: Arc<CapturedResourceStore>, executor: &str, enabled: bool) -> Self {
        Self {
            store,
            executor: executor.to_string(),
            enabled,
        }
    }
}

impl Drop for CaptureGuard {
    fn drop(&mut self) {
        if self.enabled {
            self.store.stop(&self.executor);
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_capture {
    use super::{
        has_webp_signature, response_capture_policy, CapturedResource, CapturedResourceStore,
        ResponseCapturePolicy, MAX_CAPTURED_RESOURCE_BYTES,
    };
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{Webview, Wry};
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2WebResourceRequest, ICoreWebView2WebResourceResponseReceivedEventArgs,
        ICoreWebView2WebResourceResponseReceivedEventHandler, ICoreWebView2_2,
    };
    use webview2_com::{
        take_pwstr, WebResourceResponseReceivedEventHandler,
        WebResourceResponseViewGetContentCompletedHandler,
    };
    use windows::core::{AgileReference, Interface, PWSTR};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IStream, COINIT_MULTITHREADED,
    };

    pub async fn install(
        webview: &Webview<Wry>,
        executor: String,
        store: Arc<CapturedResourceStore>,
    ) -> Result<(), String> {
        let (sender, receiver) = oneshot::channel();
        webview
            .with_webview(move |platform_webview| {
                let result = unsafe {
                    platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| error.to_string())
                        .and_then(|core| {
                            core.cast::<ICoreWebView2_2>()
                                .map_err(|error| error.to_string())
                        })
                        .and_then(|core| {
                            let handler = response_handler(executor, store);
                            let mut token = 0;
                            core.add_WebResourceResponseReceived(&handler, &mut token)
                                .map_err(|error| error.to_string())
                        })
                };
                let _ = sender.send(result);
            })
            .map_err(|error| format!("scraper: install response capture: {error}"))?;
        tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "scraper: timed out installing response capture".to_string())?
            .map_err(|_| "scraper: response capture installer closed".to_string())?
            .map_err(|error| format!("scraper: install response capture: {error}"))
    }

    fn response_handler(
        executor: String,
        store: Arc<CapturedResourceStore>,
    ) -> ICoreWebView2WebResourceResponseReceivedEventHandler {
        WebResourceResponseReceivedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                if let Err(error) = capture_response(&args, &executor, &store) {
                    log::debug!(
                        "[scraper:resource_capture] response ignored executor={executor}: {error}"
                    );
                }
            }
            Ok(())
        }))
    }

    fn capture_response(
        args: &ICoreWebView2WebResourceResponseReceivedEventArgs,
        executor: &str,
        store: &Arc<CapturedResourceStore>,
    ) -> Result<(), String> {
        let (url, response, status, status_text, headers, request_destination) = unsafe {
            let request = args.Request().map_err(|error| error.to_string())?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri).map_err(|error| error.to_string())?;
            let url = take_pwstr(uri);
            let request_destination = request_destination(&request);
            let response = args.Response().map_err(|error| error.to_string())?;
            let mut status = 0;
            response
                .StatusCode(&mut status)
                .map_err(|error| error.to_string())?;
            let mut reason = PWSTR::null();
            response
                .ReasonPhrase(&mut reason)
                .map_err(|error| error.to_string())?;
            let headers = response_headers(&response)?;
            (
                url,
                response,
                status,
                take_pwstr(reason),
                headers,
                request_destination,
            )
        };
        let Some(capture_policy) =
            response_capture_policy(&url, &headers, request_destination.as_deref())
        else {
            return Ok(());
        };
        if status != 200 {
            return Ok(());
        }
        let Some(capture_id) = store.claim(executor) else {
            return Ok(());
        };
        let executor = executor.to_string();
        let get_content_executor = executor.clone();
        let callback_store = Arc::clone(store);
        let callback = WebResourceResponseViewGetContentCompletedHandler::create(Box::new(
            move |result, stream| {
                if result.is_err() || stream.is_none() {
                    callback_store.complete(&executor, capture_id, None);
                    return Ok(());
                }
                let stream = stream.expect("captured response stream");
                let stream = match AgileReference::new(&stream) {
                    Ok(stream) => stream,
                    Err(error) => {
                        log::debug!(
                            "[scraper:resource_capture] stream marshal failed executor={executor}: {error}"
                        );
                        callback_store.complete(&executor, capture_id, None);
                        return Ok(());
                    }
                };
                let worker_store = Arc::clone(&callback_store);
                let worker_executor = executor.clone();
                let worker_url = url.clone();
                let worker_status_text = status_text.clone();
                let worker_headers = headers.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let body = match read_stream(stream, capture_policy) {
                        Ok(body) => body,
                        Err(error) => {
                            log::debug!(
                                "[scraper:resource_capture] stream read failed executor={worker_executor}: {error}"
                            );
                            None
                        }
                    };
                    let resource = body.map(|body| CapturedResource {
                        status: status as u16,
                        status_text: worker_status_text,
                        headers: worker_headers,
                        final_url: worker_url,
                        body,
                    });
                    worker_store.complete(&worker_executor, capture_id, resource);
                });
                Ok(())
            },
        ));
        if let Err(error) = unsafe { response.GetContent(&callback) } {
            store.complete(&get_content_executor, capture_id, None);
            return Err(error.to_string());
        }
        Ok(())
    }

    unsafe fn request_destination(request: &ICoreWebView2WebResourceRequest) -> Option<String> {
        let headers = request.Headers().ok()?;
        let mut value = PWSTR::null();
        headers
            .GetHeader(windows::core::w!("Sec-Fetch-Dest"), &mut value)
            .ok()?;
        Some(take_pwstr(value))
    }

    unsafe fn response_headers(
        response: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebResourceResponseView,
    ) -> Result<HashMap<String, String>, String> {
        let iterator = response
            .Headers()
            .and_then(|headers| headers.GetIterator())
            .map_err(|error| error.to_string())?;
        let mut headers = HashMap::new();
        loop {
            let mut has_current = windows::core::BOOL(0);
            iterator
                .HasCurrentHeader(&mut has_current)
                .map_err(|error| error.to_string())?;
            if !has_current.as_bool() {
                break;
            }
            let mut name = PWSTR::null();
            let mut value = PWSTR::null();
            iterator
                .GetCurrentHeader(&mut name, &mut value)
                .map_err(|error| error.to_string())?;
            let name = take_pwstr(name).to_ascii_lowercase();
            let value = take_pwstr(value);
            if name != "set-cookie" && name != "set-cookie2" {
                headers
                    .entry(name)
                    .and_modify(|existing: &mut String| {
                        existing.push_str(", ");
                        existing.push_str(&value);
                    })
                    .or_insert(value);
            }
            let mut has_next = windows::core::BOOL(0);
            iterator
                .MoveNext(&mut has_next)
                .map_err(|error| error.to_string())?;
            if !has_next.as_bool() {
                break;
            }
        }
        Ok(headers)
    }

    fn read_stream(
        stream: AgileReference<IStream>,
        policy: ResponseCapturePolicy,
    ) -> Result<Option<Vec<u8>>, String> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let result = stream
            .resolve()
            .map_err(|error| error.to_string())
            .and_then(|stream| read_stream_body(&stream, policy));
        if initialized.is_ok() {
            unsafe { CoUninitialize() };
        }
        result
    }

    fn read_stream_body(
        stream: &IStream,
        policy: ResponseCapturePolicy,
    ) -> Result<Option<Vec<u8>>, String> {
        let mut body = Vec::new();
        if policy == ResponseCapturePolicy::RequireWebpSignature {
            let mut signature = [0_u8; 12];
            let mut offset = 0;
            while offset < signature.len() {
                let read = read_stream_chunk(stream, &mut signature[offset..])?;
                if read == 0 {
                    return Ok(None);
                }
                offset += read;
            }
            if !has_webp_signature(&signature) {
                return Ok(None);
            }
            body.extend_from_slice(&signature);
        }
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = read_stream_chunk(stream, &mut buffer)?;
            if read == 0 {
                break;
            }
            if body.len().saturating_add(read) > MAX_CAPTURED_RESOURCE_BYTES {
                return Err("captured response exceeded the per-resource limit".to_string());
            }
            body.extend_from_slice(&buffer[..read]);
        }
        Ok(Some(body))
    }

    fn read_stream_chunk(stream: &IStream, buffer: &mut [u8]) -> Result<usize, String> {
        let mut read = 0_u32;
        unsafe {
            stream
                .Read(
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    Some(&mut read),
                )
                .ok()
                .map_err(|error| error.to_string())?;
        }
        Ok(read as usize)
    }
}

#[cfg(target_os = "windows")]
pub use windows_capture::install as install_windows_capture;

#[cfg(test)]
mod tests {
    use super::*;

    fn resource(url: &str, body: &[u8]) -> CapturedResource {
        CapturedResource {
            status: 200,
            status_text: "OK".to_string(),
            headers: HashMap::from([("content-type".to_string(), "image/png".to_string())]),
            final_url: url.to_string(),
            body: body.to_vec(),
        }
    }

    #[test]
    fn uses_trusted_policy_for_declared_media() {
        assert_eq!(
            response_capture_policy(
                "https://cdn.test/resource",
                &HashMap::from([("content-type".to_string(), "image/webp".to_string())]),
                None,
            ),
            Some(ResponseCapturePolicy::TrustedMedia),
        );
        assert_eq!(
            response_capture_policy("https://cdn.test/page.webp", &HashMap::new(), None),
            Some(ResponseCapturePolicy::TrustedMedia),
        );
    }

    #[test]
    fn requires_webp_signature_for_disguised_image_requests() {
        for content_type in [
            "text/css",
            "application/javascript",
            "application/json",
            "font/woff",
            "font/woff2",
        ] {
            assert_eq!(
                response_capture_policy(
                    "https://cdn.test/disguised.css",
                    &HashMap::from([("content-type".to_string(), content_type.to_string(),)]),
                    Some("image"),
                ),
                Some(ResponseCapturePolicy::RequireWebpSignature),
            );
        }
    }

    #[test]
    fn ignores_regular_stylesheet_script_json_and_font_requests() {
        for (content_type, destination) in [
            ("text/css", "style"),
            ("application/javascript", "script"),
            ("application/json", "empty"),
            ("font/woff", "font"),
            ("font/woff2", "font"),
        ] {
            assert_eq!(
                response_capture_policy(
                    "https://cdn.test/resource.css",
                    &HashMap::from([("content-type".to_string(), content_type.to_string(),)]),
                    Some(destination),
                ),
                None,
            );
        }
        assert_eq!(
            response_capture_policy(
                "data:image/webp;base64,UklGRg==",
                &HashMap::new(),
                Some("image"),
            ),
            None,
        );
    }

    #[test]
    fn recognizes_only_a_webp_riff_signature() {
        assert!(has_webp_signature(b"RIFF\x04\x00\x00\x00WEBPpayload"));
        for body in [
            b"body { color: red; }".as_slice(),
            b"console.log('x')".as_slice(),
            b"{\"page\":1}".as_slice(),
            b"wOFFfont-data".as_slice(),
            b"wOF2font-data".as_slice(),
            b"RIFFshort".as_slice(),
            b"RIFF\x04\x00\x00\x00WAVEpayload".as_slice(),
        ] {
            assert!(!has_webp_signature(body));
        }
    }

    #[test]
    fn stores_and_consumes_a_claimed_response() {
        let store = CapturedResourceStore::default();
        let capture_id = store.begin("pool:1");
        assert_eq!(store.claim("pool:1"), Some(capture_id));
        store.complete(
            "pool:1",
            capture_id,
            Some(resource("https://cdn.test/page.png#frame", b"image")),
        );
        store.finish("pool:1", capture_id);

        assert_eq!(
            store
                .take("pool:1", "https://cdn.test/page.png")
                .map(|resource| resource.body),
            Some(b"image".to_vec())
        );
        assert!(store.take("pool:1", "https://cdn.test/page.png").is_none());
    }

    #[test]
    fn ignores_completion_from_a_replaced_capture() {
        let store = CapturedResourceStore::default();
        let stale_id = store.begin("pool:1");
        assert_eq!(store.claim("pool:1"), Some(stale_id));
        let current_id = store.begin("pool:1");
        store.complete(
            "pool:1",
            stale_id,
            Some(resource("https://cdn.test/stale.png", b"stale")),
        );
        store.finish("pool:1", current_id);

        assert!(store.take("pool:1", "https://cdn.test/stale.png").is_none());
    }

    #[test]
    fn waits_for_a_response_that_starts_after_extraction() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let store = Arc::new(CapturedResourceStore::default());
            let capture_id = store.begin("pool:1");
            let producer_store = Arc::clone(&store);
            let producer = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                assert_eq!(producer_store.claim("pool:1"), Some(capture_id));
                tokio::time::sleep(Duration::from_millis(10)).await;
                producer_store.complete(
                    "pool:1",
                    capture_id,
                    Some(resource("https://cdn.test/late.png", b"late")),
                );
            });

            let started = Instant::now();
            store
                .wait_until_settled(
                    "pool:1",
                    capture_id,
                    Duration::from_millis(30),
                    Duration::from_millis(250),
                )
                .await;
            producer.await.unwrap();

            assert!(started.elapsed() >= Duration::from_millis(50));
            assert_eq!(
                store
                    .take("pool:1", "https://cdn.test/late.png")
                    .map(|resource| resource.body),
                Some(b"late".to_vec())
            );
        });
    }
}
