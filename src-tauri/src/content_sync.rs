use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const MAX_MEDIA_ZIP_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const UPLOAD_ATTEMPTS: u32 = 2;
const UPLOAD_RETRY_DELAY: Duration = if cfg!(test) { Duration::from_millis(10) } else { Duration::from_secs(3) };
const MIN_UPLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const MIN_UPLOAD_BYTES_PER_SECOND: u64 = 64 * 1024;
static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UploadConflictPolicy {
    PreferComplete,
    KeepServer,
    ReplaceServer,
}

fn failure(error: impl std::fmt::Display) -> String {
    format!("content sync: {error}")
}

fn chapter_storage_failure(operation: &str, error: impl std::fmt::Display) -> String {
    format!("chapter-storage-failed: {operation}: {error}")
}

fn copy_downloaded_file(input: &mut impl Read, output: &mut impl Write, limit: u64) -> Result<u64, String> {
    let mut input = input.take(limit + 1);
    let mut buffer = [0; 64 * 1024];
    let mut total = 0;
    loop {
        let count = input.read(&mut buffer).map_err(failure)?;
        if count == 0 { break; }
        output.write_all(&buffer[..count])
            .map_err(|error| chapter_storage_failure("write content download file", error))?;
        total += count as u64;
    }
    if total > limit { return Err(failure("content exceeds byte limit")); }
    Ok(total)
}

fn safe_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains(['\\', ':', '\0'])
        || value.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part.chars().any(char::is_control)
                || part.contains(['*', '?', '"', '<', '>', '|'])
                || matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
    {
        return Err(failure("unsafe content path"));
    }
    Ok(())
}

fn copy_limited(input: &mut impl Read, output: &mut impl Write, limit: u64) -> Result<u64, String> {
    let bytes = std::io::copy(&mut input.take(limit + 1), output).map_err(failure)?;
    if bytes > limit {
        return Err(failure("content exceeds byte limit"));
    }
    Ok(bytes)
}

fn read_json(path: &Path, io_failure: &impl Fn(&dyn std::fmt::Display) -> String) -> Result<Value, String> {
    if fs::metadata(path).map_err(|error| io_failure(&error))?.len() > 16 * 1024 * 1024 {
        return Err(failure("manifest exceeds byte limit"));
    }
    let file = File::open(path).map_err(|error| io_failure(&error))?;
    serde_json::from_reader(file).map_err(|error| {
        if error.is_io() { io_failure(&error) } else { failure(error) }
    })
}

fn media_files(manifest: &Value) -> Result<Vec<String>, String> {
    if manifest["version"] != 1 {
        return Err(failure("unsupported chapter media manifest version"));
    }
    let files = manifest["media"]["files"]
        .as_array()
        .ok_or_else(|| failure("invalid media manifest"))?;
    let mut names = HashSet::new();
    let mut result = Vec::new();
    for file in files {
        let name = file["fileName"]
            .as_str()
            .ok_or_else(|| failure("invalid media filename"))?;
        safe_path(name)?;
        if name.contains('/')
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            || !names.insert(name.to_ascii_lowercase())
            || (file["path"] != "" && file["path"] != format!("media/{name}"))
        {
            return Err(failure(format!("invalid or duplicate media entry: {name}")));
        }
        result.push(name.to_string());
    }
    Ok(result)
}

pub(crate) fn validate_chapter_media(source: &Path) -> Result<(), String> {
    if !inspect_chapter_media(source)? {
        return Err(failure("chapter media archive is incomplete"));
    }
    Ok(())
}

fn inspect_chapter_media(source: &Path) -> Result<bool, String> {
    inspect_chapter_media_with_io_failure(source, &|error| failure(error))
}

fn inspect_chapter_media_with_io_failure(
    source: &Path,
    io_failure: &impl Fn(&dyn std::fmt::Display) -> String,
) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| io_failure(&error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid chapter directory"));
    }
    let artifact_exists = |name| {
        match fs::symlink_metadata(source.join(name)) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                Err(failure("invalid chapter media artifact"))
            }
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_failure(&error)),
        }
    };
    let manifest_exists = artifact_exists("manifest.json")?;
    let archive_exists = artifact_exists("media.zip")?;
    if !manifest_exists {
        return if archive_exists {
            Err(failure("chapter media manifest is missing"))
        } else {
            Ok(true)
        };
    }
    let media = media_files(&read_json(&source.join("manifest.json"), io_failure)?)?;
    if media.len() + 2 > MAX_FILES {
        return Err(failure("too many chapter media files"));
    }
    if !archive_exists {
        return Ok(media.is_empty());
    }
    let zip_file = File::open(source.join("media.zip")).map_err(|error| io_failure(&error))?;
    if zip_file.metadata().map_err(|error| io_failure(&error))?.len() > MAX_MEDIA_ZIP_BYTES {
        return Err(failure("chapter media archive exceeds byte limit"));
    }
    let archive_failure = |error| match error {
        zip::result::ZipError::Io(error) if !matches!(error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::InvalidData | std::io::ErrorKind::InvalidInput
        ) => io_failure(&error),
        error => failure(error),
    };
    let mut archive = ZipArchive::new(zip_file).map_err(&archive_failure)?;
    if archive.len() > MAX_FILES {
        return Err(failure("too many chapter media files"));
    }
    let mut media_bytes = 0;
    let mut found = HashSet::new();
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(&archive_failure)?;
        let directory = file.is_dir() || file.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o040000);
        let file_name = file.name().map_err(&archive_failure)?;
        let name = file_name.strip_suffix('/').unwrap_or(file_name.as_ref());
        safe_path(name)?;
        if file.unix_mode().is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != if directory { 0o040000 } else { 0o100000 })
            || !names.insert(name.to_lowercase()) {
            return Err(failure("invalid chapter media artifact"));
        }
        if file.size() > MAX_EXPANDED_BYTES - media_bytes {
            return Err(failure("chapter media exceeds byte limit"));
        }
        media_bytes += file.size();
        if !directory { found.insert(file_name.into_owned()); }
    }
    Ok(media.iter().all(|name| found.contains(name)))
}

fn checked_storage_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    checked_storage_directory_with_io_failure(root, relative, &|error| failure(error))
}

fn checked_storage_directory_with_io_failure(
    root: &Path,
    relative: &str,
    io_failure: &impl Fn(&dyn std::fmt::Display) -> String,
) -> Result<PathBuf, String> {
    safe_path(relative)?;
    let segments: Vec<_> = relative.split('/').collect();
    if segments.len() != 4 || segments[0] != "contents" {
        return Err(failure("expected readable chapter directory"));
    }
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(failure("unsafe storage directory"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_failure(&error)),
        }
    }
    Ok(path)
}

fn storage_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = checked_storage_directory(root, relative)?;
    recover_content_directory(&path)?;
    Ok(path)
}

fn content_backup_path(destination: &Path) -> Result<PathBuf, String> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| failure("invalid chapter directory"))?;
    Ok(destination.with_file_name(format!(".{name}.norea-sync-backup")))
}

fn recover_content_directory_locked(destination: &Path) -> Result<(), String> {
    recover_content_directory_with_io_failure(destination, &|error| failure(error))
}

