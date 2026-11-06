//! User-started URL tests for VPN profiles. Each test opens its own OpenVPN tunnel, sends one
//! GET to the URL the user typed through a private local proxy, and closes the tunnel. Tests run
//! one at a time and never touch the plugin VPN or download worker connections.

use std::sync::Mutex;
#[cfg(target_os = "android")]
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const MAX_URL_LENGTH: usize = 2048;
const MAX_RUN_ID_LENGTH: usize = 64;
const MAX_USER_AGENT_LENGTH: usize = 512;
#[cfg(target_os = "android")]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(target_os = "android")]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(target_os = "android")]
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(any(target_os = "android", test))]
const MAX_BODY_PREFIX_BYTES: usize = 16 * 1024;
#[cfg(any(target_os = "android", test))]
const CLOUDFLARE_CHALLENGE_MARKERS: &[&str] = &[
    "/cdn-cgi/challenge-platform/",
    "challenges.cloudflare.com",
    "cf_chl_opt",
    "cf-chl-",
    "<title>just a moment...</title>",
];

/// The profile one URL test connects with.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum VpnUrlTestProfile {
    Finder { candidate_id: String },
    Saved { id: String, expected_hash: String },
    Manual { host: String, expected_hash: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VpnUrlTestStage {
    Connect,
    Request,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum VpnUrlTestResult {
    /// A 2xx or 3xx response; redirects are reported, not followed.
    Ok { status: u16, elapsed_ms: u64 },
    HttpError { status: u16, elapsed_ms: u64 },
    CloudflareChallenge { status: u16, elapsed_ms: u64 },
    /// The test tunnel did not come up or was lost.
    ConnectionFailed { reason: String },
    /// The tunnel was up, but the request failed (DNS, TCP, or TLS).
    RequestFailed { reason: String },
    TimedOut { stage: VpnUrlTestStage },
    /// An imported profile that needs a username and password, which tests do not ask for.
    CredentialsRequired,
    /// The plugin VPN or a download worker uses this server, so a second session is not opened.
    InUse,
    Cancelled,
}

/// Parses the URL the user typed: absolute http or https with a host and no credentials.
pub(crate) fn parse_test_url(input: &str) -> Result<reqwest::Url, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > MAX_URL_LENGTH {
        return Err(format!("the test URL must be 1 to {MAX_URL_LENGTH} characters"));
    }
    let url = reqwest::Url::parse(input).map_err(|error| format!("the test URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the test URL must start with http:// or https://".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("the test URL must name a host".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the test URL must not contain credentials".to_string());
    }
    Ok(url)
}

pub(crate) fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id.len() > MAX_RUN_ID_LENGTH
        || !run_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("URL test run ID is invalid".to_string());
    }
    Ok(())
}

/// The User-Agent sent with the test request; empty sends none.
pub(crate) fn validate_user_agent(user_agent: &str) -> Result<(), String> {
    if user_agent.len() > MAX_USER_AGENT_LENGTH
        || user_agent.bytes().any(|byte| byte.is_ascii_control() || !byte.is_ascii())
    {
        return Err("the User-Agent for URL tests is invalid".to_string());
    }
    Ok(())
}

/// Classifies one response from its status, its `server` and `cf-mitigated` headers, and the
/// start of its body, which is read only when the headers alone cannot rule out a challenge.
#[cfg(any(target_os = "android", test))]
fn classify_response(
    status: u16,
    server: Option<&str>,
    cf_mitigated: Option<&str>,
    body_prefix: &[u8],
    elapsed_ms: u64,
) -> VpnUrlTestResult {
    if is_cloudflare_challenge(status, server, cf_mitigated, body_prefix) {
        VpnUrlTestResult::CloudflareChallenge { status, elapsed_ms }
    } else if (200..400).contains(&status) {
        VpnUrlTestResult::Ok { status, elapsed_ms }
    } else {
        VpnUrlTestResult::HttpError { status, elapsed_ms }
    }
}

#[cfg(any(target_os = "android", test))]
fn is_cloudflare_challenge(status: u16, server: Option<&str>, cf_mitigated: Option<&str>, body_prefix: &[u8]) -> bool {
    if cf_mitigated.is_some_and(|value| value.trim().eq_ignore_ascii_case("challenge")) {
        return true;
    }
    if !needs_challenge_body(status, server) {
        return false;
    }
    let body = String::from_utf8_lossy(&body_prefix[..body_prefix.len().min(MAX_BODY_PREFIX_BYTES)]).to_ascii_lowercase();
    CLOUDFLARE_CHALLENGE_MARKERS.iter().any(|marker| body.contains(marker))
}

/// Cloudflare serves its challenge page as 403, 429, or 503 from `server: cloudflare`.
#[cfg(any(target_os = "android", test))]
fn needs_challenge_body(status: u16, server: Option<&str>) -> bool {
    matches!(status, 403 | 429 | 503) && server.is_some_and(|value| value.trim().eq_ignore_ascii_case("cloudflare"))
}

#[cfg(any(target_os = "android", test))]
fn describe_error_chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_message = cause.to_string();
        if !message.contains(&cause_message) {
            message.push_str(": ");
            message.push_str(&cause_message);
        }
        source = cause.source();
    }
    message
}

