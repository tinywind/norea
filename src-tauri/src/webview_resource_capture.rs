use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_CAPTURED_RESOURCE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CAPTURED_TOTAL_BYTES: usize = 256 * 1024 * 1024;
const MAX_CACHED_CHAPTER_PAGE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CACHED_CHAPTER_PAGE_METADATA_BYTES: usize = 1024 * 1024;
const CHAPTER_PAGE_CACHE_DIRECTORY: &str = "norea-chapter-pages-v1";
const CHAPTER_PAGE_CACHE_MAGIC: &[u8; 8] = b"NOREAPG1";
const CHAPTER_PAGE_RELOAD_MARKER: &[u8; 8] = b"NOREARL1";
const CHAPTER_PAGE_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

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
    resource_order: VecDeque<String>,
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

    pub fn begin_or_resume(&self, executor: &str) -> u64 {
        let mut sessions = self
            .sessions
            .lock()
            .expect("captured resource sessions mutex");
        if let Some(session) = sessions.get_mut(executor) {
            session.active = true;
            return session.id;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        sessions.insert(
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
        self.complete_with_total_limit(
            executor,
            capture_id,
            resource,
            MAX_CAPTURED_TOTAL_BYTES,
        );
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
        if session.id != capture_id {
            return;
        }
        session.activity = session.activity.wrapping_add(1);
        session.pending = session.pending.saturating_sub(1);
        let Some(resource) = resource else {
            return;
        };
        if resource.body.len() > MAX_CAPTURED_RESOURCE_BYTES
            || resource.body.len() > max_total_bytes
        {
            return;
        }
        let key = normalized_resource_url(&resource.final_url);
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
        }
        session.total_bytes = session.total_bytes.saturating_add(resource.body.len());
        session.resource_order.push_back(key.clone());
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
        let key = normalized_resource_url(url);
        let resource = session.resources.remove(&key)?;
        session.total_bytes = session.total_bytes.saturating_sub(resource.body.len());
        session.resource_order.retain(|existing| existing != &key);
        Some(resource)
    }

    pub fn clear(&self, executor: &str) {
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .remove(executor);
    }

    pub fn clear_all(&self) {
        self.sessions
            .lock()
            .expect("captured resource sessions mutex")
            .clear();
    }
}