fn recover_content_directory_with_io_failure(
    destination: &Path,
    io_failure: &impl Fn(&dyn std::fmt::Display) -> String,
) -> Result<(), String> {
    let backup = content_backup_path(destination)?;
    let metadata = match fs::symlink_metadata(&backup) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_failure(&error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("invalid chapter recovery directory"));
    }
    if !destination.try_exists().map_err(|error| io_failure(&error))? {
        fs::rename(&backup, destination).map_err(|error| io_failure(&error))?;
    }
    Ok(())
}

pub(crate) fn recover_content_directory(destination: &Path) -> Result<(), String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| failure("chapter install lock failed"))?;
    recover_content_directory_locked(destination)
}

fn install_directory(source: &Path, destination: &Path) -> Result<(), String> {
    let io_failure = |error| chapter_storage_failure("install downloaded chapter", error);
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| failure("chapter install lock failed"))?;
    recover_content_directory_with_io_failure(destination, &|error|
        chapter_storage_failure("recover installed chapter", error))?;
    let parent = destination
        .parent()
        .ok_or_else(|| failure("missing chapter parent"))?;
    fs::create_dir_all(parent).map_err(&io_failure)?;
    let token = stage_token();
    let stage = parent.join(format!(".norea-sync-{token}.stage"));
    let backup = content_backup_path(destination)?;
    if backup.try_exists().map_err(&io_failure)? {
        let mut readable = false;
        for name in ["content.html", "content.pdf"] {
            match fs::metadata(destination.join(name)) {
                Ok(metadata) if metadata.is_file() => { readable = true; break; }
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(io_failure(error)),
                _ => {}
            }
        }
        if !readable {
            return Err(failure(
                "previous chapter backup retained because current content is incomplete",
            ));
        }
        fs::remove_dir_all(&backup).map_err(&io_failure)?;
    }
    fs::create_dir(&stage).map_err(&io_failure)?;
    let preparation = (|| {
        for entry in fs::read_dir(source).map_err(&io_failure)? {
            let entry = entry.map_err(&io_failure)?;
            if !entry.file_type().map_err(&io_failure)?.is_file() {
                return Err(failure("invalid installed artifact"));
            }
            let target = stage.join(entry.file_name());
            let original = entry.metadata().map_err(&io_failure)?;
            if fs::copy(entry.path(), &target).map_err(&io_failure)? != original.len() {
                return Err(chapter_storage_failure("copy installed chapter", "storage copy size mismatch"));
            }
            let stored = File::options()
                .write(true)
                .open(&target)
                .map_err(&io_failure)?;
            stored.set_times(fs::FileTimes::new().set_modified(original.modified().map_err(&io_failure)?)).map_err(&io_failure)?;
            stored.sync_all().map_err(&io_failure)?;
            if stored.metadata().map_err(&io_failure)?.len() != original.len() {
                return Err(chapter_storage_failure("copy installed chapter", "storage copy size mismatch"));
            }
        }
        Ok(())
    })();
    if let Err(error) = preparation {
        fs::remove_dir_all(&stage).map_err(|cleanup|
            chapter_storage_failure("remove failed content install stage", format!("{cleanup}; original error: {error}")))?;
        return Err(error);
    }
    let previous = destination.try_exists().map_err(&io_failure)?;
    if previous {
        fs::rename(destination, &backup).map_err(&io_failure)?;
    }
    if let Err(error) = fs::rename(&stage, destination) {
        if previous {
            fs::rename(&backup, destination).map_err(|rollback| {
                chapter_storage_failure("restore previous chapter", format!(
                    "install failed: {error}; previous files retained at {}: {rollback}",
                    backup.display()
                ))
            })?;
        }
        fs::remove_dir_all(&stage).map_err(|cleanup|
            chapter_storage_failure("remove failed content install stage", format!("{cleanup}; original error: {error}")))?;
        return Err(chapter_storage_failure("publish downloaded chapter", error));
    }
    if previous {
        fs::remove_dir_all(backup).map_err(&io_failure)?;
    }
    Ok(())
}

fn stage_token() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
    )
}

fn chapter_files(source: &Path) -> Result<Vec<String>, String> {
    let metadata = fs::symlink_metadata(source).map_err(failure)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid chapter directory"));
    }
    let mut paths = Vec::new();
    for name in ["content.html", "content.pdf", "manifest.json", "media.zip"] {
        match fs::symlink_metadata(source.join(name)) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                paths.push(name.to_string());
            }
            Ok(_) => return Err(failure("invalid chapter artifact")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failure(error)),
        }
    }
    if !paths.iter().any(|path| path == "content.html" || path == "content.pdf") {
        let metadata = fs::symlink_metadata(source.join(".chapter-content.partial")).map_err(failure)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
            return Err(failure("chapter body is missing"));
        }
        if !source.join("manifest.json").is_file() {
            return Err(failure("partial chapter media manifest is missing"));
        }
        paths.push(".chapter-content.partial".to_string());
    }
    let mut total = 0;
    for path in &paths {
        let size = fs::metadata(source.join(path)).map_err(failure)?.len();
        let limit = match path.as_str() {
            "media.zip" => MAX_MEDIA_ZIP_BYTES,
            "manifest.json" => 16 * 1024 * 1024,
            _ => MAX_EXPANDED_BYTES,
        };
        if size > limit || size > MAX_EXPANDED_BYTES - total {
            return Err(failure("chapter snapshot exceeds byte limit"));
        }
        total += size;
    }
    paths.sort();
    Ok(paths)
}

fn fingerprint_directory(source: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    for path in chapter_files(source)? {
        let (size, modified_at) = file_size_and_modified_at(&source.join(&path))?;
        files.push(json!([path, size, modified_at]));
    }
    serde_json::to_string(&files).map_err(failure)
}

fn file_size_and_modified_at(path: &Path) -> Result<(u64, u64), String> {
    let metadata = fs::metadata(path).map_err(failure)?;
    let modified_at = metadata.modified().map_err(failure)?
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    Ok((metadata.len(), u64::try_from(modified_at).map_err(failure)?))
}

fn snapshot_directory(source: &Path, stage: &Path) -> Result<(), String> {
    let files = chapter_files(source)?;
    let before = fingerprint_directory(source)?;
    let destination = stage.join("source");
    fs::create_dir(&destination).map_err(failure)?;
    let copied = (|| {
        let mut total = 0;
        for path in files {
            let input = source.join(&path);
            let target = destination.join(if path == ".chapter-content.partial" { "content.html" } else { &path });
            fs::create_dir_all(target.parent().unwrap()).map_err(failure)?;
            let metadata = fs::symlink_metadata(&input).map_err(failure)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(failure("invalid chapter artifact"));
            }
            let size = metadata.len();
            if size > MAX_EXPANDED_BYTES - total {
                return Err(failure("chapter snapshot exceeds byte limit"));
            }
            let mut output = File::create(target).map_err(failure)?;
            let bytes = copy_limited(
                &mut File::open(input).map_err(failure)?,
                &mut output,
                size,
            )?;
            if bytes != size {
                return Err(failure("chapter changed during snapshot"));
            }
            output.set_times(fs::FileTimes::new().set_modified(metadata.modified().map_err(failure)?)).map_err(failure)?;
            total += bytes;
        }
        inspect_chapter_media(&destination)?;
        if fingerprint_directory(source)? != before {
            return Err(failure("chapter changed during snapshot"));
        }
        Ok(())
    })();
    if copied.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    copied
}

