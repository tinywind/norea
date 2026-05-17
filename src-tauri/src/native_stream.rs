use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

const BYTES_PER_MIB: u64 = 1024 * 1024;
pub const MAX_INLINE_IPC_BYTES: u64 = 128 * BYTES_PER_MIB;
pub const MAX_NATIVE_STREAM_BYTES: u64 = 2 * 1024 * BYTES_PER_MIB;
const DEFAULT_NATIVE_STREAM_BYTES: u64 = MAX_INLINE_IPC_BYTES;
const DEFAULT_TTL_MS: u64 = 30 * 60 * 1000;
const MAX_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const STREAM_ROOT_DIR: &str = "native-stream";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamInfo {
    handle: String,
    domain: String,
    size: u64,
    max_bytes: u64,
    created_at_ms: u64,
    expires_at_ms: u64,
    finished: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamReadChunk {
    offset: u64,
    bytes: Vec<u8>,
    eof: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeStreamCleanupResult {
    removed: usize,
    expired: usize,
    orphaned: usize,
}

#[derive(Debug, Clone)]
struct NativeStreamEntry {
    handle: String,
    domain: String,
    path: PathBuf,
    size: u64,
    max_bytes: u64,
    created_at: SystemTime,
    expires_at: SystemTime,
    finished: bool,
}

impl NativeStreamEntry {
    fn is_expired(&self, now: SystemTime) -> bool {
        now >= self.expires_at
    }

    fn info(&self) -> NativeStreamInfo {
        NativeStreamInfo {
            handle: self.handle.clone(),
            domain: self.domain.clone(),
            size: self.size,
            max_bytes: self.max_bytes,
            created_at_ms: system_time_ms(self.created_at),
            expires_at_ms: system_time_ms(self.expires_at),
            finished: self.finished,
        }
    }
}

#[derive(Debug, Default)]
struct NativeStreamRegistry {
    entries: HashMap<String, NativeStreamEntry>,
    next_id: u64,
}

impl NativeStreamRegistry {
    fn create(
        &mut self,
        root: &Path,
        domain: String,
        max_bytes: Option<u64>,
        ttl_ms: Option<u64>,
    ) -> Result<NativeStreamInfo, String> {
        let root = prepare_stream_root(root)?;
        self.remove_expired(&root)?;

        let domain = validate_domain(domain)?;
        let max_bytes = normalize_max_bytes(max_bytes)?;
        let ttl = normalize_ttl(ttl_ms)?;
        let created_at = SystemTime::now();
        let expires_at = created_at
            .checked_add(ttl)
            .ok_or_else(|| "native stream: ttl overflow".to_string())?;

        for _ in 0..16 {
            let handle = self.next_handle();
            let path = root.join(format!("{handle}.bin"));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => {
                    let path = contained_file_path(&root, &path)?;
                    let entry = NativeStreamEntry {
                        handle: handle.clone(),
                        domain,
                        path,
                        size: 0,
                        max_bytes,
                        created_at,
                        expires_at,
                        finished: false,
                    };
                    let info = entry.info();
                    self.entries.insert(handle, entry);
                    return Ok(info);
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => {
                    return Err(format!("native stream: create temp file: {err}"));
                }
            }
        }

        Err("native stream: could not allocate a handle".to_string())
    }

    fn write_chunk(
        &mut self,
        root: &Path,
        handle: &str,
        chunk: Vec<u8>,
        offset: Option<u64>,
    ) -> Result<NativeStreamInfo, String> {
        let root = prepare_stream_root(root)?;
        let entry = self.live_entry_mut(&root, handle)?;
        if entry.finished {
            return Err("native stream: handle is already finished".to_string());
        }

        let chunk_len = u64::try_from(chunk.len())
            .map_err(|_| "native stream: chunk is too large".to_string())?;
        if chunk_len > MAX_INLINE_IPC_BYTES {
            return Err(format!(
                "native stream: chunk exceeds the {MAX_INLINE_IPC_BYTES} byte IPC limit"
            ));
        }
        let expected_offset = offset.unwrap_or(entry.size);
        if expected_offset != entry.size {
            return Err(format!(
                "native stream: chunk offset {expected_offset} does not match current size {}",
                entry.size
            ));
        }
        let next_size = entry
            .size
            .checked_add(chunk_len)
            .ok_or_else(|| "native stream: size overflow".to_string())?;
        if next_size > entry.max_bytes {
            return Err(format!(
                "native stream: quota exceeded; {next_size} bytes exceeds the {} byte budget",
                entry.max_bytes
            ));
        }

        let file_path = contained_file_path(&root, &entry.path)?;
        let metadata = fs::metadata(&file_path)
            .map_err(|err| format!("native stream: inspect temp file: {err}"))?;
        if metadata.len() != entry.size {
            return Err("native stream: temp file size changed unexpectedly".to_string());
        }

        let mut file = OpenOptions::new()
            .append(true)
            .open(&file_path)
            .map_err(|err| format!("native stream: open temp file for write: {err}"))?;
        file.write_all(&chunk)
            .map_err(|err| format!("native stream: write chunk: {err}"))?;
        file.flush()
            .map_err(|err| format!("native stream: flush chunk: {err}"))?;
        entry.size = next_size;

        Ok(entry.info())
    }

    fn finish(&mut self, root: &Path, handle: &str) -> Result<NativeStreamInfo, String> {
        let root = prepare_stream_root(root)?;
        let entry = self.live_entry_mut(&root, handle)?;
        let file_path = contained_file_path(&root, &entry.path)?;
        let metadata = fs::metadata(&file_path)
            .map_err(|err| format!("native stream: inspect temp file: {err}"))?;
        if metadata.len() != entry.size {
            return Err("native stream: temp file size changed unexpectedly".to_string());
        }
        entry.finished = true;
        Ok(entry.info())
    }

    fn info(&mut self, root: &Path, handle: &str) -> Result<NativeStreamInfo, String> {
        let root = prepare_stream_root(root)?;
        let entry = self.live_entry_mut(&root, handle)?;
        let file_path = contained_file_path(&root, &entry.path)?;
        let metadata = fs::metadata(&file_path)
            .map_err(|err| format!("native stream: inspect temp file: {err}"))?;
        if metadata.len() != entry.size {
            return Err("native stream: temp file size changed unexpectedly".to_string());
        }
        Ok(entry.info())
    }

    fn read_chunk(
        &mut self,
        root: &Path,
        handle: &str,
        offset: u64,
        length: u64,
    ) -> Result<NativeStreamReadChunk, String> {
        let root = prepare_stream_root(root)?;
        if length > MAX_INLINE_IPC_BYTES {
            return Err(format!(
                "native stream: read length exceeds the {MAX_INLINE_IPC_BYTES} byte IPC limit"
            ));
        }
        let entry = self.live_entry_mut(&root, handle)?;
        if !entry.finished {
            return Err("native stream: handle is not finished".to_string());
        }

        let file_path = contained_file_path(&root, &entry.path)?;
        if offset >= entry.size || length == 0 {
            return Ok(NativeStreamReadChunk {
                offset,
                bytes: Vec::new(),
                eof: true,
            });
        }
        let to_read = length.min(entry.size - offset);
        let capacity = usize::try_from(to_read)
            .map_err(|_| "native stream: read length is too large".to_string())?;
        let mut file = File::open(&file_path)
            .map_err(|err| format!("native stream: open temp file for read: {err}"))?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|err| format!("native stream: seek temp file: {err}"))?;

        let mut bytes = Vec::with_capacity(capacity);
        file.take(to_read)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("native stream: read chunk: {err}"))?;
        let read_len = u64::try_from(bytes.len())
            .map_err(|_| "native stream: read length overflow".to_string())?;

        Ok(NativeStreamReadChunk {
            offset,
            bytes,
            eof: offset + read_len >= entry.size,
        })
    }

    fn delete(&mut self, root: &Path, handle: &str) -> Result<(), String> {
        let root = prepare_stream_root(root)?;
        let entry = self
            .entries
            .remove(handle)
            .ok_or_else(|| "native stream: invalid handle".to_string())?;
        remove_entry_file(&root, &entry.path)?;
        Ok(())
    }

    fn cancel(&mut self, root: &Path, handle: &str) -> Result<(), String> {
        let root = prepare_stream_root(root)?;
        let Some(entry) = self.entries.remove(handle) else {
            return Ok(());
        };
        remove_entry_file(&root, &entry.path)?;
        Ok(())
    }

    fn take_finished_path(
        &mut self,
        root: &Path,
        handle: &str,
        expected_domain: Option<&str>,
    ) -> Result<PathBuf, String> {
        let root = prepare_stream_root(root)?;
        let expired = match self.entries.get(handle) {
            Some(entry) => entry.is_expired(SystemTime::now()),
            None => return Err("native stream: invalid handle".to_string()),
        };
        if expired {
            if let Some(entry) = self.entries.remove(handle) {
                remove_entry_file(&root, &entry.path)?;
            }
            return Err("native stream: handle expired".to_string());
        }

        let entry = self
            .entries
            .remove(handle)
            .ok_or_else(|| "native stream: invalid handle".to_string())?;
        let validation = (|| -> Result<PathBuf, String> {
            if let Some(expected_domain) = expected_domain {
                if entry.domain != expected_domain {
                    return Err(format!(
                        "native stream: handle belongs to '{}' instead of '{expected_domain}'",
                        entry.domain
                    ));
                }
            }
            if !entry.finished {
                return Err("native stream: handle is not finished".to_string());
            }
            let file_path = contained_file_path(&root, &entry.path)?;
            let metadata = fs::metadata(&file_path)
                .map_err(|err| format!("native stream: inspect temp file: {err}"))?;
            if metadata.len() != entry.size {
                return Err("native stream: temp file size changed unexpectedly".to_string());
            }
            Ok(file_path)
        })();

        match validation {
            Ok(path) => Ok(path),
            Err(err) => {
                self.entries.insert(handle.to_string(), entry);
                Err(err)
            }
        }
    }

    fn cleanup(&mut self, root: &Path) -> Result<NativeStreamCleanupResult, String> {
        let root = prepare_stream_root(root)?;
        let expired = self.remove_expired(&root)?;
        let active_paths = self
            .entries
            .values()
            .map(|entry| entry.path.clone())
            .collect::<HashSet<_>>();
        let orphaned = remove_orphaned_root_entries(&root, &active_paths)?;

        Ok(NativeStreamCleanupResult {
            removed: expired + orphaned,
            expired,
            orphaned,
        })
    }

    fn live_entry_mut(
        &mut self,
        root: &Path,
        handle: &str,
    ) -> Result<&mut NativeStreamEntry, String> {
        let expired = match self.entries.get(handle) {
            Some(entry) => entry.is_expired(SystemTime::now()),
            None => return Err("native stream: invalid handle".to_string()),
        };
        if expired {
            if let Some(entry) = self.entries.remove(handle) {
                remove_entry_file(root, &entry.path)?;
            }
            return Err("native stream: handle expired".to_string());
        }

        self.entries
            .get_mut(handle)
            .ok_or_else(|| "native stream: invalid handle".to_string())
    }

    fn remove_expired(&mut self, root: &Path) -> Result<usize, String> {
        let now = SystemTime::now();
        let expired_handles = self
            .entries
            .iter()
            .filter_map(|(handle, entry)| {
                if entry.is_expired(now) {
                    Some(handle.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();

        let mut removed = 0;
        for handle in expired_handles {
            if let Some(entry) = self.entries.remove(&handle) {
                remove_entry_file(root, &entry.path)?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    fn next_handle(&mut self) -> String {
        self.next_id = self.next_id.saturating_add(1);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("ns-{now:x}-{:x}", self.next_id)
    }
}

pub struct NativeStreamState {
    registry: Mutex<NativeStreamRegistry>,
}

impl Default for NativeStreamState {
    fn default() -> Self {
        Self {
            registry: Mutex::new(NativeStreamRegistry::default()),
        }
    }
}

#[tauri::command]
pub fn native_stream_create(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    domain: String,
    max_bytes: Option<u64>,
    ttl_ms: Option<u64>,
) -> Result<NativeStreamInfo, String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.create(&root, domain, max_bytes, ttl_ms)
}

#[tauri::command]
pub fn native_stream_write_chunk(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
    chunk: Vec<u8>,
    offset: Option<u64>,
) -> Result<NativeStreamInfo, String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.write_chunk(&root, &handle, chunk, offset)
}

#[tauri::command]
pub fn native_stream_finish(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
) -> Result<NativeStreamInfo, String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.finish(&root, &handle)
}

#[tauri::command]
pub fn native_stream_info(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
) -> Result<NativeStreamInfo, String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.info(&root, &handle)
}

#[tauri::command]
pub fn native_stream_read_chunk(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
    offset: u64,
    length: u64,
) -> Result<NativeStreamReadChunk, String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.read_chunk(&root, &handle, offset, length)
}

#[tauri::command]
pub fn native_stream_delete(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
) -> Result<(), String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.delete(&root, &handle)
}

#[tauri::command]
pub fn native_stream_cancel(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
) -> Result<(), String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.cancel(&root, &handle)
}

