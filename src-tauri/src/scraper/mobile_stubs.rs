//! Mobile stand-ins for the desktop scraper commands; these platforms have no
//! child scraper WebView.

use tauri::AppHandle;

use super::{CapturedResourceHandleResult, FetchInit, FetchResult};

const SCRAPER_UNAVAILABLE: &str = "scraper: child webview is not available on this platform";

#[derive(Default)]
pub struct ScraperState;

pub fn init_scraper(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn scraper_open_devtools(_app: AppHandle) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[cfg(not(debug_assertions))]
#[tauri::command]
pub fn scraper_open_devtools(_app: AppHandle) -> Result<(), String> {
    Err("devtools only available in debug builds".to_string())
}

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

#[tauri::command]
pub async fn scraper_hide(_app: AppHandle) -> Result<(), String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn scraper_current_origin(
    _app: AppHandle,
    _source_id: Option<String>,
) -> Result<Option<String>, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

#[tauri::command]
pub async fn scraper_clear_cache(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
) -> Result<(), String> {
    Err("scraper_clear_cache is only available on Windows".to_string())
}

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

#[cfg(not(target_os = "android"))]
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

#[tauri::command]
pub async fn scraper_cancel_executor(
    _app: AppHandle,
    _state: tauri::State<'_, ScraperState>,
    _queue: Option<String>,
    _message: Option<String>,
) -> Result<bool, String> {
    Err(SCRAPER_UNAVAILABLE.to_string())
}

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
