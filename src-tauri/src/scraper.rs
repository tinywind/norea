//! Desktop scraper WebViews: persistent Tauri child WebViews embedded
//! in the main window. Each scraper queue owns one WebView bound to the
//! active source's isolated browser profile.
//!
//! Architecture:
//!
//! - Each scraper webview starts at `scraper.html` (a stable
//!   tauri://localhost origin) and is created lazily per scraper queue.
//!   It exists for two reasons:
//!     1. It participates in the source-owned real-browser cookie jar.
//!        When the user opens
//!        the in-app site browser overlay and navigates to a plugin
//!        site, every cookie the site sets (CF clearance, login
//!        sessions) lands in that source's jar and persists across requests.
//!     2. It is the surface React's `SiteBrowserOverlay` paints
//!        into when the user wants to interact with a site.
//!
//! - Plugin HTTP fetches run inside the queue-owned scraper WebView
//!   context. This covers source browsing/search/listing, novel
//!   metadata/detail parsing, update checks, and chapter body
//!   downloads. That keeps the request on the browser network stack
//!   that solved Cloudflare, owns the TLS/browser fingerprint, and
//!   carries the WebView cookie jar without copying cookies into a
//!   host-side HTTP client.
//!
//! - Cross-origin pages still cannot call Tauri IPC directly, so
//!   the host asks the WebView to start an async browser fetch and
//!   polls a page-local result slot through `eval_with_callback`.

use std::collections::HashMap;
#[cfg(all(desktop, target_os = "windows"))]
use std::collections::HashSet;
#[cfg(desktop)]
use std::collections::hash_map::DefaultHasher;
#[cfg(desktop)]
use std::ffi::OsStr;
#[cfg(desktop)]
use std::fs;
#[cfg(desktop)]
use std::hash::{Hash, Hasher};
#[cfg(desktop)]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(desktop)]
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(desktop)]
use std::time::Instant;

#[cfg(desktop)]
use std::path::{Path, PathBuf};

#[cfg(desktop)]
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Url};
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize, Rect, Webview, WebviewBuilder, webview::PageLoadEvent};
#[cfg(desktop)]
use tauri::{Manager, WebviewUrl};
#[cfg(desktop)]
use tokio::sync::{Mutex as AsyncMutex, oneshot};
#[cfg(desktop)]
use tokio::time::timeout;
#[cfg(all(desktop, target_os = "windows"))]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, ICoreWebView2_2, ICoreWebView2_13,
    ICoreWebView2Profile2,
};
#[cfg(all(desktop, target_os = "windows"))]
use webview2_com::{ClearBrowsingDataCompletedHandler, GetCookiesCompletedHandler};
#[cfg(all(desktop, target_os = "windows"))]
use windows::core::{HSTRING, Interface, PCWSTR};

#[cfg(desktop)]
const SCRAPER_LABEL: &str = "scraper";
#[cfg(desktop)]
const SCRAPER_BLANK_URL: &str = "about:blank";
#[cfg(desktop)]
const SCRAPER_HIDE_BLANK_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(desktop))]
const SCRAPER_UNAVAILABLE: &str = "scraper: child webview is not available on this platform";
/// Local HTML file served by Vite (dev) / bundled in dist/ (prod).
/// Using `WebviewUrl::App` gives the scraper a stable Tauri-served
/// origin so any IPC the page does (none today, but future-proof)
/// passes Tauri's Origin handshake.
#[cfg(desktop)]
const SCRAPER_HOMEPAGE_PATH: &str = "scraper.html";
#[cfg(desktop)]
static FETCH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Polyfill + before-content hook injected at scraper webview creation.
/// The script runs before any page script in every navigation, so
/// callers (e.g. `webview_extract`) can pass an arbitrary
/// before-content script via `window.name` and receive results
/// asynchronously via `window.ReactNativeWebView.postMessage`.
///
/// Bridge wiring:
/// - `window.name=__lnr_script__=ENCODED` or the legacy
///   `__lnr_script__=ENCODED` fragment: decoded + eval'd before any
///   page script runs (e.g. patches `Element.prototype.attachShadow`).
/// - `ReactNativeWebView.postMessage(payload)` polyfill: stores the
///   payload in page state and also mirrors it to `location.hash` as a
///   fallback marker for older WebView hosts.
#[cfg(desktop)]
const SCRAPER_INIT_SCRIPT: &str = r##"
(function () {
  window.ReactNativeWebView = window.ReactNativeWebView || {};
  window.ReactNativeWebView.postMessage = function (payload) {
    try {
      window.__lnrExtractResult = String(payload);
      var encoded = encodeURIComponent(String(payload));
      var marker = "#__lnr_result__=" + encoded;
      try {
        history.replaceState(null, "", location.pathname + location.search + marker);
      } catch (e) {
        location.hash = marker;
      }
      try {
        var rid = window.__lnrExtractRequestId;
        if (rid) {
          location.href = "https://norea.localhost/__norea_scraper_result__/" +
            encodeURIComponent(rid);
        }
      } catch (e) {}
    } catch (e) {}
  };
  try {
    var hash = location.hash || "";
    var name = window.name || "";
    var prefix = "__lnr_script__=";
    var hashPrefix = "#" + prefix;
    var idx = hash.indexOf(hashPrefix);
    var encoded = "";
    var fromHash = false;
    if (idx !== -1) {
      encoded = hash.substring(idx + hashPrefix.length);
      fromHash = true;
    } else if (name.indexOf(prefix) === 0) {
      encoded = name.substring(prefix.length);
    }
    if (encoded) {
      var script = decodeURIComponent(encoded);
      if (fromHash) {
        try {
          history.replaceState(null, "", location.pathname + location.search);
        } catch (e) {}
      }
      try {
        (0, eval)(script);
      } catch (e) {
        var msg = (e && e.message) || String(e);
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({ ok: false, error: "before-script error: " + msg }));
        } catch (e2) {}
      }
    }
  } catch (e) {}
})();
"##;

#[cfg(desktop)]
type ScraperWebview = Webview<tauri::Wry>;

#[cfg(desktop)]
#[derive(Clone, Debug)]
struct ScraperEntry {
    label: String,
    source_id: String,
    user_agent: Option<String>,
}

#[cfg(desktop)]
struct PendingNavigation {
    request_id: u64,
    requested_url: String,
    started: bool,
    sender: oneshot::Sender<String>,
}

/// Inbound JSON shape from `webview_fetch` callers (matches the
/// browser `RequestInit` subset our pluginFetch surfaces).
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchInit {
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
}

/// Successful fetch payload returned to JS. Mirrors the subset of
/// `Response` our pluginFetch reconstitutes on the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub status: u16,
    pub status_text: String,
    pub body_base64: String,
    pub headers: HashMap<String, String>,
    pub final_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedResourceHandleResult {
    pub status: u16,
    pub status_text: String,
    pub body_handle: String,
    pub body_bytes: u64,
    pub cloudflare_challenge: bool,
    pub headers: HashMap<String, String>,
    pub final_url: String,
}

/// Lazily-created scraper WebViews keyed by scraper executor id.
#[cfg(desktop)]
#[derive(Default)]
pub struct ScraperState {
    executor_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    webviews: Mutex<HashMap<String, ScraperEntry>>,
    visible_key: Mutex<Option<String>>,
    /// Last URL the visible site browser navigated to, for diagnostics.
    last_navigated: Mutex<Option<String>>,
    /// Pending fetch-completion waiters keyed by request id. The in-page fetch
    /// script navigates to the result sentinel (intercepted in `on_navigation`)
    /// to wake the awaiting request, replacing the per-request poll loop.
    pending_completions: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Active site-browser navigation waiter for each executor. Page-load
    /// callbacks complete the waiter only after a navigation started while it
    /// was registered, so a late finish from the initial scraper page cannot
    /// satisfy a later request.
    pending_navigations: Mutex<HashMap<String, PendingNavigation>>,
    /// Monotonic cancellation generation per executor. A request snapshots the
    /// generation before waiting for the executor lock and rejects itself if a
    /// cancellation advanced it while queued or in flight.
    cancel_generations: Mutex<HashMap<String, Arc<AtomicU64>>>,
    captured_resources: Arc<crate::webview_resource_capture::CapturedResourceStore>,
    #[cfg(target_os = "windows")]
    resource_capture_handlers: Mutex<HashSet<String>>,
}

#[cfg(not(desktop))]
#[derive(Default)]
pub struct ScraperState;

#[cfg(desktop)]
const HIDDEN_SIZE: f64 = 1.0;
#[cfg(desktop)]
const HIDDEN_POSITION: f64 = -10_000.0;
#[cfg(desktop)]
const BACKGROUND_RENDER_WIDTH: f64 = 1280.0;
#[cfg(desktop)]
const BACKGROUND_RENDER_HEIGHT: f64 = 900.0;
#[cfg(desktop)]
const SCRAPER_SENTINEL_HOST: &str = "norea.localhost";
#[cfg(desktop)]
const SCRAPER_RESULT_PATH_PREFIX: &str = "/__norea_scraper_result__/";
#[cfg(desktop)]
const IMMEDIATE_EXECUTOR: &str = "immediate";
#[cfg(desktop)]
const RESOURCE_CAPTURE_QUIET_PERIOD: Duration = Duration::from_millis(750);
#[cfg(desktop)]
const SCRAPER_COOKIE_CLEAR_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(all(desktop, target_os = "windows"))]
const SCRAPER_CACHE_CLEAR_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(desktop)]
const SOURCE_PROFILE_DIRECTORY_NAME_LENGTH: usize = 64;

#[cfg(desktop)]
fn log_windows_scraper_event(message: &str) {
    if cfg!(target_os = "windows") {
        log::trace!("[scraper:windows] {message}");
    }
}

/// Parse the fetch-completion sentinel a page navigates to when its browser
/// fetch settles, returning the request id it carries. The sentinel is
/// intercepted (and cancelled) in `on_navigation`, so it never actually leaves
/// the source document.
#[cfg(desktop)]
fn scraper_result_request_id(url: &Url) -> Option<String> {
    if url.scheme() == "https"
        && url.host_str() == Some(SCRAPER_SENTINEL_HOST)
        && url.path().starts_with(SCRAPER_RESULT_PATH_PREFIX)
    {
        let encoded = url.path().strip_prefix(SCRAPER_RESULT_PATH_PREFIX)?;
        return decode_uri_component(encoded).ok();
    }
    None
}

#[cfg(desktop)]
fn register_completion(state: &ScraperState, request_id: &str) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    state
        .pending_completions
        .lock()
        .expect("scraper pending completions mutex")
        .insert(request_id.to_string(), tx);
    rx
}

#[cfg(desktop)]
fn fire_completion(state: &ScraperState, request_id: &str) {
    let sender = state
        .pending_completions
        .lock()
        .expect("scraper pending completions mutex")
        .remove(request_id);
    if let Some(tx) = sender {
        let _ = tx.send(());
    }
}

/// Removes a pending completion waiter on every exit path of the awaiting
/// request (success, error, timeout, early return) so a missed signal cannot
/// leak a map entry.
#[cfg(desktop)]
struct CompletionGuard<'a> {
    state: &'a ScraperState,
    request_id: String,
}

#[cfg(desktop)]
impl Drop for CompletionGuard<'_> {
    fn drop(&mut self) {
        self.state
            .pending_completions
            .lock()
            .expect("scraper pending completions mutex")
            .remove(&self.request_id);
    }
}

#[cfg(desktop)]
fn register_navigation(
    state: &ScraperState,
    executor: &str,
    request_id: u64,
    requested_url: &str,
) -> oneshot::Receiver<String> {
    let (tx, rx) = oneshot::channel();
    state
        .pending_navigations
        .lock()
        .expect("scraper pending navigations mutex")
        .insert(
            executor.to_string(),
            PendingNavigation {
                request_id,
                requested_url: requested_url.to_string(),
                started: false,
                sender: tx,
            },
        );
    rx
}

#[cfg(desktop)]
fn record_navigation_page_load(
    state: &ScraperState,
    executor: &str,
    event: PageLoadEvent,
    url: &Url,
) {
    let completion = {
        let mut pending = state
            .pending_navigations
            .lock()
            .expect("scraper pending navigations mutex");
        match event {
            PageLoadEvent::Started => {
                let Some(navigation) = pending.get_mut(executor) else {
                    return;
                };
                if navigation.requested_url == SCRAPER_BLANK_URL
                    && url.as_str() != SCRAPER_BLANK_URL
                {
                    return;
                }
                navigation.started = true;
                let requested_url = scraper_url_for_log(&navigation.requested_url);
                let event_url = scraper_url_for_log(url.as_str());
                log::trace!(
                    "[scraper:navigate] page started executor={executor} request_id={} requested_url={requested_url} event_url={event_url}",
                    navigation.request_id,
                );
                None
            }
            PageLoadEvent::Finished => pending
                .get(executor)
                .is_some_and(|navigation| {
                    navigation.started
                        && (navigation.requested_url != SCRAPER_BLANK_URL
                            || url.as_str() == SCRAPER_BLANK_URL)
                })
                .then(|| pending.remove(executor))
                .flatten(),
        }
    };
    if let Some(navigation) = completion {
        let requested_url = scraper_url_for_log(&navigation.requested_url);
        let final_url = scraper_url_for_log(url.as_str());
        log::trace!(
            "[scraper:navigate] page finished executor={executor} request_id={} requested_url={requested_url} final_url={final_url}",
            navigation.request_id,
        );
        let _ = navigation.sender.send(url.to_string());
    }
}

#[cfg(desktop)]
async fn wait_for_hidden_blank_page(completion: oneshot::Receiver<String>) -> Result<(), String> {
    match timeout(SCRAPER_HIDE_BLANK_TIMEOUT, completion).await {
        Ok(Ok(url)) if url == SCRAPER_BLANK_URL => Ok(()),
        Ok(Ok(url)) => Err(format!(
            "scraper_hide: blank navigation finished at {}",
            scraper_url_for_log(&url)
        )),
        Ok(Err(_)) => Err("scraper_hide: blank page-load completion dropped".to_string()),
        Err(_) => Err(format!(
            "scraper_hide: blank navigation timed out after {}ms",
            SCRAPER_HIDE_BLANK_TIMEOUT.as_millis()
        )),
    }
}

#[cfg(desktop)]
struct NavigationGuard<'a> {
    state: &'a ScraperState,
    executor: String,
    request_id: u64,
}

#[cfg(desktop)]
impl Drop for NavigationGuard<'_> {
    fn drop(&mut self) {
        let mut pending = self
            .state
            .pending_navigations
            .lock()
            .expect("scraper pending navigations mutex");
        if pending
            .get(&self.executor)
            .is_some_and(|navigation| navigation.request_id == self.request_id)
        {
            pending.remove(&self.executor);
        }
    }
}

fn normalize_user_agent(user_agent: Option<String>) -> Option<String> {
    user_agent.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(desktop)]
fn normalize_source_id(source_id: Option<&str>) -> Result<String, String> {
    let source_id = source_id.unwrap_or_default();
    if source_id.trim().is_empty() {
        return Err("scraper: source id is required for browser profile isolation".to_string());
    }
    if source_id.len() > 512 {
        return Err("scraper: source id exceeds the 512-byte limit".to_string());
    }
    Ok(source_id.to_string())
}

#[cfg(desktop)]
fn source_profile_key(source_id: &str) -> String {
    format!("{:x}", Sha256::digest(source_id.as_bytes()))
}