#[tauri::command]
pub fn native_stream_cleanup(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
) -> Result<NativeStreamCleanupResult, String> {
    let root = stream_root(&app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.cleanup(&root)
}

pub(crate) fn take_finished_path(
    app: &AppHandle,
    state: &NativeStreamState,
    handle: &str,
    expected_domain: Option<&str>,
) -> Result<PathBuf, String> {
    let root = stream_root(app)?;
    let mut registry = state
        .registry
        .lock()
        .map_err(|_| "native stream: registry lock poisoned".to_string())?;
    registry.take_finished_path(&root, handle, expected_domain)
}

pub fn cleanup_startup(app: &AppHandle) -> Result<NativeStreamCleanupResult, String> {
    let root = stream_root(app)?;
    let root = prepare_stream_root(&root)?;
    let active_paths = HashSet::new();
    let orphaned = remove_orphaned_root_entries(&root, &active_paths)?;
    Ok(NativeStreamCleanupResult {
        removed: orphaned,
        expired: 0,
        orphaned,
    })
}

fn stream_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("native stream: app cache dir: {err}"))?
        .join(STREAM_ROOT_DIR))
}

fn prepare_stream_root(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|err| format!("native stream: create root: {err}"))?;
    root.canonicalize()
        .map_err(|err| format!("native stream: canonicalize root: {err}"))
}

