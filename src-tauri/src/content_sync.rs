use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const MAX_MEDIA_ZIP_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn failure(error: impl std::fmt::Display) -> String {
    format!("content sync: {error}")
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

fn read_json(path: &Path) -> Result<Value, String> {
    if fs::metadata(path).map_err(failure)?.len() > 16 * 1024 * 1024 {
        return Err(failure("manifest exceeds byte limit"));
    }
    serde_json::from_reader(File::open(path).map_err(failure)?).map_err(failure)
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
        if file["status"] == "remote" {
            return Err(failure(format!("media asset is not downloaded: {name}")));
        }
        safe_path(name)?;
        if name.contains('/')
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            || !names.insert(name.to_ascii_lowercase())
            || file["status"] != "stored"
            || file["path"] != format!("media/{name}")
        {
            return Err(failure(format!("invalid or duplicate media entry: {name}")));
        }
        result.push(name.to_string());
    }
    Ok(result)
}

fn validate_chapter_media(source: &Path) -> Result<(), String> {
    if !source.join("manifest.json").is_file() {
        return if source.join("media.zip").exists() {
            Err(failure("chapter media manifest is missing"))
        } else {
            Ok(())
        };
    }
    let media = media_files(&read_json(&source.join("manifest.json"))?)?;
    if media.len() + 2 > MAX_FILES {
        return Err(failure("too many chapter media files"));
    }
    if media.is_empty() && !source.join("media.zip").is_file() {
        return Ok(());
    }
    let mut archive = ZipArchive::new(File::open(source.join("media.zip")).map_err(failure)?).map_err(failure)?;
    if archive.len() != media.len() {
        return Err(failure("media archive inventory does not match its manifest"));
    }
    let mut media_bytes = 0;
    for name in media {
        let file = archive.by_name(&name).map_err(failure)?;
        if file.is_dir() || file.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(failure("invalid chapter media artifact"));
        }
        if file.size() > MAX_EXPANDED_BYTES - media_bytes {
            return Err(failure("chapter media exceeds byte limit"));
        }
        media_bytes += file.size();
    }
    Ok(())
}

