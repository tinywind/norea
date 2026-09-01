use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_CAPTURED_RESOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CAPTURED_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY: &str = "norea-chapter-pages-v1";

#[cfg(any(test, target_os = "windows"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResponseCapturePolicy {
    TrustedMedia,
    RequireImageSignature,
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
        .map(|_| ResponseCapturePolicy::RequireImageSignature)
}

#[cfg(any(test, target_os = "windows"))]
fn has_image_signature(body: &[u8]) -> bool {
    body.starts_with(b"\xff\xd8\xff")
        || body.starts_with(b"\x89PNG\r\n\x1a\n")
        || body.starts_with(b"GIF87a")
        || body.starts_with(b"GIF89a")
        || (body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP")
        || (body.len() >= 12 && &body[4..8] == b"ftyp" && matches!(&body[8..12], b"avif" | b"avis"))
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
    source_id: Option<String>,
    active: bool,
    activity: u64,
    pending: usize,
    total_bytes: usize,
    resources: HashMap<String, CapturedResource>,
    aliases: HashMap<String, String>,
    resource_order: VecDeque<String>,
}

#[derive(Default)]
pub struct CapturedResourceStore {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, CaptureSession>>,
    source_ids: Mutex<HashMap<String, String>>,
}

impl CapturedResourceStore {
    pub fn register_source(&self, executor: &str, source_id: &str) {
        let mut source_ids = self
            .source_ids
            .lock()
            .expect("captured resource source ids mutex");
        let previous_source_id = source_ids.insert(executor.to_string(), source_id.to_string());
        if previous_source_id.as_deref() != Some(source_id) {
            self.sessions
                .lock()
                .expect("captured resource sessions mutex")
                .remove(executor);
        }
    }

    pub fn begin(&self, executor: &str) -> u64 {
        let source_id = self
            .source_ids
            .lock()
            .expect("captured resource source ids mutex")
            .get(executor)
            .cloned();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .insert(
                executor.to_string(),
                CaptureSession {
                    id,
                    source_id,
                    active: true,
                    ..CaptureSession::default()
                },
            );
        id
    }

    #[cfg(target_os = "windows")]
    pub fn begin_or_resume(&self, executor: &str) -> u64 {
        let source_id = self
            .source_ids
            .lock()
            .expect("captured resource source ids mutex")
            .get(executor)
            .cloned();
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        if let Some(session) = sessions.get_mut(executor) {
            if !session.active {
                session.id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
                session.activity = session.activity.wrapping_add(1);
                session.pending = 0;
                session.total_bytes = 0;
                session.resources.clear();
                session.aliases.clear();
                session.resource_order.clear();
            }
            session.source_id = source_id;
            session.active = true;
            return session.id;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        sessions.insert(
            executor.to_string(),
            CaptureSession {
                id,
                source_id,
                active: true,
                ..CaptureSession::default()
            },
        );
        id
    }

    #[cfg(test)]
    pub fn claim(&self, executor: &str) -> Option<u64> {
        self.claim_for_source(executor, None)
    }

    fn claim_for_source(&self, executor: &str, expected_source_id: Option<&str>) -> Option<u64> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let session = sessions.get_mut(executor)?;
        if !session.active
            || expected_source_id
                .is_some_and(|source_id| session.source_id.as_deref() != Some(source_id))
        {
            return None;
        }
        session.activity = session.activity.wrapping_add(1);
        session.pending += 1;
        Some(session.id)
    }

    pub fn complete(&self, executor: &str, capture_id: u64, resource: Option<CapturedResource>) {
        self.complete_with_total_limit(executor, capture_id, resource, MAX_CAPTURED_TOTAL_BYTES);
    }

    fn complete_with_total_limit(
        &self,
        executor: &str,
        capture_id: u64,
        resource: Option<CapturedResource>,
        max_total_bytes: usize,
    ) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let Some(session) = sessions.get_mut(executor) else {
            return;
        };
        if session.id != capture_id || !session.active {
            return;
        }
        session.activity = session.activity.wrapping_add(1);
        session.pending = session.pending.saturating_sub(1);
        let Some(resource) = resource else {
            return;
        };
        if resource.body.is_empty()
            || resource.body.len() > MAX_CAPTURED_RESOURCE_BYTES
            || resource.body.len() > max_total_bytes
        {
            return;
        }
        let key = normalized_resource_url(&resource.final_url);
        insert_resource(session, key, resource, max_total_bytes);
    }

    fn complete_redirect(
        &self,
        executor: &str,
        capture_id: u64,
        request_url: &str,
        redirect_url: &str,
    ) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let Some(session) = sessions.get_mut(executor) else {
            return;
        };
        if session.id != capture_id || !session.active {
            return;
        }
        session.activity = session.activity.wrapping_add(1);
        session.pending = session.pending.saturating_sub(1);
        let request_url = normalized_resource_url(request_url);
        let redirect_url = normalized_resource_url(redirect_url);
        if request_url != redirect_url {
            session.aliases.insert(request_url, redirect_url);
        }
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

    pub fn interrupt(&self, executor: &str) {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let Some(session) = sessions.get_mut(executor) else {
            return;
        };
        session.id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        session.active = false;
        session.activity = session.activity.wrapping_add(1);
        session.pending = 0;
        session.total_bytes = 0;
        session.resources.clear();
        session.aliases.clear();
        session.resource_order.clear();
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

    pub fn take_for_source(
        &self,
        executor: &str,
        source_id: &str,
        url: &str,
    ) -> Option<CapturedResource> {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let session = sessions.get_mut(executor)?;
        if session.source_id.as_deref() != Some(source_id) {
            return None;
        }
        let requested_url = normalized_resource_url(url);
        let resource_url = resolve_resource_alias(session, &requested_url);
        let resource = session.resources.remove(&resource_url)?;
        session.total_bytes = session.total_bytes.saturating_sub(resource.body.len());
        session
            .resource_order
            .retain(|existing| existing != &resource_url);
        session.aliases.retain(|alias, target| {
            alias != &requested_url && alias != &resource_url && target != &resource_url
        });
        Some(resource)
    }

    #[cfg(test)]
    pub fn take(&self, executor: &str, url: &str) -> Option<CapturedResource> {
        let source_id = self
            .source_ids
            .lock()
            .expect("captured resource source ids mutex")
            .get(executor)
            .cloned();
        if let Some(source_id) = source_id {
            return self.take_for_source(executor, &source_id, url);
        }
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        let session = sessions.get_mut(executor)?;
        let requested_url = normalized_resource_url(url);
        let resource_url = resolve_resource_alias(session, &requested_url);
        let resource = session.resources.remove(&resource_url)?;
        session.total_bytes = session.total_bytes.saturating_sub(resource.body.len());
        session
            .resource_order
            .retain(|existing| existing != &resource_url);
        Some(resource)
    }

    pub fn clear(&self, executor: &str) {
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .remove(executor);
        self.source_ids
            .lock()
            .expect("captured resource source ids mutex")
            .remove(executor);
    }

    pub fn clear_all(&self) {
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .clear();
        self.source_ids
            .lock()
            .expect("captured resource source ids mutex")
            .clear();
    }
}

fn insert_resource(
    session: &mut CaptureSession,
    key: String,
    resource: CapturedResource,
    max_total_bytes: usize,
) {
    if let Some(replaced) = session.resources.remove(&key) {
        session.total_bytes = session.total_bytes.saturating_sub(replaced.body.len());
        session.resource_order.retain(|existing| existing != &key);
    }
    while session.total_bytes.saturating_add(resource.body.len()) > max_total_bytes {
        let Some(oldest_key) = session.resource_order.pop_front() else {
            return;
        };
        if let Some(evicted) = session.resources.remove(&oldest_key) {
            session.total_bytes = session.total_bytes.saturating_sub(evicted.body.len());
        }
        session
            .aliases
            .retain(|alias, target| alias != &oldest_key && target != &oldest_key);
    }
    session.total_bytes = session.total_bytes.saturating_add(resource.body.len());
    session.resource_order.push_back(key.clone());
    session.resources.insert(key, resource);
}

fn resolve_resource_alias(session: &CaptureSession, url: &str) -> String {
    let mut url = url.to_string();
    let mut seen = HashSet::new();
    while seen.insert(url.clone()) {
        let Some(target) = session.aliases.get(&url) else {
            break;
        };
        url = target.clone();
    }
    url
}

fn normalized_resource_url(url: &str) -> String {
    url.split_once('#')
        .map(|(without_fragment, _)| without_fragment)
        .unwrap_or(url)
        .to_string()
}

#[cfg(target_os = "windows")]
fn normalized_http_url(url: &str) -> Option<String> {
    let mut parsed = tauri::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

pub fn remove_legacy_chapter_page_cache(profile_directory: &Path) -> Result<(), String> {
    let path = profile_directory.join(LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "legacy chapter page cache path is a symlink: '{}'",
            path.display()
        )),
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&path).map_err(|error| {
            format!(
                "remove legacy chapter page cache directory '{}': {error}",
                path.display()
            )
        }),
        Ok(_) => Err(format!(
            "legacy chapter page cache path is not a directory: '{}'",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "inspect legacy chapter page cache path '{}': {error}",
            path.display()
        )),
    }
}

