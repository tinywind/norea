//! User-started URL tests for VPN profiles. Each test opens its own OpenVPN tunnel, loads the URL
//! the user typed once in an isolated Android WebView process routed through a private local
//! proxy, and closes the tunnel. Tests run one at a time and never touch the plugin VPN or
//! download worker connections.

#[cfg(target_os = "android")]
mod android;

use std::sync::Mutex;
#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicI64, Ordering};
#[cfg(target_os = "android")]
use std::time::Duration;

use serde::{Deserialize, Serialize};

const MAX_URL_LENGTH: usize = 2048;
const MAX_RUN_ID_LENGTH: usize = 64;
const MAX_USER_AGENT_LENGTH: usize = 512;
#[cfg(target_os = "android")]
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
#[cfg(target_os = "android")]
const PAGE_TIMEOUT: Duration = Duration::from_secs(25);
#[cfg(target_os = "android")]
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "android")]
static PAGE_SEQUENCE: AtomicI64 = AtomicI64::new(1);

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
    /// The page load in the test browser.
    Request,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum VpnUrlTestResult {
    /// The page finished loading; `status` is the main document's status when the WebView reports it.
    Ok { status: Option<u16>, elapsed_ms: u64 },
    HttpError { status: u16, elapsed_ms: u64 },
    CloudflareChallenge { status: u16, elapsed_ms: u64 },
    /// The test tunnel did not come up or was lost.
    ConnectionFailed { reason: String },
    /// The tunnel was up, but the page did not load (DNS, TCP, TLS, or another network error).
    RequestFailed { reason: String },
    TimedOut { stage: VpnUrlTestStage },
    /// An imported profile that needs a username and password, which tests do not ask for.
    CredentialsRequired,
    /// The plugin VPN or a download worker uses this server, so a second session is not opened.
    InUse,
    /// Android did not start the test browser process, as some builds do while Norea is not in
    /// the foreground.
    BrowserUnavailable,
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

/// The User-Agent of the test browser; empty keeps the WebView default.
pub(crate) fn validate_user_agent(user_agent: &str) -> Result<(), String> {
    if user_agent.len() > MAX_USER_AGENT_LENGTH
        || user_agent.bytes().any(|byte| byte.is_ascii_control() || !byte.is_ascii())
    {
        return Err("the User-Agent for URL tests is invalid".to_string());
    }
    Ok(())
}

/// What the test browser saw when it loaded the page once, as `AndroidVpnUrlTestService` reports it.
#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum PageObservation {
    /// The main document finished loading. `status` comes from the main-frame HTTP error or, for
    /// other responses, the document's navigation timing; the headers only from an HTTP error.
    Loaded {
        url: String,
        status: Option<u16>,
        server: Option<String>,
        cf_mitigated: Option<String>,
        challenge_markers: bool,
        elapsed_ms: u64,
    },
    NetworkError { url: String, description: String },
    TimedOut,
    BrowserUnavailable,
    Cancelled,
    /// The test browser could not run the test.
    Failed { reason: String },
}

/// Judges one page load. A proxy connection the tunnel could not open shows up in the page as a
/// bare 502 or tunnel error, so the recorded reason for that host replaces it.
#[cfg(any(target_os = "android", test))]
fn judge_page(observation: &str, failures: &ConnectFailures) -> Result<VpnUrlTestResult, String> {
    let observation: PageObservation = serde_json::from_str(observation)
        .map_err(|error| format!("the VPN URL test browser sent an invalid result: {error}"))?;
    Ok(match observation {
        PageObservation::Loaded { url, status, server, cf_mitigated, challenge_markers, elapsed_ms } => {
            let result = classify_page(status, server.as_deref(), cf_mitigated.as_deref(), challenge_markers, elapsed_ms);
            match failures.for_url(&url) {
                Some(reason) if matches!(result, VpnUrlTestResult::HttpError { status: 502, .. }) => VpnUrlTestResult::RequestFailed { reason },
                _ => result,
            }
        }
        PageObservation::NetworkError { url, description } => {
            VpnUrlTestResult::RequestFailed { reason: failures.for_url(&url).unwrap_or(description) }
        }
        PageObservation::TimedOut => VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Request },
        PageObservation::BrowserUnavailable => VpnUrlTestResult::BrowserUnavailable,
        PageObservation::Cancelled => VpnUrlTestResult::Cancelled,
        PageObservation::Failed { reason } => return Err(reason),
    })
}