fn validate_domain(domain: String) -> Result<String, String> {
    let domain = domain.trim();
    if domain.is_empty() {
        return Err("native stream: domain is required".to_string());
    }
    if domain.len() > 64 {
        return Err("native stream: domain is too long".to_string());
    }
    if !domain
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':'))
    {
        return Err("native stream: domain contains an invalid character".to_string());
    }
    Ok(domain.to_string())
}

fn normalize_max_bytes(max_bytes: Option<u64>) -> Result<u64, String> {
    let max_bytes = max_bytes.unwrap_or(DEFAULT_NATIVE_STREAM_BYTES);
    if max_bytes == 0 {
        return Err("native stream: maxBytes must be positive".to_string());
    }
    if max_bytes > MAX_NATIVE_STREAM_BYTES {
        return Err(format!(
            "native stream: maxBytes exceeds the {MAX_NATIVE_STREAM_BYTES} byte native stream limit"
        ));
    }
    Ok(max_bytes)
}

fn normalize_ttl(ttl_ms: Option<u64>) -> Result<Duration, String> {
    let ttl_ms = ttl_ms.unwrap_or(DEFAULT_TTL_MS);
    if ttl_ms == 0 {
        return Err("native stream: ttlMs must be positive".to_string());
    }
    if ttl_ms > MAX_TTL_MS {
        return Err(format!(
            "native stream: ttlMs exceeds the {MAX_TTL_MS} millisecond limit"
        ));
    }
    Ok(Duration::from_millis(ttl_ms))
}