fn normalized_resource_url(url: &str) -> String {
    url.split_once('#')
        .map(|(without_fragment, _)| without_fragment)
        .unwrap_or(url)
        .to_string()
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageCachePolicy {
    PreferCache,
    Reload,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedChapterPage {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub cache_url: String,
    pub final_url: String,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct ChapterPageCacheKey {
    source_id: String,
    url: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedChapterPageMetadata {
    source_id: String,
    cache_url: String,
    final_url: String,
    status: u16,
    status_text: String,
    headers: HashMap<String, String>,
}

struct InFlightChapterPage {
    flight_id: u64,
    started: Instant,
    waiters: Vec<tokio::sync::oneshot::Sender<()>>,
}

type SharedInFlightChapterPage = Arc<Mutex<InFlightChapterPage>>;

struct PreparedChapterPageNavigation {
    key: ChapterPageCacheKey,
    policy: Option<PageCachePolicy>,
    reload_token: Option<ChapterPageCaptureToken>,
}

struct ActiveChapterPageNavigation {
    key: ChapterPageCacheKey,
    current_url: String,
    policy: Option<PageCachePolicy>,
    capture_token: Option<ChapterPageCaptureToken>,
    awaiting_redirect: bool,
}

#[derive(Clone)]
struct ChapterPageCaptureToken {
    key: ChapterPageCacheKey,
    flight_id: u64,
    global_generation: u64,
    source_generation: u64,
    key_generation: u64,
}

struct ChapterPageCapture {
    cache_url: String,
    token: ChapterPageCaptureToken,
}

#[derive(Default)]
struct ChapterPageClearState {
    full_clears: usize,
    source_clears: HashMap<String, usize>,
}

enum ChapterPageClearScope {
    Full,
    Source(String),
}

struct ChapterPageClearGuard<'a> {
    cache: &'a ChapterPageCache,
    scope: ChapterPageClearScope,
}

#[derive(Default)]
struct ChapterPageNavigationState {
    foreground_executors: HashSet<String>,
    prepared: HashMap<String, PreparedChapterPageNavigation>,
    active: HashMap<String, ActiveChapterPageNavigation>,
}

#[derive(Debug, PartialEq, Eq)]
enum ChapterPageRequestAction {
    Disabled,
    PreferCache {
        cache_url: String,
        redirect_continuation: bool,
    },
    Reload { cache_url: String },
}

enum ChapterPageCacheLookup {
    Hit(Arc<CachedChapterPage>),
    Leader(ChapterPageCaptureToken),
    Wait(tokio::sync::oneshot::Receiver<()>),
    Network,
}

#[cfg(any(test, target_os = "windows"))]
fn chapter_page_request_requires_http_revalidation(action: &ChapterPageRequestAction) -> bool {
    matches!(action, ChapterPageRequestAction::Reload { .. })
}

#[cfg(any(test, target_os = "windows"))]
fn complete_deferred_dispatch_on_error<T, E>(
    dispatch: Result<T, E>,
    complete: impl FnOnce(),
) -> Result<T, E> {
    if dispatch.is_err() {
        complete();
    }
    dispatch
}

#[derive(Default)]
pub struct ChapterPageCache {
    entries: Mutex<HashMap<ChapterPageCacheKey, Arc<CachedChapterPage>>>,
    in_flight: Mutex<HashMap<ChapterPageCacheKey, SharedInFlightChapterPage>>,
    navigation: Mutex<ChapterPageNavigationState>,
    next_flight_id: AtomicU64,
    global_generation: AtomicU64,
    source_generations: Mutex<HashMap<String, u64>>,
    key_generations: Mutex<HashMap<ChapterPageCacheKey, u64>>,
    clear_state: Mutex<ChapterPageClearState>,
    persistence: Mutex<()>,
}

impl Drop for ChapterPageClearGuard<'_> {
    fn drop(&mut self) {
        let mut state = self
            .cache
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        match &self.scope {
            ChapterPageClearScope::Full => {
                state.full_clears = state.full_clears.saturating_sub(1);
            }
            ChapterPageClearScope::Source(source_id) => {
                let remove = state
                    .source_clears
                    .get_mut(source_id)
                    .is_some_and(|count| {
                        *count = count.saturating_sub(1);
                        *count == 0
                    });
                if remove {
                    state.source_clears.remove(source_id);
                }
            }
        }
    }
}

impl ChapterPageCache {
    pub fn get(
        &self,
        source_id: &str,
        profile_directory: &Path,
        url: &str,
    ) -> Option<Arc<CachedChapterPage>> {
        let key = chapter_page_cache_key(source_id, url)?;
        if let Some(page) = self
            .entries
            .lock()
            .expect("chapter page cache entries mutex")
            .get(&key)
            .cloned()
        {
            return Some(page);
        }

        let _persistence = self
            .persistence
            .lock()
            .expect("chapter page cache persistence mutex");
        if let Some(page) = self
            .entries
            .lock()
            .expect("chapter page cache entries mutex")
            .get(&key)
            .cloned()
        {
            return Some(page);
        }
        let path = chapter_page_cache_file(profile_directory, &key.url);
        let page = match read_persisted_chapter_page(&path, &key) {
            Ok(page) => page,
            Err(error) => {
                log::debug!(
                    "[scraper:page_cache] persisted entry ignored path={}: {error}",
                    path.display()
                );
                let _ = fs::remove_file(path);
                None
            }
        }?;
        let page = Arc::new(page);
        let mut entries = self
            .entries
            .lock()
            .expect("chapter page cache entries mutex");
        for alias in chapter_page_aliases(&page) {
            entries.insert(
                ChapterPageCacheKey {
                    source_id: key.source_id.clone(),
                    url: alias,
                },
                Arc::clone(&page),
            );
        }
        Some(page)
    }

    fn lookup_or_follow(
        &self,
        source_id: &str,
        profile_directory: &Path,
        url: &str,
    ) -> ChapterPageCacheLookup {
        let Some(key) = chapter_page_cache_key(source_id, url) else {
            return ChapterPageCacheLookup::Network;
        };
        if let Some(waiter) = self.follow_existing_flight(&key) {
            return ChapterPageCacheLookup::Wait(waiter);
        }
        let clear_state = self
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        if clear_state.full_clears > 0
            || clear_state.source_clears.contains_key(source_id)
        {
            return ChapterPageCacheLookup::Network;
        }
        if let Some(page) = self.get(source_id, profile_directory, &key.url) {
            if let Some(waiter) = self.follow_existing_flight(&key) {
                return ChapterPageCacheLookup::Wait(waiter);
            }
            return ChapterPageCacheLookup::Hit(page);
        }

        let mut in_flight = self
            .in_flight
            .lock()
            .expect("chapter page cache in-flight mutex");
        if let Some(request) = in_flight.get(&key).cloned() {
            if request
                .lock()
                .expect("chapter page cache flight mutex")
                .started
                .elapsed()
                >= CHAPTER_PAGE_FETCH_TIMEOUT
            {
                let waiters = remove_shared_chapter_page_flight(&mut in_flight, &request);
                notify_chapter_page_waiters(waiters);
            }
        }
        if let Some(request) = in_flight.get(&key) {
            let (sender, receiver) = tokio::sync::oneshot::channel();
            request
                .lock()
                .expect("chapter page cache flight mutex")
                .waiters
                .push(sender);
            return ChapterPageCacheLookup::Wait(receiver);
        }
        if let Some(page) = self
            .entries
            .lock()
            .expect("chapter page cache entries mutex")
            .get(&key)
            .cloned()
        {
            return ChapterPageCacheLookup::Hit(page);
        }
        let flight_id = self.next_flight_id.fetch_add(1, Ordering::Relaxed);
        let token = self.capture_token_for_flight(&key, flight_id);
        in_flight.insert(
            key,
            Arc::new(Mutex::new(InFlightChapterPage {
                flight_id,
                started: Instant::now(),
                waiters: Vec::new(),
            })),
        );
        ChapterPageCacheLookup::Leader(token)
    }

    fn follow_existing_flight(
        &self,
        key: &ChapterPageCacheKey,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        let mut in_flight = self
            .in_flight
            .lock()
            .expect("chapter page cache in-flight mutex");
        if let Some(request) = in_flight.get(key).cloned() {
            if request
                .lock()
                .expect("chapter page cache flight mutex")
                .started
                .elapsed()
                >= CHAPTER_PAGE_FETCH_TIMEOUT
            {
                let waiters = remove_shared_chapter_page_flight(&mut in_flight, &request);
                notify_chapter_page_waiters(waiters);
            }
        }
        let request = in_flight.get(key)?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        request
            .lock()
            .expect("chapter page cache flight mutex")
            .waiters
            .push(sender);
        Some(receiver)
    }

    fn lookup_preferred_page(
        &self,
        source_id: &str,
        profile_directory: &Path,
        url: &str,
        redirect_continuation: bool,
    ) -> ChapterPageCacheLookup {
        if redirect_continuation {
            let clear_state = self
                .clear_state
                .lock()
                .expect("chapter page cache clear state mutex");
            if clear_state.full_clears > 0
                || clear_state.source_clears.contains_key(source_id)
            {
                return ChapterPageCacheLookup::Network;
            }
            return self
                .get(source_id, profile_directory, url)
                .map(ChapterPageCacheLookup::Hit)
                .unwrap_or(ChapterPageCacheLookup::Network);
        }
        self.lookup_or_follow(source_id, profile_directory, url)
    }

    fn complete_fetch(&self, token: &ChapterPageCaptureToken) {
        let mut in_flight = self
            .in_flight
            .lock()
            .expect("chapter page cache in-flight mutex");
        let waiters = in_flight
            .get(&token.key)
            .cloned()
            .filter(|request| {
                request
                    .lock()
                    .expect("chapter page cache flight mutex")
                    .flight_id
                    == token.flight_id
            })
            .map(|request| remove_shared_chapter_page_flight(&mut in_flight, &request))
            .unwrap_or_default();
        drop(in_flight);
        notify_chapter_page_waiters(waiters);
    }

    pub fn store(
        &self,
        source_id: &str,
        profile_directory: &Path,
        page: CachedChapterPage,
    ) -> Result<bool, String> {
        self.store_inner(source_id, profile_directory, page)
    }

    fn store_captured(
        &self,
        source_id: &str,
        profile_directory: &Path,
        page: CachedChapterPage,
        token: &ChapterPageCaptureToken,
    ) -> Result<bool, String> {
        if token.key.source_id != source_id
            || chapter_page_cache_key(source_id, &page.cache_url).as_ref() != Some(&token.key)
        {
            return Ok(false);
        }
        let clear_state = self
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        if clear_state.full_clears > 0
            || clear_state.source_clears.contains_key(source_id)
        {
            return Ok(false);
        }
        if !self
            .in_flight
            .lock()
            .expect("chapter page cache in-flight mutex")
            .get(&token.key)
            .is_some_and(|request| {
                request
                    .lock()
                    .expect("chapter page cache flight mutex")
                    .flight_id
                    == token.flight_id
            })
        {
            return Ok(false);
        }
        let source_generations = self
            .source_generations
            .lock()
            .expect("chapter page cache source generations mutex");
        let generations = self
            .key_generations
            .lock()
            .expect("chapter page cache generations mutex");
        if token.global_generation != self.global_generation.load(Ordering::Acquire)
            || token.source_generation
                != *source_generations.get(source_id).unwrap_or(&0)
            || token.key_generation != *generations.get(&token.key).unwrap_or(&0)
        {
            return Ok(false);
        }
        let aliases = chapter_page_aliases(&page)
            .into_iter()
            .filter_map(|url| normalized_http_url(&url))
            .collect::<Vec<_>>();
        let stored = self.store_inner(source_id, profile_directory, page)?;
        if stored {
            clear_chapter_page_reload_markers(profile_directory, &aliases)?;
        }
        Ok(stored)
    }

    fn store_inner(
        &self,
        source_id: &str,
        profile_directory: &Path,
        mut page: CachedChapterPage,
    ) -> Result<bool, String> {
        let Some(key) = chapter_page_cache_key(source_id, &page.cache_url) else {
            return Ok(false);
        };
        let Some(final_url) = normalized_http_url(&page.final_url) else {
            return Ok(false);
        };
        page.cache_url = key.url.clone();
        page.final_url = final_url;
        page.headers = sanitized_chapter_page_headers(page.headers);
        if !chapter_page_is_storable(&page) {
            return Ok(false);
        }

        let _persistence = self
            .persistence
            .lock()
            .expect("chapter page cache persistence mutex");
        let mut entries = self
            .entries
            .lock()
            .expect("chapter page cache entries mutex");
        let previous = entries.get(&key).cloned().or_else(|| {
            let path = chapter_page_cache_file(profile_directory, &key.url);
            match read_persisted_chapter_page(&path, &key) {
                Ok(page) => page.map(Arc::new),
                Err(error) => {
                    log::debug!(
                        "[scraper:page_cache] previous entry ignored path={}: {error}",
                        path.display()
                    );
                    let _ = fs::remove_file(path);
                    None
                }
            }
        });
        if previous
            .as_deref()
            .is_some_and(|cached| cached == &page)
        {
            return Ok(true);
        }

        let new_aliases = chapter_page_aliases(&page);
        let stale_aliases = previous
            .as_deref()
            .map(chapter_page_aliases)
            .unwrap_or_default()
            .into_iter()
            .filter(|alias| !new_aliases.contains(alias))
            .collect::<Vec<_>>();
        persist_chapter_page(profile_directory, &key, &page)?;
        let page = Arc::new(page);
        let mut prune_error = None;
        for alias in stale_aliases {
            let alias_key = ChapterPageCacheKey {
                source_id: key.source_id.clone(),
                url: alias.clone(),
            };
            if entries.get(&alias_key).is_some_and(|cached| {
                previous.as_ref().is_some_and(|previous| {
                    Arc::ptr_eq(cached, previous) || cached.as_ref() == previous.as_ref()
                })
            }) {
                entries.remove(&alias_key);
            }
            let path = chapter_page_cache_file(profile_directory, &alias);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    prune_error.get_or_insert_with(|| {
                        format!(
                            "chapter page cache: remove stale alias '{}': {error}",
                            path.display()
                        )
                    });
                }
            }
        }
        for alias in new_aliases {
            entries.insert(
                ChapterPageCacheKey {
                    source_id: key.source_id.clone(),
                    url: alias,
                },
                Arc::clone(&page),
            );
        }
        prune_error.map_or(Ok(true), Err)
    }

    pub fn invalidate(
        &self,
        source_id: &str,
        profile_directory: &Path,
        url: &str,
    ) -> Result<bool, String> {
        self.invalidate_inner(source_id, profile_directory, url, true)
    }

    fn invalidate_inner(
        &self,
        source_id: &str,
        profile_directory: &Path,
        url: &str,
        require_reload: bool,
    ) -> Result<bool, String> {
        let Some(key) = chapter_page_cache_key(source_id, url) else {
            return Ok(false);
        };
        let page = self.get(source_id, profile_directory, &key.url);
        let aliases = page
            .as_deref()
            .map(chapter_page_aliases)
            .unwrap_or_else(|| vec![key.url.clone()]);
        let mut generations = self
            .key_generations
            .lock()
            .expect("chapter page cache generations mutex");
        for alias in &aliases {
            let alias_key = ChapterPageCacheKey {
                source_id: key.source_id.clone(),
                url: alias.clone(),
            };
            let generation = generations.entry(alias_key).or_default();
            *generation = generation.wrapping_add(1);
        }
        if require_reload {
            let removed_in_flight = {
                let mut in_flight = self
                    .in_flight
                    .lock()
                    .expect("chapter page cache in-flight mutex");
                aliases
                    .iter()
                    .filter_map(|alias| {
                        in_flight.remove(&ChapterPageCacheKey {
                            source_id: key.source_id.clone(),
                            url: alias.clone(),
                        })
                    })
                    .collect::<Vec<_>>()
            };
            notify_shared_chapter_page_flights(removed_in_flight);
        }
        let _persistence = self
            .persistence
            .lock()
            .expect("chapter page cache persistence mutex");
        if require_reload {
            for alias in &aliases {
                persist_chapter_page_reload_marker(profile_directory, alias)?;
            }
        }
        let mut removed = false;
        let mut entries = self
            .entries
            .lock()
            .expect("chapter page cache entries mutex");
        for alias in aliases {
            let alias_key = ChapterPageCacheKey {
                source_id: key.source_id.clone(),
                url: alias.clone(),
            };
            removed |= entries.remove(&alias_key).is_some();
            let path = chapter_page_cache_file(profile_directory, &alias);
            match fs::remove_file(&path) {
                Ok(()) => removed = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "chapter page cache: remove '{}': {error}",
                        path.display()
                    ));
                }
            }
        }
        Ok(removed)
    }

    pub fn clear_profiles(&self, profile_directories: &[PathBuf]) -> Result<(), String> {
        let _clear = self.begin_full_clear();
        {
            let _persistence = self
                .persistence
                .lock()
                .expect("chapter page cache persistence mutex");
            for profile_directory in profile_directories {
                remove_chapter_page_cache_directory(profile_directory)?;
            }
        }
        self.entries
            .lock()
            .expect("chapter page cache entries mutex")
            .clear();
        let mut navigation = self
            .navigation
            .lock()
            .expect("chapter page cache navigation mutex");
        navigation.prepared.clear();
        navigation.active.clear();
        let in_flight = std::mem::take(
            &mut *self
                .in_flight
                .lock()
                .expect("chapter page cache in-flight mutex"),
        );
        notify_shared_chapter_page_flights(in_flight.into_values().collect());
        Ok(())
    }

    pub fn clear_source(
        &self,
        source_id: &str,
        profile_directory: &Path,
    ) -> Result<(), String> {
        let _clear = self.begin_source_clear(source_id);
        {
            let _persistence = self
                .persistence
                .lock()
                .expect("chapter page cache persistence mutex");
            invalidate_source_chapter_pages(profile_directory)?;
        }
        self.entries
            .lock()
            .expect("chapter page cache entries mutex")
            .retain(|key, _| key.source_id != source_id);
        let removed_in_flight = {
            let mut in_flight = self
                .in_flight
                .lock()
                .expect("chapter page cache in-flight mutex");
            let keys = in_flight
                .keys()
                .filter(|key| key.source_id == source_id)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| in_flight.remove(&key))
                .collect::<Vec<_>>()
        };
        notify_shared_chapter_page_flights(removed_in_flight);
        let mut navigation = self
            .navigation
            .lock()
            .expect("chapter page cache navigation mutex");
        navigation
            .prepared
            .retain(|_, prepared| prepared.key.source_id != source_id);
        navigation
            .active
            .retain(|_, active| active.key.source_id != source_id);
        Ok(())
    }

    pub fn prepare_navigation(
        &self,
        executor: &str,
        source_id: &str,
        profile_directory: &Path,
        url: &str,
        policy: Option<PageCachePolicy>,
    ) -> Result<(), String> {
        let Some(key) = chapter_page_cache_key(source_id, url) else {
            return Ok(());
        };
        self.abandon_navigation(executor);
        let policy = if policy == Some(PageCachePolicy::PreferCache)
            && chapter_page_reload_is_required(profile_directory, &key.url)?
        {
            Some(PageCachePolicy::Reload)
        } else {
            policy
        };
        let reload_token = if policy == Some(PageCachePolicy::Reload) {
            self.begin_reload(source_id, profile_directory, &key)?
        } else {
            None
        };
        self.navigation
            .lock()
            .expect("chapter page cache navigation mutex")
            .prepared
            .insert(
                executor.to_string(),
                PreparedChapterPageNavigation {
                    key,
                    policy,
                    reload_token,
                },
            );
        Ok(())
    }

    fn begin_reload(
        &self,
        source_id: &str,
        profile_directory: &Path,
        key: &ChapterPageCacheKey,
    ) -> Result<Option<ChapterPageCaptureToken>, String> {
        let clear_state = self
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        if clear_state.full_clears > 0
            || clear_state.source_clears.contains_key(source_id)
        {
            return Ok(None);
        }
        let mut alias_keys = self
            .get(source_id, profile_directory, &key.url)
            .as_deref()
            .map(chapter_page_aliases)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|url| chapter_page_cache_key(source_id, &url))
            .collect::<Vec<_>>();
        if !alias_keys.contains(key) {
            alias_keys.push(key.clone());
        }
        let flight_id = self.next_flight_id.fetch_add(1, Ordering::Relaxed);
        {
            let mut in_flight = self
                .in_flight
                .lock()
                .expect("chapter page cache in-flight mutex");
            let replacement = Arc::new(Mutex::new(InFlightChapterPage {
                flight_id,
                started: Instant::now(),
                waiters: Vec::new(),
            }));
            for alias_key in alias_keys {
                if let Some(existing) = in_flight.get(&alias_key).cloned() {
                    absorb_shared_chapter_page_flight(
                        &mut in_flight,
                        &replacement,
                        &existing,
                    );
                }
                in_flight.insert(alias_key, Arc::clone(&replacement));
            }
        }
        if let Err(error) =
            self.invalidate_inner(source_id, profile_directory, &key.url, false)
        {
            let token = self.capture_token_for_flight(key, flight_id);
            self.complete_fetch(&token);
            return Err(error);
        }
        Ok(Some(self.capture_token_for_flight(key, flight_id)))
    }

    pub fn abandon_navigation(&self, executor: &str) {
        let tokens = {
            let mut navigation = self
                .navigation
                .lock()
                .expect("chapter page cache navigation mutex");
            let mut tokens = Vec::with_capacity(2);
            if let Some(token) = navigation
                .prepared
                .remove(executor)
                .and_then(|prepared| prepared.reload_token)
            {
                tokens.push(token);
            }
            if let Some(token) = navigation
                .active
                .remove(executor)
                .and_then(|active| active.capture_token)
            {
                tokens.push(token);
            }
            tokens
        };
        for token in tokens {
            self.complete_fetch(&token);
        }
    }

    pub fn enable_foreground(&self, executor: &str) {
        self.navigation
            .lock()
            .expect("chapter page cache navigation mutex")
            .foreground_executors
            .insert(executor.to_string());
    }

    fn begin_document_request(
        &self,
        executor: &str,
        source_id: &str,
        url: &str,
    ) -> ChapterPageRequestAction {
        let Some(key) = chapter_page_cache_key(source_id, url) else {
            return ChapterPageRequestAction::Disabled;
        };
        let mut navigation = self
            .navigation
            .lock()
            .expect("chapter page cache navigation mutex");
        let prepared = navigation
            .prepared
            .get(executor)
            .filter(|prepared| prepared.key == key)
            .map(|prepared| {
                (
                    prepared.key.clone(),
                    prepared.policy,
                    prepared.reload_token.clone(),
                )
            });
        let used_prepared = prepared.is_some();
        let (cache_key, policy, redirect_continuation, inherited_capture_token) =
            if let Some(prepared) = prepared {
                (prepared.0, prepared.1, false, prepared.2)
            } else if let Some(active) = navigation.active.get(executor).filter(|active| {
                active.awaiting_redirect && active.key.source_id == source_id
            }) {
                (
                    active.key.clone(),
                    active.policy,
                    true,
                    active.capture_token.clone(),
                )
            } else {
                let policy = navigation
                    .foreground_executors
                    .contains(executor)
                    .then_some(PageCachePolicy::PreferCache);
                (key.clone(), policy, false, None)
            };
        if used_prepared {
            navigation.prepared.remove(executor);
        }
        let capture_token = inherited_capture_token;
        navigation.active.insert(
            executor.to_string(),
            ActiveChapterPageNavigation {
                key: cache_key.clone(),
                current_url: key.url,
                policy,
                capture_token,
                awaiting_redirect: false,
            },
        );
        match policy {
            None => ChapterPageRequestAction::Disabled,
            Some(PageCachePolicy::PreferCache) => ChapterPageRequestAction::PreferCache {
                cache_url: cache_key.url,
                redirect_continuation,
            },
            Some(PageCachePolicy::Reload) => ChapterPageRequestAction::Reload {
                cache_url: cache_key.url,
            },
        }
    }

    fn apply_required_reload(
        &self,
        executor: &str,
        source_id: &str,
        profile_directory: &Path,
        action: ChapterPageRequestAction,
    ) -> Result<ChapterPageRequestAction, String> {
        let ChapterPageRequestAction::PreferCache { cache_url, .. } = &action else {
            return Ok(action);
        };
        if !chapter_page_reload_is_required(profile_directory, cache_url)? {
            return Ok(action);
        }
        let Some(key) = chapter_page_cache_key(source_id, cache_url) else {
            return Ok(action);
        };
        let reload_token = self.begin_reload(source_id, profile_directory, &key)?;
        let applied = {
            let mut navigation = self
                .navigation
                .lock()
                .expect("chapter page cache navigation mutex");
            navigation
                .active
                .get_mut(executor)
                .filter(|active| active.key == key)
                .map(|active| {
                    active.policy = Some(PageCachePolicy::Reload);
                    active.capture_token = reload_token.clone();
                })
                .is_some()
        };
        if !applied {
            if let Some(token) = reload_token {
                self.complete_fetch(&token);
            }
        }
        Ok(ChapterPageRequestAction::Reload {
            cache_url: key.url,
        })
    }

    fn bind_capture_token(
        &self,
        executor: &str,
        source_id: &str,
        token: ChapterPageCaptureToken,
    ) -> bool {
        let mut navigation = self
            .navigation
            .lock()
            .expect("chapter page cache navigation mutex");
        let Some(active) = navigation.active.get_mut(executor) else {
            return false;
        };
        if active.key != token.key || active.key.source_id != source_id {
            return false;
        }
        active.capture_token = Some(token);
        true
    }

    fn bind_flight_alias(&self, token: &ChapterPageCaptureToken, url: &str) -> bool {
        let Some(alias_key) = chapter_page_cache_key(&token.key.source_id, url) else {
            return false;
        };
        let mut in_flight = self
            .in_flight
            .lock()
            .expect("chapter page cache in-flight mutex");
        let Some(target) = in_flight.get(&token.key).cloned().filter(|flight| {
            flight
                .lock()
                .expect("chapter page cache flight mutex")
                .flight_id
                == token.flight_id
        }) else {
            return false;
        };
        if let Some(existing) = in_flight.get(&alias_key).cloned() {
            absorb_shared_chapter_page_flight(&mut in_flight, &target, &existing);
        }
        in_flight.insert(alias_key, target);
        true
    }

    fn finish_document_response(
        &self,
        executor: &str,
        source_id: &str,
        url: &str,
        status: i32,
        headers: &HashMap<String, String>,
    ) -> Option<ChapterPageCapture> {
        let response_url = normalized_http_url(url)?;
        let mut navigation = self
            .navigation
            .lock()
            .expect("chapter page cache navigation mutex");
        let active = navigation.active.get_mut(executor)?;
        if active.key.source_id != source_id || active.current_url != response_url {
            return None;
        }
        if let Some(redirect_url) = followed_document_redirect_url(status, headers, &response_url) {
            active.awaiting_redirect = true;
            let capture_token = active.capture_token.clone();
            drop(navigation);
            if let Some(token) = capture_token {
                self.bind_flight_alias(&token, &redirect_url);
            }
            return None;
        }
        let active = navigation.active.remove(executor)?;
        active.capture_token.map(|token| ChapterPageCapture {
            cache_url: active.key.url,
            token,
        })
    }

    fn begin_full_clear(&self) -> ChapterPageClearGuard<'_> {
        let mut state = self
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        state.full_clears = state.full_clears.saturating_add(1);
        self.global_generation.fetch_add(1, Ordering::AcqRel);
        self.source_generations
            .lock()
            .expect("chapter page cache source generations mutex")
            .clear();
        self.key_generations
            .lock()
            .expect("chapter page cache generations mutex")
            .clear();
        drop(state);
        ChapterPageClearGuard {
            cache: self,
            scope: ChapterPageClearScope::Full,
        }
    }

    fn begin_source_clear(&self, source_id: &str) -> ChapterPageClearGuard<'_> {
        let mut state = self
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        let count = state.source_clears.entry(source_id.to_string()).or_default();
        *count = count.saturating_add(1);
        {
            let mut generations = self
                .source_generations
                .lock()
                .expect("chapter page cache source generations mutex");
            let generation = generations.entry(source_id.to_string()).or_default();
            *generation = generation.wrapping_add(1);
        }
        self.key_generations
            .lock()
            .expect("chapter page cache generations mutex")
            .retain(|key, _| key.source_id != source_id);
        drop(state);
        ChapterPageClearGuard {
            cache: self,
            scope: ChapterPageClearScope::Source(source_id.to_string()),
        }
    }

    fn capture_token(
        &self,
        key: &ChapterPageCacheKey,
        flight_id: u64,
    ) -> Option<ChapterPageCaptureToken> {
        let clear_state = self
            .clear_state
            .lock()
            .expect("chapter page cache clear state mutex");
        if clear_state.full_clears > 0
            || clear_state.source_clears.contains_key(&key.source_id)
        {
            return None;
        }
        Some(self.capture_token_for_flight(key, flight_id))
    }

    fn capture_token_for_flight(
        &self,
        key: &ChapterPageCacheKey,
        flight_id: u64,
    ) -> ChapterPageCaptureToken {
        let source_generation = *self
            .source_generations
            .lock()
            .expect("chapter page cache source generations mutex")
            .get(&key.source_id)
            .unwrap_or(&0);
        let key_generation = *self
            .key_generations
            .lock()
            .expect("chapter page cache generations mutex")
            .get(key)
            .unwrap_or(&0);
        ChapterPageCaptureToken {
            key: key.clone(),
            flight_id,
            global_generation: self.global_generation.load(Ordering::Acquire),
            source_generation,
            key_generation,
        }
    }
}