#[cfg(any(target_os = "android", test))]
fn classify_page(
    status: Option<u16>,
    server: Option<&str>,
    cf_mitigated: Option<&str>,
    challenge_markers: bool,
    elapsed_ms: u64,
) -> VpnUrlTestResult {
    match status {
        Some(status) if is_cloudflare_challenge(status, server, cf_mitigated, challenge_markers) => {
            VpnUrlTestResult::CloudflareChallenge { status, elapsed_ms }
        }
        Some(status) if status >= 400 => VpnUrlTestResult::HttpError { status, elapsed_ms },
        status => VpnUrlTestResult::Ok { status, elapsed_ms },
    }
}

#[cfg(any(target_os = "android", test))]
fn is_cloudflare_challenge(status: u16, server: Option<&str>, cf_mitigated: Option<&str>, challenge_markers: bool) -> bool {
    cf_mitigated.is_some_and(|value| value.trim().eq_ignore_ascii_case("challenge"))
        || (challenge_markers && is_cloudflare_error(status, server))
}

/// Cloudflare serves its challenge page as 403, 429, or 503 from `server: cloudflare`; ordinary
/// pages can carry challenge-platform scripts too, so markers count only on these responses.
#[cfg(any(target_os = "android", test))]
fn is_cloudflare_error(status: u16, server: Option<&str>) -> bool {
    matches!(status, 403 | 429 | 503) && server.is_some_and(|value| value.trim().eq_ignore_ascii_case("cloudflare"))
}

/// Why the tunnel could not open a proxy connection, per target host and port.
#[cfg(any(target_os = "android", test))]
#[derive(Default)]
struct ConnectFailures(Mutex<Vec<(String, u16, String)>>);

#[cfg(any(target_os = "android", test))]
impl ConnectFailures {
    fn record(&self, host: &str, port: u16, reason: &str) {
        let mut failures = self.0.lock().expect("VPN URL test connector lock");
        match failures.iter().position(|(known, known_port, _)| known.eq_ignore_ascii_case(host) && *known_port == port) {
            Some(index) => failures[index].2 = reason.to_string(),
            None => failures.push((host.to_string(), port, reason.to_string())),
        }
    }

    fn for_url(&self, url: &str) -> Option<String> {
        let url = reqwest::Url::parse(url).ok()?;
        let host = url.host_str()?.trim_start_matches('[').trim_end_matches(']');
        let port = url.port_or_known_default()?;
        self.0.lock().expect("VPN URL test connector lock").iter()
            .find(|(known, known_port, _)| known.eq_ignore_ascii_case(host) && *known_port == port)
            .map(|(_, _, reason)| reason.clone())
    }
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

/// Connects a separate tunnel, loads the page once through it in the isolated test browser, which
/// keeps its process for the rest of the run, and closes the tunnel on every path.
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
    let recorder = std::sync::Arc::new(RecordingConnector { inner: connector, failures: ConnectFailures::default() });
    proxy.tunnel(recorder.clone());
    let page = PAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let (url, port, user_agent) = (request.url.to_string(), proxy.address().port(), request.user_agent);
    let page_timeout_ms = PAGE_TIMEOUT.as_millis() as i32;
    let mut load = tauri::async_runtime::spawn_blocking(move || android::load_page(page, &url, port, &user_agent, page_timeout_ms));
    let mut page_running = true;
    let mut completed = false;
    let result = tokio::select! {
        observation = &mut load => {
            page_running = false;
            observation
                .map_err(|error| format!("the VPN URL test page task failed: {error}"))
                .and_then(|observation| observation)
                .and_then(|observation| judge_page(&observation, &recorder.failures))
        }
        result = &mut completion => {
            completed = true;
            Ok(VpnUrlTestResult::ConnectionFailed { reason: result.err().unwrap_or_else(|| "OpenVPN disconnected".to_string()) })
        }
        () = wait_for_cancellation(cancellation) => Ok(VpnUrlTestResult::Cancelled),
    };
    if page_running {
        if let Err(error) = android::cancel_page(page) {
            log::warn!("could not stop the VPN URL test page: {error}");
        }
        let _ = load.await;
    }
    proxy.block("The VPN URL test tunnel is closed");
    close_tunnel(&control, (!completed).then_some(completion)).await;
    result
}