#[cfg(desktop)]
fn source_profiles_data_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("scraper: resolve app data directory: {err}"))?
        .join("scraper-profiles"))
}

#[cfg(desktop)]
fn source_profile_data_directory(app: &AppHandle, source_id: &str) -> Result<PathBuf, String> {
    Ok(source_profiles_data_directory(app)?.join(source_profile_key(source_id)))
}

#[cfg(desktop)]
fn is_source_profile_directory_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| {
        name.len() == SOURCE_PROFILE_DIRECTORY_NAME_LENGTH
            && name
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

#[cfg(desktop)]
fn source_profile_directories(root: &Path) -> Result<Vec<PathBuf>, String> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!(
                "scraper_clear_cache: inspect profile root '{}': {error}",
                root.display()
            ));
        }
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(format!(
            "scraper_clear_cache: profile root is not a normal directory: '{}'",
            root.display()
        ));
    }

    let entries = fs::read_dir(root).map_err(|error| {
        format!(
            "scraper_clear_cache: read profile root '{}': {error}",
            root.display()
        )
    })?;
    let mut profiles = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "scraper_clear_cache: read profile entry in '{}': {error}",
                root.display()
            )
        })?;
        if !is_source_profile_directory_name(&entry.file_name()) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "scraper_clear_cache: inspect profile entry '{}': {error}",
                entry.path().display()
            )
        })?;
        if !file_type.is_symlink() && file_type.is_dir() {
            profiles.push(entry.path());
        }
    }
    profiles.sort_unstable();
    Ok(profiles)
}

#[cfg(desktop)]
fn normalize_scraper_executor(queue: Option<&str>) -> Result<String, String> {
    let executor = queue.unwrap_or(IMMEDIATE_EXECUTOR);
    if executor == "mainForeground" {
        return Ok(IMMEDIATE_EXECUTOR.to_string());
    }
    if executor == IMMEDIATE_EXECUTOR {
        return Ok(executor.to_string());
    }
    if let Some(index) = executor.strip_prefix("pool:") {
        if !index.is_empty() && index.chars().all(|c| c.is_ascii_digit()) {
            return Ok(executor.to_string());
        }
    }
    Err(format!("scraper: unknown executor '{executor}'"))
}

#[cfg(desktop)]
fn scraper_executor_lock(state: &ScraperState, executor: &str) -> Arc<AsyncMutex<()>> {
    let mut locks = state
        .executor_locks
        .lock()
        .expect("scraper executor locks mutex");
    locks
        .entry(executor.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

#[cfg(desktop)]
fn scraper_executor_cancel_generation(state: &ScraperState, executor: &str) -> Arc<AtomicU64> {
    let mut generations = state
        .cancel_generations
        .lock()
        .expect("scraper cancel generations mutex");
    generations
        .entry(executor.to_string())
        .or_insert_with(|| Arc::new(AtomicU64::new(0)))
        .clone()
}

#[cfg(desktop)]
fn ensure_executor_generation(
    generation: &AtomicU64,
    expected: u64,
    operation: &str,
    executor: &str,
) -> Result<(), String> {
    if generation.load(Ordering::Acquire) != expected {
        return Err(format!(
            "scraper:{operation}: Request cancelled for executor {executor}"
        ));
    }
    Ok(())
}

#[cfg(desktop)]
async fn wait_for_navigation_completion(
    mut completion: oneshot::Receiver<String>,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
    wait: Duration,
) -> Result<String, String> {
    let started = Instant::now();
    loop {
        ensure_executor_generation(generation, expected_generation, "navigate", executor)?;
        let remaining = wait.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(format!(
                "scraper_navigate: timeout after {}ms",
                wait.as_millis()
            ));
        }
        tokio::select! {
            result = &mut completion => {
                ensure_executor_generation(
                    generation,
                    expected_generation,
                    "navigate",
                    executor,
                )?;
                return result.map_err(|_| {
                    "scraper_navigate: page-load completion dropped".to_string()
                });
            }
            _ = tokio::time::sleep(remaining.min(Duration::from_millis(100))) => {}
        }
    }
}

#[cfg(desktop)]
fn stop_scraper_loading(scraper: &ScraperWebview) {
    let _ = scraper.eval(
        r#"(function () {
  try { window.stop(); } catch (error) {}
})();"#
            .to_string(),
    );
}

#[cfg(desktop)]
fn scraper_label_from_key(key: &str) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    format!("{SCRAPER_LABEL}-{:016x}", hasher.finish())
}

#[cfg(desktop)]
fn scraper_initialization_script() -> String {
    SCRAPER_INIT_SCRIPT.to_string()
}

#[cfg(desktop)]
fn scraper_handle_for_key(
    app: &AppHandle,
    state: &ScraperState,
    key: &str,
    source_id: &str,
    user_agent: Option<&str>,
) -> Result<ScraperWebview, String> {
    let existing_entry = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(key)
        .cloned();
    if let Some(existing_entry) = existing_entry {
        if existing_entry.source_id != source_id {
            close_scraper_webview_for_key(app, state, key, "source profile switch", false)?;
        } else {
            if existing_entry.user_agent.as_deref() != user_agent {
                log::warn!(
                    "[scraper] queue {key} already has a WebView user agent; keeping the existing queue WebView"
                );
            }
            if let Some(webview) = app.get_webview(&existing_entry.label) {
                log_windows_scraper_event("handle_for_key registered webview found");
                return Ok(webview);
            }
            log_windows_scraper_event("handle_for_key registered webview missing");
            state
                .webviews
                .lock()
                .expect("scraper webviews mutex")
                .remove(key);
            #[cfg(target_os = "windows")]
            state
                .resource_capture_handlers
                .lock()
                .expect("scraper resource capture handlers mutex")
                .remove(key);
        }
    }

    let label = scraper_label_from_key(&format!("{key}:{}", source_profile_key(source_id)));
    log::trace!("[scraper] handle_for_key computed key={key} label={label}");
    if let Some(webview) = app.get_webview(&label) {
        log_windows_scraper_event("handle_for_key unregistered webview found");
        state
            .webviews
            .lock()
            .expect("scraper webviews mutex")
            .insert(
                key.to_string(),
                ScraperEntry {
                    label,
                    source_id: source_id.to_string(),
                    user_agent: user_agent.map(str::to_string),
                },
            );
        return Ok(webview);
    }

    log_windows_scraper_event("handle_for_key get main window");
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "scraper: main window missing".to_string())?;
    log_windows_scraper_event("handle_for_key build child webview");
    let app_for_navigation = app.clone();
    #[cfg(target_os = "windows")]
    let key_for_navigation = key.to_string();
    #[cfg(target_os = "windows")]
    let source_id_for_navigation = source_id.to_string();
    let app_for_page_load = app.clone();
    let key_for_page_load = key.to_string();
    let initialization_script = scraper_initialization_script();
    let data_directory = source_profile_data_directory(app, source_id)?;
    #[cfg(target_os = "windows")]
    if let Err(error) =
        crate::webview_resource_capture::remove_legacy_chapter_page_cache(&data_directory)
    {
        log::warn!("[scraper] legacy chapter page cache cleanup skipped: {error}");
    }
    let mut builder = WebviewBuilder::new(
        label.clone(),
        WebviewUrl::App(PathBuf::from(SCRAPER_HOMEPAGE_PATH)),
    )
    .on_navigation(move |url| {
        if let Some(request_id) = scraper_result_request_id(url) {
            let state = app_for_navigation.state::<ScraperState>();
            fire_completion(&state, &request_id);
            return false;
        }
        #[cfg(target_os = "windows")]
        {
            let state = app_for_navigation.state::<ScraperState>();
            begin_visible_user_navigation_resource_capture(
                &state,
                &key_for_navigation,
                &source_id_for_navigation,
            );
        }
        true
    })
    .on_page_load(move |_webview, payload| {
        let state = app_for_page_load.state::<ScraperState>();
        record_navigation_page_load(&state, &key_for_page_load, payload.event(), payload.url());
    })
    .initialization_script(initialization_script)
    .data_directory(data_directory);
    if let Some(user_agent) = user_agent {
        builder = builder.user_agent(user_agent);
    }
    log_windows_scraper_event("handle_for_key add_child start");
    let webview = match main_window.add_child(
        builder,
        LogicalPosition::new(HIDDEN_POSITION, HIDDEN_POSITION),
        LogicalSize::new(HIDDEN_SIZE, HIDDEN_SIZE),
    ) {
        Ok(webview) => webview,
        Err(err) => {
            if let Some(webview) = app.get_webview(&label) {
                log::warn!(
                    "[scraper] add_child raced with an existing WebView for {key}; reusing label {label}: {err}"
                );
                state
                    .webviews
                    .lock()
                    .expect("scraper webviews mutex")
                    .insert(
                        key.to_string(),
                        ScraperEntry {
                            label,
                            source_id: source_id.to_string(),
                            user_agent: user_agent.map(str::to_string),
                        },
                    );
                return Ok(webview);
            }
            return Err(format!("scraper: add_child for {key}: {err}"));
        }
    };
    log_windows_scraper_event("handle_for_key add_child complete");
    webview
        .hide()
        .map_err(|err| format!("scraper: hide after init for {key}: {err}"))?;
    log_windows_scraper_event("handle_for_key initial hide complete");
    state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .insert(
            key.to_string(),
            ScraperEntry {
                label,
                source_id: source_id.to_string(),
                user_agent: user_agent.map(str::to_string),
            },
        );
    log_windows_scraper_event("handle_for_key registered new webview");
    Ok(webview)
}

#[cfg(all(desktop, any(target_os = "windows", test)))]
fn begin_navigation_resource_capture(state: &ScraperState, executor: &str, source_id: &str) -> u64 {
    state
        .captured_resources
        .register_source(executor, source_id);
    state.captured_resources.begin(executor)
}

#[cfg(all(desktop, any(target_os = "windows", test)))]
fn begin_visible_user_navigation_resource_capture(
    state: &ScraperState,
    executor: &str,
    source_id: &str,
) -> Option<u64> {
    let is_visible = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .as_deref()
        == Some(executor);
    if !is_visible
        || state
            .pending_navigations
            .lock()
            .expect("scraper pending navigations mutex")
            .contains_key(executor)
    {
        return None;
    }
    Some(begin_navigation_resource_capture(
        state, executor, source_id,
    ))
}

#[cfg(all(desktop, target_os = "windows"))]
async fn ensure_resource_capture_handler(
    scraper: &ScraperWebview,
    state: &ScraperState,
    executor: &str,
    source_id: &str,
) -> Result<(), String> {
    state
        .captured_resources
        .register_source(executor, source_id);
    if state
        .resource_capture_handlers
        .lock()
        .expect("scraper resource capture handlers mutex")
        .contains(executor)
    {
        return Ok(());
    }
    crate::webview_resource_capture::install_windows_capture(
        scraper,
        executor.to_string(),
        source_id.to_string(),
        Arc::clone(&state.captured_resources),
    )
    .await?;
    state
        .resource_capture_handlers
        .lock()
        .expect("scraper resource capture handlers mutex")
        .insert(executor.to_string());
    Ok(())
}

#[cfg(desktop)]
fn hide_scraper_surface_for_key(
    app: &AppHandle,
    state: &ScraperState,
    key: &str,
) -> Result<bool, String> {
    let mut hidden = false;
    if let Some(webview) = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(key)
        .cloned()
        .and_then(|entry| app.get_webview(&entry.label))
    {
        hide_scraper_webview(&webview)?;
        hidden = true;
    }
    Ok(hidden)
}

#[cfg(desktop)]
fn close_scraper_webview_for_key(
    app: &AppHandle,
    state: &ScraperState,
    key: &str,
    reason: &str,
    preserve_captured_resources: bool,
) -> Result<bool, String> {
    {
        let mut visible_key = state.visible_key.lock().expect("scraper visible_key mutex");
        if visible_key.as_deref() == Some(key) {
            *visible_key = None;
        }
    }
    let entry = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(key)
        .cloned();
    let webview = entry
        .as_ref()
        .and_then(|entry| app.get_webview(&entry.label));
    if let Some(webview) = &webview {
        webview
            .close()
            .map_err(|err| format!("scraper: close {reason} for {key}: {err}"))?;
    }
    state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .remove(key);
    if !preserve_captured_resources {
        state.captured_resources.clear(key);
    }
    #[cfg(target_os = "windows")]
    state
        .resource_capture_handlers
        .lock()
        .expect("scraper resource capture handlers mutex")
        .remove(key);
    Ok(webview.is_some())
}

#[cfg(desktop)]
fn set_webview_bounds(
    webview: &ScraperWebview,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    context: &str,
) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        log::trace!(
            "[scraper:windows] set_webview_bounds context={context} x={x} y={y} width={width} height={height}"
        );
    }
    webview
        .set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width, height).into(),
        })
        .map_err(|err| format!("scraper: set {context} bounds: {err}"))
}

#[cfg(desktop)]
fn hide_scraper_webview(webview: &ScraperWebview) -> Result<(), String> {
    log_windows_scraper_event("hide_scraper_webview start");
    set_webview_bounds(
        webview,
        HIDDEN_POSITION,
        HIDDEN_POSITION,
        HIDDEN_SIZE,
        HIDDEN_SIZE,
        "browser",
    )?;
    webview
        .hide()
        .map_err(|err| format!("scraper: hide: {err}"))?;
    log_windows_scraper_event("hide_scraper_webview complete");
    Ok(())
}

#[cfg(desktop)]
fn show_scraper_webview_for_background_render(webview: &ScraperWebview) -> Result<(), String> {
    log_windows_scraper_event("show_scraper_webview_for_background_render start");
    set_webview_bounds(
        webview,
        HIDDEN_POSITION,
        HIDDEN_POSITION,
        BACKGROUND_RENDER_WIDTH,
        BACKGROUND_RENDER_HEIGHT,
        "background",
    )?;
    webview
        .show()
        .map_err(|err| format!("scraper: show background render surface: {err}"))?;
    log_windows_scraper_event("show_scraper_webview_for_background_render complete");
    Ok(())
}

/// Verify the main window exists. Site scraper WebViews are created
/// lazily per plugin site when fetch or browsing needs them.
#[cfg(desktop)]
pub fn init_scraper(app: &AppHandle) -> Result<(), String> {
    app.get_window("main")
        .ok_or_else(|| "scraper: main window missing at setup".to_string())?;
    Ok(())
}