#[derive(Default)]
struct RunControl {
    run_id: Option<String>,
    cancellation: Option<tokio::sync::watch::Sender<bool>>,
    cancelled_run: Option<String>,
}

/// Serializes URL tests and owns their cancellation. A cancel names its run, so a test of that
/// run that starts after the cancel returns `Cancelled` at once.
pub(crate) struct VpnUrlTester {
    // Held for a whole test; it also keeps the test proxy, bound on the first test.
    running: tokio::sync::Mutex<TesterResources>,
    control: Mutex<RunControl>,
}

#[derive(Default)]
struct TesterResources {
    #[cfg(target_os = "android")]
    proxy: Option<super::proxy::LocalProxy>,
}

pub(super) struct UrlTestGuard<'a> {
    tester: &'a VpnUrlTester,
    resources: tokio::sync::MutexGuard<'a, TesterResources>,
    cancellation: tokio::sync::watch::Receiver<bool>,
}

impl Drop for UrlTestGuard<'_> {
    fn drop(&mut self) {
        let mut control = self.tester.control.lock().expect("VPN URL test lock");
        control.run_id = None;
        control.cancellation = None;
    }
}

impl VpnUrlTester {
    pub(crate) fn new() -> Self {
        Self { running: tokio::sync::Mutex::new(TesterResources::default()), control: Mutex::new(RunControl::default()) }
    }

    /// Starts one test of `run_id`; None when that run was cancelled.
    pub(super) fn begin(&self, run_id: &str) -> Result<Option<UrlTestGuard<'_>>, String> {
        let resources = self.running.try_lock().map_err(|_| "another VPN URL test is running".to_string())?;
        let mut control = self.control.lock().expect("VPN URL test lock");
        if control.cancelled_run.as_deref() == Some(run_id) {
            return Ok(None);
        }
        let (sender, cancellation) = tokio::sync::watch::channel(false);
        control.run_id = Some(run_id.to_string());
        control.cancellation = Some(sender);
        drop(control);
        Ok(Some(UrlTestGuard { tester: self, resources, cancellation }))
    }

    pub(crate) fn cancel(&self, run_id: &str) {
        let mut control = self.control.lock().expect("VPN URL test lock");
        control.cancelled_run = Some(run_id.to_string());
        if control.run_id.as_deref() == Some(run_id) {
            if let Some(cancellation) = &control.cancellation {
                cancellation.send_replace(true);
            }
        }
    }
}

#[cfg(target_os = "android")]
pub(super) struct UrlTestRequest {
    pub(super) profile: String,
    pub(super) credentials: super::engine::EngineCredentials,
    pub(super) url: reqwest::Url,
    pub(super) user_agent: String,
}

/// Connects a separate tunnel, sends one GET through it, and closes the tunnel on every path.
#[cfg(target_os = "android")]
pub(super) async fn run_test(guard: &mut UrlTestGuard<'_>, request: UrlTestRequest) -> Result<VpnUrlTestResult, String> {
    if guard.resources.proxy.is_none() {
        let proxy = super::proxy::LocalProxy::bind()?;
        proxy.block("The VPN URL test tunnel is closed");
        proxy.start()?;
        guard.resources.proxy = Some(proxy);
    }
    let proxy = guard.resources.proxy.as_ref().expect("VPN URL test proxy");
    let cancellation = &mut guard.cancellation;

    let (engine_cancel, engine_cancellation) = tokio::sync::watch::channel(false);
    let connect = super::engine::connect(request.profile, request.credentials, engine_cancellation);
    tokio::pin!(connect);
    let first = tokio::select! {
        result = &mut connect => Some(result),
        () = tokio::time::sleep(CONNECT_TIMEOUT) => None,
        () = wait_for_cancellation(cancellation) => None,
    };
    let (connection, stopped) = match first {
        Some(result) => (result, None),
        None => {
            let stopped = if *cancellation.borrow() {
                VpnUrlTestResult::Cancelled
            } else {
                VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Connect }
            };
            // The engine tears down a half-open session itself once it sees the cancel.
            engine_cancel.send_replace(true);
            (connect.as_mut().await, Some(stopped))
        }
    };
    let connection = match (connection, stopped) {
        (Ok(connection), None) => connection,
        (Ok(connection), Some(result)) => {
            close_tunnel(&connection.control, Some(connection.completion)).await;
            return Ok(result);
        }
        (Err(_), Some(result)) => return Ok(result),
        (Err(error), None) => return Ok(VpnUrlTestResult::ConnectionFailed { reason: error }),
    };

    let super::engine::EngineConnection { connector, control, lifecycle: _lifecycle, mut completion } = connection;
    let recorder = std::sync::Arc::new(RecordingConnector { inner: connector, error: Mutex::new(None) });
    proxy.tunnel(recorder.clone());
    let mut completed = false;
    let result = tokio::select! {
        result = tokio::time::timeout(REQUEST_TIMEOUT, send_request(proxy.address().port(), &request.url, &request.user_agent)) => match result {
            Ok(result) => match recorder.error.lock().expect("VPN URL test connector lock").take() {
                Some(error) if !matches!(result, VpnUrlTestResult::Ok { .. } | VpnUrlTestResult::CloudflareChallenge { .. }) =>
                    VpnUrlTestResult::RequestFailed { reason: error },
                _ => result,
            },
            Err(_) => VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Request },
        },
        result = &mut completion => {
            completed = true;
            VpnUrlTestResult::ConnectionFailed { reason: result.err().unwrap_or_else(|| "OpenVPN disconnected".to_string()) }
        }
        () = wait_for_cancellation(cancellation) => VpnUrlTestResult::Cancelled,
    };
    proxy.block("The VPN URL test tunnel is closed");
    close_tunnel(&control, (!completed).then_some(completion)).await;
    Ok(result)
}

