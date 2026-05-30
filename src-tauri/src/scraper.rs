//! Desktop scraper WebViews: persistent Tauri child WebViews embedded
//! in the main window. Each scraper queue owns one WebView while all
//! WebViews use the same browser profile and cookie/session storage.
//!
//! Architecture:
//!
//! - Each scraper webview starts at `scraper.html` (a stable
//!   tauri://localhost origin) and is created lazily per scraper queue.
//!   It exists for two reasons:
//!     1. It participates in the shared real-browser cookie jar.
//!        When the user opens
//!        the in-app site browser overlay and navigates to a plugin
//!        site, every cookie the site sets (CF clearance, login
//!        sessions) lands in that jar and persists across requests.
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

#[cfg(desktop)]
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
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
use std::path::PathBuf;

#[cfg(desktop)]
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::{Emitter, Manager, Url, WebviewUrl};
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize, Rect, Webview, WebviewBuilder};
#[cfg(desktop)]
use tokio::sync::{oneshot, Mutex as AsyncMutex};
#[cfg(desktop)]
use tokio::time::timeout;

#[cfg(desktop)]
const SCRAPER_LABEL: &str = "scraper";
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
#[cfg(all(desktop, target_os = "windows"))]
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

#[cfg(all(desktop, not(target_os = "windows")))]
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

  function installNoreaControls() {
    try {
      if (window.top !== window.self) return;
    } catch (e) {
      return;
    }
    if (window.__noreaScraperControlsInstalled) return;
    window.__noreaScraperControlsInstalled = true;

    function applyStyle(node, styles) {
      for (var key in styles) node.style.setProperty(key, styles[key], "important");
    }

    function publish(action) {
      window.__noreaScraperControlMessage = {
        action: action,
        sequence: Date.now()
      };
    }

    function navigateToControl(action) {
      var sequence = Date.now();
      location.href = "https://norea.localhost/__norea_scraper_control__/" + action + "?sequence=" + sequence;
    }

    function requestClose() {
      publish("close");
      try {
        var internals = window.__TAURI_INTERNALS__;
        if (internals && typeof internals.invoke === "function") {
          internals.invoke("scraper_hide", {}).catch(function () {
            navigateToControl("close");
          });
          return;
        }
      } catch (e) {}
      navigateToControl("close");
    }

    function mount() {
      if (!document.body) return;
      var host = document.getElementById("__norea_scraper_controls");
      if (!host) {
        host = document.createElement("div");
        host.id = "__norea_scraper_controls";

        var url = document.createElement("span");
        url.id = "__norea_scraper_controls_url";
        var move = document.createElement("button");
        move.id = "__norea_scraper_controls_move";
        move.type = "button";
        var close = document.createElement("button");
        close.id = "__norea_scraper_controls_close";
        close.type = "button";
        close.textContent = "Close";

        host.appendChild(url);
        host.appendChild(move);
        host.appendChild(close);
        document.body.appendChild(host);

        var edge = "top";
        var lastActivation = 0;

        function setEdge(nextEdge) {
          edge = nextEdge === "bottom" ? "bottom" : "top";
          host.style.setProperty("top", edge === "top" ? "12px" : "auto", "important");
          host.style.setProperty("bottom", edge === "bottom" ? "12px" : "auto", "important");
          move.textContent = edge === "top" ? "Move bottom" : "Move top";
        }

        function activate(event, handler) {
          if (event) {
            event.preventDefault();
            event.stopPropagation();
            if (event.stopImmediatePropagation) event.stopImmediatePropagation();
          }
          var now = Date.now();
          if (now - lastActivation < 150) return;
          lastActivation = now;
          handler();
        }

        function bind(button, handler) {
          var events = ["pointerdown", "mousedown", "touchstart", "click"];
          for (var i = 0; i < events.length; i += 1) {
            button.addEventListener(events[i], function (event) {
              activate(event, handler);
            }, true);
          }
        }

        function bindPressedState(button) {
          function setPressed(pressed) {
            if (pressed) {
              button.setAttribute("data-pressed", "true");
            } else {
              button.removeAttribute("data-pressed");
            }
          }
          button.addEventListener("pointerdown", function () { setPressed(true); }, true);
          button.addEventListener("mousedown", function () { setPressed(true); }, true);
          button.addEventListener("touchstart", function () { setPressed(true); }, true);
          button.addEventListener("pointerup", function () { setPressed(false); }, true);
          button.addEventListener("pointercancel", function () { setPressed(false); }, true);
          button.addEventListener("mouseup", function () { setPressed(false); }, true);
          button.addEventListener("mouseleave", function () { setPressed(false); }, true);
          button.addEventListener("touchend", function () { setPressed(false); }, true);
          button.addEventListener("touchcancel", function () { setPressed(false); }, true);
          button.addEventListener("blur", function () { setPressed(false); }, true);
        }

        bindPressedState(move);
        bind(move, function () {
          setEdge(edge === "top" ? "bottom" : "top");
        });
        bind(close, function () {
          requestClose();
        });

        setEdge(edge);
      }

      var urlNode = document.getElementById("__norea_scraper_controls_url");
      applyStyle(host, {
        "position": "fixed",
        "left": "50%",
        "right": "auto",
        "width": "calc(100vw - 24px)",
        "max-width": "720px",
        "height": "40px",
        "transform": "translateX(-50%)",
        "z-index": "2147483647",
        "display": "flex",
        "align-items": "center",
        "gap": "8px",
        "box-sizing": "border-box",
        "padding": "7px 8px",
        "border": "1px solid rgba(255,255,255,.22)",
        "border-radius": "12px",
        "background": "rgba(22,22,24,.94)",
        "box-shadow": "0 10px 30px rgba(0,0,0,.35)",
        "color": "#fff",
        "font": "13px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "pointer-events": "auto"
      });
      if (urlNode) {
        urlNode.textContent = location.href;
        applyStyle(urlNode, {
          "flex": "1",
          "min-width": "0",
          "overflow": "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          "color": "rgba(255,255,255,.82)"
        });
      }
      var buttons = [
        document.getElementById("__norea_scraper_controls_move"),
        document.getElementById("__norea_scraper_controls_close")
      ];
      for (var index = 0; index < buttons.length; index += 1) {
        var button = buttons[index];
        if (!button) continue;
        var isMoveButton = button.id === "__norea_scraper_controls_move";
        var isPressed = isMoveButton && button.getAttribute("data-pressed") === "true";
        applyStyle(button, {
          "border": "1px solid rgba(255,255,255,.25)",
          "border-radius": "8px",
          "background": isPressed ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.12)",
          "box-shadow": isPressed ? "0 0 0 2px rgba(255,255,255,.22)" : "none",
          "color": "#fff",
          "font": "inherit",
          "padding": "5px 9px",
          "cursor": "pointer",
          "transform": isPressed ? "scale(1.04)" : "scale(1)",
          "transition": "background-color 120ms ease, box-shadow 120ms ease, transform 120ms ease"
        });
      }
      if (host.parentNode !== document.body || document.body.lastElementChild !== host) {
        document.body.appendChild(host);
      }
    }

    function mountSoon() {
      try {
        mount();
      } catch (e) {}
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mountSoon, { once: true });
    } else {
      mountSoon();
    }
    window.setInterval(mountSoon, 500);
  }

  installNoreaControls();
})();
"##;