#[cfg(not(desktop))]
pub fn init_scraper(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

/// Manually open the scraper webview's devtools.
#[cfg(all(debug_assertions, desktop))]
#[tauri::command]
pub fn scraper_open_devtools(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ScraperState>();
    let visible_key = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .clone();
    let label = visible_key
        .as_ref()
        .and_then(|key| {
            state
                .webviews
                .lock()
                .expect("scraper webviews mutex")
                .get(key)
                .map(|entry| entry.label.clone())
        })
        .or_else(|| {
            state
                .webviews
                .lock()
                .expect("scraper webviews mutex")
                .values()
                .next()
                .map(|entry| entry.label.clone())
        })
        .ok_or_else(|| "scraper: no webview available for devtools".to_string())?;
    let scraper = app
        .get_webview(&label)
        .ok_or_else(|| format!("scraper: webview '{label}' missing"))?;
    scraper.open_devtools();
    Ok(())
}

#[cfg(all(debug_assertions, not(desktop)))]
#[tauri::command]
pub fn scraper_open_devtools(_app: AppHandle) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn scraper_open_devtools(_app: AppHandle) -> Result<(), String> {
    Err("devtools only available in debug builds".to_string())
}

/// Reposition and resize the scraper child WebView inside the React overlay.
#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_set_bounds(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    source_id: Option<String>,
    user_agent: Option<String>,
) -> Result<(), String> {
    let user_agent = normalize_user_agent(user_agent);
    let source_id = normalize_source_id(source_id.as_deref())?;
    if cfg!(target_os = "windows") {
        let url_for_log = scraper_url_for_log(&url);
        log::trace!(
            "[scraper:windows] scraper_set_bounds start url={url_for_log} x={x} y={y} width={width} height={height}"
        );
    }
    let executor_lock = scraper_executor_lock(&state, IMMEDIATE_EXECUTOR);
    let _executor_guard = executor_lock.lock().await;
    let key = IMMEDIATE_EXECUTOR.to_string();
    let scraper = scraper_handle_for_key(
        &app,
        &state,
        IMMEDIATE_EXECUTOR,
        &source_id,
        user_agent.as_deref(),
    )?;
    #[cfg(target_os = "windows")]
    {
        ensure_resource_capture_handler(&scraper, &state, IMMEDIATE_EXECUTOR, &source_id).await?;
        state.captured_resources.begin_or_resume(IMMEDIATE_EXECUTOR);
    }
    let previous_key = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .clone();
    if previous_key.as_deref() != Some(key.as_str()) {
        if let Some(previous_key) = previous_key {
            if let Some(previous) = state
                .webviews
                .lock()
                .expect("scraper webviews mutex")
                .get(&previous_key)
                .cloned()
                .and_then(|entry| app.get_webview(&entry.label))
            {
                hide_scraper_webview(&previous)?;
            }
        }
    }
    let safe_x = x.max(0.0);
    let safe_y = y.max(0.0);
    let safe_w = width.max(HIDDEN_SIZE);
    let safe_h = height.max(HIDDEN_SIZE);
    scraper
        .show()
        .map_err(|err| format!("scraper: show: {err}"))?;
    log_windows_scraper_event("scraper_set_bounds show complete");
    set_webview_bounds(&scraper, safe_x, safe_y, safe_w, safe_h, "browser")?;
    *state.visible_key.lock().expect("scraper visible_key mutex") = Some(key);
    log_windows_scraper_event("scraper_set_bounds complete");
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_set_bounds(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
    _source_id: Option<String>,
    _user_agent: Option<String>,
) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Collapse and hide the scraper when the modal closes.
#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_hide(app: AppHandle) -> Result<(), String> {
    log_windows_scraper_event("scraper_hide start");
    let state = app.state::<ScraperState>();
    let visible_key = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .clone();
    let Some(visible_key) = visible_key else {
        log_windows_scraper_event("scraper_hide skipped: no visible key");
        return Ok(());
    };
    let executor_lock = scraper_executor_lock(&state, &visible_key);
    let _executor_guard = executor_lock.lock().await;
    let is_still_visible = {
        let mut current_key = state.visible_key.lock().expect("scraper visible_key mutex");
        if current_key.as_deref() == Some(visible_key.as_str()) {
            *current_key = None;
            true
        } else {
            false
        }
    };
    if !is_still_visible {
        log_windows_scraper_event("scraper_hide skipped: visible key changed");
        return Ok(());
    }
    state.captured_resources.stop(&visible_key);
    let webview = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(&visible_key)
        .cloned()
        .and_then(|entry| app.get_webview(&entry.label));
    *state
        .last_navigated
        .lock()
        .expect("scraper last_navigated mutex") = None;
    if !hide_scraper_surface_for_key(&app, &state, &visible_key)? {
        log_windows_scraper_event("scraper_hide skipped: visible webview missing");
    }
    if let Some(webview) = webview {
        stop_scraper_loading(&webview);
        let blank_url = Url::parse(SCRAPER_BLANK_URL)
            .map_err(|error| format!("scraper_hide: parse blank url: {error}"))?;
        let request_id = FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let completion = register_navigation(&state, &visible_key, request_id, SCRAPER_BLANK_URL);
        let _navigation_guard = NavigationGuard {
            state: state.inner(),
            executor: visible_key.clone(),
            request_id,
        };
        if let Err(error) = webview
            .navigate(blank_url)
            .map_err(|error| format!("scraper_hide: navigate to blank page: {error}"))
        {
            close_scraper_webview_for_key(
                &app,
                &state,
                &visible_key,
                "after blank navigation failure",
                true,
            )?;
            return Err(error);
        }
        if let Err(error) = wait_for_hidden_blank_page(completion).await {
            stop_scraper_loading(&webview);
            close_scraper_webview_for_key(
                &app,
                &state,
                &visible_key,
                "after blank navigation wait failure",
                true,
            )?;
            return Err(error);
        }
    }
    log_windows_scraper_event("scraper_hide complete");
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_hide(_app: AppHandle) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[cfg(desktop)]
fn browser_http_origin(url: &Url) -> Option<String> {
    matches!(url.scheme(), "http" | "https").then(|| url.origin().ascii_serialization())
}

fn scraper_url_for_log(value: &str) -> String {
    if let Ok(parsed) = Url::parse(value) {
        if matches!(parsed.scheme(), "http" | "https") {
            return parsed.origin().ascii_serialization();
        }
        return format!("<{}-url>", parsed.scheme());
    }
    if value.split_once("://").is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    }) {
        return "<http-url>".to_string();
    }

    let secret_boundary = [value.find('?'), value.find('#')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(value.len());
    let without_secrets = &value[..secret_boundary];
    let Some(scheme_end) = without_secrets.find("://") else {
        return without_secrets.to_string();
    };
    let authority_start = scheme_end + 3;
    let authority_and_path = &without_secrets[authority_start..];
    let authority_end = authority_and_path
        .find('/')
        .unwrap_or(authority_and_path.len());
    let authority = &authority_and_path[..authority_end];
    let Some(userinfo_end) = authority.rfind('@') else {
        return without_secrets.to_string();
    };
    format!(
        "{}{}{}",
        &without_secrets[..authority_start],
        &authority[userinfo_end + 1..],
        &authority_and_path[authority_end..]
    )
}

fn redact_urls_for_log(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;

    loop {
        let start = remaining.char_indices().find_map(|(index, _)| {
            let candidate = &remaining[index..];
            ["http://", "https://"]
                .into_iter()
                .any(|prefix| {
                    candidate
                        .get(..prefix.len())
                        .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
                })
                .then_some(index)
        });
        let Some(start) = start else {
            output.push_str(remaining);
            break;
        };

        output.push_str(&remaining[..start]);
        let candidate = &remaining[start..];
        let end = candidate
            .char_indices()
            .skip(1)
            .find_map(|(index, character)| {
                (character.is_whitespace()
                    || matches!(character, '"' | '\'' | '<' | '>' | ')' | ']' | '}'))
                .then_some(index)
            })
            .unwrap_or(candidate.len());
        output.push_str(&scraper_url_for_log(&candidate[..end]));
        remaining = &candidate[end..];
    }

    output
}

/// Return the visible native WebView's current HTTP(S) origin.
#[cfg(desktop)]
#[tauri::command]
pub fn scraper_current_origin(
    app: AppHandle,
    source_id: Option<String>,
) -> Result<Option<String>, String> {
    let source_id = normalize_source_id(source_id.as_deref())?;
    let state = app.state::<ScraperState>();
    let visible_key = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .clone();
    let Some(visible_key) = visible_key else {
        return Ok(None);
    };
    let Some(entry) = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(&visible_key)
        .cloned()
    else {
        return Ok(None);
    };
    if entry.source_id != source_id {
        return Ok(None);
    }
    let Some(scraper) = app.get_webview(&entry.label) else {
        return Ok(None);
    };
    let url = scraper
        .url()
        .map_err(|err| format!("scraper_current_origin: read current url: {err}"))?;
    Ok(browser_http_origin(&url))
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn scraper_current_origin(
    _app: AppHandle,
    _source_id: Option<String>,
) -> Result<Option<String>, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Await completion of one WebView2 profile disk-cache clear operation.
#[cfg(all(desktop, any(target_os = "windows", test)))]
async fn await_cache_clear_completion(
    receiver: oneshot::Receiver<Result<(), String>>,
    wait: Duration,
) -> Result<(), String> {
    timeout(wait, receiver)
        .await
        .map_err(|_| "scraper_clear_cache: WebView2 callback timed out".to_string())?
        .map_err(|_| "scraper_clear_cache: WebView2 callback dropped".to_string())?
}

#[cfg(all(desktop, target_os = "windows"))]
async fn clear_windows_disk_cache(webview: &ScraperWebview) -> Result<(), String> {
    let (sender, receiver) = oneshot::channel::<Result<(), String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let sender_for_start = Arc::clone(&sender);

    webview
        .with_webview(move |platform_webview| {
            let sender_for_callback = Arc::clone(&sender_for_start);
            let start_result = (|| -> windows::core::Result<()> {
                let core = unsafe { platform_webview.controller().CoreWebView2()? };
                let core = core.cast::<ICoreWebView2_13>()?;
                let profile = unsafe { core.Profile()? }.cast::<ICoreWebView2Profile2>()?;
                let handler =
                    ClearBrowsingDataCompletedHandler::create(Box::new(move |error_code| {
                        let result = error_code.map_err(|error| {
                            format!(
                                "scraper_clear_cache: WebView2 disk cache callback failed: {error}"
                            )
                        });
                        if let Ok(mut sender) = sender_for_callback.lock() {
                            if let Some(sender) = sender.take() {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(())
                    }));
                unsafe {
                    profile
                        .ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &handler)?;
                }
                Ok(())
            })();
            if let Err(error) = start_result {
                if let Ok(mut sender) = sender_for_start.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(format!(
                            "scraper_clear_cache: start WebView2 disk cache clear: {error}"
                        )));
                    }
                }
            }
        })
        .map_err(|error| format!("scraper_clear_cache: dispatch WebView2 cache clear: {error}"))?;

    await_cache_clear_completion(receiver, SCRAPER_CACHE_CLEAR_TIMEOUT).await
}

#[cfg(all(desktop, target_os = "windows"))]
fn temporary_cache_clear_webview(
    app: &AppHandle,
    data_directory: &Path,
) -> Result<ScraperWebview, String> {
    let main_window = app
        .get_window("main")
        .ok_or_else(|| "scraper_clear_cache: main window missing".to_string())?;
    let blank_url = Url::parse("about:blank")
        .map_err(|error| format!("scraper_clear_cache: parse blank url: {error}"))?;
    let label = format!(
        "{SCRAPER_LABEL}-cache-clear-{}",
        FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let builder = WebviewBuilder::new(label, WebviewUrl::External(blank_url))
        .data_directory(data_directory.to_path_buf());
    let webview = main_window
        .add_child(
            builder,
            LogicalPosition::new(HIDDEN_POSITION, HIDDEN_POSITION),
            LogicalSize::new(HIDDEN_SIZE, HIDDEN_SIZE),
        )
        .map_err(|error| {
            format!(
                "scraper_clear_cache: create temporary WebView for '{}': {error}",
                data_directory.display()
            )
        })?;
    if let Err(error) = webview.hide() {
        let _ = webview.close();
        return Err(format!(
            "scraper_clear_cache: hide temporary WebView for '{}': {error}",
            data_directory.display()
        ));
    }
    Ok(webview)
}

#[cfg(all(desktop, target_os = "windows"))]
async fn clear_windows_source_profile_cache(
    app: &AppHandle,
    data_directory: &Path,
    live_webview: Option<ScraperWebview>,
) -> Result<(), String> {
    let temporary = live_webview.is_none();
    let webview = match live_webview {
        Some(webview) => webview,
        None => temporary_cache_clear_webview(app, data_directory)?,
    };
    let clear_result = clear_windows_disk_cache(&webview).await;
    let close_result = if temporary {
        webview.close().map_err(|error| {
            format!(
                "scraper_clear_cache: close temporary WebView for '{}': {error}",
                data_directory.display()
            )
        })
    } else {
        Ok(())
    };
    match (clear_result, close_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(clear_error), Ok(())) => Err(clear_error),
        (Ok(()), Err(close_error)) => Err(close_error),
        (Err(clear_error), Err(close_error)) => Err(format!("{clear_error}; {close_error}")),
    }
}

#[cfg(all(desktop, target_os = "windows"))]
#[tauri::command]
pub async fn scraper_clear_cache(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
) -> Result<(), String> {
    let profile_root = source_profiles_data_directory(&app)?;
    let mut errors = Vec::new();
    let mut executor_keys = state
        .executor_locks
        .lock()
        .expect("scraper executor locks mutex")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    executor_keys.extend(
        state
            .webviews
            .lock()
            .expect("scraper webviews mutex")
            .keys()
            .cloned(),
    );
    executor_keys.sort_unstable();
    executor_keys.dedup();
    let executor_locks = executor_keys
        .iter()
        .map(|key| scraper_executor_lock(&state, key))
        .collect::<Vec<_>>();
    let mut _executor_guards = Vec::with_capacity(executor_locks.len());
    for lock in executor_locks {
        _executor_guards.push(lock.lock_owned().await);
    }
    let live_keys = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for key in live_keys {
        state.captured_resources.stop(&key);
        if let Err(error) =
            close_scraper_webview_for_key(&app, &state, &key, "for cache clear", true)
        {
            errors.push(error);
        }
    }
    let profiles = match source_profile_directories(&profile_root) {
        Ok(profiles) => profiles,
        Err(error) => {
            errors.push(error);
            Vec::new()
        }
    };
    for profile in &profiles {
        if let Err(error) = clear_windows_source_profile_cache(&app, profile, None).await {
            errors.push(error);
        }
        if let Err(error) =
            crate::webview_resource_capture::remove_legacy_chapter_page_cache(profile)
        {
            errors.push(error);
        }
    }
    state.captured_resources.clear_all();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(not(all(desktop, target_os = "windows")))]
#[tauri::command]
pub async fn scraper_clear_cache(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
) -> Result<(), String> {
    Err("scraper_clear_cache is only available on Windows".to_string())
}

/// Delete cookies available to one plugin URL from its isolated scraper profile.
#[cfg(all(desktop, any(target_os = "windows", test)))]
async fn await_cookie_clear_completion(
    receiver: oneshot::Receiver<Result<usize, String>>,
    wait: Duration,
) -> Result<usize, String> {
    timeout(wait, receiver)
        .await
        .map_err(|_| "scraper_clear_cookies: WebView2 cookie callback timed out".to_string())?
        .map_err(|_| "scraper_clear_cookies: WebView2 cookie callback dropped".to_string())?
}

