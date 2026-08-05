use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_CAPTURED_RESOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CAPTURED_TOTAL_BYTES: usize = 256 * 1024 * 1024;

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

    pub async fn wait_until_idle(&self, executor: &str, capture_id: u64, timeout: Duration) {
        let started = Instant::now();
        loop {
            let pending = self
                .sessions
                .lock()
                .expect("captured resource sessions mutex")
                .get(executor)
                .filter(|session| session.id == capture_id)
                .map(|session| session.pending)
                .unwrap_or(0);
            if pending == 0 || started.elapsed() >= timeout {
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
    use super::{CapturedResource, CapturedResourceStore, MAX_CAPTURED_RESOURCE_BYTES};
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{Webview, Wry};
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2WebResourceResponseReceivedEventArgs, ICoreWebView2_2,
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
    ) -> WebResourceResponseReceivedEventHandler {
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
        let (url, response, status, status_text, headers) = unsafe {
            let request = args.Request().map_err(|error| error.to_string())?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri).map_err(|error| error.to_string())?;
            let url = take_pwstr(uri);
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
            (url, response, status, take_pwstr(reason), headers)
        };
        if status != 200 || !is_media_response(&url, &headers) {
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
                    let body = read_stream(stream).ok();
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

    fn is_media_response(url: &str, headers: &HashMap<String, String>) -> bool {
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return false;
        }
        let content_type = headers
            .get("content-type")
            .map(|value| value.split(';').next().unwrap_or("").trim())
            .unwrap_or("");
        if content_type.starts_with("image/")
            || content_type.starts_with("audio/")
            || content_type.starts_with("video/")
            || matches!(content_type, "application/octet-stream" | "application/pdf")
        {
            return true;
        }
        let path = url
            .split(['?', '#'])
            .next()
            .unwrap_or(url)
            .to_ascii_lowercase();
        [
            ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp", ".aac", ".flac",
            ".m4a", ".mp3", ".ogg", ".wav", ".m4v", ".mp4", ".webm", ".pdf",
        ]
        .iter()
        .any(|extension| path.ends_with(extension))
    }

    fn read_stream(stream: AgileReference<IStream>) -> Result<Vec<u8>, String> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let result = stream
            .resolve()
            .map_err(|error| error.to_string())
            .and_then(|stream| read_stream_body(&stream));
        if initialized.is_ok() {
            unsafe { CoUninitialize() };
        }
        result
    }

    fn read_stream_body(stream: &IStream) -> Result<Vec<u8>, String> {
        let mut body = Vec::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
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
            if read == 0 {
                break;
            }
            if body.len().saturating_add(read as usize) > MAX_CAPTURED_RESOURCE_BYTES {
                return Err("captured response exceeded the per-resource limit".to_string());
            }
            body.extend_from_slice(&buffer[..read as usize]);
        }
        Ok(body)
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
}