fn is_followed_document_redirect(
    status: i32,
    headers: &HashMap<String, String>,
    response_url: &str,
) -> bool {
    followed_document_redirect_url(status, headers, response_url).is_some()
}

fn followed_document_redirect_url(
    status: i32,
    headers: &HashMap<String, String>,
    response_url: &str,
) -> Option<String> {
    if !matches!(status, 301 | 302 | 303 | 307 | 308) {
        return None;
    }
    let Some(location) = headers
        .iter()
        .find_map(|(name, value)| name.eq_ignore_ascii_case("location").then_some(value.trim()))
        .filter(|location| !location.is_empty())
    else {
        return None;
    };
    tauri::Url::parse(response_url)
        .ok()
        .and_then(|base| base.join(location).ok())
        .filter(|target| matches!(target.scheme(), "http" | "https"))
        .map(|target| target.to_string())
}

fn remove_chapter_page_cache_directory(profile_directory: &Path) -> Result<(), String> {
    let cache_directory = profile_directory.join(CHAPTER_PAGE_CACHE_DIRECTORY);
    let metadata = match fs::symlink_metadata(&cache_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "chapter page cache: inspect '{}': {error}",
                cache_directory.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "chapter page cache: cache path is not a normal directory: '{}'",
            cache_directory.display()
        ));
    }
    fs::remove_dir_all(&cache_directory).map_err(|error| {
        format!(
            "chapter page cache: clear '{}': {error}",
            cache_directory.display()
        )
    })
}

fn notify_chapter_page_waiters(waiters: Vec<tokio::sync::oneshot::Sender<()>>) {
    for waiter in waiters {
        let _ = waiter.send(());
    }
}

fn remove_shared_chapter_page_flight(
    in_flight: &mut HashMap<ChapterPageCacheKey, SharedInFlightChapterPage>,
    flight: &SharedInFlightChapterPage,
) -> Vec<tokio::sync::oneshot::Sender<()>> {
    in_flight.retain(|_, candidate| !Arc::ptr_eq(candidate, flight));
    std::mem::take(
        &mut flight
            .lock()
            .expect("chapter page cache flight mutex")
            .waiters,
    )
}

fn absorb_shared_chapter_page_flight(
    in_flight: &mut HashMap<ChapterPageCacheKey, SharedInFlightChapterPage>,
    target: &SharedInFlightChapterPage,
    absorbed: &SharedInFlightChapterPage,
) {
    if Arc::ptr_eq(target, absorbed) {
        return;
    }
    let waiters = std::mem::take(
        &mut absorbed
            .lock()
            .expect("chapter page cache flight mutex")
            .waiters,
    );
    target
        .lock()
        .expect("chapter page cache flight mutex")
        .waiters
        .extend(waiters);
    for flight in in_flight.values_mut() {
        if Arc::ptr_eq(flight, absorbed) {
            *flight = Arc::clone(target);
        }
    }
}

fn notify_shared_chapter_page_flights(flights: Vec<SharedInFlightChapterPage>) {
    let mut seen = HashSet::new();
    for flight in flights {
        let mut flight = flight.lock().expect("chapter page cache flight mutex");
        if seen.insert(flight.flight_id) {
            notify_chapter_page_waiters(std::mem::take(&mut flight.waiters));
        }
    }
}

fn chapter_page_cache_key(source_id: &str, url: &str) -> Option<ChapterPageCacheKey> {
    if source_id.trim().is_empty() {
        return None;
    }
    Some(ChapterPageCacheKey {
        source_id: source_id.to_string(),
        url: normalized_http_url(url)?,
    })
}

fn normalized_http_url(url: &str) -> Option<String> {
    let mut parsed = tauri::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    parsed.set_fragment(None);
    if let Some(query) = parsed.query() {
        let mut removed_reserved_parameter = false;
        let remaining = query
            .split('&')
            .filter(|pair| {
                let keep = pair.split_once('=').map_or(*pair, |(name, _)| name)
                    != "_norea_capture";
                removed_reserved_parameter |= !keep;
                keep
            })
            .collect::<Vec<_>>()
            .join("&");
        if removed_reserved_parameter {
            parsed.set_query((!remaining.is_empty()).then_some(remaining.as_str()));
        }
    }
    Some(parsed.to_string())
}

fn chapter_page_cache_file(profile_directory: &Path, url: &str) -> PathBuf {
    profile_directory
        .join(CHAPTER_PAGE_CACHE_DIRECTORY)
        .join(format!("{:x}.page", Sha256::digest(url.as_bytes())))
}

fn chapter_page_reload_marker_file(profile_directory: &Path, url: &str) -> PathBuf {
    chapter_page_cache_file(profile_directory, url).with_extension("reload")
}

fn chapter_page_reload_is_required(
    profile_directory: &Path,
    url: &str,
) -> Result<bool, String> {
    let path = chapter_page_reload_marker_file(profile_directory, url);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => Ok(true),
        Ok(_) => Err(format!(
            "chapter page cache: reload marker is not a normal file: '{}'",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "chapter page cache: inspect reload marker '{}': {error}",
            path.display()
        )),
    }
}

fn persist_chapter_page_reload_marker(
    profile_directory: &Path,
    url: &str,
) -> Result<(), String> {
    let cache_directory = profile_directory.join(CHAPTER_PAGE_CACHE_DIRECTORY);
    fs::create_dir_all(&cache_directory).map_err(|error| {
        format!(
            "chapter page cache: create '{}': {error}",
            cache_directory.display()
        )
    })?;
    persist_chapter_page_reload_marker_at(&chapter_page_reload_marker_file(
        profile_directory,
        url,
    ))
}

fn persist_chapter_page_reload_marker_at(path: &Path) -> Result<(), String> {
    let part_path = path.with_extension("reload.part");
    match fs::remove_file(&part_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "chapter page cache: remove stale reload marker '{}': {error}",
                part_path.display()
            ));
        }
    }
    fs::write(&part_path, CHAPTER_PAGE_RELOAD_MARKER).map_err(|error| {
        format!(
            "chapter page cache: write reload marker '{}': {error}",
            part_path.display()
        )
    })?;
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = fs::remove_file(&part_path);
            return Err(format!(
                "chapter page cache: replace reload marker '{}': {error}",
                path.display()
            ));
        }
    }
    fs::rename(&part_path, path).map_err(|error| {
        let _ = fs::remove_file(&part_path);
        format!(
            "chapter page cache: publish reload marker '{}': {error}",
            path.display()
        )
    })
}