#[cfg(desktop)]
type ScraperWebview = Webview<tauri::Wry>;

#[cfg(desktop)]
#[derive(Clone, Debug)]
struct ScraperEntry {
    label: String,
    user_agent: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScraperControlMessage {
    pub action: String,
    pub sequence: Option<u64>,
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
const SCRAPER_CONTROL_HOST: &str = "norea.localhost";
#[cfg(desktop)]
const SCRAPER_CONTROL_PATH_PREFIX: &str = "/__norea_scraper_control__/";
#[cfg(desktop)]
const SITE_BROWSER_HIDDEN_EVENT: &str = "site-browser-hidden";
#[cfg(desktop)]
const IMMEDIATE_EXECUTOR: &str = "immediate";

#[cfg(desktop)]
fn log_windows_scraper_event(message: &str) {
    if cfg!(target_os = "windows") {
        log::trace!("[scraper:windows] {message}");
    }
}

#[cfg(desktop)]
fn scraper_control_action(url: &Url) -> Option<&str> {
    if url.scheme() == "https"
        && url.host_str() == Some(SCRAPER_CONTROL_HOST)
        && url.path().starts_with(SCRAPER_CONTROL_PATH_PREFIX)
    {
        return url.path().strip_prefix(SCRAPER_CONTROL_PATH_PREFIX);
    }
    None
}

#[cfg(desktop)]
fn emit_site_browser_hidden(app: &AppHandle) {
    if let Err(err) = app.emit(SITE_BROWSER_HIDDEN_EVENT, ()) {
        log::warn!("[scraper] failed to emit site browser hidden event: {err}");
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
fn scraper_label_from_key(key: &str) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    format!("{SCRAPER_LABEL}-{:016x}", hasher.finish())
}

#[cfg(desktop)]
fn scraper_handle_for_key(
    app: &AppHandle,
    state: &ScraperState,
    key: &str,
    user_agent: Option<&str>,
) -> Result<ScraperWebview, String> {
    let existing_entry = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(key)
        .cloned();
    if let Some(existing_entry) = existing_entry {
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
    }

    let label = scraper_label_from_key(key);
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
    let mut builder = WebviewBuilder::new(
        label.clone(),
        WebviewUrl::App(PathBuf::from(SCRAPER_HOMEPAGE_PATH)),
    )
    .on_navigation(move |url| {
        if scraper_control_action(url) == Some("close") {
            log_windows_scraper_event("scraper control close navigation received");
            let app = app_for_navigation.clone();
            if let Err(err) = app_for_navigation.run_on_main_thread(move || {
                if let Err(err) = scraper_hide(app) {
                    log::error!("[scraper] control close failed: {err}");
                }
            }) {
                log::error!("[scraper] failed to schedule control close: {err}");
            }
            return false;
        }
        true
    })
    .initialization_script(SCRAPER_INIT_SCRIPT);
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
                user_agent: user_agent.map(str::to_string),
            },
        );
    log_windows_scraper_event("handle_for_key registered new webview");
    Ok(webview)
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
        .remove(key);
    let Some(entry) = entry else {
        return Ok(false);
    };
    if let Some(webview) = app.get_webview(&entry.label) {
        webview
            .close()
            .map_err(|err| format!("scraper: close {reason} for {key}: {err}"))?;
        return Ok(true);
    }
    Ok(false)
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

/// Reposition + resize the scraper child Webview. Desktop controls
/// live inside the scraper WebView so they remain in the main window.
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
    user_agent: Option<String>,
) -> Result<(), String> {
    let user_agent = normalize_user_agent(user_agent);
    if cfg!(target_os = "windows") {
        log::trace!(
            "[scraper:windows] scraper_set_bounds start url={url} x={x} y={y} width={width} height={height}"
        );
    }
    let executor_lock = scraper_executor_lock(&state, IMMEDIATE_EXECUTOR);
    let _executor_guard = executor_lock.lock().await;
    let key = IMMEDIATE_EXECUTOR.to_string();
    let scraper = scraper_handle_for_key(&app, &state, IMMEDIATE_EXECUTOR, user_agent.as_deref())?;
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
    _user_agent: Option<String>,
) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Collapse and hide the scraper when the modal closes.
#[cfg(desktop)]
#[tauri::command]
pub fn scraper_hide(app: AppHandle) -> Result<(), String> {
    log_windows_scraper_event("scraper_hide start");
    let state = app.state::<ScraperState>();
    let visible_key = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .take();
    let Some(visible_key) = visible_key else {
        log_windows_scraper_event("scraper_hide skipped: no visible key");
        return Ok(());
    };
    if !hide_scraper_surface_for_key(&app, &state, &visible_key)? {
        log_windows_scraper_event("scraper_hide skipped: visible webview missing");
    }
    emit_site_browser_hidden(&app);
    log_windows_scraper_event("scraper_hide complete");
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn scraper_hide(_app: AppHandle) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Poll the in-page scraper controls for user actions while the browser is open.
#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_poll_control_message(
    app: AppHandle,
) -> Result<Option<ScraperControlMessage>, String> {
    let state = app.state::<ScraperState>();
    let visible_key = state
        .visible_key
        .lock()
        .expect("scraper visible_key mutex")
        .clone();
    let Some(visible_key) = visible_key else {
        return Ok(None);
    };
    let Some(scraper) = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(&visible_key)
        .cloned()
        .and_then(|entry| app.get_webview(&entry.label))
    else {
        return Ok(None);
    };
    let message = eval_json::<Option<ScraperControlMessage>>(
        &scraper,
        r#"(function () {
  const message = window.__noreaScraperControlMessage || null;
  window.__noreaScraperControlMessage = null;
  return message;
})()"#
            .to_string(),
    )
    .await?;
    if let Some(message) = &message {
        if cfg!(target_os = "windows") {
            log::trace!(
                "[scraper:windows] scraper_poll_control_message action={} sequence={:?}",
                message.action,
                message.sequence
            );
        }
    }
    Ok(message)
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_poll_control_message(
    _app: AppHandle,
) -> Result<Option<ScraperControlMessage>, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