#[cfg(target_os = "android")]
async fn send_request(port: u16, url: &reqwest::Url, user_agent: &str) -> VpnUrlTestResult {
    let client = match reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).and_then(|proxy| {
        let builder = reqwest::Client::builder()
            .proxy(proxy)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(REQUEST_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .retry(reqwest::retry::never());
        (if user_agent.is_empty() { builder } else { builder.user_agent(user_agent) }).build()
    }) {
        Ok(client) => client,
        Err(error) => return VpnUrlTestResult::RequestFailed { reason: format!("could not prepare the test request: {}", describe_error_chain(&error)) },
    };
    let started = Instant::now();
    let mut response = match client.get(url.clone()).send().await {
        Ok(response) => response,
        Err(error) if error.is_timeout() => return VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Request },
        Err(error) => return VpnUrlTestResult::RequestFailed { reason: describe_error_chain(&error) },
    };
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let status = response.status().as_u16();
    let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
    let server = header("server");
    let cf_mitigated = header("cf-mitigated");
    let mut body_prefix = Vec::new();
    if cf_mitigated.is_none() && needs_challenge_body(status, server.as_deref()) {
        while body_prefix.len() < MAX_BODY_PREFIX_BYTES {
            match response.chunk().await {
                Ok(Some(chunk)) => body_prefix.extend_from_slice(&chunk[..chunk.len().min(MAX_BODY_PREFIX_BYTES - body_prefix.len())]),
                Ok(None) | Err(_) => break,
            }
        }
    }
    classify_response(status, server.as_deref(), cf_mitigated.as_deref(), &body_prefix, elapsed_ms)
}

/// Remembers why the tunnel could not open the upstream connection, which the local proxy
/// reports only as a bare 502.
#[cfg(target_os = "android")]
struct RecordingConnector {
    inner: std::sync::Arc<dyn super::proxy::ProxyConnector>,
    error: Mutex<Option<String>>,
}

#[cfg(target_os = "android")]
impl super::proxy::ProxyConnector for RecordingConnector {
    fn connect<'a>(&'a self, target: &'a super::proxy::ProxyTarget) -> super::proxy::ConnectFuture<'a> {
        Box::pin(async move {
            let result = self.inner.connect(target).await;
            if let Err(error) = &result {
                *self.error.lock().expect("VPN URL test connector lock") = Some(error.clone());
            }
            result
        })
    }
}

#[cfg(target_os = "android")]
async fn close_tunnel(
    control: &super::engine::EngineControl,
    completion: Option<std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>>,
) {
    if !matches!(tokio::time::timeout(CLOSE_TIMEOUT, control.stop()).await, Ok(Ok(()))) {
        control.cancel();
    }
    if let Some(completion) = completion {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, completion).await;
    }
}