#[cfg(all(desktop, target_os = "windows"))]
async fn clear_windows_cookies_for_url(
    webview: &ScraperWebview,
    url: &Url,
) -> Result<usize, String> {
    let (sender, receiver) = oneshot::channel::<Result<usize, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let sender_for_start = Arc::clone(&sender);
    let uri = HSTRING::from(url.as_str());

    webview
        .with_webview(move |platform_webview| {
            let sender_for_callback = Arc::clone(&sender_for_start);
            let start_result = (|| -> windows::core::Result<()> {
                let core = unsafe { platform_webview.controller().CoreWebView2()? };
                let core = core.cast::<ICoreWebView2_2>()?;
                let cookie_manager = unsafe { core.CookieManager()? };
                let callback_cookie_manager = cookie_manager.clone();
                let handler = GetCookiesCompletedHandler::create(Box::new(
                    move |error_code, cookies| {
                        let result = (|| -> Result<usize, String> {
                            error_code.map_err(|error| {
                                format!(
                                    "scraper_clear_cookies: WebView2 cookie query failed: {error}"
                                )
                            })?;
                            let cookies = cookies.ok_or_else(|| {
                                "scraper_clear_cookies: WebView2 returned no cookie list"
                                    .to_string()
                            })?;
                            let mut count = 0;
                            unsafe {
                                cookies.Count(&mut count).map_err(|error| {
                                    format!(
                                        "scraper_clear_cookies: read WebView2 cookie count: {error}"
                                    )
                                })?;
                                for index in 0..count {
                                    let cookie =
                                        cookies.GetValueAtIndex(index).map_err(|error| {
                                            format!(
                                                "scraper_clear_cookies: read WebView2 cookie: {error}"
                                            )
                                        })?;
                                    callback_cookie_manager
                                        .DeleteCookie(&cookie)
                                        .map_err(|error| {
                                            format!(
                                                "scraper_clear_cookies: delete WebView2 cookie: {error}"
                                            )
                                        })?;
                                }
                            }
                            Ok(count as usize)
                        })();
                        if let Ok(mut sender) = sender_for_callback.lock() {
                            if let Some(sender) = sender.take() {
                                let _ = sender.send(result);
                            }
                        }
                        Ok(())
                    },
                ));
                unsafe {
                    cookie_manager.GetCookies(PCWSTR::from_raw(uri.as_ptr()), &handler)?;
                }
                Ok(())
            })();
            if let Err(error) = start_result {
                if let Ok(mut sender) = sender_for_start.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(format!(
                            "scraper_clear_cookies: start WebView2 cookie query: {error}"
                        )));
                    }
                }
            }
        })
        .map_err(|error| format!("scraper_clear_cookies: dispatch WebView2 query: {error}"))?;

    await_cookie_clear_completion(receiver, SCRAPER_COOKIE_CLEAR_TIMEOUT).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_clear_cookies(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    url: String,
    source_id: Option<String>,
    user_agent: Option<String>,
    queue: Option<String>,
) -> Result<usize, String> {
    let url_for_log = scraper_url_for_log(&url);
    let parsed: Url = url
        .parse()
        .map_err(|err| format!("scraper_clear_cookies: invalid url '{url_for_log}': {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(format!(
            "scraper_clear_cookies: expected an HTTP(S) plugin url, got '{url_for_log}'"
        ));
    }

    let source_id = normalize_source_id(source_id.as_deref())?;
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let executor_lock = scraper_executor_lock(&state, &queue);
    let _executor_guard = timeout(SCRAPER_COOKIE_CLEAR_TIMEOUT, executor_lock.lock())
        .await
        .map_err(|_| "scraper_clear_cookies: scraper executor lock timed out".to_string())?;

    let user_agent = normalize_user_agent(user_agent);
    let scraper = scraper_handle_for_key(&app, &state, &queue, &source_id, user_agent.as_deref())?;

    #[cfg(target_os = "windows")]
    {
        clear_windows_cookies_for_url(&scraper, &parsed).await
    }

    #[cfg(not(target_os = "windows"))]
    {
        let cookies = scraper.cookies_for_url(parsed).map_err(|err| {
            format!("scraper_clear_cookies: read cookies for '{url_for_log}': {err}")
        })?;
        let count = cookies.len();
        for cookie in cookies {
            scraper.delete_cookie(cookie).map_err(|err| {
                format!("scraper_clear_cookies: delete cookie for '{url_for_log}': {err}")
            })?;
        }
        Ok(count)
    }
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_clear_cookies(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _queue: Option<String>,
) -> Result<usize, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Navigate the scraper Webview to `url`. Used by the in-app site
/// browser overlay so the user can log in / clear CF / interact
/// before sending plugin scrape requests.
#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_navigate(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    url: String,
    source_id: Option<String>,
    user_agent: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let user_agent = normalize_user_agent(user_agent);
    let source_id = normalize_source_id(source_id.as_deref())?;
    let request_timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).max(1));
    let request_started = Instant::now();
    let generation = scraper_executor_cancel_generation(&state, IMMEDIATE_EXECUTOR);
    let expected_generation = generation.load(Ordering::Acquire);
    let url_for_log = scraper_url_for_log(&url);
    if cfg!(target_os = "windows") {
        log::trace!(
            "[scraper:windows] scraper_navigate start url={url_for_log} timeout_ms={} ",
            request_timeout.as_millis(),
        );
    }
    let executor_lock = scraper_executor_lock(&state, IMMEDIATE_EXECUTOR);
    let _executor_guard = timeout(request_timeout, executor_lock.lock())
        .await
        .map_err(|_| {
            format!(
                "scraper_navigate: timeout waiting for executor after {}ms",
                request_timeout.as_millis()
            )
        })?;
    ensure_executor_generation(
        &generation,
        expected_generation,
        "navigate",
        IMMEDIATE_EXECUTOR,
    )?;
    let scraper = scraper_handle_for_key(
        &app,
        &state,
        IMMEDIATE_EXECUTOR,
        &source_id,
        user_agent.as_deref(),
    )?;
    #[cfg(target_os = "windows")]
    {
        ensure_resource_capture_handler(&scraper, &state, IMMEDIATE_EXECUTOR, &source_id).await?;
        begin_navigation_resource_capture(&state, IMMEDIATE_EXECUTOR, &source_id);
    }
    let parsed: Url = url
        .parse()
        .map_err(|err| format!("scraper_navigate: invalid url '{url_for_log}': {err}"))?;

    let ready_budget = request_timeout
        .saturating_sub(request_started.elapsed())
        .min(Duration::from_secs(5));
    if ready_budget.is_zero()
        || !wait_for_scraper_bridge_ready(
            &scraper,
            "navigate",
            ready_budget,
            &generation,
            expected_generation,
            IMMEDIATE_EXECUTOR,
        )
        .await?
    {
        stop_scraper_loading(&scraper);
        return Err(format!(
            "scraper_navigate: scraper bridge was not ready within {}ms",
            request_timeout.as_millis()
        ));
    }
    ensure_executor_generation(
        &generation,
        expected_generation,
        "navigate",
        IMMEDIATE_EXECUTOR,
    )?;

    let request_id = FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let completion = register_navigation(&state, IMMEDIATE_EXECUTOR, request_id, &url);
    let _navigation_guard = NavigationGuard {
        state: state.inner(),
        executor: IMMEDIATE_EXECUTOR.to_string(),
        request_id,
    };
    if let Err(err) = scraper.navigate(parsed) {
        return Err(format!(
            "scraper_navigate: {}",
            redact_urls_for_log(&err.to_string())
        ));
    }

    let remaining = request_timeout.saturating_sub(request_started.elapsed());
    let final_url = match wait_for_navigation_completion(
        completion,
        &generation,
        expected_generation,
        IMMEDIATE_EXECUTOR,
        remaining,
    )
    .await
    {
        Ok(final_url) => final_url,
        Err(err) => {
            stop_scraper_loading(&scraper);
            return Err(err);
        }
    };
    ensure_executor_generation(
        &generation,
        expected_generation,
        "navigate",
        IMMEDIATE_EXECUTOR,
    )?;
    let ready_budget = request_timeout.saturating_sub(request_started.elapsed());
    let document_ready = if ready_budget.is_zero() {
        false
    } else {
        timeout(ready_budget, document_is_ready(&scraper))
            .await
            .unwrap_or(false)
    };
    if !document_ready {
        stop_scraper_loading(&scraper);
        return Err(format!(
            "scraper_navigate: page finished without a ready document: {}",
            scraper_url_for_log(&final_url)
        ));
    }
    *state
        .last_navigated
        .lock()
        .expect("scraper last_navigated mutex") = Some(final_url);
    log_windows_scraper_event("scraper_navigate complete");
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn scraper_navigate(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    url: String,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _timeout_ms: Option<u64>,
) -> Result<(), String> {
    let _ = url;
    Err("scraper_navigate is handled by the Android native scraper bridge".to_string())
}

#[cfg(not(any(desktop, target_os = "android")))]
#[tauri::command]
pub async fn scraper_navigate(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _timeout_ms: Option<u64>,
) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[cfg(desktop)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebviewFetchScriptResult {
    ok: bool,
    status: Option<u16>,
    status_text: Option<String>,
    body_base64: Option<String>,
    headers: Option<HashMap<String, String>>,
    final_url: Option<String>,
    error: Option<String>,
}

#[cfg(desktop)]
async fn eval_json<T: DeserializeOwned>(
    scraper: &ScraperWebview,
    script: String,
) -> Result<T, String> {
    let (tx, rx) = oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let sender_for_callback = Arc::clone(&sender);

    scraper
        .eval_with_callback(script, move |payload| {
            if let Ok(mut guard) = sender_for_callback.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(payload);
                }
            }
        })
        .map_err(|err| format!("scraper: eval browser fetch script: {err}"))?;

    let payload = timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "scraper: eval browser fetch script timed out".to_string())?
        .map_err(|_| "scraper: eval browser fetch callback dropped".to_string())?;

    match serde_json::from_str::<T>(&payload) {
        Ok(value) => Ok(value),
        Err(first_err) => {
            let inner = serde_json::from_str::<String>(&payload)
                .map_err(|_| format!("scraper: eval returned invalid JSON: {first_err}"))?;
            serde_json::from_str::<T>(&inner)
                .map_err(|err| format!("scraper: eval returned invalid nested JSON: {err}"))
        }
    }
}

#[cfg(desktop)]
fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

#[cfg(all(desktop, target_os = "windows"))]
fn scraper_current_url_for_log(_scraper: &ScraperWebview) -> String {
    "<native_url_read_disabled_on_windows>".to_string()
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn scraper_current_url_for_log(scraper: &ScraperWebview) -> String {
    scraper
        .url()
        .map(|url| scraper_url_for_log(url.as_str()))
        .unwrap_or_else(|err| format!("<unavailable: {err}>"))
}

fn fetch_init_for_log(init: &Option<FetchInit>) -> String {
    let Some(init) = init else {
        return "none".to_string();
    };
    let header_names: Vec<&String> = init
        .headers
        .as_ref()
        .map(|headers| headers.keys().collect())
        .unwrap_or_default();
    format!(
        "method={:?} header_names={:?} body_len={}",
        init.method.as_deref(),
        header_names,
        init.body.as_ref().map(|body| body.len()).unwrap_or(0)
    )
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);

        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}

#[cfg(any(test, target_os = "windows"))]
fn decode_base64(value: &str) -> Option<Vec<u8>> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bytes = value.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut decoded = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let first = sextet(chunk[0])?;
        let second = sextet(chunk[1])?;
        decoded.push((first << 2) | (second >> 4));
        if chunk[2] == b'=' {
            if !last || chunk[3] != b'=' {
                return None;
            }
            continue;
        }
        let third = sextet(chunk[2])?;
        decoded.push((second << 4) | (third >> 2));
        if chunk[3] == b'=' {
            if !last {
                return None;
            }
            continue;
        }
        let fourth = sextet(chunk[3])?;
        decoded.push((third << 6) | fourth);
    }
    Some(decoded)
}

#[cfg(desktop)]
fn log_scraper_cookies(
    _scraper: &ScraperWebview,
    _queue: &str,
    _context: &str,
    _urls: Vec<(&'static str, String)>,
) {
}

#[cfg(desktop)]
fn scraper_is_at_origin(scraper: &ScraperWebview, target: &Url) -> bool {
    scraper
        .url()
        .map(|current| same_origin(&current, target))
        .unwrap_or(false)
}

#[cfg(desktop)]
async fn document_is_ready(scraper: &ScraperWebview) -> bool {
    let ready = eval_json::<String>(
        scraper,
        r#"(function () { return document.readyState || "loading"; })()"#.to_string(),
    )
    .await;
    matches!(ready.as_deref(), Ok("interactive" | "complete"))
}

#[cfg(desktop)]
async fn scraper_bridge_is_ready(scraper: &ScraperWebview) -> bool {
    let ready = eval_json::<bool>(
        scraper,
        r#"(function () {
  return !!(window.ReactNativeWebView &&
    typeof window.ReactNativeWebView.postMessage === "function");
})()"#
            .to_string(),
    )
    .await;
    ready.unwrap_or(false)
}

/// Exponential backoff for the readiness/challenge poll loops, capped so a long
/// wait emits far fewer main-thread evals than a fixed short interval.
#[cfg(desktop)]
fn next_poll_backoff(current: Duration, cap: Duration) -> Duration {
    (current * 2).min(cap)
}

#[cfg(desktop)]
async fn wait_for_scraper_bridge_ready(
    scraper: &ScraperWebview,
    operation: &str,
    timeout: Duration,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
) -> Result<bool, String> {
    let started = Instant::now();
    let mut poll_interval = Duration::from_millis(100);
    let max_poll_interval = Duration::from_millis(500);

    while started.elapsed() < timeout {
        ensure_executor_generation(generation, expected_generation, operation, executor)?;
        if scraper_bridge_is_ready(scraper).await {
            return Ok(true);
        }
        ensure_executor_generation(generation, expected_generation, operation, executor)?;
        tokio::time::sleep(poll_interval).await;
        poll_interval = next_poll_backoff(poll_interval, max_poll_interval);
    }

    log::debug!("[scraper:{operation}] bridge readiness wait timed out");
    Ok(false)
}

#[cfg(desktop)]
const BROWSER_CHALLENGE_DETECTOR_SCRIPT: &str = r##"(function () {
  var title = (document.title || "").toLowerCase();
  var body = ((document.body && document.body.innerText) || "").toLowerCase();
  if (body.length > 12000) body = body.slice(0, 12000);
  var selectors = [
    "#challenge-running",
    "#cf-challenge-running",
    "#challenge-stage",
    "form#challenge-form",
    ".cf-browser-verification",
    ".cf-turnstile",
    "iframe[src*=\"challenges.cloudflare.com\"]"
  ];
  function isVisibleChallengeElement(element) {
    if (!element || typeof element.getClientRects !== "function") return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    try {
      var style = getComputedStyle(element);
      if (style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number(style.opacity) === 0) {
        return false;
      }
    } catch (_) {}
    var rects = element.getClientRects();
    for (var rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
      if (Number(rects[rectIndex].width) > 0 &&
          Number(rects[rectIndex].height) > 0) {
        return true;
      }
    }
    return false;
  }
  for (var i = 0; i < selectors.length; i += 1) {
    var elements = document.querySelectorAll(selectors[i]);
    for (var elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
      if (isVisibleChallengeElement(elements[elementIndex])) return true;
    }
  }
  var hasCloudflareEvidence = !!document.querySelector(
    "script[src*='/cdn-cgi/challenge-platform/']," +
    "link[href*='/cdn-cgi/challenge-platform/']," +
    "[data-ray],#cf-error-details"
  ) || /cloudflare ray id|\bcf-ray\b|\bcf-chl\b/.test(body);
  var hasChallengeText =
    /just a moment|attention required/.test(title) ||
    /checking if the site connection is secure|verify you are human|enable javascript and cookies to continue|sorry, you have been blocked/.test(body);
  return hasCloudflareEvidence && hasChallengeText;
})()"##;

#[cfg(desktop)]
async fn document_has_browser_challenge(scraper: &ScraperWebview) -> bool {
    let challenged =
        eval_json::<bool>(scraper, BROWSER_CHALLENGE_DETECTOR_SCRIPT.to_string()).await;
    challenged.unwrap_or(false)
}