#[tauri::command]
pub async fn content_sync_snapshot(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<(), String> {
    let stage = checked_stage(&app, &stage_path)?;
    let source = checked_storage_directory(&crate::chapter_media::media_root(&app)?, &storage_dir)?;
    tauri::async_runtime::spawn_blocking(move || snapshot_directory(&source, &stage))
        .await
        .map_err(failure)?
}

#[tauri::command]
pub async fn content_sync_fingerprint(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<String, String> {
    let stage = checked_stage(&app, &stage_path)?;
    safe_path(&storage_dir)?;
    let source = stage.join("source");
    tauri::async_runtime::spawn_blocking(move || fingerprint_directory(&source))
        .await
        .map_err(failure)?
}

fn checked_stage(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    checked_stage_with_io_failure(app, path, &|error| failure(error))
}

fn checked_stage_with_io_failure(
    app: &AppHandle,
    path: &str,
    io_failure: &impl Fn(&dyn std::fmt::Display) -> String,
) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| io_failure(&error))?
        .join("content-sync")
        .canonicalize()
        .map_err(|error| io_failure(&error))?;
    let stage = PathBuf::from(path).canonicalize().map_err(|error| io_failure(&error))?;
    if stage.parent() != Some(root.as_path()) || !fs::metadata(&stage).map_err(|error| io_failure(&error))?.is_dir() {
        return Err(failure("invalid content staging directory"));
    }
    Ok(stage)
}

#[tauri::command]
pub async fn content_sync_create_stage(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(failure)?
        .join("content-sync")
        .join(stage_token());
    fs::create_dir_all(&path).map_err(failure)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn content_sync_remove_stage(app: AppHandle, stage_path: String) -> Result<(), String> {
    let stage = checked_stage(&app, &stage_path)?;
    tauri::async_runtime::spawn_blocking(move || fs::remove_dir_all(stage).map_err(failure))
        .await
        .map_err(failure)?
}

fn endpoint(server: &str, suffix: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(server).map_err(failure)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(failure("invalid content server URL"));
    }
    let base = url.path().trim_end_matches('/').trim_end_matches("/api/v1");
    url.set_path(&format!("{base}/api/v1/{suffix}"));
    Ok(url)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(failure)
}

#[tauri::command]
pub async fn content_sync_upload(
    app: AppHandle,
    server_url: String,
    token: String,
    storage_dir: String,
    stage_path: String,
    manifest: Value,
    conflict_policy: UploadConflictPolicy,
) -> Result<Value, String> {
    let stage = checked_stage(&app, &stage_path)?;
    safe_path(&storage_dir)?;
    let source = stage.join("source");
    tauri::async_runtime::spawn_blocking(move || {
        upload_chapter_files(&source, manifest, &server_url, &token, conflict_policy)
    })
    .await
    .map_err(failure)?
}

fn chapter_file_manifest(source: &Path, mut manifest: Value) -> Result<Value, String> {
    let body = if manifest["chapter"]["contentType"] == "pdf" { "content.pdf" } else { "content.html" };
    let mut records = Vec::new();
    for path in chapter_files(source)? {
        if path != body && path != "manifest.json" && path != "media.zip" {
            return Err(failure("chapter file transfer requires the current downloaded file layout"));
        }
        let (size, modified_at) = file_size_and_modified_at(&source.join(&path))?;
        records.push(json!({"path":path,"size":size,"modifiedAt":modified_at}));
    }
    if !records.iter().any(|record| record["path"] == body) {
        return Err(failure("chapter body is missing"));
    }
    inspect_chapter_media(source)?;
    manifest["layout"] = json!("chapter-files");
    manifest["bodyPath"] = json!(body);
    manifest["files"] = json!(records);
    Ok(manifest)
}

fn checked_response(mut response: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let mut bytes = Vec::new();
    let _ = response.by_ref().take(4096).read_to_end(&mut bytes);
    let detail = serde_json::from_slice::<Value>(&bytes).ok()
        .and_then(|value| value["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("Request failed").to_string());
    Err(failure(format!("server returned {}: {detail}", status.as_u16())))
}

struct CountingReader {
    file: File,
    sent: Arc<AtomicU64>,
}

impl Read for CountingReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let count = self.file.read(buffer)?;
        self.sent.fetch_add(count as u64, Ordering::Relaxed);
        Ok(count)
    }
}

fn upload_timeout(bytes: u64) -> Duration {
    MIN_UPLOAD_TIMEOUT.max(Duration::from_secs(bytes / MIN_UPLOAD_BYTES_PER_SECOND))
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn upload_chapter_files(source: &Path, metadata: Value, server_url: &str, token: &str, conflict_policy: UploadConflictPolicy) -> Result<Value, String> {
    let manifest = chapter_file_manifest(source, metadata)?;
    let metadata = serde_json::to_string(&manifest).map_err(failure)?;
    let records = manifest["files"].as_array().unwrap();
    let total: u64 = records.iter().map(|record| record["size"].as_u64().unwrap()).sum();
    let mut url = endpoint(server_url, "chapter-files")?;
    url.query_pairs_mut().append_pair("conflictPolicy", match conflict_policy {
        UploadConflictPolicy::PreferComplete => "prefer-complete",
        UploadConflictPolicy::KeepServer => "keep-server",
        UploadConflictPolicy::ReplaceServer => "replace-server",
    });
    let client = http_client()?;
    let mut attempt = 1;
    loop {
        let sent = Arc::new(AtomicU64::new(0));
        let mut form = reqwest::blocking::multipart::Form::new().text("metadata", metadata.clone());
        for record in records {
            let path = record["path"].as_str().unwrap();
            let reader = CountingReader { file: File::open(source.join(path)).map_err(failure)?, sent: sent.clone() };
            let part = reqwest::blocking::multipart::Part::reader_with_length(reader, record["size"].as_u64().unwrap())
                .file_name(path.to_string());
            form = form.part(path.to_string(), part);
        }
        let started = Instant::now();
        let outcome = client.post(url.clone()).timeout(upload_timeout(total))
            .bearer_auth(token).multipart(form).send();
        // Connection drops, timeouts and gateway failures are transient; server rejections are final.
        let transient = match &outcome {
            Ok(response) => matches!(response.status().as_u16(), 408 | 502 | 503 | 504),
            Err(error) => !error.is_builder(),
        };
        if transient && attempt < UPLOAD_ATTEMPTS {
            attempt += 1;
            std::thread::sleep(UPLOAD_RETRY_DELAY);
            continue;
        }
        let response = outcome.map_err(|error| failure(format!(
            "upload stopped after sending {} of {total} bytes in {} s (attempt {attempt} of {UPLOAD_ATTEMPTS}): {}",
            sent.load(Ordering::Relaxed), started.elapsed().as_secs(), error_chain(&error),
        )))?;
        return serde_json::from_reader(checked_response(response)?.take(16 * 1024 * 1024)).map_err(failure);
    }
}

#[tauri::command]
pub async fn content_sync_download(
    app: AppHandle,
    server_url: String,
    token: Option<String>,
    storage_dir: String,
    stage_path: String,
    entry: Value,
) -> Result<Value, String> {
    let stage = checked_stage_with_io_failure(&app, &stage_path, &|error|
        chapter_storage_failure("resolve content download stage", error))?;
    safe_path(&storage_dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        download_chapter_files(&server_url, token.as_deref(), &entry, &stage.join("install"))
    })
    .await
    .map_err(failure)?
}