/// Delete all cookies held by the scraper WebView cookie jar.
#[cfg(desktop)]
#[tauri::command]
pub async fn scraper_clear_cookies(app: AppHandle) -> Result<usize, String> {
    let state = app.state::<ScraperState>();
    let labels: Vec<String> = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .values()
        .map(|entry| entry.label.clone())
        .collect();
    let mut count = 0;
    for label in labels {
        let Some(scraper) = app.get_webview(&label) else {
            continue;
        };
        let cookies = scraper
            .cookies()
            .map_err(|err| format!("scraper: read cookies for {label}: {err}"))?;
        count += cookies.len();
        for cookie in cookies {
            scraper
                .delete_cookie(cookie)
                .map_err(|err| format!("scraper: delete cookie for {label}: {err}"))?;
        }
    }
    Ok(count)
}

#[cfg(not(desktop))]
#[tauri::command]
pub async fn scraper_clear_cookies(_app: AppHandle) -> Result<usize, String> {
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
    user_agent: Option<String>,
    reset_history: Option<bool>,
) -> Result<(), String> {
    let user_agent = normalize_user_agent(user_agent);
    let reset_history = reset_history.unwrap_or(false);
    if cfg!(target_os = "windows") {
        log::trace!(
            "[scraper:windows] scraper_navigate start url={url} reset_history={reset_history}"
        );
    }
    let executor_lock = scraper_executor_lock(&state, IMMEDIATE_EXECUTOR);
    let _executor_guard = executor_lock.lock().await;
    if reset_history
        && close_scraper_webview_for_key(&app, &state, IMMEDIATE_EXECUTOR, "history reset")?
    {
        log_windows_scraper_event("scraper_navigate reset foreground webview");
    }
    let scraper = scraper_handle_for_key(&app, &state, IMMEDIATE_EXECUTOR, user_agent.as_deref())?;
    let parsed: Url = url
        .parse()
        .map_err(|err| format!("scraper_navigate: invalid url '{url}': {err}"))?;
    scraper
        .navigate(parsed)
        .map_err(|err| format!("scraper_navigate: {err}"))?;
    *state
        .last_navigated
        .lock()
        .expect("scraper last_navigated mutex") = Some(url);
    log_windows_scraper_event("scraper_navigate complete");
    if cfg!(target_os = "linux") {
        log::trace!("[scraper:linux] scraper_navigate complete");
    }
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn scraper_navigate(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    url: String,
    _user_agent: Option<String>,
    _reset_history: Option<bool>,
) -> Result<(), String> {
    Err(format!(
        "scraper_navigate is handled by the Android native scraper bridge: {url}"
    ))
}

#[cfg(not(any(desktop, target_os = "android")))]
#[tauri::command]
pub async fn scraper_navigate(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _url: String,
    _user_agent: Option<String>,
    _reset_history: Option<bool>,
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
        .map(|url| url.to_string())
        .unwrap_or_else(|err| format!("<unavailable: {err}>"))
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn cookie_details_for_log(cookies: &[tauri::webview::Cookie<'static>]) -> Vec<String> {
    cookies
        .iter()
        .map(|cookie| {
            format!(
                "name={}; value_len={}; domain={:?}; path={:?}; secure={:?}; http_only={:?}; same_site={:?}; expires={:?}",
                cookie.name(),
                cookie.value().len(),
                cookie.domain(),
                cookie.path(),
                cookie.secure(),
                cookie.http_only(),
                cookie.same_site(),
                cookie.expires(),
            )
        })
        .collect()
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

fn native_media_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(timeout_ms.unwrap_or(60_000).max(1))
}

fn skip_native_media_header(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "accept-charset"
            | "accept-encoding"
            | "connection"
            | "content-length"
            | "cookie"
            | "cookie2"
            | "host"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "via"
    )
}

#[cfg(all(desktop, target_os = "windows"))]
fn log_scraper_cookies(
    _scraper: &ScraperWebview,
    _queue: &str,
    _context: &str,
    _urls: Vec<(&'static str, String)>,
) {
}

#[cfg(all(desktop, not(target_os = "windows")))]
fn log_scraper_cookies(
    scraper: &ScraperWebview,
    queue: &str,
    context: &str,
    urls: Vec<(&'static str, String)>,
) {
    let mut targets = Vec::new();
    for (label, url) in urls {
        match url.parse::<Url>() {
            Ok(parsed) => match scraper.cookies_for_url(parsed) {
                Ok(cookies) => targets.push(format!(
                    "{label} url={url} count={} cookies={:?}",
                    cookies.len(),
                    cookie_details_for_log(&cookies)
                )),
                Err(err) => targets.push(format!("{label} url={url} error={err}")),
            },
            Err(err) => targets.push(format!("{label} url={url} parse_error={err}")),
        }
    }
    log::trace!(
        "[scraper:cookies] context={context} queue={queue} current_url={} targets={targets:?}",
        scraper_current_url_for_log(scraper)
    );
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

#[cfg(desktop)]
async fn wait_for_scraper_bridge_ready(
    scraper: &ScraperWebview,
    operation: &str,
    timeout: Duration,
) -> bool {
    let started = Instant::now();
    let poll_interval = Duration::from_millis(100);

    while started.elapsed() < timeout {
        if scraper_bridge_is_ready(scraper).await {
            return true;
        }
        tokio::time::sleep(poll_interval).await;
    }

    log::debug!("[scraper:{operation}] bridge readiness wait timed out");
    false
}

#[cfg(desktop)]
async fn document_has_browser_challenge(scraper: &ScraperWebview) -> bool {
    let challenged = eval_json::<bool>(
        scraper,
        r##"(function () {
  var title = (document.title || "").toLowerCase();
  var body = ((document.body && document.body.innerText) || "").toLowerCase();
  if (body.length > 12000) body = body.slice(0, 12000);
  var selectors = [
    "#challenge-running",
    "#cf-challenge-running",
    ".cf-browser-verification",
    ".cf-challenge",
    ".cf-turnstile",
    "input[name=\"cf-turnstile-response\"]",
    "iframe[src*=\"challenges.cloudflare.com\"]"
  ];
  for (var i = 0; i < selectors.length; i += 1) {
    if (document.querySelector(selectors[i])) return true;
  }
  return title.indexOf("just a moment") !== -1 ||
    title.indexOf("attention required") !== -1 ||
    body.indexOf("checking if the site connection is secure") !== -1 ||
    body.indexOf("verify you are human") !== -1 ||
    body.indexOf("enable javascript and cookies to continue") !== -1 ||
    body.indexOf("cf-chl") !== -1;
})()"##
            .to_string(),
    )
    .await;
    challenged.unwrap_or(false)
}

#[cfg(desktop)]
fn looks_like_browser_challenge_extract_result(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("cloudflare challenge")
        || lower.contains("\"kind\":\"cf\"")
        || lower.contains("\"kind\": \"cf\"")
}

#[cfg(desktop)]
async fn wait_for_browser_challenge_to_clear(
    scraper: &ScraperWebview,
    operation: &str,
    url: &str,
    timeout: Duration,
) -> bool {
    let started = Instant::now();
    let poll_interval = Duration::from_millis(250);
    let mut challenge_logged = false;

    while started.elapsed() < timeout {
        tokio::time::sleep(poll_interval).await;
        if !document_is_ready(scraper).await {
            continue;
        }
        if document_has_browser_challenge(scraper).await {
            if !challenge_logged {
                log::debug!(
                    "[scraper:{operation}] waiting browser challenge before retry url={url}"
                );
                challenge_logged = true;
            }
            continue;
        }
        return true;
    }

    false
}

#[cfg(desktop)]
async fn prepare_scraper_context(
    scraper: &ScraperWebview,
    context_url: Option<&str>,
    operation: &str,
    wait_for_browser_challenge: bool,
) -> Result<(), String> {
    let Some(context_url) = context_url else {
        return Ok(());
    };
    let target: Url = context_url.parse().map_err(|err| {
        format!("scraper: invalid {operation} context url '{context_url}': {err}")
    })?;

    if scraper_is_at_origin(scraper, &target)
        && document_is_ready(scraper).await
        && (!wait_for_browser_challenge || !document_has_browser_challenge(scraper).await)
    {
        return Ok(());
    }

    log::debug!("[scraper:{operation}] prepare context navigate url={context_url}");
    scraper
        .navigate(target.clone())
        .map_err(|err| format!("scraper: navigate {operation} context: {err}"))?;

    let deadline = Duration::from_secs(15);
    let poll_interval = Duration::from_millis(150);
    let started = Instant::now();
    let mut challenge_logged = false;

    while started.elapsed() < deadline {
        tokio::time::sleep(poll_interval).await;
        if scraper_is_at_origin(scraper, &target) && document_is_ready(scraper).await {
            if wait_for_browser_challenge && document_has_browser_challenge(scraper).await {
                if !challenge_logged {
                    log::debug!(
                        "[scraper:{operation}] prepare context waiting browser challenge url={context_url}"
                    );
                    challenge_logged = true;
                }
                continue;
            }
            log::debug!("[scraper:{operation}] prepare context ready url={context_url}");
            return Ok(());
        }
    }

    Err(format!(
        "scraper: timed out preparing {operation} context {context_url}"
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
    scraper
        .navigate(context)
        .map_err(|err| format!("scraper: reset {operation} context: {err}"))
}

#[cfg(desktop)]
async fn prepare_fetch_context(
    scraper: &ScraperWebview,
    context_url: Option<&str>,
) -> Result<(), String> {
    prepare_scraper_context(scraper, context_url, "fetch", false).await
}

#[cfg(desktop)]
async fn prepare_extract_context(scraper: &ScraperWebview, target: &Url) -> Result<(), String> {
    if !matches!(target.scheme(), "http" | "https") {
        return Ok(());
    }
    let context_url = origin_url(target);
    prepare_scraper_context(scraper, Some(&context_url), "extract", true).await
}

#[cfg(desktop)]
fn fetch_context_urls(url: &str, context_url: Option<&str>) -> Result<Vec<String>, String> {
    let request_url: Url = url
        .parse()
        .map_err(|err| format!("scraper: invalid fetch url '{url}': {err}"))?;
    let Some(context_url) = context_url else {
        return Ok(vec![origin_url(&request_url)]);
    };
    let parsed_context_url: Url = context_url
        .parse()
        .map_err(|err| format!("scraper: invalid context url '{context_url}': {err}"))?;
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
      const requestOrigin = new URL(request.url, location.href).origin;
      const fetchInit = {{
        method: init.method || "GET",
        headers,
        credentials: requestOrigin === location.origin ? "include" : "same-origin",
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
) -> Result<(), String> {
    let script = match before_script {
        Some(before_script) => {
            let before_script_json = serde_json::to_string(before_script)
                .map_err(|err| format!("webview_extract: serialize before script: {err}"))?;
            format!(
                r#"(function () {{
  try {{ window.__lnrExtractResult = null; }} catch (error) {{}}
  try {{
    window.name = "__lnr_script__=" + encodeURIComponent({before_script_json});
  }} catch (error) {{}}
}})();"#
            )
        }
        None => r#"(function () {
  try { window.__lnrExtractResult = null; } catch (error) {}
  try {
    if ((window.name || "").indexOf("__lnr_script__=") === 0) {
      window.name = "";
    }
  } catch (error) {}
})();"#
            .to_string(),
    };
    scraper
        .eval(script)
        .map_err(|err| format!("webview_extract: install before script: {err}"))
}

#[cfg(desktop)]
fn clear_webview_extract_result(scraper: &ScraperWebview, current_url: Option<&str>) {
    let _ = scraper.eval(
        r#"(function () {
  try { window.__lnrExtractResult = null; } catch (error) {}
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
    url: String,
    init: Option<FetchInit>,
    context_url: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<FetchResult, String> {
    let _: Url = url
        .parse()
        .map_err(|err| format!("scraper: invalid url '{url}': {err}"))?;
    prepare_fetch_context(scraper, context_url.as_deref()).await?;
    let init = init.unwrap_or_default();
    let request_id = format!("fetch-{}", FETCH_SEQUENCE.fetch_add(1, Ordering::Relaxed));
    let start_script = build_webview_fetch_start_script(&request_id, &url, &init)?;
    scraper
        .eval(start_script)
        .map_err(|err| format!("scraper: start browser fetch: {err}"))?;

    let deadline = Duration::from_millis(timeout_ms.unwrap_or(60_000).max(1));
    let poll_interval = Duration::from_millis(150);
    let started = Instant::now();

    while started.elapsed() < deadline {
        tokio::time::sleep(poll_interval).await;
        let poll_script = build_webview_fetch_poll_script(&request_id)?;
        let result: Option<WebviewFetchScriptResult> = eval_json(scraper, poll_script).await?;
        let Some(result) = result else {
            continue;
        };

        if !result.ok {
            let error = result
                .error
                .unwrap_or_else(|| "unknown browser fetch error".to_string());
            return Err(format!("scraper: browser fetch to {url} failed: {error}"));
        }

        return Ok(FetchResult {
            status: result
                .status
                .ok_or_else(|| "scraper: browser fetch missing status".to_string())?,
            status_text: result.status_text.unwrap_or_default(),
            body_base64: result.body_base64.unwrap_or_default(),
            headers: result.headers.unwrap_or_default(),
            final_url: result.final_url.unwrap_or(url),
        });
    }

    if let Ok(cleanup_script) = build_webview_fetch_cleanup_script(&request_id) {
        let _ = scraper.eval(cleanup_script);
    }

    Err(format!(
        "scraper: browser fetch to {url} timed out after {}ms",
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
    user_agent: Option<String>,
    queue: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<FetchResult, String> {
    let user_agent = normalize_user_agent(user_agent);
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let queue_lock = scraper_executor_lock(&state, &queue);
    let _queue_guard = queue_lock.lock().await;
    let fetch_contexts = fetch_context_urls(&url, context_url.as_deref())?;
    let init_log = fetch_init_for_log(&init);
    log::trace!(
        "[scraper:fetch] request queue={queue} request_url={url} configured_context={:?} fetch_contexts={fetch_contexts:?} timeout_ms={timeout_ms:?} user_agent={user_agent:?} init={init_log}",
        context_url
    );
    let scraper = scraper_handle_for_key(&app, &state, &queue, user_agent.as_deref())?;
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
            url.clone(),
            init.clone(),
            Some(fetch_context.clone()),
            timeout_ms,
        )
        .await;
        if result.is_ok() || index + 1 == fetch_contexts.len() {
            break;
        }
        if let Err(err) = &result {
            log::debug!(
                "[scraper:fetch] retrying with fallback context queue={queue} request_url={url} failed_context={fetch_context} error={err}"
            );
        }
    }
    match &result {
        Ok(result) => {
            let header_names: Vec<&String> = result.headers.keys().collect();
            log::trace!(
                "[scraper:fetch] response queue={queue} request_url={url} status={} final_url={} header_names={:?}",
                result.status,
                result.final_url,
                header_names
            );
        }
        Err(err) if err.contains("Request cancelled") => {
            log::debug!("[scraper:fetch] cancelled queue={queue} request_url={url}");
        }
        Err(err) => {
            log::error!("[scraper:fetch] failed queue={queue} request_url={url} error={err}");
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
    _user_agent: Option<String>,
    _queue: Option<String>,
    _timeout_ms: Option<u64>,
) -> Result<FetchResult, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[tauri::command]
pub async fn scraper_media_fetch(
    url: String,
    init: Option<FetchInit>,
    user_agent: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<FetchResult, String> {
    let user_agent = normalize_user_agent(user_agent);
    let init_log = fetch_init_for_log(&init);
    log::debug!(
        "[scraper:media_fetch] request url={url} timeout_ms={timeout_ms:?} user_agent={user_agent:?} init={init_log}"
    );

    let init = init.unwrap_or_default();
    let method = init.method.as_deref().unwrap_or("GET");
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|err| format!("scraper: invalid media fetch method '{method}': {err}"))?;
    let client = reqwest::Client::builder()
        .timeout(native_media_timeout(timeout_ms))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|err| format!("scraper: media fetch client: {err}"))?;

    let mut request = client.request(method, &url);
    if let Some(user_agent) = user_agent {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    if let Some(headers) = init.headers {
        for (name, value) in headers {
            if skip_native_media_header(&name) {
                continue;
            }
            let header_name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|err| format!("scraper: invalid media fetch header '{name}': {err}"))?;
            let header_value = reqwest::header::HeaderValue::from_str(&value).map_err(|err| {
                format!("scraper: invalid media fetch value for header '{name}': {err}")
            })?;
            request = request.header(header_name, header_value);
        }
    }
    if let Some(body) = init.body {
        request = request.body(body);
    }

    let response = request
        .send()
        .await
        .map_err(|err| format!("scraper: native media fetch to {url} failed: {err}"))?;
    let status = response.status();
    let final_url = response.url().to_string();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or("").to_string(),
            )
        })
        .collect::<HashMap<_, _>>();
    let header_names: Vec<&String> = headers.keys().collect();
    let body = response
        .bytes()
        .await
        .map_err(|err| format!("scraper: native media fetch body from {url} failed: {err}"))?;

    log::debug!(
        "[scraper:media_fetch] response url={url} status={} final_url={final_url} header_names={header_names:?} body_len={}",
        status.as_u16(),
        body.len()
    );

    Ok(FetchResult {
        status: status.as_u16(),
        status_text,
        body_base64: encode_base64(&body),
        headers,
        final_url,
    })
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
    let entry = state
        .webviews
        .lock()
        .expect("scraper webviews mutex")
        .get(&queue)
        .cloned();
    let Some(scraper) = entry.and_then(|entry| app.get_webview(&entry.label)) else {
        return Ok(false);
    };
    let script =
        build_webview_fetch_cancel_script(message.as_deref().unwrap_or("Request cancelled"))?;
    let cancelled: u32 = eval_json(&scraper, script).await?;
    if cancelled > 0 {
        log::debug!("[scraper:fetch] cancelled queue={queue} count={cancelled}");
    }
    Ok(cancelled > 0)
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
/// chapter HTML inside a closed shadow root that only a real Chromium
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
    user_agent: Option<String>,
    queue: Option<String>,
) -> Result<String, String> {
    let user_agent = normalize_user_agent(user_agent);
    let queue = normalize_scraper_executor(queue.as_deref())?;
    let queue_lock = scraper_executor_lock(&state, &queue);
    let _queue_guard = queue_lock.lock().await;
    let scraper = scraper_handle_for_key(&app, &state, &queue, user_agent.as_deref())?;
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
        "[scraper:extract] request queue={queue} url={url} timeout_ms={timeout_ms:?} user_agent={user_agent:?} before_script_len={}",
        before_script.as_ref().map(|script| script.len()).unwrap_or(0)
    );
    log_scraper_cookies(
        &scraper,
        &queue,
        "before_webview_extract",
        vec![("request", url.clone())],
    );

    let before_script = before_script.as_deref().filter(|script| !script.is_empty());
    let target_url_str = url.clone();

    let parsed: Url = target_url_str
        .parse()
        .map_err(|err| format!("webview_extract: invalid url '{target_url_str}': {err}"))?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let poll_interval = Duration::from_millis(150);
    let result_marker = "#__lnr_result__=";
    let mut retried_after_browser_challenge = false;
    let max_attempts = 2;

    for attempt in 1..=max_attempts {
        prepare_extract_context(&scraper, &parsed).await?;
        wait_for_scraper_bridge_ready(&scraper, "extract", Duration::from_secs(5)).await;
        install_webview_extract_before_script(&scraper, before_script)?;

        log::trace!(
            "[scraper:extract] navigate queue={queue} url={url} target_url={target_url_str} attempt={attempt}"
        );

        scraper
            .navigate(parsed.clone())
            .map_err(|err| format!("webview_extract: navigate: {err}"))?;

        let start = Instant::now();
        while start.elapsed() < timeout {
            tokio::time::sleep(poll_interval).await;
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
                if !retried_after_browser_challenge
                    && looks_like_browser_challenge_extract_result(&decoded)
                {
                    retried_after_browser_challenge = true;
                    clear_webview_extract_result(&scraper, current_url.as_deref());
                    let remaining = timeout.checked_sub(start.elapsed()).unwrap_or_default();
                    let wait_budget = remaining.min(Duration::from_secs(20));
                    if wait_budget > Duration::from_millis(0)
                        && wait_for_browser_challenge_to_clear(
                            &scraper,
                            "extract",
                            &url,
                            wait_budget,
                        )
                        .await
                    {
                        reset_extract_navigation(&scraper, &parsed, "extract")?;
                        prepare_extract_context(&scraper, &parsed).await?;
                        wait_for_scraper_bridge_ready(&scraper, "extract", Duration::from_secs(5))
                            .await;
                        install_webview_extract_before_script(&scraper, before_script)?;
                        log::debug!(
                            "[scraper:extract] retry after browser challenge queue={queue} url={url}"
                        );
                        scraper.navigate(parsed.clone()).map_err(|err| {
                            format!("webview_extract: retry after browser challenge: {err}")
                        })?;
                        continue;
                    }
                }
                // Clear result state without leaving the source origin. Navigating
                // away would force the next fetch to prepare the source context again.
                clear_webview_extract_result(&scraper, current_url.as_deref());
                let current_for_log = current_url.as_deref().unwrap_or("<script-result>");
                let result_len = decoded.len();
                log::trace!(
                    "[scraper:extract] complete queue={queue} url={url} current_url={current} result_len={result_len}",
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

        if attempt < max_attempts {
            log::debug!(
                "[scraper:extract] timeout before extract result; retrying queue={queue} url={url} attempt={attempt}"
            );
            reset_extract_navigation(&scraper, &parsed, "extract")?;
        }
    }

    clear_webview_extract_result(&scraper, None);
    log::error!(
        "[scraper:extract] timeout queue={queue} url={url} current_url={}",
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
    _user_agent: Option<String>,
    _queue: Option<String>,
) -> Result<String, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}