#[cfg(desktop)]
fn looks_like_browser_challenge_extract_result(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("cloudflare challenge")
        || lower.contains("\"kind\":\"cf\"")
        || lower.contains("\"kind\": \"cf\"")
        || lower.contains("\"kind\":\"cloudflare\"")
        || lower.contains("\"kind\": \"cloudflare\"")
}

#[cfg(desktop)]
fn browser_challenge_envelope(kind: &str, url: &str) -> String {
    serde_json::json!({
        "ok": false,
        "code": "manual-action-required",
        "error": "The source page requires manual action.",
        "challenge": {
            "kind": kind,
            "url": url,
        },
    })
    .to_string()
}

#[cfg(desktop)]
fn browser_challenge_url(scraper: &ScraperWebview, fallback: &str) -> String {
    scraper
        .url()
        .map(|url| url.to_string())
        .unwrap_or_else(|_| fallback.to_string())
}

#[cfg(desktop)]
async fn wait_for_browser_challenge_to_clear(
    scraper: &ScraperWebview,
    operation: &str,
    url: &str,
    timeout: Duration,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
) -> Result<bool, String> {
    let url_for_log = scraper_url_for_log(url);
    let started = Instant::now();
    let mut poll_interval = Duration::from_millis(250);
    let max_poll_interval = Duration::from_millis(1000);
    let mut challenge_logged = false;

    while started.elapsed() < timeout {
        ensure_executor_generation(generation, expected_generation, operation, executor)?;
        tokio::time::sleep(poll_interval).await;
        poll_interval = next_poll_backoff(poll_interval, max_poll_interval);
        if !document_is_ready(scraper).await {
            continue;
        }
        if document_has_browser_challenge(scraper).await {
            if !challenge_logged {
                log::debug!(
                    "[scraper:{operation}] waiting browser challenge before retry url={url_for_log}"
                );
                challenge_logged = true;
            }
            continue;
        }
        return Ok(true);
    }

    Ok(false)
}

#[cfg(desktop)]
async fn prepare_scraper_context(
    scraper: &ScraperWebview,
    context_url: Option<&str>,
    operation: &str,
    wait_for_browser_challenge: bool,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
) -> Result<(), String> {
    ensure_executor_generation(generation, expected_generation, operation, executor)?;
    let Some(context_url) = context_url else {
        return Ok(());
    };
    let context_url_for_log = scraper_url_for_log(context_url);
    let target: Url = context_url.parse().map_err(|err| {
        format!("scraper: invalid {operation} context url '{context_url_for_log}': {err}")
    })?;

    if scraper_is_at_origin(scraper, &target)
        && document_is_ready(scraper).await
        && (!wait_for_browser_challenge || !document_has_browser_challenge(scraper).await)
    {
        return Ok(());
    }

    log::debug!("[scraper:{operation}] prepare context navigate url={context_url_for_log}");
    scraper.navigate(target.clone()).map_err(|err| {
        format!(
            "scraper: navigate {operation} context: {}",
            redact_urls_for_log(&err.to_string())
        )
    })?;

    let deadline = Duration::from_secs(15);
    let mut poll_interval = Duration::from_millis(150);
    let max_poll_interval = Duration::from_millis(750);
    let started = Instant::now();
    let mut challenge_logged = false;

    while started.elapsed() < deadline {
        ensure_executor_generation(generation, expected_generation, operation, executor)?;
        tokio::time::sleep(poll_interval).await;
        poll_interval = next_poll_backoff(poll_interval, max_poll_interval);
        if scraper_is_at_origin(scraper, &target) && document_is_ready(scraper).await {
            if wait_for_browser_challenge && document_has_browser_challenge(scraper).await {
                if !challenge_logged {
                    log::debug!(
                        "[scraper:{operation}] prepare context waiting browser challenge url={context_url_for_log}"
                    );
                    challenge_logged = true;
                }
                continue;
            }
            log::debug!("[scraper:{operation}] prepare context ready url={context_url_for_log}");
            return Ok(());
        }
    }

    Err(format!(
        "scraper: timed out preparing {operation} context {context_url_for_log}"
    ))
}

#[cfg(desktop)]
fn origin_url(url: &Url) -> String {
    let host = url.host_str().unwrap_or("local");
    match url.port() {
        Some(port) => format!("{}://{}:{}/", url.scheme(), host, port),
        None => format!("{}://{}/", url.scheme(), host),
    }
}

#[cfg(desktop)]
fn reset_extract_navigation(
    scraper: &ScraperWebview,
    target: &Url,
    operation: &str,
) -> Result<(), String> {
    if !matches!(target.scheme(), "http" | "https") {
        return Ok(());
    }
    let context_url = origin_url(target);
    let context: Url = context_url
        .parse()
        .map_err(|err| format!("scraper: invalid {operation} reset url '{context_url}': {err}"))?;
    log::debug!("[scraper:{operation}] reset context navigate url={context_url}");
    scraper.navigate(context).map_err(|err| {
        format!(
            "scraper: reset {operation} context: {}",
            redact_urls_for_log(&err.to_string())
        )
    })
}

#[cfg(desktop)]
async fn prepare_fetch_context(
    scraper: &ScraperWebview,
    context_url: Option<&str>,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
) -> Result<(), String> {
    prepare_scraper_context(
        scraper,
        context_url,
        "fetch",
        false,
        generation,
        expected_generation,
        executor,
    )
    .await
}

#[cfg(desktop)]
async fn prepare_extract_context(
    scraper: &ScraperWebview,
    target: &Url,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
) -> Result<(), String> {
    if !matches!(target.scheme(), "http" | "https") {
        return Ok(());
    }
    let context_url = origin_url(target);
    prepare_scraper_context(
        scraper,
        Some(&context_url),
        "extract",
        true,
        generation,
        expected_generation,
        executor,
    )
    .await
}

#[cfg(desktop)]
fn fetch_context_urls(url: &str, context_url: Option<&str>) -> Result<Vec<String>, String> {
    let url_for_log = scraper_url_for_log(url);
    let request_url: Url = url
        .parse()
        .map_err(|err| format!("scraper: invalid fetch url '{url_for_log}': {err}"))?;
    let Some(context_url) = context_url else {
        return Ok(vec![origin_url(&request_url)]);
    };
    let parsed_context_url: Url = context_url.parse().map_err(|err| {
        format!(
            "scraper: invalid context url '{}': {err}",
            scraper_url_for_log(context_url)
        )
    })?;
    if same_origin(&request_url, &parsed_context_url) {
        return Ok(vec![context_url.to_string()]);
    }
    let mut contexts = vec![origin_url(&request_url)];
    if !contexts.iter().any(|candidate| candidate == context_url) {
        contexts.push(context_url.to_string());
    }
    Ok(contexts)
}

#[cfg(desktop)]
fn build_webview_fetch_start_script(
    request_id: &str,
    url: &str,
    init: &FetchInit,
) -> Result<String, String> {
    let request_json = serde_json::to_string(&serde_json::json!({
        "url": url,
        "init": init,
    }))
    .map_err(|err| format!("scraper: serialize fetch request: {err}"))?;
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("scraper: serialize fetch request id: {err}"))?;

    Ok(format!(
        r#"(function () {{
  const request = {request_json};
  const requestId = {request_id_json};
  const blockedHeaders = new Set([
    "accept-charset", "accept-encoding", "access-control-request-headers",
    "access-control-request-method", "connection", "content-length", "cookie",
    "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin",
    "referer", "te", "trailer", "transfer-encoding", "upgrade", "via",
    "user-agent"
  ]);
  const init = request.init || {{}};
  const controllers = window.__lnrFetchControllers || (window.__lnrFetchControllers = {{}});
  const controller = new AbortController();
  controllers[requestId] = controller;
  const headers = new Headers();
  for (const key of Object.keys(init.headers || {{}})) {{
    if (!blockedHeaders.has(key.toLowerCase())) {{
      headers.set(key, String(init.headers[key]));
    }}
  }}
  window.__lnrFetchResults = window.__lnrFetchResults || {{}};
  window.__lnrFetchResults[requestId] = {{ done: false }};
  (async function () {{
    try {{
      const fetchInit = {{
        method: init.method || "GET",
        headers,
        credentials: "include",
        redirect: "follow",
        signal: controller.signal
      }};
      if (init.body !== undefined && init.body !== null) {{
        fetchInit.body = init.body;
      }}
      const response = await fetch(request.url, fetchInit);
      const responseHeaders = {{}};
      response.headers.forEach(function (value, key) {{
        responseHeaders[key] = value;
      }});
      const responseBytes = new Uint8Array(await response.arrayBuffer());
      const responseChunks = [];
      const chunkSize = 0x8000;
      for (let offset = 0; offset < responseBytes.length; offset += chunkSize) {{
        const chunk = responseBytes.subarray(offset, offset + chunkSize);
        responseChunks.push(String.fromCharCode.apply(null, Array.from(chunk)));
      }}
      const bodyBase64 = btoa(responseChunks.join(""));
      window.__lnrFetchResults[requestId] = {{
        done: true,
        ok: true,
        status: response.status,
        statusText: response.statusText || "",
        bodyBase64,
        headers: responseHeaders,
        finalUrl: response.url || request.url
      }};
    }} catch (error) {{
      window.__lnrFetchResults[requestId] = {{
        done: true,
        ok: false,
        error: (error && (error.message || error.toString())) || String(error)
      }};
    }} finally {{
      try {{
        delete window.__lnrFetchControllers[requestId];
      }} catch (error) {{}}
      try {{
        location.href = "https://norea.localhost/__norea_scraper_result__/" +
          encodeURIComponent(requestId);
      }} catch (error) {{}}
    }}
  }})();
}})();"#
    ))
}

#[cfg(desktop)]
fn build_webview_fetch_poll_script(request_id: &str) -> Result<String, String> {
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("scraper: serialize fetch request id: {err}"))?;
    Ok(format!(
        r#"(function () {{
  const requestId = {request_id_json};
  const store = window.__lnrFetchResults || {{}};
  const result = store[requestId];
  if (!result || !result.done) return null;
  delete store[requestId];
  return result;
}})()"#
    ))
}

#[cfg(desktop)]
fn build_webview_fetch_cleanup_script(request_id: &str) -> Result<String, String> {
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("scraper: serialize fetch request id: {err}"))?;
    Ok(format!(
        r#"(function () {{
  const requestId = {request_id_json};
  if (window.__lnrFetchResults) {{
    delete window.__lnrFetchResults[requestId];
  }}
  if (window.__lnrFetchControllers && window.__lnrFetchControllers[requestId]) {{
    try {{
      window.__lnrFetchControllers[requestId].abort();
    }} catch (error) {{}}
    delete window.__lnrFetchControllers[requestId];
  }}
}})();"#
    ))
}

#[cfg(desktop)]
fn build_webview_fetch_cancel_script(message: &str) -> Result<String, String> {
    let message_json = serde_json::to_string(message)
        .map_err(|err| format!("scraper: serialize cancel message: {err}"))?;
    Ok(format!(
        r#"(function () {{
  const message = {message_json};
  const controllers = window.__lnrFetchControllers || {{}};
  const results = window.__lnrFetchResults || (window.__lnrFetchResults = {{}});
  let cancelled = 0;
  try {{ window.stop(); }} catch (error) {{}}
  for (const requestId of Object.keys(controllers)) {{
    try {{
      controllers[requestId].abort();
    }} catch (error) {{}}
    results[requestId] = {{ done: true, ok: false, error: message }};
    try {{
      delete controllers[requestId];
    }} catch (error) {{}}
    cancelled += 1;
  }}
  return cancelled;
}})()"#
    ))
}

#[cfg(desktop)]
fn clear_webview_extract_result_marker(scraper: &ScraperWebview, current_url: &str) {
    let result_marker = "#__lnr_result__=";
    let Some((clean_url, _result)) = current_url.split_once(result_marker) else {
        return;
    };
    let Ok(clean_url_json) = serde_json::to_string(clean_url) else {
        return;
    };
    let script = format!(
        r#"(function () {{
  try {{
    history.replaceState(null, "", {clean_url_json});
  }} catch (error) {{}}
}})();"#
    );
    let _ = scraper.eval(script);
}

#[cfg(desktop)]
async fn take_webview_extract_result(scraper: &ScraperWebview) -> Option<String> {
    eval_json::<Option<String>>(
        scraper,
        r#"(function () {
  if (typeof window.__lnrExtractResult !== "string") return null;
  var result = window.__lnrExtractResult;
  window.__lnrExtractResult = null;
  return result;
})()"#
            .to_string(),
    )
    .await
    .ok()
    .flatten()
}

#[cfg(desktop)]
fn install_webview_extract_before_script(
    scraper: &ScraperWebview,
    before_script: Option<&str>,
    request_id: &str,
) -> Result<(), String> {
    let request_id_json = serde_json::to_string(request_id)
        .map_err(|err| format!("webview_extract: serialize extract request id: {err}"))?;
    // The id-setter runs on the destination document via the SCRAPER_INIT_SCRIPT
    // bridge, so the page's postMessage polyfill can navigate to the result
    // sentinel and wake the awaiting extract for this request id.
    let id_script = format!("window.__lnrExtractRequestId = {request_id_json};");
    let combined = match before_script {
        Some(before_script) => format!("{id_script}\n{before_script}"),
        None => id_script,
    };
    let combined_json = serde_json::to_string(&combined)
        .map_err(|err| format!("webview_extract: serialize before script: {err}"))?;
    let script = format!(
        r#"(function () {{
  try {{ window.__lnrExtractResult = null; }} catch (error) {{}}
  try {{
    window.name = "__lnr_script__=" + encodeURIComponent({combined_json});
  }} catch (error) {{}}
}})();"#
    );
    scraper
        .eval(script)
        .map_err(|err| format!("webview_extract: install before script: {err}"))
}

#[cfg(desktop)]
fn clear_webview_extract_result(scraper: &ScraperWebview, current_url: Option<&str>) {
    let _ = scraper.eval(
        r#"(function () {
  try { window.__lnrExtractResult = null; } catch (error) {}
  try { window.__lnrExtractRequestId = null; } catch (error) {}
  try {
    if ((window.name || "").indexOf("__lnr_script__=") === 0) {
      window.name = "";
    }
  } catch (error) {}
})()"#
            .to_string(),
    );
    if let Some(current_url) = current_url {
        clear_webview_extract_result_marker(scraper, current_url);
    }
}