fn download_chapter_files(server_url: &str, token: Option<&str>, entry: &Value, destination: &Path) -> Result<Value, String> {
    if entry["deleted"] != false {
        return Err(failure("server chapter is deleted"));
    }
    let manifest = &entry["manifest"];
    let body = if manifest["chapter"]["contentType"] == "pdf" { "content.pdf" } else { "content.html" };
    let id = entry["id"].as_str().ok_or_else(|| failure("missing chapter id"))?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return Err(failure("invalid chapter id"));
    }
    let revision = entry["revision"].as_str().ok_or_else(|| failure("missing chapter revision"))?;
    let file_bytes = entry["fileBytes"].as_u64().ok_or_else(|| failure("missing chapter file size"))?;
    let files = manifest["files"].as_array().ok_or_else(|| failure("missing chapter files"))?;
    if manifest["packageVersion"] != 1 || manifest["layout"] != "chapter-files"
        || manifest["bodyPath"] != body || files.is_empty() || files.len() > 3 {
        return Err(failure("invalid chapter file manifest"));
    }
    let mut names = HashSet::new();
    let mut declared = Vec::new();
    let mut total = 0;
    for file in files {
        let name = file["path"].as_str().ok_or_else(|| failure("missing chapter file path"))?;
        let size = file["size"].as_u64().ok_or_else(|| failure("invalid chapter file size"))?;
        let limit = match name {
            "media.zip" => MAX_MEDIA_ZIP_BYTES,
            "manifest.json" => 16 * 1024 * 1024,
            _ if name == body => MAX_EXPANDED_BYTES,
            _ => return Err(failure("unexpected chapter file")),
        };
        if !names.insert(name) || size > limit || size > MAX_EXPANDED_BYTES - total {
            return Err(failure("duplicate or oversized chapter file"));
        }
        total += size;
        let millis = file["modifiedAt"].as_u64().filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| failure("invalid chapter file modification time"))?;
        let modified = UNIX_EPOCH.checked_add(Duration::from_millis(millis))
            .ok_or_else(|| failure("invalid chapter file modification time"))?;
        declared.push((name, size, modified));
    }
    if !names.contains(body) || (names.contains("media.zip") && !names.contains("manifest.json")) {
        return Err(failure("missing chapter body or media manifest"));
    }
    if total != file_bytes {
        return Err(failure("chapter file size differs from catalog"));
    }
    fs::create_dir(destination)
        .map_err(|error| chapter_storage_failure("create content download directory", error))?;
    let client = http_client()?;
    for (name, size, modified) in declared {
        let mut url = endpoint(server_url, &format!("chapters/{id}/files"))?;
        url.query_pairs_mut().append_pair("revision", revision).append_pair("path", name);
        let mut request = client.get(url);
        if let Some(token) = token { request = request.bearer_auth(token); }
        let mut response = checked_response(request.send().map_err(failure)?)?;
        let path = destination.join(name);
        let mut output = File::create(&path)
            .map_err(|error| chapter_storage_failure("create content download file", error))?;
        if copy_downloaded_file(&mut response, &mut output, size)? != size {
            return Err(failure(format!("downloaded {name} size mismatch")));
        }
        output.set_times(fs::FileTimes::new().set_modified(modified))
            .map_err(|error| chapter_storage_failure("set content download file metadata", error))?;
    }
    let media_complete = inspect_chapter_media_with_io_failure(destination, &|error|
        chapter_storage_failure("inspect downloaded media", error))?;
    let content_bytes = fs::metadata(destination.join(body))
        .map_err(|error| chapter_storage_failure("inspect downloaded content size", error))?.len();
    let media_bytes = if names.contains("media.zip") {
        fs::metadata(destination.join("media.zip"))
            .map_err(|error| chapter_storage_failure("inspect downloaded media size", error))?.len()
    } else { 0 };
    Ok(json!({"mediaComplete": media_complete, "contentBytes": content_bytes, "mediaBytes": media_bytes}))
}