pub(crate) fn response_is_cloudflare_challenge(
    headers: &HashMap<String, String>,
    body: &[u8],
) -> bool {
    let header_value = |name: &str| {
        headers
            .iter()
            .find_map(|(key, value)| key.eq_ignore_ascii_case(name).then_some(value.as_str()))
    };
    if header_value("cf-mitigated")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("challenge"))
    {
        return true;
    }

    let prefix = &body[..body.len().min(512 * 1024)];
    let body_text = String::from_utf8_lossy(prefix).to_ascii_lowercase();
    let trimmed = body_text.trim_start_matches(|character: char| {
        character.is_ascii_whitespace() || character == '\u{feff}'
    });
    let content_type = header_value("content-type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let looks_like_html = content_type.contains("text/html")
        || content_type.contains("application/xhtml+xml")
        || ["<!doctype html", "<html", "<head", "<body"]
            .iter()
            .any(|prefix| trimmed.starts_with(prefix));
    if !looks_like_html {
        return false;
    }

    body_text.contains("/cdn-cgi/challenge-platform/")
        || body_text.contains("cf-chl-")
        || body_text.contains("__cf_chl_")
        || ["form", "running", "stage"].iter().any(|suffix| {
            body_text.contains(&format!("id=\"challenge-{suffix}\""))
                || body_text.contains(&format!("id='challenge-{suffix}'"))
        })
        || (body_text.contains("cloudflare ray id")
            && (body_text.contains("attention required")
                || body_text.contains("sorry, you have been blocked")))
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
        CapturedResource, CapturedResourceStore, MAX_CAPTURED_RESOURCE_BYTES,
        ResponseCapturePolicy, has_image_signature, normalized_http_url, normalized_resource_url,
        response_capture_policy,
    };
    use std::collections::{HashMap, VecDeque};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tauri::{Webview, Wry};
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
        ICoreWebView2_2, ICoreWebView2WebResourceRequest,
        ICoreWebView2WebResourceRequestedEventArgs, ICoreWebView2WebResourceRequestedEventHandler,
        ICoreWebView2WebResourceResponseReceivedEventArgs,
        ICoreWebView2WebResourceResponseReceivedEventHandler,
    };
    use webview2_com::{
        WebResourceRequestedEventHandler, WebResourceResponseReceivedEventHandler,
        WebResourceResponseViewGetContentCompletedHandler, take_pwstr,
    };
    use windows::Win32::System::Com::{
        COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, IStream,
    };
    use windows::core::{AgileReference, HSTRING, IUnknown, Interface, PWSTR};

    const MAX_PENDING_RESOURCE_CAPTURES: usize = 8192;

    #[derive(Clone, Debug, Hash, PartialEq, Eq)]
    struct PendingResourceKey {
        method: String,
        range: Option<String>,
        url: String,
    }

    struct PendingResourceCapture {
        capture_id: u64,
        key: PendingResourceKey,
        _retained_request: Option<AgileReference<IUnknown>>,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum PendingResourceMatch {
        Identity,
        ExactUrl,
    }

    #[derive(Default)]
    struct PendingResourceCaptures {
        next_sequence: u64,
        captures: HashMap<u64, PendingResourceCapture>,
        by_identity: HashMap<usize, VecDeque<u64>>,
        by_key: HashMap<PendingResourceKey, VecDeque<u64>>,
        order: VecDeque<u64>,
    }

    impl PendingResourceCaptures {
        fn insert(
            &mut self,
            request_identity: usize,
            capture: PendingResourceCapture,
        ) -> Vec<PendingResourceCapture> {
            let mut abandoned = Vec::new();
            if let Some(previous) = self.by_identity.get(&request_identity).cloned() {
                for sequence in previous {
                    if let Some(capture) = self.remove(sequence) {
                        abandoned.push(capture);
                    }
                }
            }
            while self.captures.len() >= MAX_PENDING_RESOURCE_CAPTURES {
                let Some(oldest) = self.order.front().copied() else {
                    break;
                };
                if let Some(capture) = self.remove(oldest) {
                    abandoned.push(capture);
                }
            }
            self.next_sequence = self.next_sequence.wrapping_add(1).max(1);
            let sequence = self.next_sequence;
            self.by_identity
                .entry(request_identity)
                .or_default()
                .push_back(sequence);
            self.by_key
                .entry(capture.key.clone())
                .or_default()
                .push_back(sequence);
            self.order.push_back(sequence);
            self.captures.insert(sequence, capture);
            abandoned
        }

        fn take(
            &mut self,
            request_identity: Option<usize>,
            key: &PendingResourceKey,
        ) -> Option<(PendingResourceCapture, PendingResourceMatch)> {
            let identity_match = request_identity.and_then(|request_identity| {
                self.by_identity
                    .get(&request_identity)
                    .into_iter()
                    .flatten()
                    .copied()
                    .find(|sequence| self.captures.contains_key(sequence))
            });
            if let Some(sequence) = identity_match {
                return self
                    .remove(sequence)
                    .map(|capture| (capture, PendingResourceMatch::Identity));
            }
            let candidates = self
                .by_key
                .get(key)?
                .iter()
                .filter(|sequence| self.captures.contains_key(sequence))
                .copied()
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                return None;
            }
            self.remove(candidates[0])
                .map(|capture| (capture, PendingResourceMatch::ExactUrl))
        }

        fn take_identity(&mut self, request_identity: usize) -> Vec<PendingResourceCapture> {
            self.by_identity
                .get(&request_identity)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|sequence| self.remove(sequence))
                .collect()
        }

        fn remove(&mut self, sequence: u64) -> Option<PendingResourceCapture> {
            let capture = self.captures.remove(&sequence)?;
            self.order.retain(|existing| *existing != sequence);
            for sequences in self.by_identity.values_mut() {
                sequences.retain(|existing| *existing != sequence);
            }
            self.by_identity.retain(|_, sequences| !sequences.is_empty());
            let remove_key = if let Some(sequences) = self.by_key.get_mut(&capture.key) {
                sequences.retain(|existing| *existing != sequence);
                sequences.is_empty()
            } else {
                false
            };
            if remove_key {
                self.by_key.remove(&capture.key);
            }
            Some(capture)
        }
    }

    pub async fn install(
        webview: &Webview<Wry>,
        executor: String,
        source_id: String,
        resource_store: Arc<CapturedResourceStore>,
    ) -> Result<(), String> {
        let (sender, receiver) = oneshot::channel();
        let pending_resource_captures = Arc::new(Mutex::new(PendingResourceCaptures::default()));
        webview
            .with_webview(move |platform_webview| {
                let result = unsafe {
                    (|| -> Result<(), String> {
                        let core = platform_webview
                            .controller()
                            .CoreWebView2()
                            .map_err(|error| error.to_string())?;
                        let request_handler = request_handler(
                            executor.clone(),
                            source_id,
                            Arc::clone(&resource_store),
                            Arc::clone(&pending_resource_captures),
                        );
                        core.AddWebResourceRequestedFilter(
                            &HSTRING::from("*"),
                            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
                        )
                        .map_err(|error| error.to_string())?;
                        let mut request_token = 0;
                        core.add_WebResourceRequested(&request_handler, &mut request_token)
                            .map_err(|error| error.to_string())?;

                        let core = core
                            .cast::<ICoreWebView2_2>()
                            .map_err(|error| error.to_string())?;
                        let response_handler =
                            response_handler(executor, resource_store, pending_resource_captures);
                        let mut response_token = 0;
                        core.add_WebResourceResponseReceived(&response_handler, &mut response_token)
                            .map_err(|error| error.to_string())
                    })()
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

    fn request_handler(
        executor: String,
        source_id: String,
        resource_store: Arc<CapturedResourceStore>,
        pending_resource_captures: Arc<Mutex<PendingResourceCaptures>>,
    ) -> ICoreWebView2WebResourceRequestedEventHandler {
        WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            if let Err(error) = handle_image_request(
                &args,
                &executor,
                &source_id,
                &resource_store,
                &pending_resource_captures,
            ) {
                log::debug!(
                    "[scraper:resource_capture] image request ignored executor={executor}: {error}"
                );
            }
            Ok(())
        }))
    }

    fn handle_image_request(
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        executor: &str,
        source_id: &str,
        resource_store: &Arc<CapturedResourceStore>,
        pending_resource_captures: &Mutex<PendingResourceCaptures>,
    ) -> Result<(), String> {
        let (request, url, method, range, context) = unsafe {
            let request = args.Request().map_err(|error| error.to_string())?;
            let url = request_uri(&request)?;
            let method = request_method(&request)?;
            let range = request_header(&request, "Range");
            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
            args.ResourceContext(&mut context)
                .map_err(|error| error.to_string())?;
            (request, url, method, range, context)
        };
        if context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE
            || !method.eq_ignore_ascii_case("GET")
            || normalized_http_url(&url).is_none()
            || range.is_some()
        {
            return Ok(());
        }
        let Some(capture_id) = resource_store.claim_for_source(executor, Some(source_id)) else {
            return Ok(());
        };
        let request_identity = request_identity(&request).map_err(|error| {
            resource_store.complete(executor, capture_id, None);
            error
        })?;
        let retained_request = agile_unknown(&request).map_err(|error| {
            resource_store.complete(executor, capture_id, None);
            error
        })?;
        let capture = PendingResourceCapture {
            capture_id,
            key: pending_resource_key(&url, &method, range),
            _retained_request: Some(retained_request),
        };
        let abandoned = pending_resource_captures
            .lock()
            .expect("pending resource captures mutex")
            .insert(request_identity, capture);
        for capture in abandoned {
            resource_store.complete(executor, capture.capture_id, None);
        }
        Ok(())
    }

    fn response_handler(
        executor: String,
        resource_store: Arc<CapturedResourceStore>,
        pending_resource_captures: Arc<Mutex<PendingResourceCaptures>>,
    ) -> ICoreWebView2WebResourceResponseReceivedEventHandler {
        WebResourceResponseReceivedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                if let Err(error) = capture_response(
                    &args,
                    &executor,
                    &resource_store,
                    &pending_resource_captures,
                ) {
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
        resource_store: &Arc<CapturedResourceStore>,
        pending_resource_captures: &Mutex<PendingResourceCaptures>,
    ) -> Result<(), String> {
        let request = unsafe { args.Request().map_err(|error| error.to_string())? };
        let request_identity = request_identity(&request).ok();
        let request_metadata = unsafe {
            (|| -> Result<_, String> {
                Ok((
                    request_uri(&request)?,
                    request_method(&request)?,
                    request_header(&request, "Range"),
                ))
            })()
        };
        let (url, method, range) = match request_metadata {
            Ok(metadata) => metadata,
            Err(error) => {
                let abandoned = request_identity
                    .map(|request_identity| {
                        pending_resource_captures
                            .lock()
                            .expect("pending resource captures mutex")
                            .take_identity(request_identity)
                    })
                    .unwrap_or_default();
                for capture in abandoned {
                    resource_store.complete(executor, capture.capture_id, None);
                }
                return Err(error);
            }
        };
        let resource_key = pending_resource_key(&url, &method, range);
        let Some((capture, matched_by)) = pending_resource_captures
            .lock()
            .expect("pending resource captures mutex")
            .take(request_identity, &resource_key)
        else {
            return Ok(());
        };
        log::trace!(
            "[scraper:resource_capture] matched executor={executor} matched_by={matched_by:?}"
        );
        let response_metadata = unsafe {
            (|| -> Result<_, String> {
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
                Ok((response, status, take_pwstr(reason), headers))
            })()
        };
        let (response, status, status_text, headers) = match response_metadata {
            Ok(metadata) => metadata,
            Err(error) => {
                resource_store.complete(executor, capture.capture_id, None);
                return Err(error);
            }
        };
        if let Some(redirect_url) = resource_redirect_url(&url, status, &headers) {
            resource_store.complete_redirect(executor, capture.capture_id, &url, &redirect_url);
            return Ok(());
        }
        let Some(policy) = response_capture_policy(&url, &headers, Some("image")) else {
            resource_store.complete(executor, capture.capture_id, None);
            return Ok(());
        };
        if status != 200 {
            resource_store.complete(executor, capture.capture_id, None);
            return Ok(());
        }

        let capture_id = capture.capture_id;
        let executor = executor.to_string();
        let get_content_executor = executor.clone();
        let callback_resource_store = Arc::clone(resource_store);
        let callback = WebResourceResponseViewGetContentCompletedHandler::create(Box::new(
            move |result, stream| {
                if result.is_err() || stream.is_none() {
                    callback_resource_store.complete(&executor, capture_id, None);
                    return Ok(());
                }
                let stream = stream.expect("captured response stream");
                let stream = match AgileReference::new(&stream) {
                    Ok(stream) => stream,
                    Err(error) => {
                        log::debug!(
                            "[scraper:resource_capture] stream marshal failed executor={executor}: {error}"
                        );
                        callback_resource_store.complete(&executor, capture_id, None);
                        return Ok(());
                    }
                };
                let worker_resource_store = Arc::clone(&callback_resource_store);
                tauri::async_runtime::spawn_blocking(move || {
                    let body = match read_stream(stream, policy, MAX_CAPTURED_RESOURCE_BYTES) {
                        Ok(body) => body,
                        Err(error) => {
                            log::debug!(
                                "[scraper:resource_capture] stream read failed executor={executor}: {error}"
                            );
                            None
                        }
                    };
                    let resource = body.map(|body| CapturedResource {
                        status: status as u16,
                        status_text,
                        headers,
                        final_url: url,
                        body,
                    });
                    worker_resource_store.complete(&executor, capture_id, resource);
                });
                Ok(())
            },
        ));
        if let Err(error) = unsafe { response.GetContent(&callback) } {
            resource_store.complete(&get_content_executor, capture_id, None);
            return Err(error.to_string());
        }
        Ok(())
    }

    fn pending_resource_key(
        url: &str,
        method: &str,
        range: Option<String>,
    ) -> PendingResourceKey {
        PendingResourceKey {
            method: method.to_ascii_uppercase(),
            range: range.and_then(|value| {
                let value = value.trim().to_string();
                (!value.is_empty()).then_some(value)
            }),
            url: normalized_resource_url(url),
        }
    }

    fn agile_unknown<T: Interface>(value: &T) -> Result<AgileReference<IUnknown>, String> {
        let value = value
            .cast::<IUnknown>()
            .map_err(|error| error.to_string())?;
        AgileReference::new(&value).map_err(|error| error.to_string())
    }

    unsafe fn request_uri(request: &ICoreWebView2WebResourceRequest) -> Result<String, String> {
        let mut uri = PWSTR::null();
        request.Uri(&mut uri).map_err(|error| error.to_string())?;
        Ok(take_pwstr(uri))
    }

    fn request_identity(request: &ICoreWebView2WebResourceRequest) -> Result<usize, String> {
        request
            .cast::<IUnknown>()
            .map(|request| request.as_raw() as usize)
            .map_err(|error| error.to_string())
    }

    fn resource_redirect_url(
        request_url: &str,
        status: i32,
        headers: &HashMap<String, String>,
    ) -> Option<String> {
        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return None;
        }
        let location = headers.get("location")?;
        let redirect_url = tauri::Url::parse(request_url).ok()?.join(location).ok()?;
        normalized_http_url(redirect_url.as_str())
    }

    unsafe fn request_method(
        request: &ICoreWebView2WebResourceRequest,
    ) -> Result<String, String> {
        let mut method = PWSTR::null();
        request
            .Method(&mut method)
            .map_err(|error| error.to_string())?;
        Ok(take_pwstr(method))
    }

    unsafe fn request_header(
        request: &ICoreWebView2WebResourceRequest,
        name: &str,
    ) -> Option<String> {
        let headers = request.Headers().ok()?;
        let mut value = PWSTR::null();
        headers.GetHeader(&HSTRING::from(name), &mut value).ok()?;
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
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let result = stream
            .resolve()
            .map_err(|error| error.to_string())
            .and_then(|stream| read_stream_body(&stream, policy, max_bytes));
        if initialized.is_ok() {
            unsafe { CoUninitialize() };
        }
        result
    }

    fn read_stream_body(
        stream: &IStream,
        policy: ResponseCapturePolicy,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        let mut body = Vec::new();
        if policy == ResponseCapturePolicy::RequireImageSignature {
            let mut signature = [0_u8; 12];
            let mut offset = 0;
            while offset < signature.len() {
                let read = read_stream_chunk(stream, &mut signature[offset..])?;
                if read == 0 {
                    return Ok(None);
                }
                offset += read;
            }
            if !has_image_signature(&signature) {
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
            if body.len().saturating_add(read) > max_bytes {
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

    #[cfg(test)]
    fn pending_test_capture(
        capture_id: u64,
        key: PendingResourceKey,
    ) -> PendingResourceCapture {
        PendingResourceCapture {
            capture_id,
            key,
            _retained_request: None,
        }
    }

    #[cfg(test)]
    #[test]
    fn pending_resource_capture_replaces_a_reused_request_identity() {
        let mut pending = PendingResourceCaptures::default();
        let key = pending_resource_key("https://cdn.test/page.jpg", "GET", None);
        assert!(pending
            .insert(1, pending_test_capture(10, key.clone()))
            .is_empty());
        assert_eq!(
            pending
                .insert(1, pending_test_capture(11, key.clone()))
                .into_iter()
                .map(|capture| capture.capture_id)
                .collect::<Vec<_>>(),
            vec![10]
        );
        assert_eq!(
            pending
                .take(Some(1), &key)
                .map(|(capture, matched_by)| (capture.capture_id, matched_by)),
            Some((11, PendingResourceMatch::Identity))
        );
    }

    #[cfg(test)]
    #[test]
    fn pending_resource_capture_rejects_an_ambiguous_url_fallback() {
        let mut pending = PendingResourceCaptures::default();
        let key = pending_resource_key("https://cdn.test/page.jpg", "GET", None);
        assert!(pending
            .insert(1, pending_test_capture(10, key.clone()))
            .is_empty());
        assert!(pending
            .insert(2, pending_test_capture(11, key.clone()))
            .is_empty());
        assert!(pending.take(Some(3), &key).is_none());
    }

    #[cfg(test)]
    #[test]
    fn media_redirects_only_accept_followable_http_statuses() {
        let headers = HashMap::from([(
            "location".to_string(),
            "https://cdn.test/final.jpg".to_string(),
        )]);
        for status in [301, 302, 303, 307, 308] {
            assert_eq!(
                resource_redirect_url("https://cdn.test/request.jpg", status, &headers),
                Some("https://cdn.test/final.jpg".to_string())
            );
        }
        for status in [300, 304, 305, 306, 309, 399] {
            assert_eq!(
                resource_redirect_url("https://cdn.test/request.jpg", status, &headers),
                None
            );
        }
    }
}

#[cfg(target_os = "windows")]
pub use windows_capture::install as install_windows_capture;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
    fn stores_and_consumes_a_response_only_in_its_executor_and_source() {
        let store = CapturedResourceStore::default();
        store.register_source("pool:1", "source-a");
        store.register_source("pool:2", "source-a");
        let capture_id = store.begin("pool:1");
        assert_eq!(store.claim("pool:1"), Some(capture_id));
        store.complete(
            "pool:1",
            capture_id,
            Some(resource("https://cdn.test/page.png#frame", b"image")),
        );
        store.finish("pool:1", capture_id);

        assert!(store
            .take_for_source("pool:2", "source-a", "https://cdn.test/page.png")
            .is_none());
        assert!(store
            .take_for_source("pool:1", "source-b", "https://cdn.test/page.png")
            .is_none());
        assert_eq!(
            store
                .take_for_source("pool:1", "source-a", "https://cdn.test/page.png")
                .map(|resource| resource.body),
            Some(b"image".to_vec())
        );
        assert!(store
            .take_for_source("pool:1", "source-a", "https://cdn.test/page.png")
            .is_none());
    }

    #[test]
    fn follows_redirect_aliases_only_inside_the_capture_session() {
        let store = CapturedResourceStore::default();
        store.register_source("pool:1", "source-a");
        let capture_id = store.begin("pool:1");
        assert_eq!(store.claim("pool:1"), Some(capture_id));
        store.complete_redirect(
            "pool:1",
            capture_id,
            "https://cdn.test/request.jpg",
            "https://cdn.test/final.jpg",
        );
        assert_eq!(store.claim("pool:1"), Some(capture_id));
        store.complete(
            "pool:1",
            capture_id,
            Some(resource("https://cdn.test/final.jpg", b"redirected")),
        );
        store.finish("pool:1", capture_id);

        assert_eq!(
            store
                .take_for_source("pool:1", "source-a", "https://cdn.test/request.jpg")
                .map(|resource| resource.body),
            Some(b"redirected".to_vec())
        );
    }

    #[test]
    fn starting_a_new_capture_discards_previous_responses() {
        let store = CapturedResourceStore::default();
        store.register_source("pool:1", "source-a");
        let first_capture = store.begin("pool:1");
        assert_eq!(store.claim("pool:1"), Some(first_capture));
        store.complete(
            "pool:1",
            first_capture,
            Some(resource("https://cdn.test/old.jpg", b"old")),
        );
        store.finish("pool:1", first_capture);

        store.begin("pool:1");
        assert!(store
            .take_for_source("pool:1", "source-a", "https://cdn.test/old.jpg")
            .is_none());
    }

    #[test]
    fn interrupt_discards_partial_capture_state() {
        let store = CapturedResourceStore::default();
        store.register_source("pool:1", "source-a");
        let capture_id = store.begin("pool:1");
        assert_eq!(store.claim("pool:1"), Some(capture_id));
        store.complete(
            "pool:1",
            capture_id,
            Some(resource("https://cdn.test/page.jpg", b"image")),
        );
        store.interrupt("pool:1");

        assert!(store
            .take_for_source("pool:1", "source-a", "https://cdn.test/page.jpg")
            .is_none());
    }

    #[test]
    fn removes_the_legacy_page_cache_directory_idempotently() {
        let profile = tempdir().unwrap();
        let legacy = profile.path().join(LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY);
        fs::create_dir(&legacy).unwrap();
        fs::write(legacy.join("entry.page"), b"stale").unwrap();

        remove_legacy_chapter_page_cache(profile.path()).unwrap();

        assert!(!legacy.exists());
        remove_legacy_chapter_page_cache(profile.path()).unwrap();
    }

    #[test]
    fn rejects_a_non_directory_legacy_page_cache_path() {
        let profile = tempdir().unwrap();
        let legacy = profile.path().join(LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY);
        fs::write(&legacy, b"not a cache directory").unwrap();

        let error = remove_legacy_chapter_page_cache(profile.path()).unwrap_err();

        assert!(error.contains("is not a directory"));
        assert_eq!(fs::read(legacy).unwrap(), b"not a cache directory");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_legacy_page_cache_symlink_without_removing_its_target() {
        let profile = tempdir().unwrap();
        let target = profile.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("entry.page"), b"keep").unwrap();
        std::os::unix::fs::symlink(
            &target,
            profile.path().join(LEGACY_CHAPTER_PAGE_CACHE_DIRECTORY),
        )
        .unwrap();

        let error = remove_legacy_chapter_page_cache(profile.path()).unwrap_err();

        assert!(error.contains("is a symlink"));
        assert_eq!(fs::read(target.join("entry.page")).unwrap(), b"keep");
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
    fn requires_image_signature_for_disguised_image_requests() {
        assert_eq!(
            response_capture_policy(
                "https://cdn.test/disguised.css",
                &HashMap::from([("content-type".to_string(), "text/css".to_string())]),
                Some("image"),
            ),
            Some(ResponseCapturePolicy::RequireImageSignature),
        );
    }

    #[test]
    fn recognizes_supported_image_signatures() {
        for body in [
            b"\xff\xd8\xff\xe0jpeg".as_slice(),
            b"\x89PNG\r\n\x1a\npayload".as_slice(),
            b"GIF87apayload".as_slice(),
            b"GIF89apayload".as_slice(),
            b"RIFF\x04\x00\x00\x00WEBPpayload".as_slice(),
            b"\x00\x00\x00\x18ftypavifpayload".as_slice(),
        ] {
            assert!(has_image_signature(body));
        }
        assert!(!has_image_signature(b"body { color: red; }"));
    }

    #[test]
    fn detects_cloudflare_challenge_bodies() {
        let headers = HashMap::from([(
            "content-type".to_string(),
            "text/html; charset=utf-8".to_string(),
        )]);
        assert!(response_is_cloudflare_challenge(
            &headers,
            b"<html><script src='/cdn-cgi/challenge-platform/x'></script></html>",
        ));
        assert!(!response_is_cloudflare_challenge(
            &HashMap::from([("content-type".to_string(), "image/png".to_string())]),
            b"cf-chl-not-html",
        ));
    }
}