/// Issue an HTTP request through the scraper WebView's own browser
/// `fetch()`, preserving Cloudflare/browser-network behavior.
#[cfg(desktop)]
async fn webview_fetch_with_ready_scraper(
    scraper: &ScraperWebview,
    state: &ScraperState,
    url: String,
    init: Option<FetchInit>,
    context_url: Option<String>,
    timeout_ms: Option<u64>,
    generation: &AtomicU64,
    expected_generation: u64,
    executor: &str,
) -> Result<FetchResult, String> {
    let url_for_log = scraper_url_for_log(&url);
    let _: Url = url
        .parse()
        .map_err(|err| format!("scraper: invalid url '{url_for_log}': {err}"))?;
    prepare_fetch_context(
        scraper,
        context_url.as_deref(),
        generation,
        expected_generation,
        executor,
    )
    .await?;
    ensure_executor_generation(generation, expected_generation, "fetch", executor)?;
    let configured_timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000).max(1));
    let init = init.unwrap_or_default();
    let request_id = format!("fetch-{}", FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let start_script = build_webview_fetch_start_script(&request_id, &url, &init)?;

    // Register the completion waiter before starting the fetch so the page's
    // result sentinel (fired from the fetch `finally`) can never beat the
    // waiter. The guard removes the map entry on every exit path.
    let mut completion = register_completion(state, &request_id);
    let _completion_guard = CompletionGuard {
        state,
        request_id: request_id.clone(),
    };
    let mut signaled = false;

    scraper
        .eval(start_script)
        .map_err(|err| format!("scraper: start browser fetch: {err}"))?;

    let deadline = configured_timeout;
    // Event-driven on the happy path: wake on the sentinel and read the result
    // once. The backstop tick still polls periodically so a missed sentinel
    // (e.g. a site that blocks the navigation) never regresses reliability
    // below the previous fixed-interval poll.
    let backstop_interval = Duration::from_millis(1500);
    let started = Instant::now();

    while started.elapsed() < deadline {
        ensure_executor_generation(generation, expected_generation, "fetch", executor)?;
        let wait = deadline
            .saturating_sub(started.elapsed())
            .min(backstop_interval);
        if signaled {
            tokio::time::sleep(wait).await;
        } else {
            tokio::select! {
                _ = &mut completion => {
                    signaled = true;
                }
                _ = tokio::time::sleep(wait) => {}
            }
        }
        ensure_executor_generation(generation, expected_generation, "fetch", executor)?;

        let poll_script = build_webview_fetch_poll_script(&request_id)?;
        let result: Option<WebviewFetchScriptResult> = eval_json(scraper, poll_script).await?;
        let Some(result) = result else {
            continue;
        };

        if !result.ok {
            let error = result
                .error
                .unwrap_or_else(|| "unknown browser fetch error".to_string());
            return Err(format!(
                "scraper: browser fetch to {url_for_log} failed: {}",
                redact_urls_for_log(&error)
            ));
        }

        let result = FetchResult {
            status: result
                .status
                .ok_or_else(|| "scraper: browser fetch missing status".to_string())?,
            status_text: result.status_text.unwrap_or_default(),
            body_base64: result.body_base64.unwrap_or_default(),
            headers: result.headers.unwrap_or_default(),
            final_url: result.final_url.unwrap_or(url),
        };
        return Ok(result);
    }

    if let Ok(cleanup_script) = build_webview_fetch_cleanup_script(&request_id) {
        let _ = scraper.eval(cleanup_script);
    }

    Err(format!(
        "scraper: browser fetch to {url_for_log} timed out after {}ms",
        deadline.as_millis()
    ))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn webview_fetch(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    url: String,
    init: Option<FetchInit>,
    context_url: Option<String>,
    source_id: Option<String>,
    user_agent: Option<String>,
    queue: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<FetchResult, String> {
    let user_agent = normalize_user_agent(user_agent);
    let source_id = normalize_source_id(source_id.as_deref())?;
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let generation = scraper_executor_cancel_generation(&state, &queue);
    let expected_generation = generation.load(Ordering::Acquire);
    let queue_lock = scraper_executor_lock(&state, &queue);
    let _queue_guard = queue_lock.lock().await;
    ensure_executor_generation(&generation, expected_generation, "fetch", &queue)?;
    let fetch_contexts = fetch_context_urls(&url, context_url.as_deref())?;
    let init_log = fetch_init_for_log(&init);
    let url_for_log = scraper_url_for_log(&url);
    let context_for_log = context_url.as_deref().map(scraper_url_for_log);
    let fetch_contexts_for_log: Vec<String> = fetch_contexts
        .iter()
        .map(|value| scraper_url_for_log(value))
        .collect();
    log::trace!(
        "[scraper:fetch] request queue={queue} request_url={url_for_log} configured_context={context_for_log:?} fetch_contexts={fetch_contexts_for_log:?} timeout_ms={timeout_ms:?} user_agent={user_agent:?} init={init_log}"
    );
    let scraper = scraper_handle_for_key(&app, &state, &queue, &source_id, user_agent.as_deref())?;
    log_scraper_cookies(
        &scraper,
        &queue,
        "before_webview_fetch",
        vec![("request", url.clone())],
    );
    let mut result = Err("scraper: no fetch context available".to_string());
    for (index, fetch_context) in fetch_contexts.iter().enumerate() {
        result = webview_fetch_with_ready_scraper(
            &scraper,
            &state,
            url.clone(),
            init.clone(),
            Some(fetch_context.clone()),
            timeout_ms,
            &generation,
            expected_generation,
            &queue,
        )
        .await;
        if generation.load(Ordering::Acquire) != expected_generation {
            result = Err(format!(
                "scraper:fetch: Request cancelled for executor {queue}"
            ));
            break;
        }
        if result.is_ok() || index + 1 == fetch_contexts.len() {
            break;
        }
        if let Err(err) = &result {
            let fetch_context_for_log = scraper_url_for_log(fetch_context);
            let error_for_log = redact_urls_for_log(err);
            log::debug!(
                "[scraper:fetch] retrying with fallback context queue={queue} request_url={url_for_log} failed_context={fetch_context_for_log} error={error_for_log}"
            );
        }
    }
    match &result {
        Ok(result) => {
            let header_names: Vec<&String> = result.headers.keys().collect();
            let final_url_for_log = scraper_url_for_log(&result.final_url);
            log::trace!(
                "[scraper:fetch] response queue={queue} request_url={url_for_log} status={} final_url={final_url_for_log} header_names={:?}",
                result.status,
                header_names
            );
        }
        Err(err) if err.contains("Request cancelled") => {
            log::debug!("[scraper:fetch] cancelled queue={queue} request_url={url_for_log}");
        }
        Err(err) => {
            let error_for_log = redact_urls_for_log(err);
            log::error!(
                "[scraper:fetch] failed queue={queue} request_url={url_for_log} error={error_for_log}"
            );
        }
    }
    let mut cookie_log_urls = vec![("request", url.clone())];
    for fetch_context in fetch_contexts {
        cookie_log_urls.push(("fetch_context", fetch_context));
    }
    if let Ok(result) = &result {
        cookie_log_urls.push(("final", result.final_url.clone()));
    }
    log_scraper_cookies(&scraper, &queue, "after_webview_fetch", cookie_log_urls);
    result
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn webview_fetch(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _init: Option<FetchInit>,
    _context_url: Option<String>,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _queue: Option<String>,
    _timeout_ms: Option<u64>,
) -> Result<FetchResult, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[cfg(desktop)]
fn take_captured_resource_for_source(
    state: &ScraperState,
    queue: &str,
    source_id: &str,
    _user_agent: Option<&str>,
    url: &str,
) -> Option<crate::webview_resource_capture::CapturedResource> {
    let resource = state
        .captured_resources
        .take_for_source(queue, source_id, url)?;
    log::debug!(
        "[scraper:capture] navigation response consumed source_id={source_id} consumer={queue} url={}",
        scraper_url_for_log(url)
    );
    Some(resource)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_take_captured_resource(
    state: tauri::State<'_, ScraperState>,
    url: String,
    source_id: Option<String>,
    user_agent: Option<String>,
    queue: Option<String>,
) -> Result<Option<FetchResult>, String> {
    let source_id = normalize_source_id(source_id.as_deref())?;
    let user_agent = normalize_user_agent(user_agent);
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let generation = scraper_executor_cancel_generation(&state, &queue);
    let expected_generation = generation.load(Ordering::Acquire);
    ensure_executor_generation(
        &generation,
        expected_generation,
        "captured resource take",
        &queue,
    )?;
    let resource = take_captured_resource_for_source(
        &state,
        &queue,
        &source_id,
        user_agent.as_deref(),
        &url,
    );
    Ok(resource.map(|resource| FetchResult {
        status: resource.status,
        status_text: resource.status_text,
        body_base64: encode_base64(&resource.body),
        headers: resource.headers,
        final_url: resource.final_url,
    }))
}

#[cfg(target_os = "windows")]
fn captured_resource_is_cloudflare_challenge(
    headers: &HashMap<String, String>,
    body: &[u8],
) -> bool {
    crate::webview_resource_capture::response_is_cloudflare_challenge(headers, body)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn scraper_take_captured_resource_handle(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    url: String,
    source_id: Option<String>,
    user_agent: Option<String>,
    queue: Option<String>,
) -> Result<Option<CapturedResourceHandleResult>, String> {
    let source_id = normalize_source_id(source_id.as_deref())?;
    let user_agent = normalize_user_agent(user_agent);
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let generation = scraper_executor_cancel_generation(&state, &queue);
    let expected_generation = generation.load(Ordering::Acquire);
    ensure_executor_generation(
        &generation,
        expected_generation,
        "captured resource take",
        &queue,
    )?;
    let Some(resource) = take_captured_resource_for_source(
        &state,
        &queue,
        &source_id,
        user_agent.as_deref(),
        &url,
    ) else {
        return Ok(None);
    };
    let status = resource.status;
    let status_text = resource.status_text;
    let headers = resource.headers;
    let final_url = resource.final_url;
    let cloudflare_challenge = captured_resource_is_cloudflare_challenge(&headers, &resource.body);
    let body = resource.body;
    let (body_handle, body_bytes) = tauri::async_runtime::spawn_blocking(move || {
        let stream_state = app.state::<crate::native_stream::NativeStreamState>();
        crate::native_stream::register_finished_bytes(
            &app,
            stream_state.inner(),
            crate::native_stream::CHAPTER_MEDIA_STREAM_DOMAIN,
            &body,
        )
    })
    .await
    .map_err(|error| format!("scraper: captured media handle task: {error}"))??;
    Ok(Some(CapturedResourceHandleResult {
        status,
        status_text,
        body_handle,
        body_bytes,
        cloudflare_challenge,
        headers,
        final_url,
    }))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn scraper_take_captured_resource_handle(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _queue: Option<String>,
) -> Result<Option<CapturedResourceHandleResult>, String> {
    Ok(None)
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_take_captured_resource(
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _queue: Option<String>,
) -> Result<Option<FetchResult>, String> {
    Ok(None)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_cancel_executor(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    queue: Option<String>,
    message: Option<String>,
) -> Result<bool, String> {
    let queue = normalize_scraper_executor(queue.as_deref())?;
    state.captured_resources.interrupt(&queue);
    let generation = scraper_executor_cancel_generation(&state, &queue);
    let next_generation = generation.fetch_add(1, Ordering::AcqRel) + 1;
    log::debug!("[scraper:cancel] executor={queue} generation={next_generation}");
    let entry = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(&queue)
        .cloned();
    let Some(scraper) = entry.and_then(|entry| app.get_webview(&entry.label)) else {
        return Ok(true);
    };
    let script =
        build_webview_fetch_cancel_script(message.as_deref().unwrap_or("Request cancelled"))?;
    match eval_json::<u32>(&scraper, script).await {
        Ok(cancelled) if cancelled > 0 => {
            log::debug!("[scraper:fetch] cancelled queue={queue} count={cancelled}");
        }
        Ok(_) => {}
        Err(err) => {
            log::debug!("[scraper:cancel] browser cancellation script failed queue={queue}: {err}");
        }
    }
    Ok(true)
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_cancel_executor(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _queue: Option<String>,
    _message: Option<String>,
) -> Result<bool, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Inverse of `encodeURIComponent`. Strict on malformed escapes so the
/// caller can surface the failure rather than silently dropping data.
#[cfg(desktop)]
fn decode_uri_component(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(format!("invalid percent escape at offset {i}"));
            }
            let hi = (bytes[i + 1] as char)
                .to_digit(16)
                .ok_or_else(|| format!("non-hex char at offset {}", i + 1))?;
            let lo = (bytes[i + 2] as char)
                .to_digit(16)
                .ok_or_else(|| format!("non-hex char at offset {}", i + 2))?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|err| format!("invalid utf-8 in payload: {err}"))
}

/// Navigate the scraper WebView to `url`, run the optional
/// `before_script` before any page script via the
/// `SCRAPER_INIT_SCRIPT` bridge, and resolve with whatever the page
/// (or the injected script) emits via
/// `window.ReactNativeWebView.postMessage`.
///
/// Use this instead of `webview_fetch` for plugins that need a fully
/// rendered page (closed shadow roots, JS-decrypted bodies,
/// fingerprinted CDN handshake) - e.g. Booktoki, which decrypts
/// chapter HTML inside a closed shadow root that only a real browser
/// session can read.
///
/// Uses the scraper WebView owned by the requested queue.
#[cfg(desktop)]
#[tauri::command]
pub async fn webview_extract(
    app: AppHandle,
    state: tauri::State<'_, ScraperState>,
    url: String,
    before_script: Option<String>,
    timeout_ms: Option<u64>,
    source_id: Option<String>,
    user_agent: Option<String>,
    queue: Option<String>,
    capture_resources: Option<bool>,
) -> Result<String, String> {
    let user_agent = normalize_user_agent(user_agent);
    let url_for_log = scraper_url_for_log(&url);
    let source_id = normalize_source_id(source_id.as_deref())?;
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let generation = scraper_executor_cancel_generation(&state, &queue);
    let expected_generation = generation.load(Ordering::Acquire);
    let queue_lock = scraper_executor_lock(&state, &queue);
    let _queue_guard = queue_lock.lock().await;
    ensure_executor_generation(&generation, expected_generation, "extract", &queue)?;
    let scraper = scraper_handle_for_key(&app, &state, &queue, &source_id, user_agent.as_deref())?;
    let capture_resources = capture_resources.unwrap_or(false) && cfg!(target_os = "windows");
    #[cfg(target_os = "windows")]
    ensure_resource_capture_handler(&scraper, &state, &queue, &source_id).await?;
    let _capture_guard = crate::webview_resource_capture::CaptureGuard::new(
        Arc::clone(&state.captured_resources),
        &queue,
        capture_resources,
    );
    let is_visible_browser = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .as_deref()
        == Some(queue.as_str());
    if !is_visible_browser {
        show_scraper_webview_for_background_render(&scraper)?;
    }
    log::trace!(
        "[scraper:extract] request queue={queue} url={url_for_log} timeout_ms={timeout_ms:?} user_agent={user_agent:?} before_script_len={}",
        before_script
            .as_ref()
            .map(|script| script.len())
            .unwrap_or(0)
    );
    log_scraper_cookies(
        &scraper,
        &queue,
        "before_webview_extract",
        vec![("request", url.clone())],
    );

    let before_script = before_script.as_deref().filter(|script| !script.is_empty());
    let target_url_str = url.clone();
    let target_url_for_log = scraper_url_for_log(&target_url_str);

    let parsed: Url = target_url_str
        .parse()
        .map_err(|err| format!("webview_extract: invalid url '{target_url_for_log}': {err}"))?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let result_marker = "#__lnr_result__=";
    let mut retried_after_browser_challenge = false;
    let max_attempts = 2;

    // Event-driven wake for the first result via the page's postMessage signal.
    // The marker/result read below is unchanged, so backoff polling remains the
    // safety net if the signal never arrives (e.g. challenge-retry navigations).
    let request_id = format!("extract-{}", FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let mut completion = register_completion(&state, &request_id);
    let _completion_guard = CompletionGuard {
        state: state.inner(),
        request_id: request_id.clone(),
    };
    let mut signaled = false;

    for attempt in 1..=max_attempts {
        let prepare_result =
            prepare_extract_context(&scraper, &parsed, &generation, expected_generation, &queue)
                .await;
        if let Err(error) = prepare_result {
            if generation.load(Ordering::Acquire) == expected_generation
                && document_has_browser_challenge(&scraper).await
            {
                let challenge_url = browser_challenge_url(&scraper, &url);
                return Ok(browser_challenge_envelope("cloudflare", &challenge_url));
            }
            return Err(error);
        }
        let _ = wait_for_scraper_bridge_ready(
            &scraper,
            "extract",
            Duration::from_secs(5),
            &generation,
            expected_generation,
            &queue,
        )
        .await?;
        ensure_executor_generation(&generation, expected_generation, "extract", &queue)?;
        install_webview_extract_before_script(&scraper, before_script, &request_id)?;
        let mut capture_id = capture_resources
            .then(|| begin_navigation_resource_capture(&state, &queue, &source_id));

        log::trace!(
            "[scraper:extract] navigate queue={queue} url={url_for_log} target_url={target_url_for_log} attempt={attempt}"
        );

        scraper.navigate(parsed.clone()).map_err(|err| {
            format!(
                "webview_extract: navigate: {}",
                redact_urls_for_log(&err.to_string())
            )
        })?;

        let start = Instant::now();
        let mut poll_interval = Duration::from_millis(150);
        while start.elapsed() < timeout {
            if generation.load(Ordering::Acquire) != expected_generation {
                clear_webview_extract_result(&scraper, None);
                stop_scraper_loading(&scraper);
                log::debug!("[scraper:extract] cancelled queue={queue} url={url_for_log}");
                return Err(format!("webview_extract: {url_for_log} Request cancelled"));
            }
            if signaled {
                tokio::time::sleep(poll_interval).await;
            } else {
                tokio::select! {
                    _ = &mut completion => {
                        signaled = true;
                    }
                    _ = tokio::time::sleep(poll_interval) => {}
                }
            }
            poll_interval = next_poll_backoff(poll_interval, Duration::from_millis(600));
            ensure_executor_generation(&generation, expected_generation, "extract", &queue)?;
            let mut extract_result = take_webview_extract_result(&scraper)
                .await
                .map(|decoded| (decoded, None::<String>));
            if extract_result.is_none() {
                if let Ok(current) = scraper.url().map(|url| url.to_string()) {
                    if let Some(idx) = current.find(result_marker) {
                        let encoded = &current[idx + result_marker.len()..];
                        let decoded = decode_uri_component(encoded)
                            .map_err(|err| format!("webview_extract: decode result: {err}"))?;
                        extract_result = Some((decoded, Some(current)));
                    }
                }
            }
            if let Some((decoded, current_url)) = extract_result {
                ensure_executor_generation(&generation, expected_generation, "extract", &queue)?;
                if !retried_after_browser_challenge
                    && looks_like_browser_challenge_extract_result(&decoded)
                {
                    retried_after_browser_challenge = true;
                    if let Some(capture_id) = capture_id.take() {
                        state.captured_resources.finish(&queue, capture_id);
                    }
                    clear_webview_extract_result(&scraper, current_url.as_deref());
                    let remaining = timeout.checked_sub(start.elapsed()).unwrap_or_default();
                    let wait_budget = remaining.min(Duration::from_secs(20));
                    if wait_budget > Duration::from_millis(0)
                        && wait_for_browser_challenge_to_clear(
                            &scraper,
                            "extract",
                            &url,
                            wait_budget,
                            &generation,
                            expected_generation,
                            &queue,
                        )
                        .await?
                    {
                        ensure_executor_generation(
                            &generation,
                            expected_generation,
                            "extract",
                            &queue,
                        )?;
                        reset_extract_navigation(&scraper, &parsed, "extract")?;
                        prepare_extract_context(
                            &scraper,
                            &parsed,
                            &generation,
                            expected_generation,
                            &queue,
                        )
                        .await?;
                        let _ = wait_for_scraper_bridge_ready(
                            &scraper,
                            "extract",
                            Duration::from_secs(5),
                            &generation,
                            expected_generation,
                            &queue,
                        )
                        .await?;
                        install_webview_extract_before_script(
                            &scraper,
                            before_script,
                            &request_id,
                        )?;
                        capture_id = capture_resources
                            .then(|| begin_navigation_resource_capture(&state, &queue, &source_id));
                        log::debug!(
                            "[scraper:extract] retry after browser challenge queue={queue} url={url_for_log}"
                        );
                        scraper.navigate(parsed.clone()).map_err(|err| {
                            format!(
                                "webview_extract: retry after browser challenge: {}",
                                redact_urls_for_log(&err.to_string())
                            )
                        })?;
                        continue;
                    }
                }
                // Clear result state without leaving the source origin. Navigating
                // away would force the next fetch to prepare the source context again.
                clear_webview_extract_result(&scraper, current_url.as_deref());
                if let Some(capture_id) = capture_id.take() {
                    let capture_wait = timeout
                        .saturating_sub(start.elapsed())
                        .min(Duration::from_secs(5));
                    state
                        .captured_resources
                        .wait_until_settled(
                            &queue,
                            capture_id,
                            RESOURCE_CAPTURE_QUIET_PERIOD,
                            capture_wait,
                        )
                        .await;
                    state.captured_resources.finish(&queue, capture_id);
                }
                let current_for_log = current_url
                    .as_deref()
                    .map(scraper_url_for_log)
                    .unwrap_or_else(|| "<script-result>".to_string());
                let result_len = decoded.len();
                log::trace!(
                    "[scraper:extract] complete queue={queue} url={url_for_log} current_url={current} result_len={result_len}",
                    current = current_for_log,
                );
                let mut cookie_targets = vec![("request", url.clone())];
                if let Some(current) = current_url {
                    cookie_targets.push(("current", current));
                }
                log_scraper_cookies(&scraper, &queue, "after_webview_extract", cookie_targets);
                return Ok(decoded);
            }
        }

        if let Some(capture_id) = capture_id.take() {
            state.captured_resources.finish(&queue, capture_id);
        }

        if attempt < max_attempts {
            log::debug!(
                "[scraper:extract] timeout before extract result; retrying queue={queue} url={url_for_log} attempt={attempt}"
            );
            ensure_executor_generation(&generation, expected_generation, "extract", &queue)?;
            reset_extract_navigation(&scraper, &parsed, "extract")?;
        }
    }

    clear_webview_extract_result(&scraper, None);
    if document_has_browser_challenge(&scraper).await {
        let challenge_url = browser_challenge_url(&scraper, &url);
        let challenge_url_for_log = scraper_url_for_log(&challenge_url);
        log::debug!(
            "[scraper:extract] browser challenge requires manual action queue={queue} url={challenge_url_for_log}"
        );
        return Ok(browser_challenge_envelope("cloudflare", &challenge_url));
    }
    log::error!(
        "[scraper:extract] timeout queue={queue} url={url_for_log} current_url={}",
        scraper_current_url_for_log(&scraper)
    );
    log_scraper_cookies(
        &scraper,
        &queue,
        "after_webview_extract_timeout",
        vec![("request", url.clone())],
    );
    Err(format!(
        "webview_extract: timeout after {}ms ({} attempts)",
        timeout.as_millis(),
        max_attempts,
    ))
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn webview_extract(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _before_script: Option<String>,
    _timeout_ms: Option<u64>,
    _source_id: Option<String>,
    _user_agent: Option<String>,
    _queue: Option<String>,
    _capture_resources: Option<bool>,
) -> Result<String, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::sync::oneshot::error::TryRecvError;

    fn register_test_executor(
        state: &ScraperState,
        executor: &str,
        source_id: &str,
        user_agent: Option<&str>,
    ) {
        state
            .webviews
            .lock()
            .expect("scraper webviews mutex")
            .insert(
                executor.to_string(),
                ScraperEntry {
                    label: format!("scraper-{executor}"),
                    source_id: source_id.to_string(),
                    user_agent: user_agent.map(str::to_string),
                },
            );
        state
            .captured_resources
            .register_source(executor, source_id);
    }

    fn capture_test_resource(state: &ScraperState, executor: &str, url: &str, body: &[u8]) {
        let capture_id = state.captured_resources.begin(executor);
        assert_eq!(state.captured_resources.claim(executor), Some(capture_id));
        state.captured_resources.complete(
            executor,
            capture_id,
            Some(crate::webview_resource_capture::CapturedResource {
                status: 200,
                status_text: "OK".to_string(),
                headers: HashMap::new(),
                final_url: url.to_string(),
                body: body.to_vec(),
            }),
        );
        state.captured_resources.finish(executor, capture_id);
    }

    #[test]
    fn source_profile_keys_are_stable_and_isolated() {
        assert_eq!(
            source_profile_key("source-a"),
            source_profile_key("source-a")
        );
        assert_ne!(
            source_profile_key("source-a"),
            source_profile_key("source-b")
        );
    }

    #[test]
    fn source_profile_requires_a_bounded_source_id() {
        let oversized = "a".repeat(513);
        assert!(normalize_source_id(None).is_err());
        assert!(normalize_source_id(Some("   ")).is_err());
        assert_eq!(
            normalize_source_id(Some(" source-a ")).unwrap(),
            " source-a "
        );
        assert!(normalize_source_id(Some(&oversized)).is_err());
    }

    #[test]
    fn source_profile_directory_names_require_exact_lowercase_sha256_shape() {
        let valid = "0123456789abcdef".repeat(4);
        assert!(is_source_profile_directory_name(OsStr::new(&valid)));

        for invalid in [
            "0123456789abcdef".repeat(3),
            format!("{}0", "0123456789abcdef".repeat(4)),
            "0123456789ABCDEF".repeat(4),
            format!("{}g", "0".repeat(63)),
        ] {
            assert!(!is_source_profile_directory_name(OsStr::new(&invalid)));
        }
    }

    #[test]
    fn source_profile_directory_scan_ignores_files_and_unrelated_directories() {
        let root = tempdir().expect("tempdir");
        let valid = "0123456789abcdef".repeat(4);
        let valid_path = root.path().join(&valid);
        std::fs::create_dir(&valid_path).expect("create valid profile directory");
        std::fs::create_dir(root.path().join("not-a-profile")).expect("create unrelated directory");
        let valid_file_name = "a".repeat(64);
        std::fs::write(root.path().join(valid_file_name), b"not a directory")
            .expect("create profile-shaped file");

        assert_eq!(
            source_profile_directories(root.path()).unwrap(),
            vec![valid_path]
        );
    }

    #[test]
    fn missing_source_profile_root_has_no_profiles() {
        let root = tempdir().expect("tempdir");
        assert!(
            source_profile_directories(&root.path().join("missing"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn navigation_capture_replaces_previous_executor_resources() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", Some("Shared Agent"));
        let url = "https://cdn.test/partial-page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"partial");
        let capture_id = begin_navigation_resource_capture(&state, IMMEDIATE_EXECUTOR, "source-a");

        assert_eq!(
            state.captured_resources.claim(IMMEDIATE_EXECUTOR),
            Some(capture_id)
        );
        assert!(state
            .captured_resources
            .take(IMMEDIATE_EXECUTOR, url)
            .is_none());
    }

    #[test]
    fn visible_user_navigation_replaces_previous_captured_resources() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", None);
        *state.visible_key.lock().expect("scraper visible_key mutex") =
            Some(IMMEDIATE_EXECUTOR.to_string());
        let url = "https://cdn.test/previous-page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"previous");

        let capture_id = begin_visible_user_navigation_resource_capture(
            &state,
            IMMEDIATE_EXECUTOR,
            "source-a",
        )
        .expect("begin visible user navigation capture");

        assert_eq!(
            state.captured_resources.claim(IMMEDIATE_EXECUTOR),
            Some(capture_id)
        );
        assert!(state
            .captured_resources
            .take(IMMEDIATE_EXECUTOR, url)
            .is_none());
    }

    #[test]
    fn registered_navigation_keeps_its_existing_capture_session() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", None);
        *state.visible_key.lock().expect("scraper visible_key mutex") =
            Some(IMMEDIATE_EXECUTOR.to_string());
        let url = "https://cdn.test/current-page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"current");
        let _completion = register_navigation(
            &state,
            IMMEDIATE_EXECUTOR,
            1,
            "https://source.test/page",
        );

        assert!(begin_visible_user_navigation_resource_capture(
            &state,
            IMMEDIATE_EXECUTOR,
            "source-a",
        )
        .is_none());
        assert!(state
            .captured_resources
            .take(IMMEDIATE_EXECUTOR, url)
            .is_some());
    }

    #[test]
    fn navigation_capture_replaces_previous_source_resources() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", Some("Shared Agent"));
        let url = "https://cdn.test/old-profile.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"old-profile");

        let capture_id = begin_navigation_resource_capture(&state, IMMEDIATE_EXECUTOR, "source-b");

        assert_eq!(
            state.captured_resources.claim(IMMEDIATE_EXECUTOR),
            Some(capture_id)
        );
        assert!(
            state
                .captured_resources
                .take(IMMEDIATE_EXECUTOR, url)
                .is_none()
        );
    }

    #[test]
    fn navigation_capture_replaces_previous_same_source_resources() {
        let state = ScraperState::default();
        register_test_executor(
            &state,
            IMMEDIATE_EXECUTOR,
            "source-a",
            Some("Existing Agent"),
        );
        let url = "https://cdn.test/old-profile.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"old-profile");

        let capture_id = begin_navigation_resource_capture(&state, IMMEDIATE_EXECUTOR, "source-a");

        assert_eq!(
            state.captured_resources.claim(IMMEDIATE_EXECUTOR),
            Some(capture_id)
        );
        assert!(state
            .captured_resources
            .take(IMMEDIATE_EXECUTOR, url)
            .is_none());
    }

    #[test]
    fn navigation_capture_stays_empty_after_explicit_cache_clear() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", None);
        let url = "https://cdn.test/cleared.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"cleared");
        state.captured_resources.clear_all();

        let capture_id = begin_navigation_resource_capture(&state, IMMEDIATE_EXECUTOR, "source-a");

        assert_eq!(
            state.captured_resources.claim(IMMEDIATE_EXECUTOR),
            Some(capture_id)
        );
        assert!(
            state
                .captured_resources
                .take(IMMEDIATE_EXECUTOR, url)
                .is_none()
        );
    }

    #[test]
    fn captured_media_stays_in_the_capturing_executor() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", Some("Shared Agent"));
        let url = "https://cdn.test/page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"foreground");

        assert!(take_captured_resource_for_source(
            &state,
            "pool:missing",
            "source-a",
            Some("Shared Agent"),
            url,
        )
        .is_none());
        assert_eq!(
            take_captured_resource_for_source(
                &state,
                IMMEDIATE_EXECUTOR,
                "source-a",
                Some("Shared Agent"),
                url,
            )
            .map(|resource| resource.body.clone()),
            Some(b"foreground".to_vec())
        );
    }

    #[test]
    fn same_source_captures_are_isolated_across_executors() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", None);
        register_test_executor(&state, "pool:1", "source-a", None);
        let url = "https://cdn.test/page.png?token=exact";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"foreground");
        capture_test_resource(&state, "pool:1", url, b"pool");

        assert_eq!(
            take_captured_resource_for_source(&state, "pool:1", "source-a", None, url)
                .map(|resource| resource.body.clone()),
            Some(b"pool".to_vec())
        );
        assert_eq!(
            state
                .captured_resources
                .take(IMMEDIATE_EXECUTOR, url)
                .map(|resource| resource.body),
            Some(b"foreground".to_vec())
        );
    }

    #[test]
    fn captured_media_is_not_available_to_another_executor() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", None);
        register_test_executor(&state, "pool:1", "source-a", None);
        let url = "https://cdn.test/page.png";
        capture_test_resource(&state, "pool:1", url, b"pool");

        assert!(take_captured_resource_for_source(
            &state,
            IMMEDIATE_EXECUTOR,
            "source-a",
            None,
            url,
        )
        .is_none());
        assert_eq!(
            take_captured_resource_for_source(&state, "pool:1", "source-a", None, url,)
                .map(|resource| resource.body.clone()),
            Some(b"pool".to_vec())
        );
    }

    #[test]
    fn captured_media_uses_the_pool_when_the_foreground_url_does_not_match() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-a", None);
        register_test_executor(&state, "pool:1", "source-a", None);
        let foreground_url = "https://cdn.test/page.png?token=foreground";
        let pool_url = "https://cdn.test/page.png?token=pool";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, foreground_url, b"foreground");
        capture_test_resource(&state, "pool:1", pool_url, b"pool");

        assert_eq!(
            take_captured_resource_for_source(&state, "pool:1", "source-a", None, pool_url)
                .map(|resource| resource.body.clone()),
            Some(b"pool".to_vec())
        );
        assert_eq!(
            state
                .captured_resources
                .take(IMMEDIATE_EXECUTOR, foreground_url)
                .map(|resource| resource.body),
            Some(b"foreground".to_vec())
        );
    }

    #[test]
    fn captured_media_does_not_cross_source_profiles() {
        let state = ScraperState::default();
        register_test_executor(&state, IMMEDIATE_EXECUTOR, "source-b", None);
        register_test_executor(&state, "pool:1", "source-a", None);
        let url = "https://cdn.test/page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"other-source");
        capture_test_resource(&state, "pool:1", url, b"requested-source");

        assert_eq!(
            take_captured_resource_for_source(&state, "pool:1", "source-a", None, url)
                .map(|resource| resource.body.clone()),
            Some(b"requested-source".to_vec())
        );
        assert_eq!(
            state
                .captured_resources
                .take(IMMEDIATE_EXECUTOR, url)
                .map(|resource| resource.body),
            Some(b"other-source".to_vec())
        );
    }

    #[test]
    fn user_agent_differences_do_not_cross_executor_boundaries() {
        let state = ScraperState::default();
        register_test_executor(
            &state,
            IMMEDIATE_EXECUTOR,
            "source-a",
            Some("Foreground Agent"),
        );
        register_test_executor(&state, "pool:1", "source-a", Some("Batch Agent"));
        let url = "https://cdn.test/page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"foreground");
        capture_test_resource(&state, "pool:1", url, b"pool");

        assert_eq!(
            take_captured_resource_for_source(
                &state,
                "pool:1",
                "source-a",
                Some("Batch Agent"),
                url,
            )
            .map(|resource| resource.body.clone()),
            Some(b"pool".to_vec())
        );
        assert_eq!(
            take_captured_resource_for_source(
                &state,
                IMMEDIATE_EXECUTOR,
                "source-a",
                Some("Foreground Agent"),
                url,
            )
            .map(|resource| resource.body.clone()),
            Some(b"foreground".to_vec())
        );
    }

    #[test]
    fn user_agent_changes_do_not_enable_cross_executor_reuse() {
        let state = ScraperState::default();
        register_test_executor(
            &state,
            IMMEDIATE_EXECUTOR,
            "source-a",
            Some("Existing Agent"),
        );
        register_test_executor(&state, "pool:1", "source-a", Some("Existing Agent"));
        let url = "https://cdn.test/page.png";
        capture_test_resource(&state, IMMEDIATE_EXECUTOR, url, b"foreground");

        assert!(take_captured_resource_for_source(
            &state,
            "pool:1",
            "source-a",
            Some("Updated Agent"),
            url,
        )
        .is_none());
    }

    #[test]
    fn parses_result_sentinel_request_id() {
        let url = Url::parse("https://norea.localhost/__norea_scraper_result__/fetch-7").unwrap();
        assert_eq!(scraper_result_request_id(&url).as_deref(), Some("fetch-7"));
    }

    #[test]
    fn base64_decoder_round_trips_binary_fetch_bodies() {
        for body in [
            b"".as_slice(),
            b"f".as_slice(),
            b"fo".as_slice(),
            b"foo".as_slice(),
            b"\x00\xff\x10image".as_slice(),
        ] {
            assert_eq!(decode_base64(&encode_base64(body)), Some(body.to_vec()));
        }
        for invalid in ["=m9v", "Zm=9", "Zm9v=", "Zm9v===="] {
            assert!(decode_base64(invalid).is_none());
        }
    }

    #[test]
    fn decodes_encoded_result_request_id() {
        let url = Url::parse("https://norea.localhost/__norea_scraper_result__/a%20b").unwrap();
        assert_eq!(scraper_result_request_id(&url).as_deref(), Some("a b"));
    }

    #[test]
    fn rejects_non_result_sentinels() {
        for raw in [
            "http://norea.localhost/__norea_scraper_result__/fetch-7",
            "https://example.com/__norea_scraper_result__/fetch-7",
            "https://norea.localhost/other/fetch-7",
        ] {
            let url = Url::parse(raw).unwrap();
            assert_eq!(scraper_result_request_id(&url), None, "should reject {raw}");
        }
    }

    #[test]
    fn fires_pending_completion_by_request_id() {
        let state = ScraperState::default();
        let mut rx = register_completion(&state, "fetch-1");
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Empty)));
        fire_completion(&state, "fetch-1");
        assert!(rx.try_recv().is_ok());
    }

    #[test]
    fn completion_guard_removes_pending_entry() {
        let state = ScraperState::default();
        let mut rx = register_completion(&state, "fetch-2");
        {
            let _guard = CompletionGuard {
                state: &state,
                request_id: "fetch-2".to_string(),
            };
        }
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Closed)));
        fire_completion(&state, "fetch-2");
    }

    #[test]
    fn fire_completion_unknown_id_is_noop() {
        let state = ScraperState::default();
        fire_completion(&state, "missing");
    }

    #[test]
    fn navigation_ignores_old_finish_and_completes_redirected_page() {
        let state = ScraperState::default();
        let mut completion = register_navigation(
            &state,
            IMMEDIATE_EXECUTOR,
            7,
            "https://example.com/requested",
        );
        let initial = Url::parse("tauri://localhost/scraper.html").unwrap();
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Finished,
            &initial,
        );
        assert!(matches!(completion.try_recv(), Err(TryRecvError::Empty)));

        let requested = Url::parse("https://example.com/requested").unwrap();
        let redirected = Url::parse("https://example.com/final").unwrap();
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Started,
            &requested,
        );
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Started,
            &redirected,
        );
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Finished,
            &redirected,
        );
        assert_eq!(completion.try_recv().unwrap(), redirected.to_string());
    }

    #[test]
    fn blank_navigation_ignores_unrelated_page_loads() {
        let state = ScraperState::default();
        let mut completion = register_navigation(&state, IMMEDIATE_EXECUTOR, 8, "about:blank");
        let unrelated = Url::parse("https://example.com/late").unwrap();
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Started,
            &unrelated,
        );
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Finished,
            &unrelated,
        );
        assert!(matches!(completion.try_recv(), Err(TryRecvError::Empty)));

        let blank = Url::parse("about:blank").unwrap();
        record_navigation_page_load(&state, IMMEDIATE_EXECUTOR, PageLoadEvent::Started, &blank);
        record_navigation_page_load(
            &state,
            IMMEDIATE_EXECUTOR,
            PageLoadEvent::Finished,
            &unrelated,
        );
        assert!(matches!(completion.try_recv(), Err(TryRecvError::Empty)));
        record_navigation_page_load(&state, IMMEDIATE_EXECUTOR, PageLoadEvent::Finished, &blank);
        assert_eq!(completion.try_recv().unwrap(), blank.to_string());
    }

    #[tokio::test]
    async fn hidden_blank_wait_keeps_executor_locked_until_finished() {
        let state = Arc::new(ScraperState::default());
        let completion = register_navigation(&state, IMMEDIATE_EXECUTOR, 9, SCRAPER_BLANK_URL);
        let executor_lock = scraper_executor_lock(&state, IMMEDIATE_EXECUTOR);
        let hide_lock = Arc::clone(&executor_lock);
        let (locked, locked_rx) = oneshot::channel();
        let blank_wait = tokio::spawn(async move {
            let _guard = hide_lock.lock().await;
            let _ = locked.send(());
            wait_for_hidden_blank_page(completion).await
        });

        locked_rx.await.unwrap();
        assert!(
            timeout(Duration::from_millis(20), executor_lock.lock())
                .await
                .is_err()
        );

        let blank = Url::parse(SCRAPER_BLANK_URL).unwrap();
        record_navigation_page_load(&state, IMMEDIATE_EXECUTOR, PageLoadEvent::Started, &blank);
        record_navigation_page_load(&state, IMMEDIATE_EXECUTOR, PageLoadEvent::Finished, &blank);
        blank_wait.await.unwrap().unwrap();
        assert!(
            timeout(Duration::from_millis(100), executor_lock.lock())
                .await
                .is_ok()
        );
    }

    #[test]
    fn cancellation_generation_invalidates_queued_request() {
        let state = ScraperState::default();
        let generation = scraper_executor_cancel_generation(&state, "pool:0");
        let expected = generation.load(Ordering::Acquire);
        generation.fetch_add(1, Ordering::AcqRel);
        assert!(
            ensure_executor_generation(&generation, expected, "fetch", "pool:0")
                .unwrap_err()
                .contains("Request cancelled")
        );
    }

    #[test]
    fn initialization_script_has_no_remote_page_controls() {
        let script = scraper_initialization_script();

        assert!(!script.contains("__noreaScraperControl"));
        assert!(!script.contains("keep-paused"));
        assert!(!script.contains("publish(\"verify\")"));
    }

    #[test]
    fn browser_challenge_detector_requires_visible_or_correlated_evidence() {
        assert!(BROWSER_CHALLENGE_DETECTOR_SCRIPT.contains("getClientRects"));
        assert!(
            BROWSER_CHALLENGE_DETECTOR_SCRIPT.contains("hasCloudflareEvidence && hasChallengeText")
        );
        assert!(
            !BROWSER_CHALLENGE_DETECTOR_SCRIPT
                .contains("if (document.querySelector(selectors[i]))")
        );
    }

    #[test]
    fn browser_http_origin_preserves_scheme_host_and_port() {
        let url = Url::parse("https://Source.Test:8443/a?x=1#fragment").unwrap();
        assert_eq!(
            browser_http_origin(&url).as_deref(),
            Some("https://source.test:8443")
        );

        let default_port = Url::parse("https://source.test:443/path").unwrap();
        assert_eq!(
            browser_http_origin(&default_port).as_deref(),
            Some("https://source.test")
        );

        for raw in ["file:///tmp/challenge", "data:text/plain,challenge"] {
            assert_eq!(browser_http_origin(&Url::parse(raw).unwrap()), None);
        }
    }

    #[test]
    fn scraper_url_log_redaction_keeps_only_the_http_origin() {
        assert_eq!(
            scraper_url_for_log(
                "https://user:password@Source.Test:8443/signed/path-token?token=secret#proof"
            ),
            "https://source.test:8443"
        );
        assert_eq!(
            scraper_url_for_log("not a url?token=secret#proof"),
            "not a url"
        );
        assert_eq!(
            scraper_url_for_log("https://%zz/signed-path?token=secret"),
            "<http-url>"
        );
    }

    #[test]
    fn scraper_error_log_redaction_removes_embedded_url_secrets() {
        let message = redact_urls_for_log(
            "request https://source.test/signed-path-one?token=first#proof failed via http://user:pass@fallback.test/signed-path-two?token=second",
        );

        assert_eq!(
            message,
            "request https://source.test failed via http://fallback.test"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn captured_resource_challenge_detector_sniffs_html_without_trusting_headers() {
        let body =
            b"<!DOCTYPE html><html><script src='/cdn-cgi/challenge-platform/h/g'></script></html>";

        assert!(captured_resource_is_cloudflare_challenge(
            &HashMap::new(),
            body
        ));
        assert!(captured_resource_is_cloudflare_challenge(
            &HashMap::from([("content-type".to_string(), "image/png".to_string())]),
            body
        ));
        assert!(captured_resource_is_cloudflare_challenge(
            &HashMap::from([("CF-Mitigated".to_string(), "challenge".to_string())]),
            b"binary"
        ));
        assert!(!captured_resource_is_cloudflare_challenge(
            &HashMap::from([("content-type".to_string(), "image/png".to_string())]),
            b"\x89PNG\r\ncloudflare"
        ));
        assert!(!captured_resource_is_cloudflare_challenge(
            &HashMap::from([("content-type".to_string(), "image/svg+xml".to_string())]),
            b"<svg><text>/cdn-cgi/challenge-platform/</text></svg>"
        ));
    }

    #[test]
    fn browser_challenge_envelope_uses_the_manual_action_contract() {
        let raw = browser_challenge_envelope(
            "cloudflare",
            "https://source.test/chapter/1?token=quoted%22value",
        );
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(value["ok"], false);
        assert_eq!(value["code"], "manual-action-required");
        assert_eq!(value["challenge"]["kind"], "cloudflare");
        assert_eq!(
            value["challenge"]["url"],
            "https://source.test/chapter/1?token=quoted%22value"
        );
    }

    #[tokio::test]
    async fn cookie_clear_completion_returns_deleted_count() {
        let (sender, receiver) = oneshot::channel();
        sender.send(Ok(3)).unwrap();

        assert_eq!(
            await_cookie_clear_completion(receiver, Duration::from_millis(10))
                .await
                .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn cookie_clear_completion_reports_dropped_callback() {
        let (sender, receiver) = oneshot::channel::<Result<usize, String>>();
        drop(sender);

        assert!(
            await_cookie_clear_completion(receiver, Duration::from_millis(10))
                .await
                .unwrap_err()
                .contains("callback dropped")
        );
    }

    #[tokio::test]
    async fn cookie_clear_completion_times_out() {
        let (_sender, receiver) = oneshot::channel::<Result<usize, String>>();

        assert!(
            await_cookie_clear_completion(receiver, Duration::from_millis(1))
                .await
                .unwrap_err()
                .contains("timed out")
        );
    }

    #[tokio::test]
    async fn cache_clear_completion_waits_for_successful_callback() {
        let (sender, receiver) = oneshot::channel();
        sender.send(Ok(())).unwrap();

        await_cache_clear_completion(receiver, Duration::from_millis(10))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cache_clear_completion_reports_callback_failure() {
        let (sender, receiver) = oneshot::channel();
        sender
            .send(Err(
                "scraper_clear_cache: WebView2 callback failed".to_string()
            ))
            .unwrap();

        assert!(
            await_cache_clear_completion(receiver, Duration::from_millis(10))
                .await
                .unwrap_err()
                .contains("callback failed")
        );
    }

    #[tokio::test]
    async fn cache_clear_completion_reports_dropped_callback() {
        let (sender, receiver) = oneshot::channel::<Result<(), String>>();
        drop(sender);

        assert!(
            await_cache_clear_completion(receiver, Duration::from_millis(10))
                .await
                .unwrap_err()
                .contains("callback dropped")
        );
    }

    #[test]
    fn fetch_start_script_uses_the_browser_default_cache_policy() {
        let init = FetchInit::default();
        let script =
            build_webview_fetch_start_script("fetch-3", "https://example.com/a", &init).unwrap();
        assert!(script.contains("__norea_scraper_result__"));
        assert!(script.contains("encodeURIComponent(requestId)"));
        assert!(script.contains(r#"credentials: "include""#));
        assert!(!script.contains("preferBrowserCache"));
        assert!(!script.contains("force-cache"));
        assert!(!script.contains("cache:"));
    }
}