#[tauri::command]
pub async fn content_sync_install(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<(), String> {
    let stage = checked_stage_with_io_failure(&app, &stage_path, &|error|
        chapter_storage_failure("resolve content install stage", error))?;
    let source = stage.join("install");
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| chapter_storage_failure("inspect staged chapter directory", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid staged chapter directory"));
    }
    let root = crate::chapter_media::media_root(&app)
        .map_err(|error| chapter_storage_failure("resolve chapter storage directory", error))?;
    let destination = checked_storage_directory_with_io_failure(&root, &storage_dir, &|error|
        chapter_storage_failure("inspect chapter storage directory", error))?;
    tauri::async_runtime::spawn_blocking(move || install_directory(&source, &destination))
        .await
        .map_err(failure)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use zip::{write::SimpleFileOptions, ZipWriter};

    fn workspace() -> tempfile::TempDir {
        let root = if cfg!(target_os = "android") {
            std::env::temp_dir().join("norea-content-sync-tests")
        } else {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../.tmp/content-sync-tests")
        };
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    fn metadata() -> Value {
        json!({"packageVersion":1,"identity":{"pluginId":"fixture","novelPath":"/novel","chapterPath":"/chapter"},"novel":{"name":"Work","isLocal":false},"chapter":{"name":"Chapter","position":1,"contentType":"html","page":"/chapter"}})
    }

    fn original_media_archive() -> Vec<u8> {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer.start_file("page.png", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"image").unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn download_copy_separates_response_read_errors_from_file_write_errors() {
        struct FailedReader;
        impl Read for FailedReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "response disconnected"))
            }
        }
        struct FailedWriter;
        impl Write for FailedWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "storage refused"))
            }
            fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
        }
        let read_error = copy_downloaded_file(&mut FailedReader, &mut Vec::new(), 3).unwrap_err();
        assert!(read_error.starts_with("content sync:"), "{read_error}");
        assert!(!read_error.starts_with("chapter-storage-failed:"), "{read_error}");
        let write_error = copy_downloaded_file(&mut std::io::Cursor::new(b"one"), &mut FailedWriter, 3).unwrap_err();
        assert!(write_error.starts_with("chapter-storage-failed: write content download file:"), "{write_error}");
    }

    #[test]
    fn download_media_inspection_separates_local_io_from_invalid_server_packages() {
        let root = workspace();
        let io_failure = |error: &dyn std::fmt::Display| chapter_storage_failure("inspect downloaded media", error);
        assert!(inspect_chapter_media_with_io_failure(root.path(), &io_failure).unwrap());
        let blocked = root.path().join("blocked");
        fs::write(&blocked, "file").unwrap();
        for unavailable in [root.path().join("missing"), blocked.join("child")] {
            let error = inspect_chapter_media_with_io_failure(&unavailable, &io_failure).unwrap_err();
            assert!(error.starts_with("chapter-storage-failed:"), "{error}");
        }
        let error = inspect_chapter_media_with_io_failure(&blocked, &io_failure).unwrap_err();
        assert_eq!(error, failure("invalid chapter directory"));
        #[cfg(unix)]
        {
            let linked = root.path().join("linked");
            std::os::unix::fs::symlink(root.path(), &linked).unwrap();
            let error = inspect_chapter_media_with_io_failure(&linked, &io_failure).unwrap_err();
            assert_eq!(error, failure("invalid chapter directory"));
        }
        fs::write(root.path().join("manifest.json"), "{broken").unwrap();
        let error = inspect_chapter_media_with_io_failure(root.path(), &io_failure).unwrap_err();
        assert!(!error.starts_with("chapter-storage-failed:"), "{error}");
        fs::write(root.path().join("manifest.json"), json!({"version":1,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png"}]}}).to_string()).unwrap();
        let truncated = original_media_archive()[..14].to_vec();
        for archive in [b"not a zip".to_vec(), Vec::new(), truncated] {
            fs::write(root.path().join("media.zip"), archive).unwrap();
            let error = inspect_chapter_media_with_io_failure(root.path(), &io_failure).unwrap_err();
            assert!(!error.starts_with("chapter-storage-failed:"), "{error}");
        }
    }

    #[test]
    fn download_local_directory_failure_is_storage_and_preserves_existing_files() {
        let root = workspace();
        let destination = root.path().join("existing");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("content.html"), "previous").unwrap();
        let entry = json!({"id":"chapter","revision":"upload","fileBytes":1,"deleted":false,
            "manifest":{"packageVersion":1,"layout":"chapter-files","chapter":{"contentType":"html"},
                "bodyPath":"content.html","files":[{"path":"content.html","size":1,"modifiedAt":1}]}});
        let error = download_chapter_files("http://127.0.0.1:1", None, &entry, &destination).unwrap_err();
        assert!(error.starts_with("chapter-storage-failed: create content download directory:"), "{error}");
        assert_eq!(fs::read_to_string(destination.join("content.html")).unwrap(), "previous");
    }

    #[test]
    fn install_local_directory_failure_is_storage_and_preserves_source() {
        let root = workspace();
        let source = root.path().join("incoming");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("content.html"), "incoming").unwrap();
        let blocked_parent = root.path().join("blocked");
        fs::write(&blocked_parent, "existing").unwrap();
        let error = install_directory(&source, &blocked_parent.join("chapter")).unwrap_err();
        assert!(error.starts_with("chapter-storage-failed:"), "{error}");
        assert_eq!(fs::read_to_string(source.join("content.html")).unwrap(), "incoming");
        assert_eq!(fs::read_to_string(blocked_parent).unwrap(), "existing");
    }

    #[test]
    fn download_http_not_found_remains_a_source_error() {
        use std::net::TcpListener;
        let root = workspace();
        let entry = json!({"id":"chapter","revision":"upload","fileBytes":2,"deleted":false,
            "manifest":{"packageVersion":1,"layout":"chapter-files","chapter":{"contentType":"html"},
                "bodyPath":"content.html","files":[{"path":"content.html","size":1,"modifiedAt":1},
                    {"path":"manifest.json","size":1,"modifiedAt":1}]}});
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                connection.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            connection.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let destination = root.path().join("downloaded");
        let error = download_chapter_files(&server, None, &entry, &destination).unwrap_err();
        receiver.join().unwrap();
        assert_eq!(error, "content sync: server returned 404: Not Found");
        assert!(!destination.join("content.html").exists());
        assert!(!destination.join("manifest.json").exists());
    }

    #[test]
    fn download_requires_current_layout_and_file_metadata_before_creating_stage() {
        let root = workspace();
        let mut entry = json!({"id":"chapter","revision":"upload","fileBytes":1,"deleted":false,"sequence":1,
            "manifest":{"packageVersion":1,"layout":"chapter-files","chapter":{"contentType":"html"},
                "bodyPath":"content.html","files":[{"path":"content.html","size":1,"modifiedAt":1}]}});
        for field in ["layout", "modifiedAt", "fileBytes"] {
            let mut incomplete = entry.clone();
            match field {
                "layout" => { incomplete["manifest"].as_object_mut().unwrap().remove(field); }
                "modifiedAt" => { incomplete["manifest"]["files"][0].as_object_mut().unwrap().remove(field); }
                _ => { incomplete.as_object_mut().unwrap().remove(field); }
            }
            let destination = root.path().join(field);
            let error = download_chapter_files("http://127.0.0.1:1", None, &incomplete, &destination).unwrap_err();
            assert!(!error.starts_with("chapter-storage-failed:"), "{error}");
            assert!(!destination.exists(), "invalid {field} reached the download stage");
        }
        entry["fileBytes"] = json!(2);
        let destination = root.path().join("wrong-total");
        assert!(download_chapter_files("http://127.0.0.1:1", None, &entry, &destination).is_err());
        assert!(!destination.exists());
    }

    #[test]
    fn download_rejects_unlisted_and_nested_files_before_creating_stage() {
        let root = workspace();
        for (index, path) in ["../escaped.html", "media/page.png", "media-manifest.json"].iter().enumerate() {
            let entry = json!({"id":"chapter","revision":"upload","fileBytes":1,"deleted":false,"sequence":1,
                "manifest":{"packageVersion":1,"layout":"chapter-files","chapter":{"contentType":"html"},
                    "bodyPath":"content.html","files":[{"path":path,"size":1,"modifiedAt":1}]}});
            let destination = root.path().join(index.to_string());
            let result = download_chapter_files("http://127.0.0.1:1", None, &entry, &destination);
            assert!(result.unwrap_err().contains("unexpected chapter file"));
            assert!(!destination.exists());
        }
        assert!(!root.path().join("escaped.html").exists());
    }

    #[test]
    fn snapshot_skips_media_workspace_and_uploads_published_files_as_incomplete() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir_all(source.join("media")).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "<p>Original</p>").unwrap();
        fs::write(source.join("media/page.png"), b"image").unwrap();
        fs::write(source.join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}).to_string()).unwrap();
        snapshot_directory(&source, &stage).unwrap();
        let staged = stage.join("source");
        assert!(!staged.join("media").exists());
        let manifest = chapter_file_manifest(&staged, metadata()).unwrap();
        let paths: Vec<_> = manifest["files"].as_array().unwrap().iter().map(|file| file["path"].as_str().unwrap()).collect();
        assert_eq!(paths, ["content.html", "manifest.json"]);
        assert!(!inspect_chapter_media(&staged).unwrap());
        assert_eq!(fs::read(source.join("media/page.png")).unwrap(), b"image");
    }

    #[test]
    fn chapter_file_transfer_preserves_original_body_and_media_bytes() {
        let root = workspace();
        let body = b"<img src=\"norea-media://reader-asset/page.png\"><p>Original body</p>";
        let media = original_media_archive();
        let manifest = br#"{"version":1,"complete":true,"updatedAt":123,"media":{"files":[{"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}"#;
        fs::write(root.path().join("content.html"), body).unwrap();
        fs::write(root.path().join("manifest.json"), manifest).unwrap();
        fs::write(root.path().join("media.zip"), &media).unwrap();
        let original = fingerprint_directory(root.path()).unwrap();
        let description = chapter_file_manifest(root.path(), metadata()).unwrap();
        assert_eq!(description["layout"], "chapter-files");
        assert_eq!(description["bodyPath"], "content.html");
        assert_eq!(description["files"].as_array().unwrap().len(), 3);
        for record in description["files"].as_array().unwrap() {
            let name = record["path"].as_str().unwrap();
            let expected: &[u8] = match name {
                "content.html" => body,
                "manifest.json" => manifest,
                "media.zip" => &media,
                _ => panic!("unexpected transfer file"),
            };
            assert_eq!(record["size"], expected.len());
            assert!(record.get("sha256").is_none());
            assert!(record["modifiedAt"].as_u64().is_some());
        }
        assert_eq!(fingerprint_directory(root.path()).unwrap(), original);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
    }

    #[test]
    fn chapter_media_inventory_allows_safe_extra_directories_and_nested_files() {
        let root = workspace();
        fs::write(root.path().join("manifest.json"), json!({"version":1,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png"}]}}).to_string()).unwrap();
        let mut writer = ZipWriter::new(File::create(root.path().join("media.zip")).unwrap());
        writer.start_file("page.png", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"image").unwrap();
        writer.add_directory("extras/", SimpleFileOptions::default()).unwrap();
        writer.start_file("extras/extra.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"extra").unwrap();
        writer.finish().unwrap();
        validate_chapter_media(root.path()).unwrap();

        let mut archive = original_media_archive();
        let central = archive.windows(4).position(|bytes| bytes == b"PK\x01\x02").unwrap();
        archive[central + 5] = 0;
        archive[central + 38..central + 42].copy_from_slice(&0x10u32.to_le_bytes());
        fs::write(root.path().join("media.zip"), archive).unwrap();
        assert!(validate_chapter_media(root.path()).is_err());
    }

    #[test]
    fn chapter_file_transfer_validates_stored_media_without_a_completion_marker() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<img src=\"norea-media://reader-asset/page.png\">").unwrap();
        let archive = original_media_archive();
        fs::write(root.path().join("media.zip"), &archive).unwrap();
        for complete in [None, Some(false)] {
            let mut manifest = json!({"version":1,"media":{"files":[
                {"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}});
            if let Some(complete) = complete { manifest["complete"] = json!(complete); }
            let raw = manifest.to_string();
            fs::write(root.path().join("manifest.json"), &raw).unwrap();
            let before = fingerprint_directory(root.path()).unwrap();
            chapter_file_manifest(root.path(), metadata()).unwrap();
            assert_eq!(fingerprint_directory(root.path()).unwrap(), before);
            assert_eq!(fs::read_to_string(root.path().join("manifest.json")).unwrap(), raw);
        }
        fs::remove_file(root.path().join("media.zip")).unwrap();
        chapter_file_manifest(root.path(), metadata()).unwrap();
        assert!(validate_chapter_media(root.path()).is_err());
    }

    #[test]
    fn chapter_file_transfer_tracks_missing_entries_without_trusting_completion_markers() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<img src=\"https://example.com/page.png\">").unwrap();
        fs::write(root.path().join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":[
            {"fileName":"page.png","path":"","status":"remote","bytes":0}]}}).to_string()).unwrap();
        chapter_file_manifest(root.path(), metadata()).unwrap();
        assert!(validate_chapter_media(root.path()).is_err());
        fs::write(root.path().join("media.zip"), original_media_archive()).unwrap();
        chapter_file_manifest(root.path(), metadata()).unwrap();
    }

    #[test]
    fn chapter_file_transfer_uses_archive_sizes_without_rewriting_cached_sizes() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<img src=\"norea-media://reader-asset/page.png\">").unwrap();
        let archive = original_media_archive();
        fs::write(root.path().join("media.zip"), &archive).unwrap();
        for bytes in [0, 999] {
            let manifest = json!({"version":1,"complete":true,"media":{"files":[
                {"fileName":"page.png","path":"media/page.png","status":"stored","bytes":bytes}]}}).to_string();
            fs::write(root.path().join("manifest.json"), &manifest).unwrap();
            chapter_file_manifest(root.path(), metadata()).unwrap();
            assert_eq!(fs::read_to_string(root.path().join("manifest.json")).unwrap(), manifest);
            assert_eq!(fs::read(root.path().join("media.zip")).unwrap(), archive);
        }
        let mut oversized = archive;
        let directory = oversized.windows(4).position(|bytes| bytes == b"PK\x01\x02").unwrap();
        oversized[directory + 24..directory + 28].copy_from_slice(&((MAX_EXPANDED_BYTES + 1) as u32).to_le_bytes());
        fs::write(root.path().join("media.zip"), oversized).unwrap();
        let error = chapter_file_manifest(root.path(), metadata()).unwrap_err();
        assert!(error.contains("chapter media exceeds byte limit"), "{error}");
    }

    #[test]
    fn chapter_file_transfer_rejects_wrong_body_and_ignores_media_workspace() {
        let root = workspace();
        fs::write(root.path().join("content.pdf"), b"pdf").unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
        fs::remove_file(root.path().join("content.pdf")).unwrap();
        fs::write(root.path().join("content.html"), b"text").unwrap();
        fs::create_dir(root.path().join("media")).unwrap();
        fs::write(root.path().join("media/page.png"), b"image").unwrap();
        let manifest = chapter_file_manifest(root.path(), metadata()).unwrap();
        assert_eq!(manifest["files"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["files"][0]["path"], "content.html");
    }

    #[test]
    fn upload_timeout_grows_with_body_size() {
        assert_eq!(upload_timeout(0), MIN_UPLOAD_TIMEOUT);
        assert_eq!(upload_timeout(32 * 1024 * 1024), MIN_UPLOAD_TIMEOUT);
        assert_eq!(upload_timeout(64 * 1024 * 1024), Duration::from_secs(1024));
        assert_eq!(upload_timeout(512 * 1024 * 1024), Duration::from_secs(8192));
    }

    fn read_request_head(connection: &mut std::net::TcpStream) -> String {
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            connection.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
            assert!(head.len() < 64 * 1024);
        }
        String::from_utf8(head).unwrap()
    }

    fn read_request_body(connection: &mut std::net::TcpStream) {
        connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let head = read_request_head(connection);
        let length = head.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
        }).unwrap();
        let mut body = vec![0; length];
        connection.read_exact(&mut body).unwrap();
    }

    fn large_upload_source(root: &Path) -> PathBuf {
        let source = root.join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("content.html"), vec![b'a'; 8 * 1024 * 1024]).unwrap();
        source
    }

    #[test]
    fn upload_retries_once_after_the_server_drops_the_connection() {
        use std::net::TcpListener;
        let root = workspace();
        let source = large_upload_source(root.path());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            let (mut dropped, _) = listener.accept().unwrap();
            read_request_head(&mut dropped);
            drop(dropped);
            let (mut connection, _) = listener.accept().unwrap();
            read_request_body(&mut connection);
            let reply = br#"{"id":"uploaded"}"#;
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).unwrap();
            connection.write_all(reply).unwrap();
        });
        let uploaded = upload_chapter_files(&source, metadata(), &server, "device", UploadConflictPolicy::PreferComplete).unwrap();
        receiver.join().unwrap();
        assert_eq!(uploaded, json!({"id":"uploaded"}));
    }

    #[test]
    fn upload_failure_reports_progress_and_transport_cause_after_retrying() {
        use std::net::TcpListener;
        let root = workspace();
        let source = large_upload_source(root.path());
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            for _ in 0..UPLOAD_ATTEMPTS {
                let (mut connection, _) = listener.accept().unwrap();
                read_request_head(&mut connection);
            }
        });
        let error = upload_chapter_files(&source, metadata(), &server, "device", UploadConflictPolicy::PreferComplete).unwrap_err();
        receiver.join().unwrap();
        assert!(error.starts_with("content sync: upload stopped after sending "), "{error}");
        assert!(error.contains(&format!(" of {} bytes in ", 8 * 1024 * 1024)), "{error}");
        assert!(error.contains(&format!("(attempt {UPLOAD_ATTEMPTS} of {UPLOAD_ATTEMPTS})")), "{error}");
        assert!(error.contains("for url (") && error.matches(": ").count() > 2, "{error}");
    }

    #[test]
    fn upload_does_not_retry_server_rejections() {
        use std::net::TcpListener;
        let root = workspace();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("content.html"), b"<p>Body</p>").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            read_request_body(&mut connection);
            let reply = br#"{"message":"Chapter files are incomplete"}"#;
            write!(connection, "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).unwrap();
            connection.write_all(reply).unwrap();
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            assert!(listener.accept().is_err());
        });
        let error = upload_chapter_files(&source, metadata(), &server, "device", UploadConflictPolicy::PreferComplete).unwrap_err();
        receiver.join().unwrap();
        assert_eq!(error, "content sync: server returned 400: Chapter files are incomplete");
    }

    #[test]
    fn chapter_file_transfer_preserves_pdf_without_media_files() {
        let root = workspace();
        let body = b"%PDF-1.7\noriginal pdf bytes";
        fs::write(root.path().join("content.pdf"), body).unwrap();
        let mut metadata = metadata();
        metadata["chapter"]["contentType"] = json!("pdf");
        let manifest = chapter_file_manifest(root.path(), metadata).unwrap();
        assert_eq!(manifest["bodyPath"], "content.pdf");
        assert_eq!(manifest["files"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["files"][0]["path"], "content.pdf");
        assert_eq!(manifest["files"][0]["size"], body.len());
        assert_eq!(fs::read(root.path().join("content.pdf")).unwrap(), body);
    }

    #[test]
    fn chapter_fingerprint_uses_file_metadata_without_reading_contents() {
        let root = workspace();
        let body = root.path().join("content.html");
        let modified = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::write(&body, b"one").unwrap();
        File::options().write(true).open(&body).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        let original = fingerprint_directory(root.path()).unwrap();
        fs::write(&body, b"two").unwrap();
        File::options().write(true).open(&body).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        assert_eq!(fingerprint_directory(root.path()).unwrap(), original);
        File::options().write(true).open(&body).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified + Duration::from_secs(1))).unwrap();
        assert_ne!(fingerprint_directory(root.path()).unwrap(), original);
        let stage = root.path().join("snapshot");
        fs::create_dir(&stage).unwrap();
        snapshot_directory(root.path(), &stage).unwrap();
        assert_eq!(fingerprint_directory(root.path()).unwrap(), fingerprint_directory(&stage.join("source")).unwrap());
    }

    #[test]
    fn chapter_file_transfer_preserves_incomplete_media_inventory_without_rewriting() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<p>Original</p>").unwrap();
        let archive = original_media_archive();
        fs::write(root.path().join("media.zip"), &archive).unwrap();
        fs::write(root.path().join("manifest.json"), json!({"version":1,"media":{"files":[]}}).to_string()).unwrap();
        chapter_file_manifest(root.path(), metadata()).unwrap();
        for files in [json!([{"fileName":"missing.png","path":"media/missing.png","status":"stored","bytes":5}])] {
            fs::write(root.path().join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":files}}).to_string()).unwrap();
            chapter_file_manifest(root.path(), metadata()).unwrap();
            assert!(validate_chapter_media(root.path()).is_err());
            assert_eq!(fs::read(root.path().join("media.zip")).unwrap(), archive);
        }
        fs::remove_file(root.path().join("manifest.json")).unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
    }

    #[test]
    fn original_files_use_multipart_upload_and_individual_http_downloads() {
        chapter_files_round_trip(true, true);
    }

    #[test]
    fn incomplete_files_download_and_install_without_rewriting_originals() {
        chapter_files_round_trip(false, true);
    }

    #[test]
    fn incomplete_files_without_media_archive_download_and_install() {
        chapter_files_round_trip(false, false);
    }

    fn chapter_files_round_trip(complete: bool, archive_present: bool) {
        use std::net::TcpListener;
        let root = workspace();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let mut files = vec![
            ("content.html", b"<img src=\"norea-media://reader-asset/page.png\">".to_vec()),
            ("manifest.json", br#"{"version":1,"complete":true,"updatedAt":123,"media":{"files":[{"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}"#.to_vec()),
            ("media.zip", original_media_archive()),
        ];
        if !complete {
            let mut media: Value = serde_json::from_slice(&files[1].1).unwrap();
            media["complete"] = json!(false);
            media["media"]["files"].as_array_mut().unwrap().push(json!({"fileName":"missing.png","path":"","status":"remote"}));
            files[1].1 = serde_json::to_vec(&media).unwrap();
        }
        if !archive_present { files.pop(); }
        for (name, bytes) in &files { fs::write(source.join(name), bytes).unwrap(); }
        let manifest = chapter_file_manifest(&source, metadata()).unwrap();
        let file_bytes: usize = files.iter().map(|(_, bytes)| bytes.len()).sum();
        let entry = json!({"id":"a".repeat(64),"revision":"b".repeat(64),"fileBytes":file_bytes,"manifest":manifest,"deleted":false,"sequence":1});
        let reply = serde_json::to_vec(&entry).unwrap();
        let expected = files.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            for index in 0..expected.len() + 1 {
                let (mut connection, _) = listener.accept().unwrap();
                connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0]; connection.read_exact(&mut byte).unwrap(); head.push(byte[0]);
                    assert!(head.len() < 64 * 1024);
                }
                let head = String::from_utf8(head).unwrap();
                let response = if index == 0 {
                    assert!(head.starts_with("POST /api/v1/chapter-files?conflictPolicy=replace-server HTTP/1.1"));
                    assert!(head.to_ascii_lowercase().contains("content-type: multipart/form-data; boundary="));
                    let length = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    }).unwrap();
                    let mut body = vec![0; length]; connection.read_exact(&mut body).unwrap();
                    for (name, bytes) in &expected {
                        let part = [format!("filename=\"{name}\"\r\n\r\n").as_bytes(), bytes, b"\r\n"].concat();
                        assert!(body.windows(part.len()).any(|window| window == part), "changed file bytes for {name}");
                    }
                    reply.clone()
                } else {
                    let target = head.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                    let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
                    assert_eq!(url.path(), format!("/api/v1/chapters/{}/files", "a".repeat(64)));
                    let path = url.query_pairs().find(|(key, _)| key == "path").unwrap().1.into_owned();
                    assert!(url.query_pairs().any(|(key, value)| key == "revision" && value == "b".repeat(64)));
                    expected.iter().find(|(name, _)| *name == path).unwrap().1.clone()
                };
                write!(connection, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
                connection.write_all(&response).unwrap();
            }
        });
        let uploaded = upload_chapter_files(&source, metadata(), &server, "device", UploadConflictPolicy::ReplaceServer).unwrap();
        assert_eq!(uploaded, entry);
        let destination = root.path().join("downloaded");
        let installed = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("content.html"), "previous body").unwrap();
        let sizes = download_chapter_files(&server, Some("device"), &entry, &destination).unwrap();
        receiver.join().unwrap();
        assert_eq!(fs::read_to_string(installed.join("content.html")).unwrap(), "previous body");
        install_directory(&destination, &installed).unwrap();
        assert_eq!(sizes["contentBytes"], files[0].1.len());
        assert_eq!(sizes["mediaBytes"], files.get(2).map_or(0, |file| file.1.len()));
        assert_eq!(sizes["mediaComplete"], complete);
        let file_count = files.len();
        for (name, bytes) in files {
            assert_eq!(fs::read(source.join(name)).unwrap(), bytes);
            assert_eq!(fs::read(destination.join(name)).unwrap(), bytes);
            assert_eq!(fs::read(installed.join(name)).unwrap(), bytes);
        }
        assert_eq!(fingerprint_directory(&source).unwrap(), fingerprint_directory(&installed).unwrap());
        assert_eq!(fs::read_dir(&source).unwrap().count(), file_count);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), file_count);
    }

    #[test]
    fn snapshot_keeps_upload_generation_after_original_files_change() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        let body = "<p>Original</p><img src=\"norea-media://reader-asset/page.png\">";
        fs::write(source.join("content.html"), body).unwrap();
        let media = original_media_archive();
        fs::write(source.join("media.zip"), &media).unwrap();
        fs::write(source.join("ignored.txt"), b"keep original").unwrap();
        fs::write(source.join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":[{"fileName":"page.png","path":"media/page.png","bytes":5,"status":"stored"}]}}).to_string()).unwrap();

        snapshot_directory(&source, &stage).unwrap();
        let snapshot = stage.join("source");
        let original_fingerprint = fingerprint_directory(&snapshot).unwrap();
        assert_eq!(fs::read_to_string(source.join("content.html")).unwrap(), body);
        assert_eq!(fs::read(source.join("media.zip")).unwrap(), media);
        assert_eq!(fs::read(source.join("ignored.txt")).unwrap(), b"keep original");
        assert!(!snapshot.join("ignored.txt").exists());

        fs::write(source.join("content.html"), "<p>Replacement</p>").unwrap();
        fs::write(source.join("media.zip"), b"changed").unwrap();
        assert_eq!(fingerprint_directory(&snapshot).unwrap(), original_fingerprint);
        assert_ne!(fingerprint_directory(&source).unwrap(), original_fingerprint);
        chapter_file_manifest(&snapshot, metadata()).unwrap();
        assert_eq!(fs::read_to_string(snapshot.join("content.html")).unwrap(), body);
        assert_eq!(fs::read(snapshot.join("media.zip")).unwrap(), media);
    }

    #[test]
    fn incomplete_snapshot_is_preserved_without_changing_original_files() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "original").unwrap();
        let manifest = json!({"version":1,"complete":true,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}).to_string();
        fs::write(source.join("manifest.json"), &manifest).unwrap();
        snapshot_directory(&source, &stage).unwrap();
        chapter_file_manifest(&stage.join("source"), metadata()).unwrap();
        assert!(validate_chapter_media(&stage.join("source")).is_err());
        assert_eq!(fs::read_to_string(stage.join("source/content.html")).unwrap(), "original");
        assert_eq!(fs::read_to_string(stage.join("source/manifest.json")).unwrap(), manifest);
        assert_eq!(fs::read_to_string(source.join("content.html")).unwrap(), "original");
        assert_eq!(fs::read_to_string(source.join("manifest.json")).unwrap(), manifest);
    }

    #[test]
    fn snapshot_rejects_partial_body_without_media_inventory() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join(".chapter-content.partial"), "uninspected body").unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        assert_eq!(fs::read_to_string(source.join(".chapter-content.partial")).unwrap(), "uninspected body");
    }

    #[test]
    fn snapshot_uploads_partial_body_and_media_without_marking_them_complete() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join(".chapter-content.partial"), "partial body").unwrap();
        let archive = original_media_archive();
        fs::write(source.join("media.zip"), &archive).unwrap();
        let manifest = json!({"version":1,"complete":false,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png"},
            {"fileName":"missing.png","path":"","status":"remote"}]}}).to_string();
        fs::write(source.join("manifest.json"), &manifest).unwrap();
        snapshot_directory(&source, &stage).unwrap();
        let snapshot = stage.join("source");
        chapter_file_manifest(&snapshot, metadata()).unwrap();
        assert!(validate_chapter_media(&snapshot).is_err());
        assert_eq!(fs::read_to_string(snapshot.join("content.html")).unwrap(), "partial body");
        assert_eq!(fs::read(snapshot.join("media.zip")).unwrap(), archive);
        assert_eq!(fs::read_to_string(snapshot.join("manifest.json")).unwrap(), manifest);
        assert!(!source.join("content.html").exists());
        assert_eq!(fs::read_to_string(source.join(".chapter-content.partial")).unwrap(), "partial body");
    }

    #[test]
    fn snapshot_rejects_non_file_artifacts_and_never_replaces_an_existing_snapshot() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir_all(source.join("manifest.json")).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "original").unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        fs::remove_dir(source.join("manifest.json")).unwrap();
        snapshot_directory(&source, &stage).unwrap();
        fs::write(source.join("content.html"), "replacement").unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert_eq!(fs::read_to_string(stage.join("source/content.html")).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_rejects_symbolic_chapter_artifacts() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(root.path().join("external.html"), "external").unwrap();
        std::os::unix::fs::symlink(root.path().join("external.html"), source.join("content.html")).unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        assert_eq!(fs::read_to_string(root.path().join("external.html")).unwrap(), "external");
    }

    #[test]
    fn failed_install_preparation_preserves_previous_directory() {
        let root = workspace();
        let source = root.path().join("incoming");
        fs::create_dir_all(source.join("unexpected-directory")).unwrap();
        let destination = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("content.html"), "original").unwrap();
        assert!(install_directory(&source, &destination).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_dir(destination.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn truncated_file_download_does_not_replace_existing_chapter() {
        use std::net::TcpListener;
        let root = workspace();
        let installed = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("content.html"), "previous body").unwrap();
        let entry = json!({"id":"chapter","revision":"upload","fileBytes":18,"deleted":false,"sequence":1,
            "manifest":{"packageVersion":1,"layout":"chapter-files","chapter":{"contentType":"html"},
                "bodyPath":"content.html","files":[{"path":"content.html","size":18,"modifiedAt":1}]}});
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                connection.read_exact(&mut byte).unwrap();
                head.push(byte[0]);
            }
            let body = b"truncated";
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            connection.write_all(body).unwrap();
        });
        let result = download_chapter_files(&server, None, &entry, &root.path().join("downloaded"));
        receiver.join().unwrap();
        assert!(result.unwrap_err().contains("downloaded content.html size mismatch"));
        assert_eq!(fs::read_to_string(installed.join("content.html")).unwrap(), "previous body");
    }

    #[test]
    fn replacement_keeps_readable_folder_and_removes_old_media() {
        let root = workspace();
        let incoming = root.path().join("incoming");
        fs::create_dir_all(&incoming).unwrap();
        fs::write(incoming.join("content.html"), "<p>New chapter</p>").unwrap();
        let destination = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("media.zip"), "old").unwrap();
        install_directory(&incoming, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "<p>New chapter</p>"
        );
        assert!(!destination.join("media.zip").exists());
        assert_eq!(
            fs::read_dir(destination.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn lookup_restores_chapter_after_interruption_between_directory_renames() {
        let root = workspace();
        let parent = root.path().join("contents/fixture/Work");
        let backup = parent.join(".1-Chapter.norea-sync-backup");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("content.html"), "previous complete chapter").unwrap();
        fs::write(backup.join("media.zip"), "previous media").unwrap();
        let destination =
            storage_directory(root.path(), "contents/fixture/Work/1-Chapter").unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "previous complete chapter"
        );
        assert_eq!(
            fs::read_to_string(destination.join("media.zip")).unwrap(),
            "previous media"
        );
        assert!(!backup.exists());
        let broken = root.path().join("broken");
        fs::create_dir_all(broken.join("unexpected-directory")).unwrap();
        assert!(install_directory(&broken, &destination).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "previous complete chapter"
        );
    }

}