fn contained_file_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("native stream: inspect temp file: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Err("native stream: temp file must not be a symlink".to_string());
    }
    if !metadata.is_file() {
        return Err("native stream: temp path is not a file".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|err| format!("native stream: canonicalize temp file: {err}"))?;
    if !path.starts_with(root) {
        return Err("native stream: temp file escaped the stream root".to_string());
    }
    Ok(path)
}

fn remove_entry_file(root: &Path, path: &Path) -> Result<bool, String> {
    if !path.starts_with(root) {
        return Err("native stream: temp file escaped the stream root".to_string());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("native stream: inspect temp file: {err}")),
    };
    if !metadata.file_type().is_symlink() {
        let path = contained_file_path(root, path)?;
        fs::remove_file(&path).map_err(|err| format!("native stream: delete temp file: {err}"))?;
        return Ok(true);
    }

    fs::remove_file(path).map_err(|err| format!("native stream: delete temp symlink: {err}"))?;
    Ok(true)
}

fn remove_orphaned_root_entries(
    root: &Path,
    active_paths: &HashSet<PathBuf>,
) -> Result<usize, String> {
    if root.file_name().and_then(|name| name.to_str()) != Some(STREAM_ROOT_DIR) {
        return Err("native stream: cleanup root is invalid".to_string());
    }

    let mut removed = 0;
    for entry in fs::read_dir(root).map_err(|err| format!("native stream: read root: {err}"))? {
        let path = entry
            .map_err(|err| format!("native stream: read root entry: {err}"))?
            .path();
        let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
        if active_paths.contains(&canonical) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("native stream: inspect orphan: {err}")),
        };
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&path)
                .map_err(|err| format!("native stream: remove orphan directory: {err}"))?;
        } else {
            fs::remove_file(&path)
                .map_err(|err| format!("native stream: remove orphan file: {err}"))?;
        }
        removed += 1;
    }
    Ok(removed)
}

