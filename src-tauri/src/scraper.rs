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

use serde::{Deserialize, Serialize};

#[cfg(desktop)]
mod desktop;
#[cfg(not(desktop))]
mod mobile_stubs;
#[cfg(desktop)]
mod scripts;

// Glob re-exports also carry the `__cmd__*` wrapper macros that
// `tauri::generate_handler!` resolves next to each command path.
#[cfg(desktop)]
pub use desktop::*;
#[cfg(not(desktop))]
pub use mobile_stubs::*;

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