fn checked_storage_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
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
            Err(error) => return Err(failure(error)),
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
    let backup = content_backup_path(destination)?;
    let metadata = match fs::symlink_metadata(&backup) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(failure(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("invalid chapter recovery directory"));
    }
    if !destination.exists() {
        fs::rename(&backup, destination).map_err(failure)?;
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
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| failure("chapter install lock failed"))?;
    recover_content_directory_locked(destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| failure("missing chapter parent"))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let token = stage_token();
    let stage = parent.join(format!(".norea-sync-{token}.stage"));
    let backup = content_backup_path(destination)?;
    if backup.exists() {
        if !destination.join("content.html").is_file() && !destination.join("content.pdf").is_file()
        {
            return Err(failure(
                "previous chapter backup retained because current content is incomplete",
            ));
        }
        fs::remove_dir_all(&backup).map_err(failure)?;
    }
    fs::create_dir(&stage).map_err(failure)?;
    let preparation = (|| {
        for entry in fs::read_dir(source).map_err(failure)? {
            let entry = entry.map_err(failure)?;
            if !entry.file_type().map_err(failure)?.is_file() {
                return Err(failure("invalid installed artifact"));
            }
            let target = stage.join(entry.file_name());
            let original = entry.metadata().map_err(failure)?;
            if fs::copy(entry.path(), &target).map_err(failure)? != original.len() {
                return Err(failure("storage copy size mismatch"));
            }
            let stored = File::options()
                .write(true)
                .open(&target)
                .map_err(failure)?;
            stored.set_times(fs::FileTimes::new().set_modified(original.modified().map_err(failure)?)).map_err(failure)?;
            stored.sync_all().map_err(failure)?;
            if stored.metadata().map_err(failure)?.len() != original.len() {
                return Err(failure("storage copy size mismatch"));
            }
        }
        Ok(())
    })();
    if let Err(error) = preparation {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let previous = destination.exists();
    if previous {
        fs::rename(destination, &backup).map_err(failure)?;
    }
    if let Err(error) = fs::rename(&stage, destination) {
        if previous {
            fs::rename(&backup, destination).map_err(|rollback| {
                failure(format!(
                    "install failed: {error}; previous files retained at {}: {rollback}",
                    backup.display()
                ))
            })?;
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(failure(error));
    }
    if previous {
        let _ = fs::remove_dir_all(backup);
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
    if !paths
        .iter()
        .any(|path| path == "content.html" || path == "content.pdf")
    {
        return Err(failure("chapter body is missing"));
    }
    match fs::symlink_metadata(source.join("media")) {
        Ok(_) => return Err(failure("chapter media must use media.zip")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(failure(error)),
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
            let target = destination.join(&path);
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
        validate_chapter_media(&destination)?;
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
    let root = app
        .path()
        .app_cache_dir()
        .map_err(failure)?
        .join("content-sync")
        .canonicalize()
        .map_err(failure)?;
    let stage = PathBuf::from(path).canonicalize().map_err(failure)?;
    if stage.parent() != Some(root.as_path()) || !stage.is_dir() {
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
) -> Result<Value, String> {
    let stage = checked_stage(&app, &stage_path)?;
    safe_path(&storage_dir)?;
    let source = stage.join("source");
    tauri::async_runtime::spawn_blocking(move || {
        upload_chapter_files(&source, manifest, &server_url, &token)
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
    validate_chapter_media(source)?;
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

fn upload_chapter_files(source: &Path, metadata: Value, server_url: &str, token: &str) -> Result<Value, String> {
    let manifest = chapter_file_manifest(source, metadata)?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .text("metadata", serde_json::to_string(&manifest).map_err(failure)?);
    for record in manifest["files"].as_array().unwrap() {
        let path = record["path"].as_str().unwrap();
        let part = reqwest::blocking::multipart::Part::reader_with_length(
            File::open(source.join(path)).map_err(failure)?, record["size"].as_u64().unwrap())
            .file_name(path.to_string());
        form = form.part(path.to_string(), part);
    }
    let response = checked_response(http_client()?.post(endpoint(server_url, "chapter-files")?)
        .bearer_auth(token).multipart(form).send().map_err(failure)?)?;
    serde_json::from_reader(response.take(16 * 1024 * 1024)).map_err(failure)
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
    let stage = checked_stage(&app, &stage_path)?;
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
    fs::create_dir(destination).map_err(failure)?;
    let client = http_client()?;
    for (name, size, modified) in declared {
        let mut url = endpoint(server_url, &format!("chapters/{id}/files"))?;
        url.query_pairs_mut().append_pair("revision", revision).append_pair("path", name);
        let mut request = client.get(url);
        if let Some(token) = token { request = request.bearer_auth(token); }
        let mut response = checked_response(request.send().map_err(failure)?)?;
        let path = destination.join(name);
        let mut output = File::create(&path).map_err(failure)?;
        if copy_limited(&mut response, &mut output, size)? != size {
            return Err(failure(format!("downloaded {name} size mismatch")));
        }
        output.set_times(fs::FileTimes::new().set_modified(modified)).map_err(failure)?;
    }
    validate_chapter_media(destination)?;
    Ok(json!({"contentBytes": fs::metadata(destination.join(body)).map_err(failure)?.len(),
        "mediaBytes": if names.contains("media.zip") { fs::metadata(destination.join("media.zip")).map_err(failure)?.len() } else { 0 }}))
}

#[tauri::command]
pub async fn content_sync_install(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<(), String> {
    let stage = checked_stage(&app, &stage_path)?;
    let source = stage.join("install");
    let metadata = fs::symlink_metadata(&source).map_err(failure)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid staged chapter directory"));
    }
    let destination = storage_directory(&crate::chapter_media::media_root(&app)?, &storage_dir)?;
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
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.tmp/content-sync-tests");
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
            assert!(download_chapter_files("http://127.0.0.1:1", None, &incomplete, &destination).is_err());
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
    fn snapshot_rejects_unpacked_media_without_copying_it() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir_all(source.join("media")).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "<p>Original</p>").unwrap();
        fs::write(source.join("media/page.png"), b"image").unwrap();
        fs::write(source.join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}).to_string()).unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
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
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
    }

    #[test]
    fn chapter_file_transfer_reports_remote_assets_even_with_a_completion_marker() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<img src=\"https://example.com/page.png\">").unwrap();
        fs::write(root.path().join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":[
            {"fileName":"page.png","path":"","status":"remote","bytes":0}]}}).to_string()).unwrap();
        let error = chapter_file_manifest(root.path(), metadata()).unwrap_err();
        assert!(error.contains("media asset is not downloaded: page.png"), "{error}");
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
    fn chapter_file_transfer_rejects_wrong_body_and_unpacked_legacy_media() {
        let root = workspace();
        fs::write(root.path().join("content.pdf"), b"pdf").unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
        fs::remove_file(root.path().join("content.pdf")).unwrap();
        fs::write(root.path().join("content.html"), b"text").unwrap();
        fs::create_dir(root.path().join("media")).unwrap();
        fs::write(root.path().join("media/page.png"), b"image").unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
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
    fn chapter_file_transfer_rejects_media_inventory_mismatch_without_rewriting() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<p>Original</p>").unwrap();
        let archive = original_media_archive();
        fs::write(root.path().join("media.zip"), &archive).unwrap();
        for files in [json!([]), json!([{"fileName":"missing.png","path":"media/missing.png","status":"stored","bytes":5}])] {
            fs::write(root.path().join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":files}}).to_string()).unwrap();
            assert!(chapter_file_manifest(root.path(), metadata()).is_err());
            assert_eq!(fs::read(root.path().join("media.zip")).unwrap(), archive);
        }
        fs::remove_file(root.path().join("manifest.json")).unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
    }

    #[test]
    fn original_files_use_multipart_upload_and_individual_http_downloads() {
        use std::net::TcpListener;
        let root = workspace();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let files = vec![
            ("content.html", b"<img src=\"norea-media://reader-asset/page.png\">".to_vec()),
            ("manifest.json", br#"{"version":1,"complete":true,"updatedAt":123,"media":{"files":[{"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}"#.to_vec()),
            ("media.zip", original_media_archive()),
        ];
        for (name, bytes) in &files { fs::write(source.join(name), bytes).unwrap(); }
        let manifest = chapter_file_manifest(&source, metadata()).unwrap();
        let file_bytes: usize = files.iter().map(|(_, bytes)| bytes.len()).sum();
        let entry = json!({"id":"a".repeat(64),"revision":"b".repeat(64),"fileBytes":file_bytes,"manifest":manifest,"deleted":false,"sequence":1});
        let reply = serde_json::to_vec(&entry).unwrap();
        let expected = files.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            for index in 0..4 {
                let (mut connection, _) = listener.accept().unwrap();
                connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0]; connection.read_exact(&mut byte).unwrap(); head.push(byte[0]);
                    assert!(head.len() < 64 * 1024);
                }
                let head = String::from_utf8(head).unwrap();
                let response = if index == 0 {
                    assert!(head.starts_with("POST /api/v1/chapter-files HTTP/1.1"));
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
        let uploaded = upload_chapter_files(&source, metadata(), &server, "device").unwrap();
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
        assert_eq!(sizes["mediaBytes"], files[2].1.len());
        for (name, bytes) in files {
            assert_eq!(fs::read(source.join(name)).unwrap(), bytes);
            assert_eq!(fs::read(destination.join(name)).unwrap(), bytes);
            assert_eq!(fs::read(installed.join(name)).unwrap(), bytes);
        }
        assert_eq!(fingerprint_directory(&source).unwrap(), fingerprint_directory(&installed).unwrap());
        assert_eq!(fs::read_dir(&source).unwrap().count(), 3);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 3);
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
    fn incomplete_snapshot_is_discarded_without_changing_original_files() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "original").unwrap();
        let manifest = json!({"version":1,"complete":true,"media":{"files":[
            {"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}).to_string();
        fs::write(source.join("manifest.json"), &manifest).unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        assert_eq!(fs::read_to_string(source.join("content.html")).unwrap(), "original");
        assert_eq!(fs::read_to_string(source.join("manifest.json")).unwrap(), manifest);
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