fn system_time_ms(time: SystemTime) -> u64 {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    millis.min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_root(parent: &Path) -> PathBuf {
        parent.join(STREAM_ROOT_DIR)
    }

    #[test]
    fn stream_lifecycle_writes_finishes_reads_and_deletes() {
        let dir = tempdir().expect("tempdir");
        let root = test_root(dir.path());
        let mut registry = NativeStreamRegistry::default();

        let created = registry
            .create(&root, "backup".to_string(), Some(8), Some(60_000))
            .expect("create");
        assert_eq!(created.domain, "backup");
        assert_eq!(created.size, 0);
        assert!(!created.finished);

        let first = registry
            .write_chunk(&root, &created.handle, vec![1, 2, 3], Some(0))
            .expect("write first");
        assert_eq!(first.size, 3);

        let second = registry
            .write_chunk(&root, &created.handle, vec![4, 5], Some(3))
            .expect("write second");
        assert_eq!(second.size, 5);

        let finished = registry.finish(&root, &created.handle).expect("finish");
        assert!(finished.finished);
        assert_eq!(finished.size, 5);

        let chunk = registry
            .read_chunk(&root, &created.handle, 1, 3)
            .expect("read");
        assert_eq!(chunk.offset, 1);
        assert_eq!(chunk.bytes, vec![2, 3, 4]);
        assert!(!chunk.eof);

        let tail = registry
            .read_chunk(&root, &created.handle, 4, 8)
            .expect("read tail");
        assert_eq!(tail.bytes, vec![5]);
        assert!(tail.eof);

        let path = registry
            .entries
            .get(&created.handle)
            .expect("entry")
            .path
            .clone();
        assert!(path.exists());
        registry.delete(&root, &created.handle).expect("delete");
        assert!(!path.exists());
        assert!(registry.info(&root, &created.handle).is_err());
    }

    #[test]
    fn take_finished_path_consumes_handle_without_deleting_file() {
        let dir = tempdir().expect("tempdir");
        let root = test_root(dir.path());
        let mut registry = NativeStreamRegistry::default();
        let created = registry
            .create(&root, "chapter-media".to_string(), Some(8), Some(60_000))
            .expect("create");
        registry
            .write_chunk(&root, &created.handle, vec![1, 2, 3], Some(0))
            .expect("write");
        registry.finish(&root, &created.handle).expect("finish");

        let path = registry
            .take_finished_path(&root, &created.handle, Some("chapter-media"))
            .expect("take");

        assert_eq!(fs::read(&path).expect("read temp"), vec![1, 2, 3]);
        assert!(!registry.entries.contains_key(&created.handle));
    }

    #[test]
    fn stream_rejects_quota_overflow_and_wrong_offsets() {
        let dir = tempdir().expect("tempdir");
        let root = test_root(dir.path());
        let mut registry = NativeStreamRegistry::default();
        let created = registry
            .create(&root, "media".to_string(), Some(3), Some(60_000))
            .expect("create");

        registry
            .write_chunk(&root, &created.handle, vec![1, 2], Some(0))
            .expect("write first");

        let offset_error = registry
            .write_chunk(&root, &created.handle, vec![3], Some(0))
            .expect_err("offset error");
        assert!(offset_error.contains("offset"), "error was: {offset_error}");

        let quota_error = registry
            .write_chunk(&root, &created.handle, vec![3, 4], Some(2))
            .expect_err("quota error");
        assert!(
            quota_error.contains("quota exceeded"),
            "error was: {quota_error}"
        );

        let info = registry.info(&root, &created.handle).expect("info");
        assert_eq!(info.size, 2);
    }

    #[test]
    fn stream_rejects_paths_outside_root() {
        let dir = tempdir().expect("tempdir");
        let root = test_root(dir.path());
        let mut registry = NativeStreamRegistry::default();
        let created = registry
            .create(&root, "backup".to_string(), Some(8), Some(60_000))
            .expect("create");
        let outside = dir.path().join("outside.bin");
        fs::write(&outside, [1, 2, 3]).expect("outside file");

        let entry = registry.entries.get_mut(&created.handle).expect("entry");
        entry.path = outside.canonicalize().expect("canonical outside");
        entry.size = 3;
        entry.finished = true;

        let error = registry
            .read_chunk(&root, &created.handle, 0, 3)
            .expect_err("containment error");
        assert!(error.contains("stream root"), "error was: {error}");
    }

    #[test]
    fn cleanup_removes_expired_handles_and_orphans() {
        let dir = tempdir().expect("tempdir");
        let root = test_root(dir.path());
        let mut registry = NativeStreamRegistry::default();
        let created = registry
            .create(&root, "update".to_string(), Some(8), Some(60_000))
            .expect("create");
        let entry = registry.entries.get_mut(&created.handle).expect("entry");
        entry.expires_at = UNIX_EPOCH;

        let orphan = root.join("orphan.bin");
        fs::write(&orphan, [9]).expect("orphan");

        let cleanup = registry.cleanup(&root).expect("cleanup");
        assert_eq!(cleanup.expired, 1);
        assert_eq!(cleanup.orphaned, 1);
        assert_eq!(cleanup.removed, 2);
        assert!(registry.entries.is_empty());
        assert!(!orphan.exists());
    }

    #[test]
    fn cancel_is_idempotent_and_removes_file() {
        let dir = tempdir().expect("tempdir");
        let root = test_root(dir.path());
        let mut registry = NativeStreamRegistry::default();
        let created = registry
            .create(&root, "source".to_string(), Some(8), Some(60_000))
            .expect("create");
        let path = registry
            .entries
            .get(&created.handle)
            .expect("entry")
            .path
            .clone();

        registry.cancel(&root, &created.handle).expect("cancel");
        assert!(!path.exists());
        registry
            .cancel(&root, &created.handle)
            .expect("cancel again");
    }
}