/// Remembers why the tunnel could not open each upstream connection.
#[cfg(target_os = "android")]
struct RecordingConnector {
    inner: std::sync::Arc<dyn super::proxy::ProxyConnector>,
    failures: ConnectFailures,
}

#[cfg(target_os = "android")]
impl super::proxy::ProxyConnector for RecordingConnector {
    fn connect<'a>(&'a self, target: &'a super::proxy::ProxyTarget) -> super::proxy::ConnectFuture<'a> {
        Box::pin(async move {
            let result = self.inner.connect(target).await;
            if let Err(error) = &result {
                self.failures.record(&target.host, target.port, error);
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
        assert_eq!(classify_page(Some(403), Some("cloudflare"), Some("challenge"), false, 120),
            VpnUrlTestResult::CloudflareChallenge { status: 403, elapsed_ms: 120 });
        assert_eq!(classify_page(Some(200), None, Some(" Challenge "), false, 5),
            VpnUrlTestResult::CloudflareChallenge { status: 200, elapsed_ms: 5 });
    }

    #[test]
    fn reports_challenge_page_markers_only_on_cloudflare_error_responses() {
        assert_eq!(classify_page(Some(503), Some("cloudflare"), None, true, 40),
            VpnUrlTestResult::CloudflareChallenge { status: 503, elapsed_ms: 40 });
        assert_eq!(classify_page(Some(403), Some("nginx"), None, true, 40),
            VpnUrlTestResult::HttpError { status: 403, elapsed_ms: 40 });
        assert_eq!(classify_page(Some(403), Some("cloudflare"), None, false, 40),
            VpnUrlTestResult::HttpError { status: 403, elapsed_ms: 40 });
        assert_eq!(classify_page(Some(200), Some("cloudflare"), None, true, 40),
            VpnUrlTestResult::Ok { status: Some(200), elapsed_ms: 40 });
        assert_eq!(classify_page(None, None, None, true, 40), VpnUrlTestResult::Ok { status: None, elapsed_ms: 40 });
        assert!(!is_cloudflare_error(200, Some("cloudflare")));
        assert!(!is_cloudflare_error(503, None));
    }

    #[test]
    fn maps_document_statuses_and_keeps_an_unknown_success_status_unknown() {
        assert_eq!(classify_page(Some(204), None, None, false, 1), VpnUrlTestResult::Ok { status: Some(204), elapsed_ms: 1 });
        assert_eq!(classify_page(None, None, None, false, 1), VpnUrlTestResult::Ok { status: None, elapsed_ms: 1 });
        assert_eq!(classify_page(Some(404), None, None, false, 1), VpnUrlTestResult::HttpError { status: 404, elapsed_ms: 1 });
        assert_eq!(classify_page(Some(500), Some("cloudflare"), None, false, 1), VpnUrlTestResult::HttpError { status: 500, elapsed_ms: 1 });
    }

    #[test]
    fn judges_page_observations_from_the_test_browser() {
        let failures = ConnectFailures::default();
        assert_eq!(judge_page(r#"{"kind":"loaded","url":"https://example.com/","status":200,"challengeMarkers":false,"elapsedMs":812}"#, &failures),
            Ok(VpnUrlTestResult::Ok { status: Some(200), elapsed_ms: 812 }));
        assert_eq!(judge_page(r#"{"kind":"loaded","url":"https://example.com/","challengeMarkers":false,"elapsedMs":9}"#, &failures),
            Ok(VpnUrlTestResult::Ok { status: None, elapsed_ms: 9 }));
        assert_eq!(judge_page(r#"{"kind":"loaded","url":"https://example.com/","status":403,"server":"cloudflare","challengeMarkers":true,"elapsedMs":300}"#, &failures),
            Ok(VpnUrlTestResult::CloudflareChallenge { status: 403, elapsed_ms: 300 }));
        assert_eq!(judge_page(r#"{"kind":"networkError","url":"https://example.com/","description":"net::ERR_CONNECTION_RESET"}"#, &failures),
            Ok(VpnUrlTestResult::RequestFailed { reason: "net::ERR_CONNECTION_RESET".into() }));
        assert_eq!(judge_page(r#"{"kind":"timedOut"}"#, &failures), Ok(VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Request }));
        assert_eq!(judge_page(r#"{"kind":"cancelled"}"#, &failures), Ok(VpnUrlTestResult::Cancelled));
        assert_eq!(judge_page(r#"{"kind":"browserUnavailable"}"#, &failures), Ok(VpnUrlTestResult::BrowserUnavailable));
        assert_eq!(judge_page(r#"{"kind":"failed","reason":"VPN URL tests require WebView multi-profile support."}"#, &failures),
            Err("VPN URL tests require WebView multi-profile support.".into()));
        assert!(judge_page("null", &failures).is_err());
    }

    #[test]
    fn replaces_proxy_errors_with_why_the_tunnel_could_not_reach_the_host() {
        let failures = ConnectFailures::default();
        failures.record("Example.com", 443, "DNS lookup through the tunnel failed");
        failures.record("plain.example", 80, "connection refused");
        assert_eq!(judge_page(r#"{"kind":"networkError","url":"https://example.com/a","description":"net::ERR_TUNNEL_CONNECTION_FAILED"}"#, &failures),
            Ok(VpnUrlTestResult::RequestFailed { reason: "DNS lookup through the tunnel failed".into() }));
        assert_eq!(judge_page(r#"{"kind":"loaded","url":"http://plain.example/","status":502,"challengeMarkers":false,"elapsedMs":20}"#, &failures),
            Ok(VpnUrlTestResult::RequestFailed { reason: "connection refused".into() }));
        assert_eq!(judge_page(r#"{"kind":"loaded","url":"http://plain.example/","status":404,"challengeMarkers":false,"elapsedMs":20}"#, &failures),
            Ok(VpnUrlTestResult::HttpError { status: 404, elapsed_ms: 20 }), "a real response is not replaced");
        assert_eq!(judge_page(r#"{"kind":"loaded","url":"http://other.example/","status":502,"challengeMarkers":false,"elapsedMs":20}"#, &failures),
            Ok(VpnUrlTestResult::HttpError { status: 502, elapsed_ms: 20 }), "another host's failure does not count");
    }

    #[test]
    fn matches_connect_failures_by_host_and_effective_port() {
        let failures = ConnectFailures::default();
        failures.record("2001:db8::1", 443, "unreachable");
        failures.record("example.com", 8080, "refused");
        failures.record("example.com", 8080, "reset");
        assert_eq!(failures.for_url("https://[2001:db8::1]/").as_deref(), Some("unreachable"));
        assert_eq!(failures.for_url("http://EXAMPLE.com:8080/path").as_deref(), Some("reset"));
        assert_eq!(failures.for_url("http://example.com/"), None);
        assert_eq!(failures.for_url("not a url"), None);
    }

    #[test]
    fn serializes_results_for_the_frontend() {
        assert_eq!(serde_json::to_value(VpnUrlTestResult::Ok { status: Some(200), elapsed_ms: 31 }).unwrap(),
            serde_json::json!({ "kind": "ok", "status": 200, "elapsedMs": 31 }));
        assert_eq!(serde_json::to_value(VpnUrlTestResult::Ok { status: None, elapsed_ms: 31 }).unwrap(),
            serde_json::json!({ "kind": "ok", "status": null, "elapsedMs": 31 }));
        assert_eq!(serde_json::to_value(VpnUrlTestResult::TimedOut { stage: VpnUrlTestStage::Connect }).unwrap(),
            serde_json::json!({ "kind": "timedOut", "stage": "connect" }));
        assert_eq!(serde_json::to_value(VpnUrlTestResult::CredentialsRequired).unwrap(), serde_json::json!({ "kind": "credentialsRequired" }));
        assert_eq!(serde_json::to_value(VpnUrlTestResult::BrowserUnavailable).unwrap(), serde_json::json!({ "kind": "browserUnavailable" }));
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
}