fn clear_chapter_page_reload_markers(
    profile_directory: &Path,
    urls: &[String],
) -> Result<(), String> {
    for url in urls {
        let path = chapter_page_reload_marker_file(profile_directory, url);
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "chapter page cache: remove reload marker '{}': {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(())
}

fn invalidate_source_chapter_pages(profile_directory: &Path) -> Result<(), String> {
    let cache_directory = profile_directory.join(CHAPTER_PAGE_CACHE_DIRECTORY);
    let metadata = match fs::symlink_metadata(&cache_directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "chapter page cache: inspect '{}': {error}",
                cache_directory.display()
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "chapter page cache: cache path is not a normal directory: '{}'",
            cache_directory.display()
        ));
    }
    let entries = fs::read_dir(&cache_directory).map_err(|error| {
        format!(
            "chapter page cache: read '{}': {error}",
            cache_directory.display()
        )
    })?
    .map(|entry| {
        let entry = entry.map_err(|error| {
            format!(
                "chapter page cache: read entry in '{}': {error}",
                cache_directory.display()
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "chapter page cache: inspect '{}': {error}",
                path.display()
            )
        })?;
        Ok((path, file_type))
    })
    .collect::<Result<Vec<_>, String>>()?;
    for (path, file_type) in entries {
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(format!(
                "chapter page cache: entry is not a normal file: '{}'",
                path.display()
            ));
        }
        if path.extension().and_then(|extension| extension.to_str()) == Some("reload") {
            continue;
        }
        if path.extension().and_then(|extension| extension.to_str()) == Some("page") {
            persist_chapter_page_reload_marker_at(&path.with_extension("reload"))?;
        }
        fs::remove_file(&path).map_err(|error| {
            format!(
                "chapter page cache: remove '{}': {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn persist_chapter_page(
    profile_directory: &Path,
    key: &ChapterPageCacheKey,
    page: &CachedChapterPage,
) -> Result<(), String> {
    let metadata = PersistedChapterPageMetadata {
        source_id: key.source_id.clone(),
        cache_url: page.cache_url.clone(),
        final_url: page.final_url.clone(),
        status: page.status,
        status_text: page.status_text.clone(),
        headers: page.headers.clone(),
    };
    let metadata = serde_json::to_vec(&metadata)
        .map_err(|error| format!("chapter page cache: encode metadata: {error}"))?;
    if metadata.len() > MAX_CACHED_CHAPTER_PAGE_METADATA_BYTES {
        return Err("chapter page cache: metadata exceeds the size limit".to_string());
    }
    let metadata_length = u32::try_from(metadata.len())
        .map_err(|_| "chapter page cache: metadata length overflow".to_string())?;
    let cache_directory = profile_directory.join(CHAPTER_PAGE_CACHE_DIRECTORY);
    fs::create_dir_all(&cache_directory).map_err(|error| {
        format!(
            "chapter page cache: create '{}': {error}",
            cache_directory.display()
        )
    })?;
    let mut encoded = Vec::with_capacity(
        CHAPTER_PAGE_CACHE_MAGIC.len()
            + std::mem::size_of::<u32>()
            + metadata.len()
            + page.body.len(),
    );
    encoded.extend_from_slice(CHAPTER_PAGE_CACHE_MAGIC);
    encoded.extend_from_slice(&metadata_length.to_le_bytes());
    encoded.extend_from_slice(&metadata);
    encoded.extend_from_slice(&page.body);
    for alias in chapter_page_aliases(page) {
        let path = chapter_page_cache_file(profile_directory, &alias);
        let part_path = path.with_extension("page.part");
        fs::write(&part_path, &encoded).map_err(|error| {
            format!(
                "chapter page cache: write '{}': {error}",
                part_path.display()
            )
        })?;
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                let _ = fs::remove_file(&part_path);
                return Err(format!(
                    "chapter page cache: replace '{}': {error}",
                    path.display()
                ));
            }
        }
        fs::rename(&part_path, &path).map_err(|error| {
            let _ = fs::remove_file(&part_path);
            format!(
                "chapter page cache: publish '{}': {error}",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn read_persisted_chapter_page(
    path: &Path,
    expected_key: &ChapterPageCacheKey,
) -> Result<Option<CachedChapterPage>, String> {
    let encoded = match fs::read(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!("read '{}': {error}", path.display()));
        }
    };
    let max_encoded_bytes = CHAPTER_PAGE_CACHE_MAGIC.len()
        + std::mem::size_of::<u32>()
        + MAX_CACHED_CHAPTER_PAGE_METADATA_BYTES
        + MAX_CACHED_CHAPTER_PAGE_BYTES;
    if encoded.len() > max_encoded_bytes
        || encoded.len()
            < CHAPTER_PAGE_CACHE_MAGIC.len() + std::mem::size_of::<u32>()
        || &encoded[..CHAPTER_PAGE_CACHE_MAGIC.len()] != CHAPTER_PAGE_CACHE_MAGIC
    {
        return Err("invalid persisted entry envelope".to_string());
    }
    let metadata_start = CHAPTER_PAGE_CACHE_MAGIC.len() + std::mem::size_of::<u32>();
    let metadata_length = u32::from_le_bytes(
        encoded[CHAPTER_PAGE_CACHE_MAGIC.len()..metadata_start]
            .try_into()
            .map_err(|_| "invalid persisted metadata length".to_string())?,
    ) as usize;
    if metadata_length > MAX_CACHED_CHAPTER_PAGE_METADATA_BYTES
        || metadata_start.saturating_add(metadata_length) > encoded.len()
    {
        return Err("invalid persisted metadata bounds".to_string());
    }
    let body_start = metadata_start + metadata_length;
    let body = encoded[body_start..].to_vec();
    if body.len() > MAX_CACHED_CHAPTER_PAGE_BYTES {
        return Err("persisted body exceeds the size limit".to_string());
    }
    let metadata: PersistedChapterPageMetadata =
        serde_json::from_slice(&encoded[metadata_start..body_start])
            .map_err(|error| format!("decode persisted metadata: {error}"))?;
    let aliases = [metadata.cache_url.as_str(), metadata.final_url.as_str()];
    if metadata.source_id != expected_key.source_id
        || !aliases.iter().any(|alias| *alias == expected_key.url)
    {
        return Err("persisted entry key does not match the request".to_string());
    }
    let page = CachedChapterPage {
        status: metadata.status,
        status_text: metadata.status_text,
        headers: sanitized_chapter_page_headers(metadata.headers),
        cache_url: metadata.cache_url,
        final_url: metadata.final_url,
        body,
    };
    if !chapter_page_is_storable(&page) {
        return Err("persisted entry is not a cacheable chapter page".to_string());
    }
    Ok(Some(page))
}

fn chapter_page_is_storable(page: &CachedChapterPage) -> bool {
    page.status == 200
        && page.body.len() <= MAX_CACHED_CHAPTER_PAGE_BYTES
        && normalized_http_url(&page.cache_url).as_deref() == Some(page.cache_url.as_str())
        && normalized_http_url(&page.final_url).as_deref() == Some(page.final_url.as_str())
        && is_html_content_type(&page.headers)
        && !response_is_cloudflare_challenge(&page.headers, &page.body)
}

fn chapter_page_aliases(page: &CachedChapterPage) -> Vec<String> {
    let mut aliases = vec![page.cache_url.clone()];
    if page.final_url != page.cache_url {
        aliases.push(page.final_url.clone());
    }
    aliases
}

#[cfg(any(test, target_os = "windows"))]
fn is_cacheable_chapter_page_response(
    method: &str,
    status: i32,
    headers: &HashMap<String, String>,
    request_destination: Option<&str>,
) -> bool {
    method.eq_ignore_ascii_case("GET")
        && status == 200
        && request_destination
            .is_none_or(|destination| destination.eq_ignore_ascii_case("document"))
        && is_html_content_type(headers)
}

fn is_html_content_type(headers: &HashMap<String, String>) -> bool {
    headers
        .iter()
        .find_map(|(name, value)| name.eq_ignore_ascii_case("content-type").then_some(value))
        .map(|value| value.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "text/html" | "application/xhtml+xml"))
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

fn sanitized_chapter_page_headers(
    headers: HashMap<String, String>,
) -> HashMap<String, String> {
    headers
        .into_iter()
        .filter_map(|(name, value)| {
            let name = name.to_ascii_lowercase();
            let excluded = matches!(
                name.as_str(),
                "connection"
                    | "content-encoding"
                    | "content-length"
                    | "keep-alive"
                    | "proxy-authenticate"
                    | "proxy-authorization"
                    | "set-cookie"
                    | "set-cookie2"
                    | "te"
                    | "trailer"
                    | "transfer-encoding"
                    | "upgrade"
            );
            (!excluded
                && !name.contains(['\r', '\n', ':'])
                && !value.contains(['\r', '\n']))
            .then_some((name, value))
        })
        .collect()
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
        chapter_page_request_requires_http_revalidation,
        complete_deferred_dispatch_on_error, has_webp_signature,
        is_cacheable_chapter_page_response, normalized_http_url, response_capture_policy,
        CachedChapterPage, CapturedResource, CapturedResourceStore, ChapterPageCache,
        ChapterPageCacheLookup, ChapterPageCaptureToken, ChapterPageRequestAction,
        ResponseCapturePolicy,
        CHAPTER_PAGE_FETCH_TIMEOUT, MAX_CACHED_CHAPTER_PAGE_BYTES,
        MAX_CAPTURED_RESOURCE_BYTES,
    };
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    use tauri::{Webview, Wry};
    use tokio::sync::oneshot;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Deferral, ICoreWebView2Environment, ICoreWebView2WebResourceRequest,
        ICoreWebView2WebResourceRequestedEventArgs,
        ICoreWebView2WebResourceRequestedEventHandler,
        ICoreWebView2WebResourceResponseReceivedEventArgs,
        ICoreWebView2WebResourceResponseReceivedEventHandler, ICoreWebView2_2,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
    };
    use webview2_com::{
        take_pwstr, WebResourceRequestedEventHandler, WebResourceResponseReceivedEventHandler,
        WebResourceResponseViewGetContentCompletedHandler,
    };
    use windows::core::{AgileReference, HSTRING, IUnknown, Interface, PWSTR};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IStream, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::SHCreateMemStream;

    #[derive(Clone)]
    enum CaptureTarget {
        ChapterPage {
            cache_url: String,
            token: ChapterPageCaptureToken,
        },
        Resource {
            capture_id: u64,
            policy: ResponseCapturePolicy,
        },
    }

    pub async fn install(
        webview: &Webview<Wry>,
        executor: String,
        source_id: String,
        profile_directory: PathBuf,
        resource_store: Arc<CapturedResourceStore>,
        page_cache: Arc<ChapterPageCache>,
    ) -> Result<(), String> {
        let (sender, receiver) = oneshot::channel();
        let webview_for_requests = webview.clone();
        webview
            .with_webview(move |platform_webview| {
                let result = unsafe { (|| -> Result<(), String> {
                    let core = platform_webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| error.to_string())?;
                    let environment = platform_webview.environment();
                    let request_handler = request_handler(
                        executor.clone(),
                        source_id.clone(),
                        profile_directory.clone(),
                        environment,
                        webview_for_requests,
                        Arc::clone(&page_cache),
                    );
                    core.AddWebResourceRequestedFilter(
                        &HSTRING::from("*"),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
                    )
                    .map_err(|error| error.to_string())?;
                    let mut request_token = 0;
                    core.add_WebResourceRequested(&request_handler, &mut request_token)
                        .map_err(|error| error.to_string())?;

                    let core = core
                        .cast::<ICoreWebView2_2>()
                        .map_err(|error| error.to_string())?;
                    let response_handler = response_handler(
                        executor,
                        source_id,
                        profile_directory,
                        resource_store,
                        page_cache,
                    );
                    let mut response_token = 0;
                    core.add_WebResourceResponseReceived(
                        &response_handler,
                        &mut response_token,
                    )
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
        profile_directory: PathBuf,
        environment: ICoreWebView2Environment,
        webview: Webview<Wry>,
        page_cache: Arc<ChapterPageCache>,
    ) -> ICoreWebView2WebResourceRequestedEventHandler {
        WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            if let Err(error) = handle_document_request(
                &args,
                &executor,
                &source_id,
                &profile_directory,
                &environment,
                &webview,
                &page_cache,
            ) {
                log::debug!(
                    "[scraper:page_cache] document request ignored executor={executor}: {error}"
                );
            }
            Ok(())
        }))
    }

    fn handle_document_request(
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        executor: &str,
        source_id: &str,
        profile_directory: &PathBuf,
        environment: &ICoreWebView2Environment,
        webview: &Webview<Wry>,
        page_cache: &Arc<ChapterPageCache>,
    ) -> Result<(), String> {
        let (request, url, method, destination, context) = unsafe {
            let request = args.Request().map_err(|error| error.to_string())?;
            let url = request_uri(&request)?;
            let method = request_method(&request)?;
            let destination = request_destination(&request);
            let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
            args.ResourceContext(&mut context)
                .map_err(|error| error.to_string())?;
            (request, url, method, destination, context)
        };
        if context != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT
            || !method.eq_ignore_ascii_case("GET")
            || destination
                .as_deref()
                .is_some_and(|value| !value.eq_ignore_ascii_case("document"))
            || normalized_http_url(&url).is_none()
        {
            return Ok(());
        }

        let action = page_cache.begin_document_request(executor, source_id, &url);
        let action =
            page_cache.apply_required_reload(executor, source_id, profile_directory, action)?;
        if chapter_page_request_requires_http_revalidation(&action) {
            set_request_revalidation_headers(&request)?;
        }
        let cache_url = match action {
            ChapterPageRequestAction::Disabled => return Ok(()),
            ChapterPageRequestAction::Reload { .. } => return Ok(()),
            ChapterPageRequestAction::PreferCache {
                cache_url,
                redirect_continuation,
            } => (cache_url, redirect_continuation),
        };

        let (cache_url, redirect_continuation) = cache_url;
        let lookup = page_cache.lookup_preferred_page(
            source_id,
            profile_directory,
            &cache_url,
            redirect_continuation,
        );
        match lookup {
            ChapterPageCacheLookup::Hit(page) => {
                set_cached_response(args, environment, &url, &page)?;
            }
            ChapterPageCacheLookup::Leader(token) => {
                if !page_cache.bind_capture_token(executor, source_id, token.clone()) {
                    page_cache.complete_fetch(&token);
                }
            }
            ChapterPageCacheLookup::Wait(waiter) => {
                defer_cached_response(
                    args,
                    environment,
                    webview,
                    Arc::clone(page_cache),
                    source_id.to_string(),
                    profile_directory.clone(),
                    url,
                    cache_url,
                    waiter,
                )?;
            }
            ChapterPageCacheLookup::Network => {}
        }
        Ok(())
    }

    fn set_request_revalidation_headers(
        request: &ICoreWebView2WebResourceRequest,
    ) -> Result<(), String> {
        unsafe {
            let headers = request.Headers().map_err(|error| error.to_string())?;
            headers
                .SetHeader(&HSTRING::from("Cache-Control"), &HSTRING::from("no-cache"))
                .map_err(|error| error.to_string())?;
            headers
                .SetHeader(&HSTRING::from("Pragma"), &HSTRING::from("no-cache"))
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn defer_cached_response(
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        environment: &ICoreWebView2Environment,
        webview: &Webview<Wry>,
        page_cache: Arc<ChapterPageCache>,
        source_id: String,
        profile_directory: PathBuf,
        request_url: String,
        cache_url: String,
        waiter: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let args_reference = agile_unknown(args)?;
        let environment_reference = agile_unknown(environment)?;
        let deferral = unsafe { args.GetDeferral() }.map_err(|error| error.to_string())?;
        let deferral = match agile_unknown(&deferral) {
            Ok(deferral) => deferral,
            Err(error) => {
                let _ = unsafe { deferral.Complete() };
                return Err(error);
            }
        };
        let args = args_reference;
        let environment = environment_reference;
        let webview = webview.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tokio::time::timeout(CHAPTER_PAGE_FETCH_TIMEOUT, waiter).await;
            let page = page_cache.get(&source_id, &profile_directory, &cache_url);
            let fallback_deferral = deferral.clone();
            let dispatch = webview.run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    let args = args
                        .resolve()
                        .map_err(|error| error.to_string())?
                        .cast::<ICoreWebView2WebResourceRequestedEventArgs>()
                        .map_err(|error| error.to_string())?;
                    let environment = environment
                        .resolve()
                        .map_err(|error| error.to_string())?
                        .cast::<ICoreWebView2Environment>()
                        .map_err(|error| error.to_string())?;
                    if let Some(page) = page {
                        set_cached_response(&args, &environment, &request_url, &page)?;
                    }
                    Ok(())
                })();
                if let Err(error) = result {
                    log::debug!("[scraper:page_cache] deferred response missed: {error}");
                }
                complete_deferred_request(&deferral);
            });
            if let Err(error) = complete_deferred_dispatch_on_error(dispatch, || {
                complete_deferred_request(&fallback_deferral);
            }) {
                log::debug!("[scraper:page_cache] deferred response dispatch failed: {error}");
            }
        });
        Ok(())
    }

    fn agile_unknown<T: Interface>(value: &T) -> Result<AgileReference<IUnknown>, String> {
        let value = value
            .cast::<IUnknown>()
            .map_err(|error| error.to_string())?;
        AgileReference::new(&value).map_err(|error| error.to_string())
    }

    fn complete_deferred_request(deferral: &AgileReference<IUnknown>) {
        let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if let Ok(deferral) = deferral
            .resolve()
            .and_then(|value| value.cast::<ICoreWebView2Deferral>())
        {
            let _ = unsafe { deferral.Complete() };
        }
        if initialized.is_ok() {
            unsafe { CoUninitialize() };
        }
    }

    fn set_cached_response(
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        environment: &ICoreWebView2Environment,
        request_url: &str,
        page: &CachedChapterPage,
    ) -> Result<(), String> {
        let requested_url = normalized_http_url(request_url)
            .ok_or_else(|| "normalize cached response URL".to_string())?;
        let is_redirect_alias = requested_url != page.final_url;
        let (status, reason, headers) = if is_redirect_alias {
            (
                302,
                "Found",
                format!(
                    "Location: {}\r\nCache-Control: no-store\r\n",
                    page.final_url
                ),
            )
        } else {
            let reason = if page.status_text.trim().is_empty() {
                "OK"
            } else {
                page.status_text.as_str()
            };
            (
                page.status as i32,
                reason,
                chapter_page_response_headers(&page.headers),
            )
        };
        unsafe {
            let stream = (!is_redirect_alias && !page.body.is_empty())
                .then(|| SHCreateMemStream(Some(&page.body)))
                .flatten();
            if !is_redirect_alias && !page.body.is_empty() && stream.is_none() {
                return Err("create cached response stream".to_string());
            }
            let response = environment
                .CreateWebResourceResponse(
                    stream.as_ref(),
                    status,
                    &HSTRING::from(reason),
                    &HSTRING::from(headers),
                )
                .map_err(|error| error.to_string())?;
            args.SetResponse(&response)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn chapter_page_response_headers(headers: &HashMap<String, String>) -> String {
        let mut names = headers.keys().collect::<Vec<_>>();
        names.sort_unstable();
        names
            .into_iter()
            .filter_map(|name| headers.get(name).map(|value| format!("{name}: {value}\r\n")))
            .collect()
    }

    fn response_handler(
        executor: String,
        source_id: String,
        profile_directory: PathBuf,
        resource_store: Arc<CapturedResourceStore>,
        page_cache: Arc<ChapterPageCache>,
    ) -> ICoreWebView2WebResourceResponseReceivedEventHandler {
        WebResourceResponseReceivedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                if let Err(error) = capture_response(
                    &args,
                    &executor,
                    &source_id,
                    &profile_directory,
                    &resource_store,
                    &page_cache,
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
        source_id: &str,
        profile_directory: &PathBuf,
        resource_store: &Arc<CapturedResourceStore>,
        page_cache: &Arc<ChapterPageCache>,
    ) -> Result<(), String> {
        let (url, method, response, status, status_text, headers, request_destination) = unsafe {
            let request = args.Request().map_err(|error| error.to_string())?;
            let url = request_uri(&request)?;
            let method = request_method(&request)?;
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
                method,
                response,
                status,
                take_pwstr(reason),
                headers,
                request_destination,
            )
        };
        let chapter_page_capture = (method.eq_ignore_ascii_case("GET")
            && request_destination
                .as_deref()
                .is_none_or(|destination| destination.eq_ignore_ascii_case("document"))
            && normalized_http_url(&url).is_some())
        .then(|| {
            page_cache.finish_document_response(executor, source_id, &url, status, &headers)
        })
        .flatten();
        let target = if let Some(capture) = chapter_page_capture {
            if !is_cacheable_chapter_page_response(
                &method,
                status,
                &headers,
                request_destination.as_deref(),
            ) {
                page_cache.complete_fetch(&capture.token);
                return Ok(());
            }
            CaptureTarget::ChapterPage {
                cache_url: capture.cache_url,
                token: capture.token,
            }
        } else {
            let Some(policy) =
                response_capture_policy(&url, &headers, request_destination.as_deref())
            else {
                return Ok(());
            };
            if status != 200 {
                return Ok(());
            }
            let Some(capture_id) = resource_store.claim(executor) else {
                return Ok(());
            };
            CaptureTarget::Resource { capture_id, policy }
        };
        let executor = executor.to_string();
        let source_id = source_id.to_string();
        let profile_directory = profile_directory.clone();
        let get_content_executor = executor.clone();
        let get_content_source_id = source_id.clone();
        let get_content_url = url.clone();
        let callback_resource_store = Arc::clone(resource_store);
        let callback_page_cache = Arc::clone(page_cache);
        let callback_target = target.clone();
        let callback = WebResourceResponseViewGetContentCompletedHandler::create(Box::new(
            move |result, stream| {
                if result.is_err() || stream.is_none() {
                    complete_failed_capture(
                        callback_target.clone(),
                        &executor,
                        &source_id,
                        &url,
                        &callback_resource_store,
                        &callback_page_cache,
                    );
                    return Ok(());
                }
                let stream = stream.expect("captured response stream");
                let stream = match AgileReference::new(&stream) {
                    Ok(stream) => stream,
                    Err(error) => {
                        log::debug!(
                            "[scraper:resource_capture] stream marshal failed executor={executor}: {error}"
                        );
                        complete_failed_capture(
                            callback_target.clone(),
                            &executor,
                            &source_id,
                            &url,
                            &callback_resource_store,
                            &callback_page_cache,
                        );
                        return Ok(());
                    }
                };
                let worker_resource_store = Arc::clone(&callback_resource_store);
                let worker_page_cache = Arc::clone(&callback_page_cache);
                let worker_executor = executor.clone();
                let worker_source_id = source_id.clone();
                let worker_profile_directory = profile_directory.clone();
                let worker_url = url.clone();
                let worker_status_text = status_text.clone();
                let worker_headers = headers.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let worker_target = callback_target.clone();
                    let (policy, max_bytes) = match &worker_target {
                        CaptureTarget::ChapterPage { .. } => {
                            (ResponseCapturePolicy::TrustedMedia, MAX_CACHED_CHAPTER_PAGE_BYTES)
                        }
                        CaptureTarget::Resource { policy, .. } => {
                            (*policy, MAX_CAPTURED_RESOURCE_BYTES)
                        }
                    };
                    let body = match read_stream(stream, policy, max_bytes) {
                        Ok(body) => body,
                        Err(error) => {
                            log::debug!(
                                "[scraper:resource_capture] stream read failed executor={worker_executor}: {error}"
                            );
                            None
                        }
                    };
                    match worker_target {
                        CaptureTarget::ChapterPage { cache_url, token } => {
                            if let Some(body) = body {
                                let page = CachedChapterPage {
                                    status: status as u16,
                                    status_text: worker_status_text,
                                    headers: worker_headers,
                                    cache_url: cache_url.clone(),
                                    final_url: worker_url.clone(),
                                    body,
                                };
                                if let Err(error) = worker_page_cache.store_captured(
                                    &worker_source_id,
                                    &worker_profile_directory,
                                    page,
                                    &token,
                                ) {
                                    log::debug!(
                                        "[scraper:page_cache] response store failed: {error}"
                                    );
                                }
                            }
                            worker_page_cache.complete_fetch(&token);
                        }
                        CaptureTarget::Resource { capture_id, .. } => {
                            let resource = body.map(|body| CapturedResource {
                                status: status as u16,
                                status_text: worker_status_text,
                                headers: worker_headers,
                                final_url: worker_url,
                                body,
                            });
                            worker_resource_store.complete(
                                &worker_executor,
                                capture_id,
                                resource,
                            );
                        }
                    }
                });
                Ok(())
            },
        ));
        if let Err(error) = unsafe { response.GetContent(&callback) } {
            complete_failed_capture(
                target,
                &get_content_executor,
                &get_content_source_id,
                &get_content_url,
                resource_store,
                page_cache,
            );
            return Err(error.to_string());
        }
        Ok(())
    }

    fn complete_failed_capture(
        target: CaptureTarget,
        executor: &str,
        _source_id: &str,
        _url: &str,
        resource_store: &Arc<CapturedResourceStore>,
        page_cache: &Arc<ChapterPageCache>,
    ) {
        match target {
            CaptureTarget::ChapterPage { token, .. } => {
                page_cache.complete_fetch(&token)
            }
            CaptureTarget::Resource { capture_id, .. } => {
                resource_store.complete(executor, capture_id, None)
            }
        }
    }

    unsafe fn request_uri(request: &ICoreWebView2WebResourceRequest) -> Result<String, String> {
        let mut uri = PWSTR::null();
        request.Uri(&mut uri).map_err(|error| error.to_string())?;
        Ok(take_pwstr(uri))
    }

    unsafe fn request_method(request: &ICoreWebView2WebResourceRequest) -> Result<String, String> {
        let mut method = PWSTR::null();
        request
            .Method(&mut method)
            .map_err(|error| error.to_string())?;
        Ok(take_pwstr(method))
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

    fn chapter_page(url: &str, body: &[u8]) -> CachedChapterPage {
        CachedChapterPage {
            status: 200,
            status_text: "OK".to_string(),
            headers: HashMap::from([(
                "content-type".to_string(),
                "text/html; charset=utf-8".to_string(),
            )]),
            cache_url: url.to_string(),
            final_url: url.to_string(),
            body: body.to_vec(),
        }
    }

    fn begin_prefer_leader(
        cache: &ChapterPageCache,
        profile: &Path,
        executor: &str,
        source_id: &str,
        url: &str,
    ) {
        cache
            .prepare_navigation(
                executor,
                source_id,
                profile,
                url,
                Some(PageCachePolicy::PreferCache),
            )
            .unwrap();
        assert!(matches!(
            cache.begin_document_request(executor, source_id, url),
            ChapterPageRequestAction::PreferCache { .. }
        ));
        let ChapterPageCacheLookup::Leader(token) =
            cache.lookup_preferred_page(source_id, profile, url, false)
        else {
            panic!("expected the first custom-cache miss to lead the fetch");
        };
        assert!(cache.bind_capture_token(executor, source_id, token));
    }

    #[test]
    fn page_cache_policy_uses_the_ipc_string_contract() {
        assert_eq!(
            serde_json::from_str::<PageCachePolicy>(r#""prefer-cache""#).unwrap(),
            PageCachePolicy::PreferCache,
        );
        assert_eq!(
            serde_json::from_str::<PageCachePolicy>(r#""reload""#).unwrap(),
            PageCachePolicy::Reload,
        );
        assert!(serde_json::from_str::<PageCachePolicy>(r#""default""#).is_err());
    }

    #[test]
    fn chapter_page_cache_is_non_destructive_and_persists_fragment_variants() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        cache
            .store(
                "source-a",
                profile.path(),
                chapter_page(
                    "https://source.test/chapter/1?episode=1&_norea_capture=123#reader",
                    b"<p>one</p>",
                ),
            )
            .unwrap();

        for _ in 0..2 {
            assert_eq!(
                cache
                    .get(
                        "source-a",
                        profile.path(),
                        "https://source.test/chapter/1?episode=1&_norea_capture=456#other",
                    )
                    .map(|page| page.body.clone()),
                Some(b"<p>one</p>".to_vec()),
            );
        }

        let restarted = ChapterPageCache::default();
        assert_eq!(
            restarted
                .get(
                    "source-a",
                    profile.path(),
                    "https://source.test/chapter/1?episode=1",
                )
                .map(|page| page.body.clone()),
            Some(b"<p>one</p>".to_vec()),
        );
    }

    #[test]
    fn chapter_page_cache_key_removes_only_the_reserved_raw_query_pair() {
        let normalized = normalized_http_url(
            "https://source.test/chapter/1?title=a%20b&plus=a+b&_norea_capture=123&encoded=%2f%2F&title=second#reader",
        );

        assert_eq!(
            normalized.as_deref(),
            Some(
                "https://source.test/chapter/1?title=a%20b&plus=a+b&encoded=%2f%2F&title=second",
            ),
        );
    }

    #[test]
    fn chapter_page_cache_isolates_sources_and_invalidates_only_the_exact_url() {
        let profile_a = tempdir().unwrap();
        let profile_b = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        for (source_id, profile, url, body) in [
            (
                "source-a",
                profile_a.path(),
                "https://source.test/chapter/1",
                b"one".as_slice(),
            ),
            (
                "source-a",
                profile_a.path(),
                "https://source.test/chapter/2",
                b"two".as_slice(),
            ),
            (
                "source-b",
                profile_b.path(),
                "https://source.test/chapter/1",
                b"other source".as_slice(),
            ),
        ] {
            cache
                .store(source_id, profile, chapter_page(url, body))
                .unwrap();
        }

        assert!(cache
            .invalidate(
                "source-a",
                profile_a.path(),
                "https://source.test/chapter/1#reader",
            )
            .unwrap());
        assert!(cache
            .get(
                "source-a",
                profile_a.path(),
                "https://source.test/chapter/1",
            )
            .is_none());
        assert!(cache
            .get(
                "source-a",
                profile_a.path(),
                "https://source.test/chapter/2",
            )
            .is_some());
        assert_eq!(
            cache
                .get(
                    "source-b",
                    profile_b.path(),
                    "https://source.test/chapter/1",
                )
                .map(|page| page.body.clone()),
            Some(b"other source".to_vec()),
        );
    }

    #[test]
    fn chapter_page_cache_persists_redirect_aliases_and_invalidates_them_together() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let mut page = chapter_page("https://source.test/final/1", b"redirected");
        page.cache_url = "https://source.test/chapter/1?_norea_capture=123".to_string();
        cache.store("source-a", profile.path(), page).unwrap();

        for url in [
            "https://source.test/chapter/1",
            "https://source.test/final/1",
        ] {
            assert_eq!(
                ChapterPageCache::default()
                    .get("source-a", profile.path(), url)
                    .map(|page| page.body.clone()),
                Some(b"redirected".to_vec()),
            );
        }

        cache
            .invalidate(
                "source-a",
                profile.path(),
                "https://source.test/chapter/1",
            )
            .unwrap();
        let restarted = ChapterPageCache::default();
        for url in [
            "https://source.test/chapter/1",
            "https://source.test/final/1",
        ] {
            assert!(restarted.get("source-a", profile.path(), url).is_none());
        }
    }

    #[test]
    fn exact_invalidation_persists_reload_until_a_fresh_page_is_stored() {
        let profile = tempdir().unwrap();
        let source_id = "source-a";
        let url = "https://source.test/chapter/1";
        let cache = ChapterPageCache::default();
        cache
            .store(source_id, profile.path(), chapter_page(url, b"stale"))
            .unwrap();
        cache.invalidate(source_id, profile.path(), url).unwrap();

        let restarted = ChapterPageCache::default();
        restarted
            .prepare_navigation(
                "pool:first",
                source_id,
                profile.path(),
                url,
                Some(PageCachePolicy::PreferCache),
            )
            .unwrap();
        assert!(matches!(
            restarted.begin_document_request("pool:first", source_id, url),
            ChapterPageRequestAction::Reload { .. },
        ));
        restarted.abandon_navigation("pool:first");

        let retried = ChapterPageCache::default();
        retried
            .prepare_navigation(
                "pool:retry",
                source_id,
                profile.path(),
                url,
                Some(PageCachePolicy::PreferCache),
            )
            .unwrap();
        assert!(matches!(
            retried.begin_document_request("pool:retry", source_id, url),
            ChapterPageRequestAction::Reload { .. },
        ));
        let capture = retried
            .finish_document_response(
                "pool:retry",
                source_id,
                url,
                200,
                &HashMap::new(),
            )
            .unwrap();
        assert!(retried
            .store_captured(
                source_id,
                profile.path(),
                chapter_page(url, b"fresh"),
                &capture.token,
            )
            .unwrap());
        retried.complete_fetch(&capture.token);

        let after_store = ChapterPageCache::default();
        after_store
            .prepare_navigation(
                "pool:after",
                source_id,
                profile.path(),
                url,
                Some(PageCachePolicy::PreferCache),
            )
            .unwrap();
        assert!(matches!(
            after_store.begin_document_request("pool:after", source_id, url),
            ChapterPageRequestAction::PreferCache { .. },
        ));
        assert!(matches!(
            after_store.lookup_preferred_page(source_id, profile.path(), url, false),
            ChapterPageCacheLookup::Hit(_),
        ));
    }

    #[test]
    fn foreground_navigation_honors_a_persisted_reload_marker() {
        let profile = tempdir().unwrap();
        let source_id = "source-a";
        let url = "https://source.test/chapter/1";
        let cache = ChapterPageCache::default();
        cache
            .store(source_id, profile.path(), chapter_page(url, b"stale"))
            .unwrap();
        cache.invalidate(source_id, profile.path(), url).unwrap();

        let restarted = ChapterPageCache::default();
        restarted.enable_foreground("immediate");
        let action = restarted.begin_document_request("immediate", source_id, url);
        assert!(matches!(
            action,
            ChapterPageRequestAction::PreferCache { .. }
        ));
        let action = restarted
            .apply_required_reload("immediate", source_id, profile.path(), action)
            .unwrap();
        assert_eq!(
            action,
            ChapterPageRequestAction::Reload {
                cache_url: url.to_string(),
            },
        );

        let capture = restarted
            .finish_document_response("immediate", source_id, url, 200, &HashMap::new())
            .unwrap();
        assert!(restarted
            .store_captured(
                source_id,
                profile.path(),
                chapter_page(url, b"fresh"),
                &capture.token,
            )
            .unwrap());
        restarted.complete_fetch(&capture.token);

        assert!(!chapter_page_reload_is_required(profile.path(), url).unwrap());
        assert_eq!(
            ChapterPageCache::default()
                .get(source_id, profile.path(), url)
                .map(|page| page.body.clone()),
            Some(b"fresh".to_vec()),
        );
    }

    #[test]
    fn source_invalidation_persists_one_reload_for_each_cached_page() {
        let profile = tempdir().unwrap();
        let source_id = "source-a";
        let urls = [
            "https://source.test/chapter/1",
            "https://source.test/chapter/2",
        ];
        let cache = ChapterPageCache::default();
        for url in urls {
            cache
                .store(source_id, profile.path(), chapter_page(url, b"stale"))
                .unwrap();
        }
        cache.clear_source(source_id, profile.path()).unwrap();

        let restarted = ChapterPageCache::default();
        for (index, url) in urls.into_iter().enumerate() {
            let executor = format!("pool:{index}");
            restarted
                .prepare_navigation(
                    &executor,
                    source_id,
                    profile.path(),
                    url,
                    Some(PageCachePolicy::PreferCache),
                )
                .unwrap();
            assert!(matches!(
                restarted.begin_document_request(&executor, source_id, url),
                ChapterPageRequestAction::Reload { .. },
            ));
            restarted.abandon_navigation(&executor);
        }
    }

    #[test]
    fn replacing_a_redirect_prunes_the_previous_alias() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let requested_url = "https://source.test/chapter/1";
        let old_final_url = "https://source.test/read/old";
        let new_final_url = "https://source.test/read/new";
        let mut old_page = chapter_page(old_final_url, b"old");
        old_page.cache_url = requested_url.to_string();
        cache.store("source-a", profile.path(), old_page).unwrap();
        let mut new_page = chapter_page(new_final_url, b"new");
        new_page.cache_url = requested_url.to_string();

        cache.store("source-a", profile.path(), new_page).unwrap();

        assert!(cache
            .get("source-a", profile.path(), old_final_url)
            .is_none());
        let restarted = ChapterPageCache::default();
        assert!(restarted
            .get("source-a", profile.path(), old_final_url)
            .is_none());
        for url in [requested_url, new_final_url] {
            assert_eq!(
                restarted
                    .get("source-a", profile.path(), url)
                    .map(|page| page.body.clone()),
                Some(b"new".to_vec()),
            );
        }
    }

    #[test]
    fn chapter_page_cache_clear_removes_memory_and_persisted_entries() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        cache
            .store(
                "source-a",
                profile.path(),
                chapter_page("https://source.test/chapter/1", b"cached"),
            )
            .unwrap();
        let pending_url = "https://source.test/chapter/2";
        begin_prefer_leader(
            &cache,
            profile.path(),
            "pool:1",
            "source-a",
            pending_url,
        );
        let pending = cache
            .finish_document_response(
                "pool:1",
                "source-a",
                pending_url,
                200,
                &HashMap::new(),
            )
            .unwrap();

        cache.clear_profiles(&[profile.path().to_path_buf()]).unwrap();

        assert!(cache
            .get(
                "source-a",
                profile.path(),
                "https://source.test/chapter/1",
            )
            .is_none());
        assert!(ChapterPageCache::default()
            .get(
                "source-a",
                profile.path(),
                "https://source.test/chapter/1",
            )
            .is_none());
        assert!(!cache
            .store_captured(
                "source-a",
                profile.path(),
                chapter_page(pending_url, b"late"),
                &pending.token,
            )
            .unwrap());
    }

    #[test]
    fn reload_policy_bypasses_only_one_matching_top_level_document() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        cache
            .prepare_navigation(
                "pool:1",
                "source-a",
                profile.path(),
                "https://source.test/chapter/1#reader",
                Some(PageCachePolicy::Reload),
            )
            .unwrap();

        assert_eq!(
            cache.begin_document_request(
                "pool:1",
                "source-a",
                "https://source.test/chapter/2",
            ),
            ChapterPageRequestAction::Disabled,
        );
        assert_eq!(
            cache.begin_document_request(
                "pool:1",
                "source-a",
                "https://source.test/chapter/1#other",
            ),
            ChapterPageRequestAction::Reload {
                cache_url: "https://source.test/chapter/1".to_string(),
            },
        );
        assert_eq!(
            cache.begin_document_request(
                "pool:1",
                "source-a",
                "https://source.test/chapter/1",
            ),
            ChapterPageRequestAction::Disabled,
        );
    }

    #[test]
    fn reload_removes_the_old_page_and_makes_prefer_cache_follow_its_flight() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let url = "https://source.test/chapter/1";
        cache
            .store(
                "source-a",
                profile.path(),
                chapter_page(url, b"old"),
            )
            .unwrap();
        cache.enable_foreground("foreground:old");
        assert!(matches!(
            cache.begin_document_request("foreground:old", "source-a", url),
            ChapterPageRequestAction::PreferCache { .. }
        ));
        assert!(matches!(
            cache.lookup_preferred_page("source-a", profile.path(), url, false),
            ChapterPageCacheLookup::Hit(_),
        ));
        cache
            .prepare_navigation(
                "pool:reload",
                "source-a",
                profile.path(),
                url,
                Some(PageCachePolicy::Reload),
            )
            .unwrap();

        assert!(cache.get("source-a", profile.path(), url).is_none());
        assert!(matches!(
            cache.begin_document_request("pool:reload", "source-a", url),
            ChapterPageRequestAction::Reload { .. }
        ));
        cache.enable_foreground("immediate");
        assert!(matches!(
            cache.begin_document_request("immediate", "source-a", url),
            ChapterPageRequestAction::PreferCache { .. }
        ));
        let ChapterPageCacheLookup::Wait(mut waiter) =
            cache.lookup_preferred_page("source-a", profile.path(), url, false)
        else {
            panic!("prefer-cache must follow the active reload");
        };

        let capture = cache
            .finish_document_response(
                "pool:reload",
                "source-a",
                url,
                200,
                &HashMap::new(),
            )
            .unwrap();
        assert!(cache
            .store_captured(
                "source-a",
                profile.path(),
                chapter_page(url, b"fresh"),
                &capture.token,
            )
            .unwrap());
        cache.complete_fetch(&capture.token);

        assert!(waiter.try_recv().is_ok());
        assert!(cache
            .finish_document_response(
                "foreground:old",
                "source-a",
                url,
                200,
                &HashMap::new(),
            )
            .is_none());
        assert_eq!(
            cache
                .get("source-a", profile.path(), url)
                .map(|page| page.body.clone()),
            Some(b"fresh".to_vec()),
        );
    }

    #[test]
    fn abandoning_a_navigation_releases_its_flight_and_waiters() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let source_id = "source-a";
        let url = "https://source.test/chapter/1";
        begin_prefer_leader(&cache, profile.path(), "pool:leader", source_id, url);
        let ChapterPageCacheLookup::Wait(mut waiter) =
            cache.lookup_or_follow(source_id, profile.path(), url)
        else {
            panic!("the competing request should wait for the active navigation");
        };

        cache.abandon_navigation("pool:leader");

        assert!(waiter.try_recv().is_ok());
        assert!(matches!(
            cache.lookup_or_follow(source_id, profile.path(), url),
            ChapterPageCacheLookup::Leader(_),
        ));
    }

    #[test]
    fn replacing_a_prepared_navigation_releases_its_reload_flight() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let source_id = "source-a";
        let old_url = "https://source.test/chapter/1";
        let new_url = "https://source.test/chapter/2";
        cache
            .prepare_navigation(
                "pool:1",
                source_id,
                profile.path(),
                old_url,
                Some(PageCachePolicy::Reload),
            )
            .unwrap();
        let ChapterPageCacheLookup::Wait(mut waiter) =
            cache.lookup_or_follow(source_id, profile.path(), old_url)
        else {
            panic!("the prepared reload should own the flight");
        };

        cache
            .prepare_navigation(
                "pool:1",
                source_id,
                profile.path(),
                new_url,
                Some(PageCachePolicy::PreferCache),
            )
            .unwrap();

        assert!(waiter.try_recv().is_ok());
        assert!(matches!(
            cache.lookup_or_follow(source_id, profile.path(), old_url),
            ChapterPageCacheLookup::Leader(_),
        ));
    }

    #[test]
    fn reload_makes_every_previous_redirect_alias_follow_the_same_flight() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let requested_url = "https://source.test/chapter/1";
        let final_url = "https://source.test/read/1";
        let mut old_page = chapter_page(final_url, b"old");
        old_page.cache_url = requested_url.to_string();
        cache.store("source-a", profile.path(), old_page).unwrap();

        cache
            .prepare_navigation(
                "pool:reload",
                "source-a",
                profile.path(),
                requested_url,
                Some(PageCachePolicy::Reload),
            )
            .unwrap();

        assert!(cache
            .get("source-a", profile.path(), final_url)
            .is_none());
        assert!(matches!(
            cache.lookup_or_follow("source-a", profile.path(), final_url),
            ChapterPageCacheLookup::Wait(_),
        ));
    }

    #[test]
    fn generic_extract_is_disabled_while_foreground_navigation_prefers_cache() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        cache
            .prepare_navigation(
                "pool:1",
                "source-a",
                profile.path(),
                "https://source.test/chapter/1",
                None,
            )
            .unwrap();
        assert_eq!(
            cache.begin_document_request(
                "pool:1",
                "source-a",
                "https://source.test/chapter/1",
            ),
            ChapterPageRequestAction::Disabled,
        );

        cache.enable_foreground("immediate");
        assert_eq!(
            cache.begin_document_request(
                "immediate",
                "source-a",
                "https://source.test/chapter/1",
            ),
            ChapterPageRequestAction::PreferCache {
                cache_url: "https://source.test/chapter/1".to_string(),
                redirect_continuation: false,
            },
        );
    }

    #[test]
    fn redirect_leader_continues_network_without_waiting_on_itself() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let requested_url = "https://source.test/chapter/1";
        let final_url = "https://source.test/read/1";
        begin_prefer_leader(
            &cache,
            profile.path(),
            "pool:1",
            "source-a",
            requested_url,
        );
        assert!(cache
            .finish_document_response(
                "pool:1",
                "source-a",
                requested_url,
                302,
                &HashMap::from([("location".to_string(), final_url.to_string())]),
            )
            .is_none());

        let continuation =
            cache.begin_document_request("pool:1", "source-a", final_url);
        assert_eq!(
            continuation,
            ChapterPageRequestAction::PreferCache {
                cache_url: requested_url.to_string(),
                redirect_continuation: true,
            },
        );
        assert!(matches!(
            cache.lookup_preferred_page("source-a", profile.path(), requested_url, true),
            ChapterPageCacheLookup::Network,
        ));
        assert!(matches!(
            cache.lookup_or_follow("source-a", profile.path(), requested_url),
            ChapterPageCacheLookup::Wait(_),
        ));
    }

    #[test]
    fn redirect_final_url_joins_the_original_flight_and_absorbs_an_early_leader() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let source_id = "source-a";
        let requested_url = "https://source.test/chapter/1";
        let final_url = "https://source.test/read/1";
        begin_prefer_leader(
            &cache,
            profile.path(),
            "pool:redirect",
            source_id,
            requested_url,
        );
        let ChapterPageCacheLookup::Leader(early_final_token) =
            cache.lookup_or_follow(source_id, profile.path(), final_url)
        else {
            panic!("the direct final URL should initially own a separate flight");
        };
        let ChapterPageCacheLookup::Wait(mut early_final_waiter) =
            cache.lookup_or_follow(source_id, profile.path(), final_url)
        else {
            panic!("the early final URL follower should wait");
        };

        assert!(cache
            .finish_document_response(
                "pool:redirect",
                source_id,
                requested_url,
                302,
                &HashMap::from([("location".to_string(), final_url.to_string())]),
            )
            .is_none());
        let ChapterPageCacheLookup::Wait(mut joined_waiter) =
            cache.lookup_or_follow(source_id, profile.path(), final_url)
        else {
            panic!("the redirect alias must follow the original flight");
        };
        assert!(!cache
            .store_captured(
                source_id,
                profile.path(),
                chapter_page(final_url, b"duplicate"),
                &early_final_token,
            )
            .unwrap());
        cache.complete_fetch(&early_final_token);
        assert!(matches!(
            early_final_waiter.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            joined_waiter.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(matches!(
            cache.begin_document_request("pool:redirect", source_id, final_url),
            ChapterPageRequestAction::PreferCache {
                redirect_continuation: true,
                ..
            }
        ));
        assert!(matches!(
            cache.lookup_preferred_page(source_id, profile.path(), requested_url, true),
            ChapterPageCacheLookup::Network,
        ));

        let capture = cache
            .finish_document_response(
                "pool:redirect",
                source_id,
                final_url,
                200,
                &HashMap::new(),
            )
            .unwrap();
        let mut page = chapter_page(final_url, b"redirected");
        page.cache_url = requested_url.to_string();
        assert!(cache
            .store_captured(source_id, profile.path(), page, &capture.token)
            .unwrap());
        cache.complete_fetch(&capture.token);

        assert!(early_final_waiter.try_recv().is_ok());
        assert!(joined_waiter.try_recv().is_ok());
    }

    #[test]
    fn not_modified_response_finishes_the_navigation_and_dedupe() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let url = "https://source.test/chapter/1";
        begin_prefer_leader(&cache, profile.path(), "pool:1", "source-a", url);

        let capture = cache
            .finish_document_response(
                "pool:1",
                "source-a",
                url,
                304,
                &HashMap::new(),
            )
            .expect("304 must finish instead of waiting for a redirect");
        cache.complete_fetch(&capture.token);

        assert!(matches!(
            cache.lookup_or_follow("source-a", profile.path(), url),
            ChapterPageCacheLookup::Leader(_),
        ));
        assert_eq!(
            cache.begin_document_request("pool:1", "source-a", url),
            ChapterPageRequestAction::Disabled,
        );
    }

    #[test]
    fn only_followable_redirects_with_http_locations_remain_active() {
        let valid = HashMap::from([("Location".to_string(), "/read/1".to_string())]);
        assert!(is_followed_document_redirect(
            302,
            &valid,
            "https://source.test/chapter/1",
        ));
        for (status, headers) in [
            (304, valid.clone()),
            (302, HashMap::new()),
            (
                302,
                HashMap::from([("location".to_string(), "javascript:close()".to_string())]),
            ),
            (305, valid),
        ] {
            assert!(!is_followed_document_redirect(
                status,
                &headers,
                "https://source.test/chapter/1",
            ));
        }
    }

    #[test]
    fn invalidation_rejects_an_older_in_flight_capture() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let url = "https://source.test/chapter/1";
        begin_prefer_leader(&cache, profile.path(), "pool:1", "source-a", url);
        let capture = cache
            .finish_document_response(
                "pool:1",
                "source-a",
                url,
                200,
                &HashMap::new(),
            )
            .unwrap();

        cache.invalidate("source-a", profile.path(), url).unwrap();

        assert!(!cache
            .store_captured(
                "source-a",
                profile.path(),
                chapter_page(url, b"stale"),
                &capture.token,
            )
            .unwrap());
        assert!(cache.get("source-a", profile.path(), url).is_none());
    }

    #[test]
    fn manual_action_invalidation_removes_committed_and_racing_pages() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let source_id = "source-a";
        let url = "https://source.test/chapter/1";
        begin_prefer_leader(&cache, profile.path(), "pool:gate", source_id, url);
        let capture = cache
            .finish_document_response(
                "pool:gate",
                source_id,
                url,
                200,
                &HashMap::new(),
            )
            .unwrap();
        assert!(cache
            .store(source_id, profile.path(), chapter_page(url, b"committed gate"))
            .unwrap());

        cache.invalidate(source_id, profile.path(), url).unwrap();

        assert!(cache.get(source_id, profile.path(), url).is_none());
        assert!(ChapterPageCache::default()
            .get(source_id, profile.path(), url)
            .is_none());
        assert!(!cache
            .store_captured(
                source_id,
                profile.path(),
                chapter_page(url, b"racing gate"),
                &capture.token,
            )
            .unwrap());
        cache
            .prepare_navigation(
                "pool:retry",
                source_id,
                profile.path(),
                url,
                Some(PageCachePolicy::PreferCache),
            )
            .unwrap();
        assert!(matches!(
            cache.begin_document_request("pool:retry", source_id, url),
            ChapterPageRequestAction::Reload { .. },
        ));
    }

    #[test]
    fn invalidation_during_redirect_rejects_the_original_navigation_capture() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let requested_url = "https://source.test/chapter/1";
        let final_url = "https://source.test/read/1";
        begin_prefer_leader(
            &cache,
            profile.path(),
            "pool:1",
            "source-a",
            requested_url,
        );
        assert!(cache
            .finish_document_response(
                "pool:1",
                "source-a",
                requested_url,
                302,
                &HashMap::from([("location".to_string(), final_url.to_string())]),
            )
            .is_none());

        cache
            .invalidate("source-a", profile.path(), requested_url)
            .unwrap();
        assert!(matches!(
            cache.begin_document_request("pool:1", "source-a", final_url),
            ChapterPageRequestAction::PreferCache {
                redirect_continuation: true,
                ..
            }
        ));
        let capture = cache
            .finish_document_response(
                "pool:1",
                "source-a",
                final_url,
                200,
                &HashMap::new(),
            )
            .unwrap();
        let mut page = chapter_page(final_url, b"late");
        page.cache_url = requested_url.to_string();

        assert!(!cache
            .store_captured("source-a", profile.path(), page, &capture.token)
            .unwrap());
    }

    #[test]
    fn source_clear_rejects_only_that_sources_older_capture() {
        let profile_a = tempdir().unwrap();
        let profile_b = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let url = "https://source.test/chapter/1";
        let mut captures = Vec::new();
        for (executor, source_id) in [("pool:1", "source-a"), ("pool:2", "source-b")] {
            let profile = if source_id == "source-a" {
                profile_a.path()
            } else {
                profile_b.path()
            };
            begin_prefer_leader(
                &cache,
                profile,
                executor,
                source_id,
                url,
            );
            captures.push((
                source_id,
                cache
                    .finish_document_response(
                        executor,
                        source_id,
                        url,
                        200,
                        &HashMap::new(),
                    )
                    .unwrap()
                    .token,
            ));
        }

        cache.clear_source("source-a", profile_a.path()).unwrap();

        assert!(!cache
            .store_captured(
                "source-a",
                profile_a.path(),
                chapter_page(url, b"stale-a"),
                &captures[0].1,
            )
            .unwrap());
        assert!(cache
            .store_captured(
                "source-b",
                profile_b.path(),
                chapter_page(url, b"current-b"),
                &captures[1].1,
            )
            .unwrap());
        assert_eq!(
            cache
                .get("source-b", profile_b.path(), url)
                .map(|page| page.body.clone()),
            Some(b"current-b".to_vec()),
        );
    }

    #[test]
    fn clear_barriers_reject_overlapping_captures_without_blocking_other_sources() {
        let profile_a = tempdir().unwrap();
        let profile_b = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let url = "https://source.test/chapter/1";
        let ChapterPageCacheLookup::Leader(token_a) =
            cache.lookup_or_follow("source-a", profile_a.path(), url)
        else {
            panic!("source-a should lead its initial fetch");
        };
        let ChapterPageCacheLookup::Leader(token_b) =
            cache.lookup_or_follow("source-b", profile_b.path(), url)
        else {
            panic!("source-b should lead its initial fetch");
        };
        let key_a = chapter_page_cache_key("source-a", url).unwrap();
        let key_b = chapter_page_cache_key("source-b", url).unwrap();

        let source_clear = cache.begin_source_clear("source-a");
        assert!(cache.capture_token(&key_a, 100).is_none());
        assert!(cache.capture_token(&key_b, 101).is_some());
        assert!(!cache
            .store_captured(
                "source-a",
                profile_a.path(),
                chapter_page(url, b"stale-a"),
                &token_a,
            )
            .unwrap());
        assert!(cache
            .store_captured(
                "source-b",
                profile_b.path(),
                chapter_page(url, b"current-b"),
                &token_b,
            )
            .unwrap());
        drop(source_clear);
        assert!(cache.capture_token(&key_a, 102).is_some());

        let full_clear = cache.begin_full_clear();
        assert!(cache.capture_token(&key_a, 103).is_none());
        assert!(cache.capture_token(&key_b, 104).is_none());
        drop(full_clear);
        assert!(cache.capture_token(&key_b, 105).is_some());
    }

    #[test]
    fn expired_flight_cannot_store_or_complete_its_replacement() {
        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let source_id = "source-a";
        let url = "https://source.test/chapter/1";
        let ChapterPageCacheLookup::Leader(expired_token) =
            cache.lookup_or_follow(source_id, profile.path(), url)
        else {
            panic!("the first miss should lead");
        };
        cache
            .in_flight
            .lock()
            .unwrap()
            .get(&expired_token.key)
            .unwrap()
            .lock()
            .unwrap()
            .started = Instant::now() - CHAPTER_PAGE_FETCH_TIMEOUT;
        let ChapterPageCacheLookup::Leader(current_token) =
            cache.lookup_or_follow(source_id, profile.path(), url)
        else {
            panic!("an expired flight should be replaced");
        };
        assert_ne!(expired_token.flight_id, current_token.flight_id);

        assert!(!cache
            .store_captured(
                source_id,
                profile.path(),
                chapter_page(url, b"expired"),
                &expired_token,
            )
            .unwrap());
        cache.complete_fetch(&expired_token);
        assert!(matches!(
            cache.lookup_or_follow(source_id, profile.path(), url),
            ChapterPageCacheLookup::Wait(_),
        ));
        assert!(cache
            .store_captured(
                source_id,
                profile.path(),
                chapter_page(url, b"current"),
                &current_token,
            )
            .unwrap());
        cache.complete_fetch(&current_token);
        assert_eq!(
            cache
                .get(source_id, profile.path(), url)
                .map(|page| page.body.clone()),
            Some(b"current".to_vec()),
        );
    }

    #[test]
    fn chapter_page_cache_rejects_non_document_challenge_and_oversized_responses() {
        let headers = HashMap::from([(
            "content-type".to_string(),
            "text/html; charset=utf-8".to_string(),
        )]);
        assert!(is_cacheable_chapter_page_response(
            "GET",
            200,
            &headers,
            None,
        ));
        for (method, status, content_type, destination) in [
            ("POST", 200, "text/html", Some("document")),
            ("GET", 404, "text/html", Some("document")),
            ("GET", 200, "application/json", Some("document")),
            ("GET", 200, "text/html", Some("iframe")),
        ] {
            assert!(!is_cacheable_chapter_page_response(
                method,
                status,
                &HashMap::from([("content-type".to_string(), content_type.to_string())]),
                destination,
            ));
        }

        let profile = tempdir().unwrap();
        let cache = ChapterPageCache::default();
        let challenge = b"<!doctype html><script src='/cdn-cgi/challenge-platform/h/g'></script>";
        assert!(!cache
            .store(
                "source-a",
                profile.path(),
                chapter_page("https://source.test/challenge", challenge),
            )
            .unwrap());
        assert!(!cache
            .store(
                "source-a",
                profile.path(),
                chapter_page(
                    "https://source.test/oversized",
                    &vec![b'x'; MAX_CACHED_CHAPTER_PAGE_BYTES + 1],
                ),
            )
            .unwrap());
    }

    #[test]
    fn only_reload_requests_bypass_the_webview_http_cache() {
        assert!(!chapter_page_request_requires_http_revalidation(
            &ChapterPageRequestAction::Disabled,
        ));
        assert!(!chapter_page_request_requires_http_revalidation(
            &ChapterPageRequestAction::PreferCache {
                cache_url: "https://source.test/chapter/1".to_string(),
                redirect_continuation: false,
            },
        ));
        assert!(chapter_page_request_requires_http_revalidation(
            &ChapterPageRequestAction::Reload {
                cache_url: "https://source.test/chapter/1".to_string(),
            },
        ));
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
    fn resumes_an_active_session_without_resetting_resources() {
        let store = CapturedResourceStore::default();
        let capture_id = store.begin_or_resume("foreground:source");
        assert_eq!(store.claim("foreground:source"), Some(capture_id));
        store.complete(
            "foreground:source",
            capture_id,
            Some(resource("https://cdn.test/first.png", b"first")),
        );

        assert_eq!(store.begin_or_resume("foreground:source"), capture_id);
        assert_eq!(
            store
                .take("foreground:source", "https://cdn.test/first.png")
                .map(|resource| resource.body),
            Some(b"first".to_vec())
        );
    }

    #[test]
    fn resumes_a_stopped_session_and_preserves_resources_by_url() {
        let store = CapturedResourceStore::default();
        let capture_id = store.begin_or_resume("foreground:source");
        for (url, body) in [
            ("https://cdn.test/first.png", b"first".as_slice()),
            ("https://cdn.test/second.png#page", b"second".as_slice()),
        ] {
            assert_eq!(store.claim("foreground:source"), Some(capture_id));
            store.complete("foreground:source", capture_id, Some(resource(url, body)));
        }
        store.stop("foreground:source");
        assert_eq!(store.claim("foreground:source"), None);

        assert_eq!(store.begin_or_resume("foreground:source"), capture_id);
        assert_eq!(store.claim("foreground:source"), Some(capture_id));
        store.complete(
            "foreground:source",
            capture_id,
            Some(resource("https://cdn.test/third.png", b"third")),
        );
        store.finish("foreground:source", capture_id);

        for (url, expected) in [
            ("https://cdn.test/first.png", b"first".as_slice()),
            ("https://cdn.test/second.png", b"second".as_slice()),
            ("https://cdn.test/third.png", b"third".as_slice()),
        ] {
            assert_eq!(
                store
                    .take("foreground:source", url)
                    .map(|resource| resource.body),
                Some(expected.to_vec())
            );
        }
    }

    #[test]
    fn evicts_oldest_resources_when_session_reaches_total_limit() {
        let store = CapturedResourceStore::default();
        let capture_id = store.begin("foreground:source");
        for (url, body) in [
            ("https://cdn.test/first.png", b"first".as_slice()),
            ("https://cdn.test/second.png", b"second".as_slice()),
            ("https://cdn.test/third.png", b"third".as_slice()),
        ] {
            assert_eq!(store.claim("foreground:source"), Some(capture_id));
            store.complete_with_total_limit(
                "foreground:source",
                capture_id,
                Some(resource(url, body)),
                11,
            );
        }

        assert!(store
            .take("foreground:source", "https://cdn.test/first.png")
            .is_none());
        assert_eq!(
            store
                .take("foreground:source", "https://cdn.test/second.png")
                .map(|resource| resource.body),
            Some(b"second".to_vec())
        );
        assert_eq!(
            store
                .take("foreground:source", "https://cdn.test/third.png")
                .map(|resource| resource.body),
            Some(b"third".to_vec())
        );
    }

    #[test]
    fn refreshing_a_resource_moves_it_behind_older_resources() {
        let store = CapturedResourceStore::default();
        let capture_id = store.begin("foreground:source");
        for (url, body) in [
            ("https://cdn.test/first.png", b"old1".as_slice()),
            ("https://cdn.test/second.png", b"two2".as_slice()),
            ("https://cdn.test/first.png", b"new1".as_slice()),
            ("https://cdn.test/third.png", b"tri3".as_slice()),
        ] {
            assert_eq!(store.claim("foreground:source"), Some(capture_id));
            store.complete_with_total_limit(
                "foreground:source",
                capture_id,
                Some(resource(url, body)),
                8,
            );
        }

        assert!(store
            .take("foreground:source", "https://cdn.test/second.png")
            .is_none());
        assert_eq!(
            store
                .take("foreground:source", "https://cdn.test/first.png")
                .map(|resource| resource.body),
            Some(b"new1".to_vec())
        );
        assert_eq!(
            store
                .take("foreground:source", "https://cdn.test/third.png")
                .map(|resource| resource.body),
            Some(b"tri3".to_vec())
        );
    }

    #[test]
    fn taking_a_resource_releases_its_capacity_and_order_entry() {
        let store = CapturedResourceStore::default();
        let capture_id = store.begin("foreground:source");
        for (url, body) in [
            ("https://cdn.test/first.png", b"first".as_slice()),
            ("https://cdn.test/second.png", b"other".as_slice()),
        ] {
            assert_eq!(store.claim("foreground:source"), Some(capture_id));
            store.complete_with_total_limit(
                "foreground:source",
                capture_id,
                Some(resource(url, body)),
                10,
            );
        }

        assert!(store
            .take("foreground:source", "https://cdn.test/first.png")
            .is_some());
        {
            let sessions = store
                .sessions
                .lock()
                .expect("captured resource sessions mutex");
            let session = sessions.get("foreground:source").unwrap();
            assert_eq!(session.total_bytes, 5);
            assert_eq!(
                session.resource_order,
                VecDeque::from(["https://cdn.test/second.png".to_string()])
            );
        }

        assert_eq!(store.claim("foreground:source"), Some(capture_id));
        store.complete_with_total_limit(
            "foreground:source",
            capture_id,
            Some(resource("https://cdn.test/third.png", b"third")),
            10,
        );
        for url in [
            "https://cdn.test/second.png",
            "https://cdn.test/third.png",
        ] {
            assert!(store.take("foreground:source", url).is_some());
        }
    }

    #[test]
    fn clears_every_capture_session() {
        let store = CapturedResourceStore::default();
        for executor in ["immediate", "pool:1"] {
            let capture_id = store.begin(executor);
            assert_eq!(store.claim(executor), Some(capture_id));
            store.complete(
                executor,
                capture_id,
                Some(resource(
                    &format!("https://cdn.test/{executor}.png"),
                    executor.as_bytes(),
                )),
            );
        }

        store.clear_all();

        assert_eq!(store.claim("immediate"), None);
        assert_eq!(store.claim("pool:1"), None);
        assert!(store
            .take("immediate", "https://cdn.test/immediate.png")
            .is_none());
        assert!(store
            .take("pool:1", "https://cdn.test/pool:1.png")
            .is_none());
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