#[cfg(target_os = "android")]
async fn wait_for_cancellation(cancellation: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *cancellation.borrow_and_update() {
            return;
        }
        if cancellation.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_absolute_http_and_https_urls_with_a_host() {
        assert_eq!(parse_test_url(" https://example.com/path?q=1 ").unwrap().as_str(), "https://example.com/path?q=1");
        assert!(parse_test_url("http://127.0.0.1:8080/").is_ok());
        for invalid in ["", "example.com", "ftp://example.com/", "file:///etc/hosts", "https://user:pass@example.com/", "javascript:alert(1)"] {
            assert!(parse_test_url(invalid).is_err(), "{invalid}");
        }
        assert!(parse_test_url(&format!("https://example.com/{}", "a".repeat(MAX_URL_LENGTH))).is_err());
    }

    #[test]
    fn validates_run_ids_and_user_agents() {
        assert!(validate_run_id("0b5e5e43-4f2a-4f8e-9d55-2f0d7a6c1b3e").is_ok());
        assert!(validate_run_id("").is_err());
        assert!(validate_run_id("bad id").is_err());
        assert!(validate_user_agent("").is_ok());
        assert!(validate_user_agent("Mozilla/5.0 (Linux; Android 14)").is_ok());
        assert!(validate_user_agent("bad\r\nheader").is_err());
    }

    #[test]
    fn reports_a_cloudflare_challenge_from_the_mitigation_header() {
        assert_eq!(classify_response(403, Some("cloudflare"), Some("challenge"), b"", 120),
            VpnUrlTestResult::CloudflareChallenge { status: 403, elapsed_ms: 120 });
        assert_eq!(classify_response(200, None, Some(" Challenge "), b"", 5),
            VpnUrlTestResult::CloudflareChallenge { status: 200, elapsed_ms: 5 });
    }

    #[test]
    fn reports_a_cloudflare_challenge_page_only_from_cloudflare_error_responses() {
        let page = b"<!DOCTYPE html><html><head><title>Just a moment...</title></head><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate\"></script>";
        assert_eq!(classify_response(503, Some("cloudflare"), None, page, 40),
            VpnUrlTestResult::CloudflareChallenge { status: 503, elapsed_ms: 40 });
        assert_eq!(classify_response(403, Some("nginx"), None, page, 40),
            VpnUrlTestResult::HttpError { status: 403, elapsed_ms: 40 });
        assert_eq!(classify_response(403, Some("cloudflare"), None, b"<h1>Access denied</h1>", 40),
            VpnUrlTestResult::HttpError { status: 403, elapsed_ms: 40 });
        assert_eq!(classify_response(200, Some("cloudflare"), None, page, 40),
            VpnUrlTestResult::Ok { status: 200, elapsed_ms: 40 });
        assert!(!needs_challenge_body(200, Some("cloudflare")));
        assert!(!needs_challenge_body(503, None));
    }

    #[test]
    fn maps_success_redirect_and_error_statuses() {
        assert_eq!(classify_response(204, None, None, b"", 1), VpnUrlTestResult::Ok { status: 204, elapsed_ms: 1 });
        assert_eq!(classify_response(301, None, None, b"", 1), VpnUrlTestResult::Ok { status: 301, elapsed_ms: 1 });
        assert_eq!(classify_response(404, None, None, b"", 1), VpnUrlTestResult::HttpError { status: 404, elapsed_ms: 1 });
        assert_eq!(classify_response(500, Some("cloudflare"), None, b"", 1), VpnUrlTestResult::HttpError { status: 500, elapsed_ms: 1 });
    }

    #[test]
    fn serializes_results_for_the_frontend() {
        assert_eq!(serde_json::to_value(VpnUrlTestResult::Ok { status: 200, elapsed_ms: 31 }).unwrap(),
            serde_json::json!({ "kind": "ok", "status": 200, "elapsedMs": 31 }));
        assert_eq!(serde_json::to_value(VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Connect }).unwrap(),
            serde_json::json!({ "kind": "timedOut", "stage": "connect" }));
        assert_eq!(serde_json::to_value(VpnUrlTestResult::CredentialsRequired).unwrap(), serde_json::json!({ "kind": "credentialsRequired" }));
        let profile: VpnUrlTestProfile = serde_json::from_value(serde_json::json!({ "kind": "saved", "id": "a", "expectedHash": "b" })).unwrap();
        assert!(matches!(profile, VpnUrlTestProfile::Saved { id, expected_hash } if id == "a" && expected_hash == "b"));
    }

    #[test]
    fn a_cancelled_run_does_not_start_another_test() {
        let tester = VpnUrlTester::new();
        let guard = tester.begin("run-1").unwrap().expect("first test starts");
        assert!(tester.begin("run-1").is_err(), "tests never overlap");
        tester.cancel("run-1");
        assert!(*guard.cancellation.borrow(), "the in-flight test sees the cancel");
        drop(guard);
        assert!(tester.begin("run-1").unwrap().is_none());
        assert!(tester.begin("run-2").unwrap().is_some());
    }

    #[test]
    fn joins_error_sources_without_repeating_them() {
        #[derive(Debug)]
        struct Outer(std::io::Error);
        impl std::fmt::Display for Outer {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str("error sending request") }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> { Some(&self.0) }
        }
        let error = Outer(std::io::Error::other("dns error: no record"));
        assert_eq!(describe_error_chain(&error), "error sending request: dns error: no record");
    }
}
