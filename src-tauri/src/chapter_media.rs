use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, BufReader, BufWriter, ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::http::{self, StatusCode, header};
use tauri::{AppHandle, Manager, Runtime};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::native_stream::{self, NativeStreamState, CHAPTER_MEDIA_STREAM_DOMAIN};
use tauri::State;

pub(crate) const MEDIA_ROOT_DIR: &str = "chapter-media";
const MEDIA_URI_PREFIX: &str = "norea-media://reader-asset/";
const CONTENTS_ROOT_DIR: &str = "contents";
const NO_MEDIA_FILE: &str = ".nomedia";
const MEDIA_DOWNLOAD_DIR: &str = "media";
const MEDIA_ARCHIVE_FILE: &str = "media.zip";
const NOVEL_COVER_MANIFEST_FILE: &str = "cover.json";
const LEGACY_STORAGE_MANIFEST_FILE: &str = "storage-manifest.json";
const CHAPTER_MEDIA_MANIFEST_FILE: &str = "manifest.json";
const CHAPTER_PARTIAL_CONTENT_FILE: &str = ".chapter-content.partial";
const STORAGE_ROOT_CONFIG_FILE: &str = "chapter-media-storage-root.txt";
const MEDIA_RESTORE_BACKUP_INFIX: &str = ".restore-backup-";

#[derive(Debug, Clone)]
pub(crate) struct ChapterMediaClearContext {
    pub chapter_id: i64,
    pub novel_id: Option<i64>,
    pub source_id: Option<String>,
    pub novel_name: Option<String>,
    pub novel_path: Option<String>,
    pub chapter_number: Option<String>,
    pub chapter_name: Option<String>,
    pub chapter_position: Option<i64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContentInspection {
    status: String,
    content_file: Option<String>,
    content_bytes: u64,
    media_bytes: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelCoverReadResult {
    manifest: String,
    relative_path: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferEntry {
    pub entry_id: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChapterStorageTransferOutcome {
    CopiedSource,
    KeptTarget,
    SourceNotDownloaded,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparedEntry {
    pub entry_id: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
    pub outcome: ChapterStorageTransferOutcome,
    pub replaced_target: bool,
    pub content_file: Option<String>,
    pub content_bytes: u64,
    pub media_bytes: u64,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparation {
    pub token: String,
    pub entries: Vec<ChapterStorageTransferPreparedEntry>,
}

async fn chapter_media_blocking<T, F>(context: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("chapter media: {context} task: {err}"))?
}

fn legacy_media_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("chapter media: app data dir: {err}"))?
        .join(MEDIA_ROOT_DIR))
}

fn storage_root_config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|err| format!("chapter media: app config dir: {err}"))?
        .join(STORAGE_ROOT_CONFIG_FILE))
}

fn configured_media_root<R: Runtime>(app: &AppHandle<R>) -> Result<Option<PathBuf>, String> {
    let config_path = storage_root_config_path(app)?;
    match fs::read_to_string(&config_path) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(PathBuf::from(trimmed)))
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: read storage root: {err}")),
    }
}

fn media_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    configured_media_root(app)?.map_or_else(|| legacy_media_root(app), Ok)
}

fn save_configured_media_root<R: Runtime>(
    app: &AppHandle<R>,
    root_path: &Path,
) -> Result<String, String> {
    let root_value = root_path.to_string_lossy().into_owned();
    if !root_value.starts_with("content://") {
        fs::create_dir_all(root_path)
            .map_err(|err| format!("chapter media: create storage root: {err}"))?;
        ensure_contents_nomedia(root_path)?;
    }
    let config_path = storage_root_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("chapter media: create config dir: {err}"))?;
    }
    fs::write(&config_path, &root_value)
        .map_err(|err| format!("chapter media: write storage root: {err}"))?;
    Ok(root_value)
}

fn ensure_contents_nomedia(root: &Path) -> Result<(), String> {
    let contents_dir = root.join(CONTENTS_ROOT_DIR);
    fs::create_dir_all(&contents_dir)
        .map_err(|err| format!("chapter media: create contents dir: {err}"))?;
    File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(contents_dir.join(NO_MEDIA_FILE))
        .map(|_| ())
        .map_err(|err| format!("chapter media: create .nomedia: {err}"))
}

fn media_roots_for_lookup<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    roots.push(media_root(app)?);
    let legacy_root = legacy_media_root(app)?;
    if !roots.iter().any(|root| root == &legacy_root) {
        roots.push(legacy_root);
    }
    Ok(roots)
}

#[tauri::command]
pub fn chapter_media_get_storage_root(app: AppHandle) -> Result<Option<String>, String> {
    configured_media_root(&app).map(|root| root.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn chapter_media_set_storage_root(app: AppHandle, root: String) -> Result<String, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("chapter media: storage root is empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("chapter media: storage root contains an invalid character".to_string());
    }

    let root_path = PathBuf::from(trimmed);
    save_configured_media_root(&app, &root_path)
}

#[tauri::command]
pub fn chapter_media_use_default_storage_root(app: AppHandle) -> Result<String, String> {
    let root_path = legacy_media_root(&app)?;
    save_configured_media_root(&app, &root_path)
}

fn safe_segment(value: &str, fallback: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(96)
        .collect::<String>();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn safe_media_relative_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('.')
        || trimmed.starts_with('/')
        || trimmed.starts_with('#')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('?')
        || trimmed.contains('&')
        || trimmed.contains('=')
        || trimmed.contains('\0')
    {
        return Err("chapter media: invalid media file path".to_string());
    }
    for part in trimmed.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || !part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return Err("chapter media: invalid media file path".to_string());
        }
    }
    Ok(trimmed.to_string())
}

fn is_unsafe_unicode_format(ch: char) -> bool {
    matches!(
        ch,
        '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FEFF}'
    )
}

pub fn norea_media_protocol_response(
    app: &AppHandle,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    match norea_media_protocol_body(app, request.uri().path()) {
        Ok((body, content_type)) => http::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .body(body)
            .unwrap_or_else(|_| http::Response::new(Vec::new())),
        Err((status, message)) => http::Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.into_bytes())
            .unwrap_or_else(|_| http::Response::new(Vec::new())),
    }
}

fn norea_media_protocol_body(
    app: &AppHandle,
    request_path: &str,
) -> Result<(Vec<u8>, &'static str), (StatusCode, String)> {
    let relative_path = norea_media_relative_path(request_path)
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    let media_root =
        media_root(app).map_err(|message| (StatusCode::INTERNAL_SERVER_ERROR, message))?;
    let path = media_root.join(&relative_path);
    if !path.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "norea media: file not found".to_string(),
        ));
    }
    let body = fs::read(&path).map_err(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("norea media: read file: {err}"),
        )
    })?;
    let content_type = norea_media_content_type(&path, &body);
    Ok((body, content_type))
}

fn norea_media_relative_path(request_path: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode_utf8(request_path.trim_start_matches('/'))?;
    let parts = decoded.split('/').collect::<Vec<_>>();
    if parts.first() != Some(&CONTENTS_ROOT_DIR) {
        return Err("norea media: path must be contents-relative".to_string());
    }

    let mut path = PathBuf::new();
    for part in parts {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.chars().any(|ch| {
                ch.is_control()
                    || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            })
        {
            return Err("norea media: invalid relative path".to_string());
        }
        path.push(part);
    }
    Ok(path)
}

fn percent_decode_utf8(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("norea media: invalid percent encoding".to_string());
            }
            let high = percent_hex_value(bytes[index + 1])
                .ok_or_else(|| "norea media: invalid percent encoding".to_string())?;
            let low = percent_hex_value(bytes[index + 2])
                .ok_or_else(|| "norea media: invalid percent encoding".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "norea media: invalid utf-8 path".to_string())
}

fn percent_hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn image_mime_type(body: &[u8]) -> Option<&'static str> {
    if body.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if body.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if body.len() >= 12 && body.starts_with(b"RIFF") && &body[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if body.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if is_avif_image(body) {
        return Some("image/avif");
    }
    None
}

fn is_avif_image(body: &[u8]) -> bool {
    if body.len() < 12 || &body[4..8] != b"ftyp" {
        return false;
    }
    let declared_size = u32::from_be_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let box_end = match declared_size {
        0 => body.len(),
        1 => return false,
        size => size.min(body.len()),
    };
    if box_end < 12 {
        return false;
    }

    matches!(&body[8..12], b"avif" | b"avis")
        || (box_end >= 20
            && body[16..box_end]
                .chunks_exact(4)
                .any(|brand| matches!(brand, b"avif" | b"avis")))
}

fn norea_media_content_type(path: &Path, body: &[u8]) -> &'static str {
    if let Some(content_type) = image_mime_type(body) {
        return content_type;
    }
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("gif") => "image/gif",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn safe_label_segment(value: Option<&str>, fallback: &str) -> String {
    let raw = value.map(str::trim).filter(|value| !value.is_empty());
    let sanitized = raw
        .unwrap_or(fallback)
        .chars()
        .map(|ch| {
            if ch.is_control()
                || ch.is_whitespace()
                || is_unsafe_unicode_format(ch)
                || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim_matches(['-', '.'])
        .chars()
        .take(96)
        .collect::<String>();

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn novel_folder_segment(
    novel_name: Option<&str>,
    novel_path: Option<&str>,
    novel_id: i64,
) -> String {
    let novel_address = safe_segment(novel_path.unwrap_or_default(), &novel_id.to_string());
    format!(
        "{}-{novel_address}",
        safe_label_segment(novel_name, "novel")
    )
}

fn content_novel_dir_at(
    root: &Path,
    source_id: &str,
    novel_id: i64,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
) -> Result<PathBuf, String> {
    let has_novel_path = novel_path.is_some_and(|path| !path.trim().is_empty());
    if novel_id < 0 || (novel_id == 0 && !has_novel_path) {
        return Err("chapter media: invalid novel id".to_string());
    }
    let source_id = safe_segment(source_id, "source");
    let novel_segment = novel_folder_segment(novel_name, novel_path, novel_id);
    Ok(root
        .join(CONTENTS_ROOT_DIR)
        .join(source_id)
        .join(novel_segment))
}

fn chapter_number_segment(
    chapter_number: Option<&str>,
    position: Option<i64>,
    chapter_id: i64,
) -> String {
    let fallback = position
        .filter(|value| *value > 0)
        .map(|value| value.to_string())
        .unwrap_or_else(|| chapter_id.to_string());
    safe_segment(chapter_number.unwrap_or_default(), &fallback)
}

fn chapter_folder_segment(
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    position: Option<i64>,
    chapter_id: i64,
) -> String {
    format!(
        "{}-{}",
        chapter_number_segment(chapter_number, position, chapter_id),
        safe_label_segment(chapter_name, "chapter")
    )
}

fn chapter_dir_at(root: &Path, chapter_id: i64) -> Result<PathBuf, String> {
    if chapter_id <= 0 {
        return Err("chapter media: invalid chapter id".to_string());
    }
    Ok(root.join(chapter_id.to_string()))
}

fn content_chapter_dir_at(
    root: &Path,
    source_id: &str,
    novel_id: i64,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<PathBuf, String> {
    if novel_id <= 0 {
        return Err("chapter media: invalid novel id".to_string());
    }
    if chapter_id <= 0 {
        return Err("chapter media: invalid chapter id".to_string());
    }
    let chapter_segment =
        chapter_folder_segment(chapter_number, chapter_name, chapter_position, chapter_id);
    Ok(
        content_novel_dir_at(root, source_id, novel_id, novel_path, novel_name)?
            .join(chapter_segment),
    )
}

fn content_chapter_relative_dir(
    source_id: &str,
    novel_id: i64,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    let dir = content_chapter_dir_at(
        Path::new(""),
        source_id,
        novel_id,
        novel_path,
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?;
    Ok(dir.to_string_lossy().replace('\\', "/"))
}

fn path_segment_has_id_suffix(path: &Path, id: i64) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.ends_with(&format!("-{id}")))
}

fn content_chapter_dirs_for_lookup(root: &Path, chapter_id: i64) -> Result<Vec<PathBuf>, String> {
    if chapter_id <= 0 {
        return Err("chapter media: invalid chapter id".to_string());
    }

    let contents_dir = root.join(CONTENTS_ROOT_DIR);
    if !contents_dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut dirs = Vec::new();
    for source_entry in
        fs::read_dir(&contents_dir).map_err(|err| format!("chapter media: read contents: {err}"))?
    {
        let source_entry =
            source_entry.map_err(|err| format!("chapter media: read contents entry: {err}"))?;
        let source_dir = source_entry.path();
        if !source_dir.is_dir() {
            continue;
        }
        for novel_entry in fs::read_dir(&source_dir)
            .map_err(|err| format!("chapter media: read source contents: {err}"))?
        {
            let novel_entry =
                novel_entry.map_err(|err| format!("chapter media: read source entry: {err}"))?;
            let novel_dir = novel_entry.path();
            if !novel_dir.is_dir() {
                continue;
            }
            for chapter_entry in fs::read_dir(&novel_dir)
                .map_err(|err| format!("chapter media: read novel contents: {err}"))?
            {
                let chapter_entry = chapter_entry
                    .map_err(|err| format!("chapter media: read novel entry: {err}"))?;
                let chapter_dir = chapter_entry.path();
                if chapter_dir.is_dir() && path_segment_has_id_suffix(&chapter_dir, chapter_id) {
                    dirs.push(chapter_dir);
                }
            }
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn legacy_storage_manifest_path(root: &Path) -> PathBuf {
    root.join(LEGACY_STORAGE_MANIFEST_FILE)
}

fn safe_relative_storage_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Err("chapter media: storage path must be relative".to_string());
    }
    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("chapter media: invalid storage path".to_string()),
        }
    }
    Ok(path)
}

fn relative_storage_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "chapter media: stored chapter path is outside the storage root".to_string())
}

fn validate_chapter_dir_under_storage_root(root: &Path, chapter_dir: &Path) -> Result<(), String> {
    let relative_dir = chapter_dir
        .strip_prefix(root)
        .map_err(|_| "chapter media: chapter path is outside the storage root".to_string())?;
    if relative_dir.as_os_str().is_empty() {
        return Err("chapter media: chapter path is the storage root".to_string());
    }

    let root_metadata =
        fs::metadata(root).map_err(|err| format!("chapter media: inspect storage root: {err}"))?;
    if !root_metadata.is_dir() {
        return Err("chapter media: storage root is not a directory".to_string());
    }

    let mut current_path = root.to_path_buf();
    for component in relative_dir.components() {
        let Component::Normal(segment) = component else {
            return Err("chapter media: invalid chapter storage path".to_string());
        };
        current_path.push(segment);
        let metadata = fs::symlink_metadata(&current_path).map_err(|err| {
            format!(
                "chapter media: inspect chapter storage path '{}': {err}",
                current_path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "chapter media: chapter storage path contains a symbolic link: {}",
                current_path.display()
            ));
        }
        if !metadata.file_type().is_dir() {
            return Err(format!(
                "chapter media: chapter storage path is not a directory: {}",
                current_path.display()
            ));
        }
    }

    let canonical_root = fs::canonicalize(root)
        .map_err(|err| format!("chapter media: resolve storage root: {err}"))?;
    let canonical_chapter = fs::canonicalize(chapter_dir)
        .map_err(|err| format!("chapter media: resolve chapter storage path: {err}"))?;
    if !canonical_chapter.starts_with(&canonical_root) {
        return Err("chapter media: resolved chapter path is outside the storage root".to_string());
    }
    Ok(())
}

fn stored_content_path_in_dir(
    chapter_dir: &Path,
    preferred_file_name: &str,
) -> Result<Option<PathBuf>, String> {
    let mut file_names = vec![preferred_file_name.to_string()];
    for file_name in ["content.html", "content.pdf"] {
        if !file_names.iter().any(|candidate| candidate == file_name) {
            file_names.push(file_name.to_string());
        }
    }

    for file_name in file_names {
        let path = chapter_dir.join(file_name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => return Ok(Some(path)),
            Ok(_) => {
                return Err(format!(
                    "chapter media: stored content path is not a regular file: {}",
                    path.display()
                ));
            }
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                return Err(format!(
                    "chapter media: inspect stored chapter '{}': {err}",
                    path.to_string_lossy()
                ));
            }
        }
    }
    Ok(None)
}

fn inspect_content_chapter_dir(
    root: &Path,
    chapter_dir: &Path,
    preferred_file_name: &str,
) -> Result<Option<ChapterContentInspection>, String> {
    let Some(content_path) = stored_content_path_in_dir(chapter_dir, preferred_file_name)? else {
        return Ok(None);
    };
    let content_metadata = fs::symlink_metadata(&content_path)
        .map_err(|err| format!("chapter media: read stored chapter size: {err}"))?;
    if !content_metadata.file_type().is_file() {
        return Err(format!(
            "chapter media: stored content path is not a regular file: {}",
            content_path.display()
        ));
    }
    let content_bytes = content_metadata.len();
    let media_bytes = match finalize_chapter_media_artifacts(root, chapter_dir)? {
        ChapterMediaFinalization::Incomplete(reason) => {
            log::warn!(
                "[chapter-media] stored chapter is incomplete dir={} reason={reason}",
                chapter_dir.display()
            );
            return Ok(None);
        }
        ChapterMediaFinalization::ManifestMissing => {
            let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
            fs::symlink_metadata(&archive_path)
                .ok()
                .filter(|metadata| metadata.file_type().is_file())
                .map_or(0, |metadata| metadata.len())
        }
        ChapterMediaFinalization::Ready(media_bytes) => media_bytes,
    };
    Ok(Some(ChapterContentInspection {
        status: "present".to_string(),
        content_file: Some(relative_storage_path(root, &content_path)?),
        content_bytes,
        media_bytes,
    }))
}

fn content_chapter_dirs_matching_segments(
    source_dir: &Path,
    novel_identity_suffix: &str,
    chapter_identity_prefix: &str,
) -> Result<Vec<PathBuf>, String> {
    match fs::metadata(&source_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(format!(
                "chapter media: source storage path is not a directory: {}",
                source_dir.display()
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("chapter media: inspect source storage: {err}")),
    }

    let mut matches = Vec::new();
    for novel_entry in
        fs::read_dir(source_dir).map_err(|err| format!("chapter media: read source: {err}"))?
    {
        let novel_entry =
            novel_entry.map_err(|err| format!("chapter media: read source entry: {err}"))?;
        if !novel_entry
            .file_type()
            .map_err(|err| format!("chapter media: read source entry type: {err}"))?
            .is_dir()
            || !novel_entry
                .file_name()
                .to_string_lossy()
                .ends_with(novel_identity_suffix)
        {
            continue;
        }
        for chapter_entry in fs::read_dir(novel_entry.path())
            .map_err(|err| format!("chapter media: read novel storage: {err}"))?
        {
            let chapter_entry =
                chapter_entry.map_err(|err| format!("chapter media: read chapter entry: {err}"))?;
            if chapter_entry
                .file_type()
                .map_err(|err| format!("chapter media: read chapter entry type: {err}"))?
                .is_dir()
                && chapter_entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(chapter_identity_prefix)
            {
                matches.push(chapter_entry.path());
            }
        }
    }
    matches.sort();
    Ok(matches)
}

fn content_chapter_dirs_matching_identity(
    root: &Path,
    source_id: &str,
    novel_id: i64,
    novel_path: &str,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<Vec<PathBuf>, String> {
    content_chapter_dirs_matching_segments(
        &root
            .join(CONTENTS_ROOT_DIR)
            .join(safe_segment(source_id, "source")),
        &format!("-{}", safe_segment(novel_path, &novel_id.to_string())),
        &format!(
            "{}-",
            chapter_number_segment(chapter_number, chapter_position, chapter_id)
        ),
    )
}

fn chapter_content_mirror_inspect_sync(
    app: AppHandle,
    preferred_chapter_dir: String,
    source_dir: String,
    novel_identity_suffix: String,
    chapter_identity_prefix: String,
    preferred_content_file_name: String,
) -> Result<ChapterContentInspection, String> {
    let root = media_root(&app)?;
    let preferred_relative_dir = safe_relative_storage_path(&preferred_chapter_dir)?;
    let source_relative_dir = safe_relative_storage_path(&source_dir)?;
    let preferred_file_name = Path::new(&preferred_content_file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "chapter media: invalid preferred content file name".to_string())?;

    if let Some(inspection) = inspect_content_chapter_dir(
        &root,
        &root.join(&preferred_relative_dir),
        preferred_file_name,
    )? {
        return Ok(inspection);
    }

    let mut matches = Vec::new();
    for chapter_path in content_chapter_dirs_matching_segments(
        &root.join(source_relative_dir),
        &novel_identity_suffix,
        &chapter_identity_prefix,
    )? {
        if let Some(inspection) =
            inspect_content_chapter_dir(&root, &chapter_path, preferred_file_name)?
        {
            matches.push(inspection);
        }
    }

    match matches.len() {
        0 => Ok(ChapterContentInspection {
            status: "missing".to_string(),
            content_file: None,
            content_bytes: 0,
            media_bytes: 0,
        }),
        1 => Ok(matches.remove(0)),
        _ => Err(format!(
            "chapter media: multiple stored chapter folders match source identity {chapter_identity_prefix}"
        )),
    }
}

fn chapter_content_extension(content_type: Option<&str>) -> &'static str {
    match content_type {
        Some("pdf") => "pdf",
        Some("markdown") => "html",
        Some("epub") => "html",
        _ => "html",
    }
}

fn chapter_content_relative_path(
    source_id: &str,
    novel_id: i64,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
    extension: &str,
) -> Result<String, String> {
    Ok(format!(
        "{}/content.{extension}",
        content_chapter_relative_dir(
            source_id,
            novel_id,
            novel_path,
            novel_name,
            chapter_id,
            chapter_number,
            chapter_name,
            chapter_position,
        )?
    ))
}

fn chapter_archives_in_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut archives = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| format!("chapter media: read dir: {err}"))? {
        let entry = entry.map_err(|err| format!("chapter media: read entry: {err}"))?;
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            archives.push(path);
        }
    }
    archives.sort();
    Ok(archives)
}

fn clear_content_media_artifacts(chapter_dir: &Path) -> Result<(), String> {
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    if media_dir.exists() {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
    }
    for archive_path in chapter_archives_in_dir(chapter_dir)? {
        fs::remove_file(&archive_path)
            .map_err(|err| format!("chapter media: remove media archive: {err}"))?;
    }
    remove_known_publication_file(
        &chapter_dir.join(MEDIA_ARCHIVE_FILE),
        "chapter media: remove media archive",
    )?;
    remove_stale_chapter_media_archive_publication_files(chapter_dir)?;
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    remove_known_publication_file(&manifest_path, "chapter media: remove media manifest")?;
    remove_stale_chapter_media_manifest_publication_files(chapter_dir)?;
    Ok(())
}

fn archive_backup_path(archive_path: &Path) -> PathBuf {
    archive_path.with_file_name(format!("{MEDIA_ARCHIVE_FILE}.bak"))
}

fn archive_rollback_path(archive_path: &Path) -> PathBuf {
    archive_path.with_file_name(format!("{MEDIA_ARCHIVE_FILE}.rollback"))
}

fn replace_storage_file(
    temp_path: &Path,
    final_path: &Path,
    backup_path: &Path,
    context: &str,
) -> Result<(), String> {
    if backup_path.exists() {
        fs::remove_file(backup_path)
            .map_err(|err| format!("{context}: remove stale backup: {err}"))?;
    }
    let had_final = final_path.exists();
    if had_final {
        fs::rename(final_path, backup_path)
            .map_err(|err| format!("{context}: backup existing file: {err}"))?;
    }
    if let Err(err) = fs::rename(temp_path, final_path) {
        if had_final {
            let _ = fs::rename(backup_path, final_path);
        }
        return Err(format!("{context}: publish file: {err}"));
    }
    if backup_path.exists() {
        fs::remove_file(backup_path).map_err(|err| format!("{context}: remove backup: {err}"))?;
    }
    Ok(())
}

fn publication_file_exists(path: &Path, context: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err(format!("{context}: publication path is not a regular file")),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("{context}: inspect publication path: {err}")),
    }
}

fn remove_known_publication_file(path: &Path, context: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(path).map_err(|err| format!("{context}: {err}"))
        }
        Ok(_) => Err(format!("{context}: path is not a regular file")),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("{context}: inspect path: {err}")),
    }
}

fn create_publication_temp_file(path: &Path, context: &str) -> Result<File, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(path)
                .map_err(|err| format!("{context}: remove stale temp publication file: {err}"))?;
        }
        Ok(_) => {
            return Err(format!(
                "{context}: temp publication path is not a regular file"
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(format!("{context}: inspect temp publication path: {err}")),
    }
    File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| format!("{context}: create temp publication file: {err}"))
}

fn replace_file_preserving_recovery_backup(
    temp_path: &Path,
    final_path: &Path,
    backup_path: &Path,
    rollback_path: &Path,
    context: &str,
) -> Result<(), String> {
    match fs::symlink_metadata(temp_path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Err(format!(
                "{context}: temp publication path is not a regular file"
            ))
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Err(format!("{context}: temp publication file is missing"));
        }
        Err(err) => return Err(format!("{context}: inspect temp publication file: {err}")),
    }

    let had_final = publication_file_exists(final_path, context)?;
    let had_recovery_backup = publication_file_exists(backup_path, context)?;
    let had_rollback = publication_file_exists(rollback_path, context)?;
    let active_rollback_path = if had_recovery_backup {
        rollback_path
    } else {
        backup_path
    };
    let active_rollback_exists = (active_rollback_path == backup_path && had_recovery_backup)
        || (active_rollback_path == rollback_path && had_rollback);
    let mut final_was_staged = false;
    if had_final {
        if active_rollback_exists {
            fs::remove_file(final_path)
                .map_err(|err| format!("{context}: remove current file before publish: {err}"))?;
        } else {
            fs::rename(final_path, active_rollback_path)
                .map_err(|err| format!("{context}: move current file to rollback: {err}"))?;
            final_was_staged = true;
        }
    }

    if let Err(publish_error) = fs::rename(temp_path, final_path) {
        if final_was_staged {
            if let Err(restore_error) = fs::rename(active_rollback_path, final_path) {
                return Err(format!(
                    "{context}: publish file: {publish_error}; restore current file: {restore_error}"
                ));
            }
        }
        return Err(format!("{context}: publish file: {publish_error}"));
    }

    for stale_path in [backup_path, rollback_path] {
        remove_known_publication_file(stale_path, context)?;
    }
    Ok(())
}

fn replace_media_archive(temp_archive_path: &Path, archive_path: &Path) -> Result<(), String> {
    let backup_path = archive_backup_path(archive_path);
    replace_file_preserving_recovery_backup(
        temp_archive_path,
        archive_path,
        &backup_path,
        &archive_rollback_path(archive_path),
        "chapter media: publish media archive",
    )
}

fn chapter_media_archive_publication_paths(chapter_dir: &Path) -> [PathBuf; 3] {
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    [
        chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp")),
        archive_backup_path(&archive_path),
        archive_rollback_path(&archive_path),
    ]
}

fn remove_stale_chapter_media_archive_publication_files(chapter_dir: &Path) -> Result<(), String> {
    for path in chapter_media_archive_publication_paths(chapter_dir) {
        remove_known_publication_file(
            &path,
            "chapter media: remove stale media archive publication file",
        )?;
    }
    Ok(())
}

fn chapter_media_manifest_path(chapter_dir: &Path) -> PathBuf {
    chapter_dir.join(CHAPTER_MEDIA_MANIFEST_FILE)
}

fn chapter_media_manifest_backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn chapter_media_manifest_rollback_path(path: &Path) -> PathBuf {
    path.with_extension("json.rollback")
}

fn chapter_media_manifest_publication_paths(chapter_dir: &Path) -> [PathBuf; 3] {
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    [
        manifest_path.with_extension("json.tmp"),
        chapter_media_manifest_backup_path(&manifest_path),
        chapter_media_manifest_rollback_path(&manifest_path),
    ]
}

fn remove_stale_chapter_media_manifest_publication_files(chapter_dir: &Path) -> Result<(), String> {
    for path in chapter_media_manifest_publication_paths(chapter_dir) {
        remove_known_publication_file(
            &path,
            "chapter media: remove stale media manifest publication file",
        )?;
    }
    Ok(())
}

fn write_chapter_media_manifest(path: &Path, manifest: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("chapter media: create media manifest dir: {err}"))?;
    }
    let mut body = serde_json::to_vec_pretty(manifest)
        .map_err(|err| format!("chapter media: encode media manifest: {err}"))?;
    body.push(b'\n');
    let temp_path = path.with_extension("json.tmp");
    let mut temp_file =
        create_publication_temp_file(&temp_path, "chapter media: write media manifest")?;
    temp_file
        .write_all(&body)
        .map_err(|err| format!("chapter media: write media manifest temp: {err}"))?;
    temp_file
        .flush()
        .map_err(|err| format!("chapter media: flush media manifest temp: {err}"))?;
    drop(temp_file);

    let backup_path = chapter_media_manifest_backup_path(path);
    replace_file_preserving_recovery_backup(
        &temp_path,
        path,
        &backup_path,
        &chapter_media_manifest_rollback_path(path),
        "chapter media: publish media manifest",
    )
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterMediaArchiveManifest {
    complete: bool,
    media: ChapterMediaArchiveManifestMedia,
    #[serde(rename = "updatedAt")]
    _updated_at: u64,
    version: u64,
}

#[derive(Debug, serde::Deserialize)]
struct ChapterMediaArchiveManifestMedia {
    files: Vec<ChapterMediaArchiveManifestFile>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterMediaArchiveManifestFile {
    bytes: u64,
    #[serde(rename = "contentType")]
    _content_type: Option<String>,
    file_name: String,
    path: String,
    #[serde(rename = "sourceUrl")]
    _source_url: String,
    status: ChapterMediaArchiveManifestFileStatus,
    #[serde(rename = "updatedAt")]
    _updated_at: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChapterMediaArchiveManifestFileStatus {
    Remote,
    Stored,
}

#[derive(Debug)]
struct ExpectedStoredChapterMedia {
    bytes: u64,
    file_name: String,
}

#[derive(Debug)]
struct ValidChapterMediaArchiveManifest {
    complete: bool,
    raw: serde_json::Value,
    stored_files: Vec<ExpectedStoredChapterMedia>,
}

#[derive(Debug)]
enum ChapterMediaArchiveManifestState {
    Invalid(String),
    Missing,
    Valid(ValidChapterMediaArchiveManifest),
}

#[derive(Debug)]
enum ChapterMediaArtifactState {
    Invalid(String),
    Missing,
    Valid(HashSet<String>),
}

#[derive(Debug)]
enum ChapterMediaFinalization {
    Incomplete(String),
    ManifestMissing,
    Ready(u64),
}

fn is_safe_manifest_media_file_name(file_name: &str) -> bool {
    safe_media_relative_path(file_name).is_ok()
        && matches!(
            Path::new(file_name)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [Component::Normal(_)]
        )
}

fn parse_chapter_media_archive_manifest(
    raw: &str,
) -> Result<ValidChapterMediaArchiveManifest, String> {
    let raw_value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(err) => return Err(format!("invalid manifest JSON: {err}")),
    };
    let manifest = match serde_json::from_value::<ChapterMediaArchiveManifest>(raw_value.clone()) {
        Ok(manifest) => manifest,
        Err(err) => return Err(format!("invalid manifest schema: {err}")),
    };
    if manifest.version != 1 {
        return Err(format!("unsupported manifest version {}", manifest.version));
    }

    let mut stored_file_names = HashSet::new();
    let mut stored_files = Vec::new();
    for file in manifest.media.files {
        if !matches!(file.status, ChapterMediaArchiveManifestFileStatus::Stored) {
            continue;
        }
        if !is_safe_manifest_media_file_name(&file.file_name)
            || file.file_name.to_ascii_lowercase().ends_with(".part")
            || file.path != format!("{MEDIA_DOWNLOAD_DIR}/{}", file.file_name)
        {
            return Err(format!("invalid stored media path '{}'", file.path));
        }
        if !stored_file_names.insert(file.file_name.clone()) {
            return Err(format!("duplicate stored media file '{}'", file.file_name));
        }
        stored_files.push(ExpectedStoredChapterMedia {
            bytes: file.bytes,
            file_name: file.file_name,
        });
    }
    stored_files.sort_by(|left, right| left.file_name.cmp(&right.file_name));

    Ok(ValidChapterMediaArchiveManifest {
        complete: manifest.complete,
        raw: raw_value,
        stored_files,
    })
}

fn read_chapter_media_archive_manifest_at(
    manifest_path: &Path,
) -> Result<ChapterMediaArchiveManifestState, String> {
    match fs::symlink_metadata(manifest_path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Ok(ChapterMediaArchiveManifestState::Invalid(format!(
                "manifest candidate '{}' is not a regular file",
                manifest_path.display()
            )));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(ChapterMediaArchiveManifestState::Missing);
        }
        Err(err) => return Err(format!("chapter media: inspect media manifest: {err}")),
    }
    let raw = fs::read_to_string(manifest_path)
        .map_err(|err| format!("chapter media: read media manifest: {err}"))?;
    Ok(match parse_chapter_media_archive_manifest(&raw) {
        Ok(manifest) => ChapterMediaArchiveManifestState::Valid(manifest),
        Err(reason) => ChapterMediaArchiveManifestState::Invalid(reason),
    })
}

fn read_chapter_media_archive_manifest(
    chapter_dir: &Path,
) -> Result<ChapterMediaArchiveManifestState, String> {
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    let manifest = read_chapter_media_archive_manifest_at(&manifest_path)?;
    let final_was_missing = matches!(&manifest, ChapterMediaArchiveManifestState::Missing);
    let mut invalid_candidates = Vec::new();
    let final_manifest = match manifest {
        ChapterMediaArchiveManifestState::Valid(manifest) => Some(manifest),
        ChapterMediaArchiveManifestState::Invalid(reason) => {
            invalid_candidates.push(format!("final manifest: {reason}"));
            None
        }
        ChapterMediaArchiveManifestState::Missing => None,
    };
    let temp_path = manifest_path.with_extension("json.tmp");
    match read_chapter_media_archive_manifest_at(&temp_path)? {
        ChapterMediaArchiveManifestState::Invalid(reason) => {
            invalid_candidates.push(format!("{}: {reason}", temp_path.display()));
        }
        ChapterMediaArchiveManifestState::Missing => {}
        ChapterMediaArchiveManifestState::Valid(temp_manifest) => {
            replace_file_preserving_recovery_backup(
                &temp_path,
                &manifest_path,
                &chapter_media_manifest_backup_path(&manifest_path),
                &chapter_media_manifest_rollback_path(&manifest_path),
                "chapter media: recover media manifest publication",
            )?;
            return Ok(ChapterMediaArchiveManifestState::Valid(temp_manifest));
        }
    }
    if let Some(manifest) = final_manifest {
        return Ok(ChapterMediaArchiveManifestState::Valid(manifest));
    }

    let candidate_paths = [
        chapter_media_manifest_backup_path(&manifest_path),
        chapter_media_manifest_rollback_path(&manifest_path),
    ];
    for candidate_path in candidate_paths {
        match read_chapter_media_archive_manifest_at(&candidate_path)? {
            ChapterMediaArchiveManifestState::Invalid(reason) => {
                invalid_candidates.push(format!("{}: {reason}", candidate_path.display()));
            }
            ChapterMediaArchiveManifestState::Missing => {}
            ChapterMediaArchiveManifestState::Valid(manifest) => {
                write_chapter_media_manifest(&manifest_path, &manifest.raw)?;
                return Ok(ChapterMediaArchiveManifestState::Valid(manifest));
            }
        }
    }
    if final_was_missing && invalid_candidates.is_empty() {
        Ok(ChapterMediaArchiveManifestState::Missing)
    } else {
        Ok(ChapterMediaArchiveManifestState::Invalid(format!(
            "interrupted manifest publication has no valid candidate: {}",
            invalid_candidates.join("; ")
        )))
    }
}

fn expected_stored_media_by_name(
    stored_files: &[ExpectedStoredChapterMedia],
) -> HashMap<&str, u64> {
    stored_files
        .iter()
        .map(|file| (file.file_name.as_str(), file.bytes))
        .collect()
}

fn validate_loose_chapter_media(
    media_dir: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
) -> Result<ChapterMediaArtifactState, String> {
    match fs::symlink_metadata(media_dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "loose media path is not a directory".to_string(),
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(ChapterMediaArtifactState::Missing);
        }
        Err(err) => return Err(format!("chapter media: inspect loose media dir: {err}")),
    }

    let expected = expected_stored_media_by_name(stored_files);
    let mut found = HashSet::new();
    for entry in fs::read_dir(media_dir)
        .map_err(|err| format!("chapter media: read loose media dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read loose media entry: {err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("chapter media: read loose media entry type: {err}"))?;
        let file_name = match entry.file_name().into_string() {
            Ok(file_name) => file_name,
            Err(_) => {
                return Ok(ChapterMediaArtifactState::Invalid(
                    "loose media contains a non-Unicode entry name".to_string(),
                ));
            }
        };
        if !file_type.is_file() {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "loose media entry '{file_name}' is not a regular file"
            )));
        }
        let Some(expected_bytes) = expected.get(file_name.as_str()) else {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "unexpected loose media file '{file_name}'"
            )));
        };
        let actual_bytes = entry
            .metadata()
            .map_err(|err| format!("chapter media: read loose media file metadata: {err}"))?
            .len();
        if actual_bytes != *expected_bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "loose media file '{file_name}' has {actual_bytes} bytes, expected {expected_bytes}"
            )));
        }
        if !found.insert(file_name) {
            return Ok(ChapterMediaArtifactState::Invalid(
                "loose media contains duplicate file names".to_string(),
            ));
        }
    }

    Ok(ChapterMediaArtifactState::Valid(found))
}

fn completed_manifest_media_bytes(
    chapter_dir: &Path,
    manifest: &ValidChapterMediaArchiveManifest,
) -> Result<Option<u64>, String> {
    if !manifest.complete {
        return Ok(None);
    }

    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    match fs::symlink_metadata(&media_dir) {
        Ok(_) => return Ok(None),
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(format!("chapter media: inspect loose media dir: {err}")),
    }
    for path in chapter_media_archive_publication_paths(chapter_dir)
        .into_iter()
        .chain(chapter_media_manifest_publication_paths(chapter_dir))
    {
        match fs::symlink_metadata(&path) {
            Ok(_) => return Ok(None),
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "chapter media: inspect media publication file: {err}"
                ));
            }
        }
    }

    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    if manifest.stored_files.is_empty() {
        return match fs::symlink_metadata(&archive_path) {
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(Some(0)),
            Err(err) => Err(format!("chapter media: inspect media archive: {err}")),
            Ok(_) => Ok(None),
        };
    }

    match fs::symlink_metadata(&archive_path) {
        Ok(metadata) if metadata.file_type().is_file() && metadata.len() > 0 => {
            Ok(Some(metadata.len()))
        }
        Ok(_) => Ok(None),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: inspect media archive: {err}")),
    }
}

fn validate_chapter_media_archive(
    archive_path: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
) -> Result<ChapterMediaArtifactState, String> {
    match fs::symlink_metadata(archive_path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "media archive path is not a regular file".to_string(),
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(ChapterMediaArtifactState::Missing);
        }
        Err(err) => return Err(format!("chapter media: inspect media archive: {err}")),
    }

    let archive_file = File::open(archive_path)
        .map_err(|err| format!("chapter media: open media archive: {err}"))?;
    let mut archive = match ZipArchive::new(BufReader::new(archive_file)) {
        Ok(archive) => archive,
        Err(err) => {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "invalid media archive: {err}"
            )));
        }
    };
    let expected = expected_stored_media_by_name(stored_files);
    let mut found = HashSet::new();

    for index in 0..archive.len() {
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(err) => {
                return Ok(ChapterMediaArtifactState::Invalid(format!(
                    "invalid media archive entry: {err}"
                )));
            }
        };
        let file_name = entry.name().to_string();
        if !entry.is_file() || !is_safe_manifest_media_file_name(&file_name) {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "invalid media archive entry '{file_name}'"
            )));
        }
        let Some(expected_bytes) = expected.get(file_name.as_str()) else {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "unexpected media archive entry '{file_name}'"
            )));
        };
        if !found.insert(file_name.clone()) {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "duplicate media archive entry '{file_name}'"
            )));
        }
        if entry.size() != *expected_bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "media archive entry '{file_name}' has {} bytes, expected {expected_bytes}",
                entry.size()
            )));
        }

        let mut sink = io::sink();
        let actual_bytes = match io::copy(&mut entry, &mut sink) {
            Ok(bytes) => bytes,
            Err(err) => {
                return Ok(ChapterMediaArtifactState::Invalid(format!(
                    "cannot read media archive entry '{file_name}': {err}"
                )));
            }
        };
        if actual_bytes != *expected_bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "media archive entry '{file_name}' read {actual_bytes} bytes, expected {expected_bytes}"
            )));
        }
    }

    Ok(ChapterMediaArtifactState::Valid(found))
}

fn stored_media_sources_cover_manifest(
    stored_files: &[ExpectedStoredChapterMedia],
    loose_file_names: &HashSet<String>,
    archive_file_names: &HashSet<String>,
) -> bool {
    stored_files.iter().all(|file| {
        loose_file_names.contains(&file.file_name) || archive_file_names.contains(&file.file_name)
    })
}

fn recover_chapter_media_archive_source(
    chapter_dir: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
    loose_file_names: &HashSet<String>,
) -> Result<(ChapterMediaArtifactState, PathBuf), String> {
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let [temp_archive_path, backup_archive_path, rollback_archive_path] =
        chapter_media_archive_publication_paths(chapter_dir);
    let archive_state = validate_chapter_media_archive(&archive_path, stored_files)?;
    if matches!(&archive_state, ChapterMediaArtifactState::Valid(file_names)
        if stored_media_sources_cover_manifest(stored_files, loose_file_names, file_names))
    {
        return Ok((archive_state, archive_path));
    }

    let temp_state = validate_chapter_media_archive(&temp_archive_path, stored_files)?;

    let temp_issue = match temp_state {
        ChapterMediaArtifactState::Valid(file_names) => {
            if file_names.len() == stored_files.len() {
                replace_media_archive(&temp_archive_path, &archive_path)?;
                return Ok((ChapterMediaArtifactState::Valid(file_names), archive_path));
            }
            Some("interrupted media archive temp is incomplete".to_string())
        }
        ChapterMediaArtifactState::Invalid(reason) => Some(reason),
        ChapterMediaArtifactState::Missing => None,
    };

    let backup_state = validate_chapter_media_archive(&backup_archive_path, stored_files)?;
    if matches!(&backup_state, ChapterMediaArtifactState::Valid(file_names)
        if stored_media_sources_cover_manifest(stored_files, loose_file_names, file_names))
    {
        return Ok((backup_state, backup_archive_path));
    }

    let rollback_state = validate_chapter_media_archive(&rollback_archive_path, stored_files)?;
    if matches!(&rollback_state, ChapterMediaArtifactState::Valid(file_names)
        if stored_media_sources_cover_manifest(stored_files, loose_file_names, file_names))
    {
        return Ok((rollback_state, rollback_archive_path));
    }

    if matches!(&archive_state, ChapterMediaArtifactState::Valid(_)) {
        return Ok((archive_state, archive_path));
    }
    if matches!(&backup_state, ChapterMediaArtifactState::Valid(_)) {
        return Ok((backup_state, backup_archive_path));
    }
    if matches!(&rollback_state, ChapterMediaArtifactState::Valid(_)) {
        return Ok((rollback_state, rollback_archive_path));
    }
    if matches!(&archive_state, ChapterMediaArtifactState::Invalid(_)) {
        return Ok((archive_state, archive_path));
    }
    if matches!(&backup_state, ChapterMediaArtifactState::Invalid(_)) {
        return Ok((backup_state, backup_archive_path));
    }
    if matches!(&rollback_state, ChapterMediaArtifactState::Invalid(_)) {
        return Ok((rollback_state, rollback_archive_path));
    }
    if let Some(reason) = temp_issue {
        return Ok((
            ChapterMediaArtifactState::Invalid(reason),
            temp_archive_path,
        ));
    }

    Ok((archive_state, archive_path))
}

fn build_validated_chapter_media_archive(
    chapter_dir: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
    loose_file_names: &HashSet<String>,
    archive_file_names: &HashSet<String>,
    archive_source_path: &Path,
) -> Result<ChapterMediaArtifactState, String> {
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let temp_archive_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    let needs_existing_archive = stored_files
        .iter()
        .any(|file| !loose_file_names.contains(&file.file_name));
    let mut existing_archive = if needs_existing_archive {
        let archive_file = File::open(archive_source_path)
            .map_err(|err| format!("chapter media: reopen media archive: {err}"))?;
        Some(
            ZipArchive::new(BufReader::new(archive_file))
                .map_err(|err| format!("chapter media: reopen media archive: {err}"))?,
        )
    } else {
        None
    };
    let temp_file =
        create_publication_temp_file(&temp_archive_path, "chapter media: create media archive")?;
    let mut archive = ZipWriter::new(BufWriter::new(temp_file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for file in stored_files {
        archive
            .start_file(&file.file_name, options)
            .map_err(|err| format!("chapter media: start media archive entry: {err}"))?;
        let written_bytes = if loose_file_names.contains(&file.file_name) {
            let path = media_dir.join(&file.file_name);
            let mut input = File::open(&path)
                .map_err(|err| format!("chapter media: open loose media file: {err}"))?;
            io::copy(&mut input, &mut archive)
                .map_err(|err| format!("chapter media: write loose media archive entry: {err}"))?
        } else if archive_file_names.contains(&file.file_name) {
            let Some(existing_archive) = existing_archive.as_mut() else {
                return Ok(ChapterMediaArtifactState::Invalid(format!(
                    "media archive source '{}' is unavailable",
                    file.file_name
                )));
            };
            let mut input = match existing_archive.by_name(&file.file_name) {
                Ok(input) => input,
                Err(err) => {
                    return Ok(ChapterMediaArtifactState::Invalid(format!(
                        "cannot reopen media archive entry '{}': {err}",
                        file.file_name
                    )));
                }
            };
            io::copy(&mut input, &mut archive)
                .map_err(|err| format!("chapter media: copy existing media archive entry: {err}"))?
        } else {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "stored media source '{}' is missing",
                file.file_name
            )));
        };
        if written_bytes != file.bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "media file '{}' changed while archiving",
                file.file_name
            )));
        }
    }
    drop(existing_archive);

    let mut output = archive
        .finish()
        .map_err(|err| format!("chapter media: finalize media archive: {err}"))?;
    output
        .flush()
        .map_err(|err| format!("chapter media: flush media archive: {err}"))?;
    drop(output);

    match validate_chapter_media_archive(&temp_archive_path, stored_files)? {
        ChapterMediaArtifactState::Valid(file_names) if file_names.len() == stored_files.len() => {}
        ChapterMediaArtifactState::Valid(_) => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "created media archive is incomplete".to_string(),
            ));
        }
        ChapterMediaArtifactState::Invalid(reason) => {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "created media archive failed validation: {reason}"
            )));
        }
        ChapterMediaArtifactState::Missing => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "created media archive is missing".to_string(),
            ));
        }
    }
    replace_media_archive(&temp_archive_path, &archive_path)?;
    Ok(ChapterMediaArtifactState::Valid(
        stored_files
            .iter()
            .map(|file| file.file_name.clone())
            .collect(),
    ))
}

fn mark_chapter_media_manifest_complete(
    chapter_dir: &Path,
    manifest: &mut ValidChapterMediaArchiveManifest,
) -> Result<(), String> {
    let Some(manifest_object) = manifest.raw.as_object_mut() else {
        return Err("chapter media: media manifest root is not an object".to_string());
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    manifest_object.insert("complete".to_string(), serde_json::Value::Bool(true));
    manifest_object.insert(
        "updatedAt".to_string(),
        serde_json::Value::Number(now.into()),
    );
    write_chapter_media_manifest(&chapter_media_manifest_path(chapter_dir), &manifest.raw)
}

fn chapter_media_finalization_lock(chapter_dir: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

    let canonical_chapter = fs::canonicalize(chapter_dir)
        .map_err(|err| format!("chapter media: resolve finalization path: {err}"))?;
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&canonical_chapter).and_then(Weak::upgrade) {
        return Ok(lock);
    }

    let lock = Arc::new(Mutex::new(()));
    locks.insert(canonical_chapter, Arc::downgrade(&lock));
    Ok(lock)
}

fn finalize_chapter_media_artifacts(
    root: &Path,
    chapter_dir: &Path,
) -> Result<ChapterMediaFinalization, String> {
    validate_chapter_dir_under_storage_root(root, chapter_dir)?;
    let finalization_lock = chapter_media_finalization_lock(chapter_dir)?;
    let _finalization_guard = finalization_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    finalize_chapter_media_artifacts_locked(chapter_dir)
}

fn finalize_chapter_media_artifacts_locked(
    chapter_dir: &Path,
) -> Result<ChapterMediaFinalization, String> {
    let mut manifest = match read_chapter_media_archive_manifest(chapter_dir)? {
        ChapterMediaArchiveManifestState::Invalid(reason) => {
            return Ok(ChapterMediaFinalization::Incomplete(reason));
        }
        ChapterMediaArchiveManifestState::Missing => {
            return Ok(ChapterMediaFinalization::ManifestMissing);
        }
        ChapterMediaArchiveManifestState::Valid(manifest) => manifest,
    };

    if let Some(media_bytes) = completed_manifest_media_bytes(chapter_dir, &manifest)? {
        return Ok(ChapterMediaFinalization::Ready(media_bytes));
    }

    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let loose_state = validate_loose_chapter_media(&media_dir, &manifest.stored_files)?;

    if let ChapterMediaArtifactState::Invalid(reason) = &loose_state {
        return Ok(ChapterMediaFinalization::Incomplete(reason.clone()));
    }
    let empty_file_names = HashSet::new();
    let loose_file_names = match &loose_state {
        ChapterMediaArtifactState::Valid(file_names) => file_names,
        ChapterMediaArtifactState::Invalid(reason) => {
            return Ok(ChapterMediaFinalization::Incomplete(reason.clone()));
        }
        ChapterMediaArtifactState::Missing => &empty_file_names,
    };
    let (archive_state, archive_source_path) = recover_chapter_media_archive_source(
        chapter_dir,
        &manifest.stored_files,
        loose_file_names,
    )?;

    if manifest.stored_files.is_empty() {
        if let ChapterMediaArtifactState::Invalid(reason) = &archive_state {
            return Ok(ChapterMediaFinalization::Incomplete(reason.clone()));
        }
        if matches!(&archive_state, ChapterMediaArtifactState::Valid(_)) {
            if archive_source_path != archive_path {
                let empty_file_names = HashSet::new();
                match build_validated_chapter_media_archive(
                    chapter_dir,
                    &manifest.stored_files,
                    &empty_file_names,
                    &empty_file_names,
                    &archive_source_path,
                )? {
                    ChapterMediaArtifactState::Valid(_) => {}
                    ChapterMediaArtifactState::Invalid(reason) => {
                        return Ok(ChapterMediaFinalization::Incomplete(reason));
                    }
                    ChapterMediaArtifactState::Missing => {
                        return Ok(ChapterMediaFinalization::Incomplete(
                            "created empty media archive is missing".to_string(),
                        ));
                    }
                }
            }
            match validate_chapter_media_archive(&archive_path, &manifest.stored_files)? {
                ChapterMediaArtifactState::Valid(file_names) if file_names.is_empty() => {}
                ChapterMediaArtifactState::Valid(_) => {
                    return Ok(ChapterMediaFinalization::Incomplete(
                        "published empty media archive contains stored entries".to_string(),
                    ));
                }
                ChapterMediaArtifactState::Invalid(reason) => {
                    return Ok(ChapterMediaFinalization::Incomplete(reason));
                }
                ChapterMediaArtifactState::Missing => {
                    return Ok(ChapterMediaFinalization::Incomplete(
                        "published empty media archive is missing".to_string(),
                    ));
                }
            }
            fs::remove_file(&archive_path)
                .map_err(|err| format!("chapter media: remove empty media archive: {err}"))?;
        }
        remove_stale_chapter_media_archive_publication_files(chapter_dir)?;
        remove_stale_chapter_media_manifest_publication_files(chapter_dir)?;
        if matches!(&loose_state, ChapterMediaArtifactState::Valid(_)) {
            fs::remove_dir_all(&media_dir)
                .map_err(|err| format!("chapter media: remove empty loose media dir: {err}"))?;
        }
        mark_chapter_media_manifest_complete(chapter_dir, &mut manifest)?;
        return Ok(ChapterMediaFinalization::Ready(0));
    }

    let archive_file_names = match &archive_state {
        ChapterMediaArtifactState::Valid(file_names) => file_names,
        ChapterMediaArtifactState::Invalid(_) | ChapterMediaArtifactState::Missing => {
            &empty_file_names
        }
    };
    let missing_file = manifest.stored_files.iter().find(|file| {
        !loose_file_names.contains(&file.file_name) && !archive_file_names.contains(&file.file_name)
    });
    if let Some(missing_file) = missing_file {
        let archive_reason = match &archive_state {
            ChapterMediaArtifactState::Invalid(reason) => format!("; {reason}"),
            _ => String::new(),
        };
        return Ok(ChapterMediaFinalization::Incomplete(format!(
            "stored media source '{}' is missing{archive_reason}",
            missing_file.file_name
        )));
    }

    let archive_is_published_and_complete = archive_source_path == archive_path
        && archive_file_names.len() == manifest.stored_files.len()
        && loose_file_names.is_empty();
    if !archive_is_published_and_complete {
        match build_validated_chapter_media_archive(
            chapter_dir,
            &manifest.stored_files,
            loose_file_names,
            archive_file_names,
            &archive_source_path,
        )? {
            ChapterMediaArtifactState::Valid(_) => {}
            ChapterMediaArtifactState::Invalid(reason) => {
                return Ok(ChapterMediaFinalization::Incomplete(reason));
            }
            ChapterMediaArtifactState::Missing => {
                return Ok(ChapterMediaFinalization::Incomplete(
                    "created media archive is missing".to_string(),
                ));
            }
        }
    }

    let media_bytes = match validate_chapter_media_archive(&archive_path, &manifest.stored_files)? {
        ChapterMediaArtifactState::Valid(file_names)
            if file_names.len() == manifest.stored_files.len() =>
        {
            fs::symlink_metadata(&archive_path)
                .map_err(|err| format!("chapter media: inspect published media archive: {err}"))?
                .len()
        }
        ChapterMediaArtifactState::Valid(_) => {
            return Ok(ChapterMediaFinalization::Incomplete(
                "published media archive is incomplete".to_string(),
            ));
        }
        ChapterMediaArtifactState::Invalid(reason) => {
            return Ok(ChapterMediaFinalization::Incomplete(reason));
        }
        ChapterMediaArtifactState::Missing => {
            return Ok(ChapterMediaFinalization::Incomplete(
                "published media archive is missing".to_string(),
            ));
        }
    };
    remove_stale_chapter_media_archive_publication_files(chapter_dir)?;
    remove_stale_chapter_media_manifest_publication_files(chapter_dir)?;
    if matches!(&loose_state, ChapterMediaArtifactState::Valid(_)) {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove loose media dir: {err}"))?;
    }
    mark_chapter_media_manifest_complete(chapter_dir, &mut manifest)?;
    Ok(ChapterMediaFinalization::Ready(media_bytes))
}

fn delete_legacy_storage_manifest(root: &Path) -> Result<(), String> {
    let manifest_path = legacy_storage_manifest_path(root);
    if manifest_path.exists() {
        fs::remove_file(&manifest_path)
            .map_err(|err| format!("chapter media: remove legacy storage manifest: {err}"))?;
    }
    Ok(())
}

fn remove_chapter_content_files_in_dir(
    chapter_dir: &Path,
    keep_path: Option<&Path>,
) -> Result<(), String> {
    if !chapter_dir.is_dir() {
        return Ok(());
    }
    for entry in
        fs::read_dir(chapter_dir).map_err(|err| format!("chapter media: read dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read entry: {err}"))?;
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value == CHAPTER_PARTIAL_CONTENT_FILE)
        {
            fs::remove_file(path)
                .map_err(|err| format!("chapter media: remove partial content: {err}"))?;
            continue;
        }
        if keep_path.is_some_and(|keep_path| path == keep_path) {
            continue;
        }
        if path.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| {
                    ["html", "txt", "pdf", "epub"]
                        .iter()
                        .any(|extension| value.eq_ignore_ascii_case(extension))
                })
            && path
                .file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value == "content" || value.starts_with("chapter"))
        {
            fs::remove_file(path)
                .map_err(|err| format!("chapter media: remove content mirror: {err}"))?;
        }
    }
    Ok(())
}

fn remove_stored_chapter_content_files(
    root: &Path,
    chapter_id: i64,
    keep_path: Option<&Path>,
) -> Result<(), String> {
    for chapter_dir in content_chapter_dirs_for_lookup(root, chapter_id)? {
        remove_chapter_content_files_in_dir(&chapter_dir, keep_path)?;
    }
    Ok(())
}

#[derive(Debug)]
struct ParsedMediaSrc {
    file_name: String,
}

fn parse_media_src(media_src: &str) -> Result<ParsedMediaSrc, String> {
    let payload = media_src
        .strip_prefix(MEDIA_URI_PREFIX)
        .ok_or_else(|| "chapter media: unsupported media uri".to_string())?;
    Ok(ParsedMediaSrc {
        file_name: safe_media_relative_path(payload)?,
    })
}

fn media_src_chapter_id(context_chapter_id: Option<i64>) -> Result<i64, String> {
    let chapter_id = context_chapter_id
        .ok_or_else(|| "chapter media: missing chapter id context".to_string())?;
    if chapter_id <= 0 {
        return Err("chapter media: chapter id must be positive".to_string());
    }
    Ok(chapter_id)
}

fn content_chapter_dir_from_context(
    root: &Path,
    novel_id: Option<i64>,
    source_id: Option<&str>,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<Option<PathBuf>, String> {
    let Some(novel_id) = novel_id else {
        return Ok(None);
    };
    let Some(source_id) = source_id else {
        return Ok(None);
    };
    let Some(novel_path) = novel_path else {
        return Ok(None);
    };
    let preferred_dir = content_chapter_dir_at(
        root,
        source_id,
        novel_id,
        Some(novel_path),
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?;
    match fs::metadata(&preferred_dir) {
        Ok(metadata) if metadata.is_dir() => {
            if stored_content_path_in_dir(&preferred_dir, "content.html")?.is_some() {
                return Ok(Some(preferred_dir));
            }
        }
        Ok(_) => {
            return Err(format!(
                "chapter media: chapter storage path is not a directory: {}",
                preferred_dir.display()
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(format!("chapter media: inspect chapter storage: {err}")),
    }

    let chapter_identity_prefix = format!(
        "{}-",
        chapter_number_segment(chapter_number, chapter_position, chapter_id)
    );
    let candidate_dirs = content_chapter_dirs_matching_identity(
        root,
        source_id,
        novel_id,
        novel_path,
        chapter_id,
        chapter_number,
        chapter_position,
    )?;
    let mut matches = Vec::new();
    for chapter_dir in candidate_dirs {
        if stored_content_path_in_dir(&chapter_dir, "content.html")?.is_some() {
            matches.push(chapter_dir);
        }
    }

    match matches.len() {
        0 => Ok(Some(preferred_dir)),
        1 => Ok(matches.pop()),
        _ => Err(format!(
            "chapter media: multiple stored chapter folders match source identity {chapter_identity_prefix}"
        )),
    }
}

fn media_path_in_chapter_dir(chapter_dir: &Path, file_name: &str) -> Option<PathBuf> {
    let current_path = chapter_dir.join(MEDIA_DOWNLOAD_DIR).join(file_name);
    if current_path.is_file() {
        return Some(current_path);
    }
    None
}

fn media_path_from_chapter_dir(
    chapter_dir: &Path,
    file_name: &str,
) -> Result<Option<PathBuf>, String> {
    Ok(media_path_in_chapter_dir(chapter_dir, file_name))
}

fn media_body_from_archive(
    archive_path: &Path,
    file_name: &str,
) -> Result<Option<Vec<u8>>, String> {
    let archive_file =
        File::open(archive_path).map_err(|err| format!("chapter media: open archive: {err}"))?;
    let mut archive = ZipArchive::new(BufReader::new(archive_file))
        .map_err(|err| format!("chapter media: read archive: {err}"))?;
    let mut entry = match archive.by_name(file_name) {
        Ok(entry) => entry,
        Err(ZipError::FileNotFound) => return Ok(None),
        Err(err) => return Err(format!("chapter media: open archive entry: {err}")),
    };
    if !entry.is_file() {
        return Err("chapter media: archive entry is not a file".to_string());
    }

    let mut body = Vec::with_capacity(entry.size().try_into().unwrap_or_default());
    entry
        .read_to_end(&mut body)
        .map_err(|err| format!("chapter media: read archive entry: {err}"))?;
    Ok(Some(body))
}

fn media_body_from_chapter_dir(
    chapter_dir: &Path,
    file_name: &str,
) -> Result<Option<Vec<u8>>, String> {
    if let Some(path) = media_path_in_chapter_dir(chapter_dir, file_name) {
        let body = fs::read(&path).map_err(|err| format!("chapter media: read media: {err}"))?;
        log::debug!(
            "[chapter-media:data-url] direct hit file={file_name} bytes={} path={}",
            body.len(),
            path.display()
        );
        return Ok(Some(body));
    }

    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    if archive_path.is_file() {
        if let Some(body) = media_body_from_archive(&archive_path, file_name)? {
            log::debug!(
                "[chapter-media:data-url] archive hit file={file_name} bytes={} archive={}",
                body.len(),
                archive_path.display()
            );
            return Ok(Some(body));
        }
    }

    log::debug!(
        "[chapter-media:data-url] miss file={file_name} chapter_dir={}",
        chapter_dir.display()
    );
    Ok(None)
}

fn chapter_media_path_from_src_with_context(
    app: &AppHandle,
    media_src: &str,
    context_chapter_id: Option<i64>,
    novel_id: Option<i64>,
    source_id: Option<&str>,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<PathBuf, String> {
    let parsed = parse_media_src(media_src)?;
    let chapter_id = media_src_chapter_id(context_chapter_id)?;
    let file_name = parsed.file_name;
    let roots = media_roots_for_lookup(app)?;
    for root in &roots {
        if let Some(chapter_dir) = content_chapter_dir_from_context(
            root,
            novel_id,
            source_id,
            novel_path,
            novel_name,
            chapter_id,
            chapter_number,
            chapter_name,
            chapter_position,
        )? {
            if let Some(path) = media_path_from_chapter_dir(&chapter_dir, &file_name)? {
                return Ok(path);
            }
            if chapter_dir.is_dir() {
                // The context-derived chapter directory is authoritative. Media kept
                // only inside media.zip has no extractable file path and is served via
                // chapter_media_data_url instead, so skip the full-library scan rather
                // than walking every downloaded chapter directory on each media
                // request (which is O(chapters) per image and freezes large libraries).
                continue;
            }
        }

        for chapter_dir in content_chapter_dirs_for_lookup(root, chapter_id)? {
            if let Some(path) = media_path_from_chapter_dir(&chapter_dir, &file_name)? {
                return Ok(path);
            }
        }
    }

    Ok(chapter_dir_at(&roots[0], chapter_id)?
        .join(MEDIA_DOWNLOAD_DIR)
        .join(&file_name))
}

pub(crate) fn chapter_media_body_from_src_with_context(
    app: &AppHandle,
    media_src: &str,
    context_chapter_id: Option<i64>,
    novel_id: Option<i64>,
    source_id: Option<&str>,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<(Vec<u8>, String), String> {
    let parsed = parse_media_src(media_src)?;
    let chapter_id = media_src_chapter_id(context_chapter_id)?;
    let file_name = parsed.file_name;
    let roots = media_roots_for_lookup(app)?;
    for root in &roots {
        if let Some(chapter_dir) = content_chapter_dir_from_context(
            root,
            novel_id,
            source_id,
            novel_path,
            novel_name,
            chapter_id,
            chapter_number,
            chapter_name,
            chapter_position,
        )? {
            if let Some(body) = media_body_from_chapter_dir(&chapter_dir, &file_name)? {
                return Ok((body, file_name));
            }
            if chapter_dir.is_dir() {
                // Authoritative context dir exists; avoid the O(chapters) full-library
                // scan on every media request (see chapter_media_path_from_src_with_context).
                continue;
            }
        }

        for chapter_dir in content_chapter_dirs_for_lookup(root, chapter_id)? {
            if let Some(body) = media_body_from_chapter_dir(&chapter_dir, &file_name)? {
                return Ok((body, file_name));
            }
        }
    }

    Err("chapter media: file not found".to_string())
}

pub(crate) fn chapter_media_from_backup_entry(entry_name: &str) -> Option<(i64, String)> {
    let rest = entry_name.strip_prefix(&format!("{MEDIA_ROOT_DIR}/"))?;
    let mut parts = rest.split('/');
    let chapter_id = parts.next()?.parse::<i64>().ok()?;
    if chapter_id <= 0 {
        return None;
    }
    let file_name = parts.collect::<Vec<_>>().join("/");
    let file_name = safe_media_relative_path(&file_name).ok()?;
    Some((chapter_id, format!("{MEDIA_URI_PREFIX}{file_name}")))
}

struct ChapterMediaStoreInput {
    chapter_id: i64,
    file_name: String,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
}

enum ChapterMediaStoreSource {
    Bytes(Vec<u8>),
    File(PathBuf),
}

fn move_media_source_to_part_path(
    source_path: &Path,
    part_path: &Path,
    context: &str,
) -> Result<(), String> {
    if part_path.exists() {
        fs::remove_file(part_path).map_err(|err| format!("{context}: remove stale part: {err}"))?;
    }
    match fs::rename(source_path, part_path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            if let Err(copy_err) = fs::copy(source_path, part_path) {
                let _ = fs::remove_file(part_path);
                return Err(format!(
                    "{context}: move temp media: {rename_err}; copy fallback: {copy_err}"
                ));
            }
            if let Err(err) = fs::remove_file(source_path) {
                let _ = fs::remove_file(part_path);
                return Err(format!("{context}: remove temp media: {err}"));
            }
            Ok(())
        }
    }
}

fn store_chapter_media_at_root(
    root: &Path,
    input: ChapterMediaStoreInput,
    source: ChapterMediaStoreSource,
) -> Result<String, String> {
    let file_name = safe_segment(&input.file_name, "media");
    let novel_id = input
        .novel_id
        .ok_or_else(|| "chapter media: missing novel id".to_string())?;
    let source_id = input
        .source_id
        .as_deref()
        .ok_or_else(|| "chapter media: missing source id".to_string())?;
    ensure_contents_nomedia(root)?;
    let dir = content_chapter_dir_at(
        root,
        source_id,
        novel_id,
        input.novel_path.as_deref(),
        input.novel_name.as_deref(),
        input.chapter_id,
        input.chapter_number.as_deref(),
        input.chapter_name.as_deref(),
        input.chapter_position,
    )?
    .join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&dir).map_err(|err| format!("chapter media: create dir: {err}"))?;
    let part_path = dir.join(format!("{file_name}.part"));
    let final_path = dir.join(&file_name);
    match source {
        ChapterMediaStoreSource::Bytes(body) => {
            fs::write(&part_path, body)
                .map_err(|err| format!("chapter media: write media file: {err}"))?;
        }
        ChapterMediaStoreSource::File(source_path) => {
            move_media_source_to_part_path(
                &source_path,
                &part_path,
                "chapter media: store media handle",
            )?;
        }
    }
    if final_path.exists() {
        fs::remove_file(&final_path)
            .map_err(|err| format!("chapter media: replace media file: {err}"))?;
    }
    fs::rename(&part_path, &final_path)
        .map_err(|err| format!("chapter media: move media file: {err}"))?;
    Ok(format!("{MEDIA_URI_PREFIX}{file_name}"))
}

fn store_chapter_media(
    app: &AppHandle,
    input: ChapterMediaStoreInput,
    source: ChapterMediaStoreSource,
) -> Result<String, String> {
    let root = media_root(app)?;
    store_chapter_media_at_root(&root, input, source)
}

pub(crate) fn store_chapter_media_file_source(
    app: &AppHandle,
    source_path: PathBuf,
    chapter_id: i64,
    file_name: String,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    store_chapter_media(
        app,
        ChapterMediaStoreInput {
            chapter_id,
            file_name,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        },
        ChapterMediaStoreSource::File(source_path),
    )
}

#[tauri::command]
pub async fn chapter_media_store(
    app: AppHandle,
    chapter_id: i64,
    file_name: String,
    body: Vec<u8>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    chapter_media_blocking("store", move || {
        store_chapter_media(
            &app,
            ChapterMediaStoreInput {
                chapter_id,
                file_name,
                novel_id,
                source_id,
                novel_name,
                novel_path,
                chapter_number,
                chapter_name,
                chapter_position,
            },
            ChapterMediaStoreSource::Bytes(body),
        )
    })
    .await
}

#[tauri::command]
pub async fn chapter_media_store_handle(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
    chapter_id: i64,
    file_name: String,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    let stream_path = native_stream::take_finished_path(
        &app,
        state.inner(),
        &handle,
        Some(CHAPTER_MEDIA_STREAM_DOMAIN),
    )?;
    let cleanup_path = stream_path.clone();
    chapter_media_blocking("store handle", move || {
        let result = store_chapter_media(
            &app,
            ChapterMediaStoreInput {
                chapter_id,
                file_name,
                novel_id,
                source_id,
                novel_name,
                novel_path,
                chapter_number,
                chapter_name,
                chapter_position,
            },
            ChapterMediaStoreSource::File(stream_path),
        );
        if result.is_err() {
            let _ = fs::remove_file(cleanup_path);
        }
        result
    })
    .await
}

#[tauri::command]
pub async fn chapter_media_archive_cache(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<u64, String> {
    chapter_media_blocking("archive cache", move || {
        chapter_media_archive_cache_sync(
            app,
            chapter_id,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

fn chapter_media_archive_cache_sync(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<u64, String> {
    let novel_id = novel_id.ok_or_else(|| "chapter media: missing novel id".to_string())?;
    let source_id = source_id
        .as_deref()
        .ok_or_else(|| "chapter media: missing source id".to_string())?;
    let media_root = media_root(&app)?;
    let chapter_dir = content_chapter_dir_at(
        &media_root,
        source_id,
        novel_id,
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_id,
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    validate_chapter_dir_under_storage_root(&media_root, &chapter_dir)?;
    ensure_contents_nomedia(&media_root)?;
    let media_bytes = match finalize_chapter_media_artifacts(&media_root, &chapter_dir)? {
        ChapterMediaFinalization::Incomplete(reason) => {
            return Err(format!(
                "chapter media: media archive finalization incomplete: {reason}"
            ));
        }
        ChapterMediaFinalization::ManifestMissing => {
            return Err("chapter media: media manifest is missing".to_string());
        }
        ChapterMediaFinalization::Ready(media_bytes) => media_bytes,
    };

    for root in media_roots_for_lookup(&app)? {
        for old_chapter_dir in content_chapter_dirs_for_lookup(&root, chapter_id)? {
            if old_chapter_dir != chapter_dir {
                validate_chapter_dir_under_storage_root(&root, &old_chapter_dir)?;
                clear_content_media_artifacts(&old_chapter_dir)?;
            }
        }
    }
    Ok(media_bytes)
}

fn required_content_chapter_dir(
    app: &AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<&str>,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<PathBuf, String> {
    let novel_id = novel_id.ok_or_else(|| "chapter media: missing novel id".to_string())?;
    let source_id = source_id.ok_or_else(|| "chapter media: missing source id".to_string())?;
    let novel_path = novel_path.ok_or_else(|| "chapter media: missing novel path".to_string())?;
    let root = media_root(app)?;
    ensure_contents_nomedia(&root)?;
    content_chapter_dir_from_context(
        &root,
        Some(novel_id),
        Some(source_id),
        Some(novel_path),
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?
    .ok_or_else(|| "chapter media: cannot resolve chapter storage path".to_string())
}

#[tauri::command]
pub async fn chapter_media_prepare_workspace(
    app: AppHandle,
    chapter_id: i64,
    repair: bool,
    preserve_existing: Option<bool>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    chapter_media_blocking("prepare workspace", move || {
        chapter_media_prepare_workspace_sync(
            app,
            chapter_id,
            repair,
            preserve_existing.unwrap_or(false),
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

fn chapter_media_prepare_workspace_sync(
    app: AppHandle,
    chapter_id: i64,
    repair: bool,
    preserve_existing: bool,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    if !repair && !preserve_existing {
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        if media_dir.exists() {
            fs::remove_dir_all(&media_dir)
                .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
        }
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        remove_known_publication_file(&archive_path, "chapter media: remove media archive")?;
        remove_stale_chapter_media_archive_publication_files(&chapter_dir)?;
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        remove_known_publication_file(&manifest_path, "chapter media: remove media manifest")?;
        remove_stale_chapter_media_manifest_publication_files(&chapter_dir)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_cleanup_workspace(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    chapter_media_blocking("cleanup workspace", move || {
        chapter_media_cleanup_workspace_sync(
            app,
            chapter_id,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

fn chapter_media_cleanup_workspace_sync(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    if media_dir.exists() {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn chapter_media_write_manifest(
    app: AppHandle,
    chapter_id: i64,
    complete: Option<bool>,
    files: serde_json::Value,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let files = match files {
        serde_json::Value::Array(files) => files,
        _ => Vec::new(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let manifest = serde_json::json!({
        "version": 1,
        "complete": complete.unwrap_or(false),
        "updatedAt": now,
        "media": {
            "files": files
        }
    });
    write_chapter_media_manifest(&chapter_media_manifest_path(&chapter_dir), &manifest)
}

#[tauri::command]
pub fn chapter_media_read_manifest(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<Option<String>, String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    match fs::read_to_string(&manifest_path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: read media manifest: {err}")),
    }
}

#[tauri::command]
pub fn chapter_content_mirror_store(
    app: AppHandle,
    chapter_id: i64,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    let media_root = media_root(&app)?;
    ensure_contents_nomedia(&media_root)?;
    let novel = metadata
        .get("novel")
        .cloned()
        .ok_or_else(|| "chapter media: missing novel metadata".to_string())?;
    let chapter = metadata
        .get("chapter")
        .cloned()
        .ok_or_else(|| "chapter media: missing chapter metadata".to_string())?;
    let novel_id = novel
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "chapter media: invalid novel metadata id".to_string())?;
    let source_id = novel
        .get("pluginId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "chapter media: invalid novel metadata plugin id".to_string())?;
    let novel_name = novel.get("name").and_then(serde_json::Value::as_str);
    let novel_path = novel.get("path").and_then(serde_json::Value::as_str);
    let chapter_number = chapter
        .get("chapterNumber")
        .and_then(serde_json::Value::as_str);
    let chapter_name = chapter.get("name").and_then(serde_json::Value::as_str);
    let position = chapter.get("position").and_then(serde_json::Value::as_i64);
    let content_type = chapter
        .get("contentType")
        .and_then(serde_json::Value::as_str);
    let extension = chapter_content_extension(content_type);
    let content_file = chapter_content_relative_path(
        source_id,
        novel_id,
        novel_path,
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        position,
        extension,
    )?;
    let content_path = media_root.join(&content_file);

    if let Some(parent) = content_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("chapter media: create content mirror dir: {err}"))?;
    }
    let temp_content_path = content_path.with_extension(format!("{extension}.tmp"));
    fs::write(&temp_content_path, content)
        .map_err(|err| format!("chapter media: write content mirror temp: {err}"))?;
    let backup_content_path = content_path.with_extension(format!("{extension}.bak"));
    replace_storage_file(
        &temp_content_path,
        &content_path,
        &backup_content_path,
        "chapter media: replace content mirror",
    )?;
    let partial_path = content_path.with_file_name(CHAPTER_PARTIAL_CONTENT_FILE);
    if partial_path.exists() {
        fs::remove_file(&partial_path)
            .map_err(|err| format!("chapter media: remove partial content: {err}"))?;
    }
    let chapter_dir = content_path
        .parent()
        .ok_or_else(|| "chapter media: content mirror has no parent directory".to_string())?;
    remove_chapter_content_files_in_dir(chapter_dir, Some(&content_path))?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub fn chapter_content_mirror_store_partial(
    app: AppHandle,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    let media_root = media_root(&app)?;
    ensure_contents_nomedia(&media_root)?;
    let novel = metadata
        .get("novel")
        .ok_or_else(|| "chapter media: missing novel metadata".to_string())?;
    let chapter = metadata
        .get("chapter")
        .ok_or_else(|| "chapter media: missing chapter metadata".to_string())?;
    let novel_id = novel
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "chapter media: invalid novel metadata id".to_string())?;
    let source_id = novel
        .get("pluginId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "chapter media: invalid novel metadata plugin id".to_string())?;
    let chapter_id = chapter
        .get("id")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| "chapter media: invalid chapter metadata id".to_string())?;
    let chapter_dir = content_chapter_dir_at(
        &media_root,
        source_id,
        novel_id,
        novel.get("path").and_then(serde_json::Value::as_str),
        novel.get("name").and_then(serde_json::Value::as_str),
        chapter_id,
        chapter
            .get("chapterNumber")
            .and_then(serde_json::Value::as_str),
        chapter.get("name").and_then(serde_json::Value::as_str),
        chapter.get("position").and_then(serde_json::Value::as_i64),
    )?;
    fs::create_dir_all(&chapter_dir)
        .map_err(|err| format!("chapter media: create partial content dir: {err}"))?;
    let partial_path = chapter_dir.join(CHAPTER_PARTIAL_CONTENT_FILE);
    let temp_path = chapter_dir.join(format!("{CHAPTER_PARTIAL_CONTENT_FILE}.tmp"));
    let backup_path = chapter_dir.join(format!("{CHAPTER_PARTIAL_CONTENT_FILE}.bak"));
    fs::write(&temp_path, content)
        .map_err(|err| format!("chapter media: write partial content: {err}"))?;
    replace_storage_file(
        &temp_path,
        &partial_path,
        &backup_path,
        "chapter media: replace partial content",
    )
}

fn novel_cover_manifest_path(novel_dir: &Path) -> PathBuf {
    novel_dir.join(NOVEL_COVER_MANIFEST_FILE)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NovelCoverManifestMetadata {
    file_name: String,
    #[serde(default)]
    novel_path: Option<String>,
    #[serde(default)]
    source_id: Option<String>,
    source_url: String,
    #[serde(default)]
    updated_at: u64,
    version: u64,
}

fn novel_cover_manifest_metadata(raw: &str) -> Option<NovelCoverManifestMetadata> {
    serde_json::from_str(raw)
        .ok()
        .filter(|manifest: &NovelCoverManifestMetadata| manifest.version == 1)
}

fn novel_cover_file_name_from_manifest(raw: &str) -> Option<String> {
    novel_cover_manifest_metadata(raw).map(|manifest| manifest.file_name)
}

fn read_existing_novel_cover_manifest(novel_dir: &Path) -> Result<Option<String>, String> {
    let manifest_path = novel_cover_manifest_path(novel_dir);
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("chapter media: read novel cover manifest: {err}")),
    };
    let file_name = match novel_cover_file_name_from_manifest(&raw) {
        Some(file_name) => safe_segment(&file_name, "cover"),
        None => return Ok(None),
    };
    let cover_path = novel_dir.join(file_name);
    match fs::metadata(&cover_path) {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Ok(Some(raw)),
        Ok(_) => Ok(None),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: inspect novel cover file: {err}")),
    }
}

#[derive(Debug)]
struct NovelCoverCandidate {
    cover: NovelCoverReadResult,
    updated_at: u64,
}

fn novel_cover_manifest_matches_identity(
    manifest: &NovelCoverManifestMetadata,
    source_id: &str,
    novel_path: &str,
    expected_source_url: Option<&str>,
    is_preferred: bool,
) -> bool {
    match (
        manifest.source_id.as_deref(),
        manifest.novel_path.as_deref(),
    ) {
        (Some(stored_source_id), Some(stored_novel_path)) => {
            stored_source_id == source_id && stored_novel_path == novel_path
        }
        (None, None) => {
            is_preferred
                || expected_source_url
                    .is_some_and(|source_url| manifest.source_url == source_url)
        }
        _ => false,
    }
}

fn read_novel_cover_candidate_at(
    media_root: &Path,
    novel_dir: &Path,
    source_id: &str,
    novel_path: &str,
    expected_source_url: Option<&str>,
    is_preferred: bool,
) -> Result<Option<NovelCoverCandidate>, String> {
    let Some(manifest) = read_existing_novel_cover_manifest(novel_dir)? else {
        return Ok(None);
    };
    let Some(metadata) = novel_cover_manifest_metadata(&manifest) else {
        return Ok(None);
    };
    if !novel_cover_manifest_matches_identity(
        &metadata,
        source_id,
        novel_path,
        expected_source_url,
        is_preferred,
    ) {
        return Ok(None);
    }
    let file_name = safe_segment(&metadata.file_name, "cover");
    let relative_path = relative_storage_path(media_root, &novel_dir.join(file_name))?;
    Ok(Some(NovelCoverCandidate {
        cover: NovelCoverReadResult {
            manifest,
            relative_path,
        },
        updated_at: metadata.updated_at,
    }))
}

fn novel_cover_dirs_matching_identity(
    media_root: &Path,
    source_id: &str,
    novel_id: i64,
    novel_path: &str,
) -> Result<Vec<PathBuf>, String> {
    let source_dir = media_root
        .join(CONTENTS_ROOT_DIR)
        .join(safe_segment(source_id, "source"));
    match fs::metadata(&source_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(format!(
                "chapter media: source storage path is not a directory: {}",
                source_dir.display()
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("chapter media: inspect source storage: {err}")),
    }

    let identity_suffix = format!("-{}", safe_segment(novel_path, &novel_id.to_string()));
    let mut matches = Vec::new();
    for entry in
        fs::read_dir(&source_dir).map_err(|err| format!("chapter media: read source: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read source entry: {err}"))?;
        if entry
            .file_type()
            .map_err(|err| format!("chapter media: read source entry type: {err}"))?
            .is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .ends_with(&identity_suffix)
        {
            matches.push(entry.path());
        }
    }
    matches.sort();
    Ok(matches)
}

fn novel_cover_read_manifest_at(
    media_root: &Path,
    novel_id: i64,
    source_id: &str,
    novel_name: &str,
    novel_path: &str,
    expected_source_url: Option<&str>,
) -> Result<Option<NovelCoverReadResult>, String> {
    let preferred_dir = content_novel_dir_at(
        media_root,
        source_id,
        novel_id,
        Some(novel_path),
        Some(novel_name),
    )?;
    if let Some(cover) = read_novel_cover_candidate_at(
        media_root,
        &preferred_dir,
        source_id,
        novel_path,
        expected_source_url,
        true,
    )? {
        return Ok(Some(cover.cover));
    }

    let mut matches = Vec::new();
    for novel_dir in
        novel_cover_dirs_matching_identity(media_root, source_id, novel_id, novel_path)?
    {
        if novel_dir == preferred_dir {
            continue;
        }
        if let Some(cover) = read_novel_cover_candidate_at(
            media_root,
            &novel_dir,
            source_id,
            novel_path,
            expected_source_url,
            false,
        )? {
            matches.push(cover);
        }
    }

    matches.sort_by(|left, right| {
        right.updated_at.cmp(&left.updated_at).then_with(|| {
            left.cover
                .relative_path
                .cmp(&right.cover.relative_path)
        })
    });
    Ok(matches.into_iter().next().map(|candidate| candidate.cover))
}

#[tauri::command]
pub fn novel_cover_read_manifest(
    app: AppHandle,
    novel_id: i64,
    source_id: String,
    novel_name: String,
    novel_path: String,
    expected_source_url: Option<String>,
) -> Result<Option<NovelCoverReadResult>, String> {
    let media_root = media_root(&app)?;
    novel_cover_read_manifest_at(
        &media_root,
        novel_id,
        &source_id,
        &novel_name,
        &novel_path,
        expected_source_url.as_deref(),
    )
}

fn novel_cover_store_at(
    media_root: &Path,
    novel_id: i64,
    source_id: &str,
    novel_name: &str,
    novel_path: &str,
    file_name: &str,
    body: &[u8],
    manifest: &str,
) -> Result<(), String> {
    if body.is_empty() {
        return Err("chapter media: novel cover body is empty".to_string());
    }
    let incoming_manifest = novel_cover_manifest_metadata(manifest)
        .ok_or_else(|| "chapter media: invalid novel cover manifest".to_string())?;
    if incoming_manifest.source_id.as_deref() != Some(source_id)
        || incoming_manifest.novel_path.as_deref() != Some(novel_path)
    {
        return Err("chapter media: novel cover manifest identity does not match".to_string());
    }

    ensure_contents_nomedia(media_root)?;
    let existing_cover = novel_cover_read_manifest_at(
        media_root,
        novel_id,
        source_id,
        novel_name,
        novel_path,
        None,
    )?;
    let novel_dir = match existing_cover {
        Some(existing_cover) => {
            let relative_cover_path = safe_relative_storage_path(&existing_cover.relative_path)?;
            media_root
                .join(relative_cover_path)
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "chapter media: invalid stored novel cover path".to_string())?
        }
        None => content_novel_dir_at(
            media_root,
            source_id,
            novel_id,
            Some(novel_path),
            Some(novel_name),
        )?,
    };
    fs::create_dir_all(&novel_dir)
        .map_err(|err| format!("chapter media: create novel cover dir: {err}"))?;

    let previous_file_name = read_existing_novel_cover_manifest(&novel_dir)?
        .as_deref()
        .and_then(novel_cover_file_name_from_manifest)
        .map(|file_name| safe_segment(&file_name, "cover"));
    let file_name = safe_segment(file_name, "cover");
    let cover_path = novel_dir.join(&file_name);
    let temp_cover_path = novel_dir.join(format!("{file_name}.tmp"));
    fs::write(&temp_cover_path, body)
        .map_err(|err| format!("chapter media: write novel cover temp: {err}"))?;
    move_media_source_to_part_path(&temp_cover_path, &cover_path, "chapter media: novel cover")?;

    let manifest_path = novel_cover_manifest_path(&novel_dir);
    let temp_manifest_path = novel_dir.join(format!("{NOVEL_COVER_MANIFEST_FILE}.tmp"));
    fs::write(&temp_manifest_path, manifest)
        .map_err(|err| format!("chapter media: write novel cover manifest temp: {err}"))?;
    move_media_source_to_part_path(
        &temp_manifest_path,
        &manifest_path,
        "chapter media: novel cover manifest",
    )?;

    if let Some(previous_file_name) = previous_file_name {
        if previous_file_name != file_name {
            let _ = fs::remove_file(novel_dir.join(previous_file_name));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn novel_cover_store(
    app: AppHandle,
    novel_id: i64,
    source_id: String,
    novel_name: String,
    novel_path: String,
    file_name: String,
    body: Vec<u8>,
    manifest: String,
) -> Result<(), String> {
    let media_root = media_root(&app)?;
    novel_cover_store_at(
        &media_root,
        novel_id,
        &source_id,
        &novel_name,
        &novel_path,
        &file_name,
        &body,
        &manifest,
    )
}

#[tauri::command]
pub fn chapter_content_mirror_clear(app: AppHandle, chapter_id: i64) -> Result<(), String> {
    let media_root = media_root(&app)?;
    remove_stored_chapter_content_files(&media_root, chapter_id, None)?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub async fn chapter_content_mirror_inspect(
    app: AppHandle,
    preferred_chapter_dir: String,
    source_dir: String,
    novel_identity_suffix: String,
    chapter_identity_prefix: String,
    preferred_content_file_name: String,
) -> Result<ChapterContentInspection, String> {
    chapter_media_blocking("inspect stored chapter", move || {
        chapter_content_mirror_inspect_sync(
            app,
            preferred_chapter_dir,
            source_dir,
            novel_identity_suffix,
            chapter_identity_prefix,
            preferred_content_file_name,
        )
    })
    .await
}

#[tauri::command]
pub fn chapter_content_mirror_cleanup_legacy_manifest(app: AppHandle) -> Result<(), String> {
    let media_root = media_root(&app)?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub fn chapter_content_mirror_read_file(
    app: AppHandle,
    content_file: String,
) -> Result<Option<String>, String> {
    let media_root = media_root(&app)?;
    let relative_path = safe_relative_storage_path(&content_file)?;
    let content_path = media_root.join(relative_path);
    match fs::read_to_string(&content_path) {
        Ok(content) => Ok(Some(content)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!(
            "chapter media: read mirrored chapter '{}': {err}",
            content_path.to_string_lossy()
        )),
    }
}

fn archive_contains_file(archive_path: &Path, file_name: &str) -> Result<bool, String> {
    let archive_file =
        File::open(archive_path).map_err(|err| format!("chapter media: open archive: {err}"))?;
    let mut archive = ZipArchive::new(BufReader::new(archive_file))
        .map_err(|err| format!("chapter media: read archive: {err}"))?;
    let contains_file = match archive.by_name(file_name) {
        Ok(entry) => Ok(entry.is_file()),
        Err(ZipError::FileNotFound) => Ok(false),
        Err(err) => Err(format!("chapter media: open archive entry: {err}")),
    };
    contains_file
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

fn media_mime_type(path: &Path, body: &[u8]) -> &'static str {
    if let Some(content_type) = image_mime_type(body) {
        return content_type;
    }
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("apng") => "image/apng",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("oga") | Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("mp4") => "video/mp4",
        Some("ogv") => "video/ogg",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn chapter_media_path(
    app: AppHandle,
    media_src: String,
    chapter_id: Option<i64>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    let path = chapter_media_path_from_src_with_context(
        &app,
        &media_src,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    if !path.is_file() {
        return Err("chapter media: file not found".to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn chapter_media_data_url(
    app: AppHandle,
    media_src: String,
    chapter_id: Option<i64>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        match parse_media_src(&media_src) {
            Ok(parsed) => {
                log::debug!(
                    "[chapter-media:data-url] request chapter_id={:?} file={}",
                    chapter_id,
                    parsed.file_name
                );
            }
            Err(err) => {
                log::debug!("[chapter-media:data-url] request parse failed: {err}");
            }
        }
        let (body, file_name) = chapter_media_body_from_src_with_context(
            &app,
            &media_src,
            chapter_id,
            novel_id,
            source_id.as_deref(),
            novel_path.as_deref(),
            novel_name.as_deref(),
            chapter_number.as_deref(),
            chapter_name.as_deref(),
            chapter_position,
        )?;
        Ok(format!(
            "data:{};base64,{}",
            media_mime_type(Path::new(&file_name), &body),
            encode_base64(&body)
        ))
    })
    .await
    .map_err(|err| format!("chapter media: read media task: {err}"))?
}

#[tauri::command]
pub async fn chapter_media_total_size(
    app: AppHandle,
    media_srcs: Vec<String>,
    chapter_id: Option<i64>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<u64, String> {
    chapter_media_blocking("total size", move || {
        chapter_media_total_size_sync(
            app,
            media_srcs,
            chapter_id,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

fn chapter_media_total_size_sync(
    app: AppHandle,
    media_srcs: Vec<String>,
    context_chapter_id: Option<i64>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<u64, String> {
    let mut total = 0;
    let mut counted_archives = HashSet::new();
    for media_src in media_srcs {
        let parsed = parse_media_src(&media_src)?;
        let chapter_id = media_src_chapter_id(context_chapter_id)?;
        let file_name = parsed.file_name;
        for root in media_roots_for_lookup(&app)? {
            let mut found = false;
            if let Some(chapter_dir) = content_chapter_dir_from_context(
                &root,
                novel_id,
                source_id.as_deref(),
                novel_path.as_deref(),
                novel_name.as_deref(),
                chapter_id,
                chapter_number.as_deref(),
                chapter_name.as_deref(),
                chapter_position,
            )? {
                if let Some(path) = media_path_in_chapter_dir(&chapter_dir, &file_name) {
                    match fs::metadata(&path) {
                        Ok(metadata) if metadata.is_file() => {
                            total += metadata.len();
                            found = true;
                        }
                        Ok(_) => {}
                        Err(err) if err.kind() == ErrorKind::NotFound => {}
                        Err(err) => {
                            return Err(format!("chapter media: read media metadata: {err}"));
                        }
                    }
                }

                if !found {
                    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
                    if archive_path.is_file() {
                        let archive_key = archive_path.to_string_lossy().into_owned();
                        if counted_archives.contains(&archive_key)
                            || !archive_contains_file(&archive_path, &file_name)?
                        {
                            continue;
                        }
                        match fs::metadata(&archive_path) {
                            Ok(metadata) if metadata.is_file() => {
                                total += metadata.len();
                                counted_archives.insert(archive_key);
                                break;
                            }
                            Ok(_) => {}
                            Err(err) if err.kind() == ErrorKind::NotFound => {}
                            Err(err) => {
                                return Err(format!("chapter media: read archive metadata: {err}"));
                            }
                        }
                    }
                }
            }

            for chapter_dir in content_chapter_dirs_for_lookup(&root, chapter_id)? {
                if found {
                    break;
                }
                if let Some(path) = media_path_in_chapter_dir(&chapter_dir, &file_name) {
                    match fs::metadata(&path) {
                        Ok(metadata) if metadata.is_file() => {
                            total += metadata.len();
                            found = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(err) if err.kind() == ErrorKind::NotFound => {}
                        Err(err) => {
                            return Err(format!("chapter media: read media metadata: {err}"));
                        }
                    }
                }

                let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
                if archive_path.is_file() {
                    let archive_key = archive_path.to_string_lossy().into_owned();
                    if counted_archives.contains(&archive_key)
                        || !archive_contains_file(&archive_path, &file_name)?
                    {
                        continue;
                    }
                    match fs::metadata(&archive_path) {
                        Ok(metadata) if metadata.is_file() => {
                            total += metadata.len();
                            counted_archives.insert(archive_key);
                            found = true;
                            break;
                        }
                        Ok(_) => {}
                        Err(err) if err.kind() == ErrorKind::NotFound => {}
                        Err(err) => {
                            return Err(format!("chapter media: read archive metadata: {err}"));
                        }
                    }
                }
                if found {
                    break;
                }
            }
            if found {
                break;
            }
        }
    }
    Ok(total)
}

fn prune_chapter_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }

    let media_dir = dir.join(MEDIA_DOWNLOAD_DIR);
    if media_dir.is_dir() {
        for entry in fs::read_dir(&media_dir)
            .map_err(|err| format!("chapter media: read media dir: {err}"))?
        {
            let entry = entry.map_err(|err| format!("chapter media: read media entry: {err}"))?;
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|err| format!("chapter media: remove stale media dir: {err}"))?;
            }
        }
    }
    let backup_path = archive_backup_path(&dir.join(MEDIA_ARCHIVE_FILE));
    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|err| format!("chapter media: remove archive backup: {err}"))?;
    }

    for entry in fs::read_dir(dir).map_err(|err| format!("chapter media: read dir: {err}"))? {
        let entry = entry.map_err(|err| format!("chapter media: read entry: {err}"))?;
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if entry_name == MEDIA_DOWNLOAD_DIR
            || entry_name == MEDIA_ARCHIVE_FILE
            || !entry_name.ends_with(".zip")
        {
            continue;
        }
        let path = entry.path();
        fs::remove_file(&path).map_err(|err| format!("chapter media: remove archive: {err}"))?;
    }
    Ok(())
}

fn clear_storage_root(root: &Path) -> Result<(), String> {
    let contents_dir = root.join(CONTENTS_ROOT_DIR);
    if contents_dir.exists() {
        fs::remove_dir_all(&contents_dir)
            .map_err(|err| format!("chapter media: remove contents dir: {err}"))?;
    }
    ensure_contents_nomedia(root)?;

    delete_legacy_storage_manifest(root)?;

    if !root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|err| format!("chapter media: read root dir: {err}"))? {
        let entry = entry.map_err(|err| format!("chapter media: read root entry: {err}"))?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.chars().all(|ch| ch.is_ascii_digit()) {
            let path = entry.path();
            if path.is_dir() {
                fs::remove_dir_all(path)
                    .map_err(|err| format!("chapter media: remove legacy chapter dir: {err}"))?;
            }
        }
    }
    Ok(())
}

fn remove_existing_path(path: &Path, context: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| format!("{context}: {err}"))
    } else {
        fs::remove_file(path).map_err(|err| format!("{context}: {err}"))
    }
}

fn safe_content_storage_relative_dir(
    value: &str,
    allowed_depths: &[usize],
) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("chapter media: chapter storage path is invalid".to_string());
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Err("chapter media: chapter storage path must be relative".to_string());
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => segments.push(segment.to_os_string()),
            _ => return Err("chapter media: chapter storage path is invalid".to_string()),
        }
    }
    if !allowed_depths.contains(&segments.len())
        || segments.first().map(|segment| segment.as_os_str())
            != Some(std::ffi::OsStr::new(CONTENTS_ROOT_DIR))
    {
        return Err(
            "chapter media: chapter storage path must stay within a novel or chapter directory"
                .to_string(),
        );
    }
    Ok(segments.into_iter().collect())
}

fn safe_chapter_storage_relative_dir(value: &str) -> Result<PathBuf, String> {
    safe_content_storage_relative_dir(value, &[4])
}

fn safe_chapter_storage_removal_relative_dir(value: &str) -> Result<PathBuf, String> {
    safe_content_storage_relative_dir(value, &[3, 4])
}

fn storage_metadata(path: &Path, context: &str) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(format!("{context}: symbolic links are not allowed"))
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("{context}: {err}")),
    }
}

fn validate_storage_path_ancestors(root: &Path, relative: &Path) -> Result<(), String> {
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|err| format!("chapter media: inspect storage root: {err}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("chapter media: storage root must be a directory without symbolic links".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("chapter media: canonicalize storage root: {err}"))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("chapter media: chapter storage path is invalid".to_string());
        };
        current.push(segment);
        let Some(metadata) = storage_metadata(&current, "chapter media: inspect storage path")?
        else {
            break;
        };
        if metadata.is_dir() {
            let canonical = current
                .canonicalize()
                .map_err(|err| format!("chapter media: canonicalize storage path: {err}"))?;
            if !canonical.starts_with(&canonical_root) {
                return Err("chapter media: chapter storage path escaped the storage root".to_string());
            }
        }
    }
    Ok(())
}

fn validate_storage_tree_without_symlinks(path: &Path) -> Result<(), String> {
    let Some(metadata) = storage_metadata(path, "chapter media: inspect storage tree")? else {
        return Ok(());
    };
    if metadata.is_file() {
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("chapter media: storage tree contains an unsupported entry".to_string());
    }
    for entry in
        fs::read_dir(path).map_err(|err| format!("chapter media: read storage tree: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read storage entry: {err}"))?;
        validate_storage_tree_without_symlinks(&entry.path())?;
    }
    Ok(())
}

fn remove_transfer_path(path: &Path, context: &str) -> Result<(), String> {
    let Some(metadata) = storage_metadata(path, context)? else {
        return Ok(());
    };
    if metadata.is_dir() {
        validate_storage_tree_without_symlinks(path)?;
        fs::remove_dir_all(path).map_err(|err| format!("{context}: {err}"))
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(|err| format!("{context}: {err}"))
    } else {
        Err(format!("{context}: unsupported storage entry"))
    }
}

fn copy_storage_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = storage_metadata(source, "chapter media: inspect transfer source")?
        .ok_or_else(|| "chapter media: transfer source disappeared".to_string())?;
    if metadata.is_file() {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("chapter media: copy transfer file: {err}"))?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err("chapter media: transfer source contains an unsupported entry".to_string());
    }
    fs::create_dir(target)
        .map_err(|err| format!("chapter media: create transfer directory: {err}"))?;
    for entry in fs::read_dir(source)
        .map_err(|err| format!("chapter media: read transfer source: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read transfer entry: {err}"))?;
        copy_storage_tree(&entry.path(), &target.join(entry.file_name()))?;
    }
    Ok(())
}

#[derive(Debug)]
struct ChapterStorageTransferArtifacts {
    content_path: PathBuf,
    content_bytes: u64,
    media_bytes: u64,
}

fn storage_tree_file_bytes(path: &Path) -> Result<u64, String> {
    let Some(metadata) = storage_metadata(path, "chapter media: inspect transfer media")? else {
        return Ok(0);
    };
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err("chapter media: transfer media contains an unsupported entry".to_string());
    }
    let mut bytes = 0_u64;
    for entry in fs::read_dir(path)
        .map_err(|err| format!("chapter media: read transfer media: {err}"))?
    {
        let entry =
            entry.map_err(|err| format!("chapter media: read transfer media entry: {err}"))?;
        bytes = bytes
            .checked_add(storage_tree_file_bytes(&entry.path())?)
            .ok_or_else(|| "chapter media: transfer media byte count overflowed".to_string())?;
    }
    Ok(bytes)
}

fn inspect_transfer_artifacts(
    chapter_dir: &Path,
) -> Result<Option<ChapterStorageTransferArtifacts>, String> {
    let Some(directory_metadata) =
        storage_metadata(chapter_dir, "chapter media: inspect transfer chapter")?
    else {
        return Ok(None);
    };
    if !directory_metadata.is_dir() {
        return Ok(None);
    }
    for file_name in ["content.html", "content.pdf"] {
        let content_path = chapter_dir.join(file_name);
        let Some(content_metadata) =
            storage_metadata(&content_path, "chapter media: inspect transfer content")?
        else {
            continue;
        };
        if !content_metadata.is_file() {
            return Err("chapter media: transfer content path is not a file".to_string());
        }
        let media_bytes = storage_tree_file_bytes(&chapter_dir.join(MEDIA_DOWNLOAD_DIR))?
            .checked_add(storage_tree_file_bytes(&chapter_dir.join(MEDIA_ARCHIVE_FILE))?)
            .ok_or_else(|| "chapter media: transfer media byte count overflowed".to_string())?;
        return Ok(Some(ChapterStorageTransferArtifacts {
            content_path,
            content_bytes: content_metadata.len(),
            media_bytes,
        }));
    }
    Ok(None)
}

fn validate_transfer_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || token.len() > 128
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("chapter media: invalid chapter storage transfer token".to_string());
    }
    Ok(())
}

fn chapter_storage_transfer_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{timestamp}-{}", std::process::id())
}

fn transfer_sibling_path(target: &Path, token: &str, kind: &str) -> Result<PathBuf, String> {
    validate_transfer_token(token)?;
    let parent = target
        .parent()
        .ok_or_else(|| "chapter media: transfer target has no parent".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "chapter media: transfer target name is invalid".to_string())?;
    Ok(parent.join(format!(".{name}.norea-transfer-{token}.{kind}")))
}

fn transfer_marker_path(target: &Path, token: &str) -> Result<PathBuf, String> {
    validate_transfer_token(token)?;
    Ok(target.join(format!(".norea-transfer-{token}")))
}

fn has_transfer_marker(target: &Path, token: &str) -> Result<bool, String> {
    let marker = transfer_marker_path(target, token)?;
    match storage_metadata(&marker, "chapter media: inspect transfer marker")? {
        Some(metadata) if metadata.is_file() => Ok(true),
        Some(_) => Err("chapter media: transfer marker is not a file".to_string()),
        None => Ok(false),
    }
}

fn transfer_prepared_entry(
    root: &Path,
    entry: ChapterStorageTransferEntry,
    outcome: ChapterStorageTransferOutcome,
    replaced_target: bool,
    artifacts: Option<ChapterStorageTransferArtifacts>,
) -> Result<ChapterStorageTransferPreparedEntry, String> {
    let (content_file, content_bytes, media_bytes) = if let Some(artifacts) = artifacts {
        (
            Some(relative_storage_path(root, &artifacts.content_path)?),
            artifacts.content_bytes,
            artifacts.media_bytes,
        )
    } else {
        (None, 0, 0)
    };
    Ok(ChapterStorageTransferPreparedEntry {
        entry_id: entry.entry_id,
        source_relative_dir: entry.source_relative_dir,
        target_relative_dir: entry.target_relative_dir,
        outcome,
        replaced_target,
        content_file,
        content_bytes,
        media_bytes,
    })
}

fn prepare_chapter_storage_transfer_entry_at_root(
    root: &Path,
    entry: ChapterStorageTransferEntry,
    token: &str,
) -> Result<ChapterStorageTransferPreparedEntry, String> {
    let source_relative = safe_chapter_storage_relative_dir(&entry.source_relative_dir)?;
    let target_relative = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
    validate_storage_path_ancestors(root, &source_relative)?;
    validate_storage_path_ancestors(root, &target_relative)?;
    let source = root.join(&source_relative);
    let target = root.join(&target_relative);

    if storage_metadata(&target, "chapter media: inspect transfer target")?.is_some() {
        validate_storage_tree_without_symlinks(&target)?;
    }
    if let Some(artifacts) = inspect_transfer_artifacts(&target)? {
        return transfer_prepared_entry(
            root,
            entry,
            ChapterStorageTransferOutcome::KeptTarget,
            false,
            Some(artifacts),
        );
    }

    let Some(source_metadata) =
        storage_metadata(&source, "chapter media: inspect transfer source")?
    else {
        return transfer_prepared_entry(
            root,
            entry,
            ChapterStorageTransferOutcome::SourceNotDownloaded,
            false,
            None,
        );
    };
    if !source_metadata.is_dir() {
        return Err("chapter media: transfer source is not a directory".to_string());
    }
    let Some(source_artifacts) = inspect_transfer_artifacts(&source)? else {
        return transfer_prepared_entry(
            root,
            entry,
            ChapterStorageTransferOutcome::SourceNotDownloaded,
            false,
            None,
        );
    };

    let target_parent = target
        .parent()
        .ok_or_else(|| "chapter media: transfer target has no parent".to_string())?;
    fs::create_dir_all(target_parent)
        .map_err(|err| format!("chapter media: create transfer target parent: {err}"))?;
    validate_storage_path_ancestors(root, &target_relative)?;
    let stage = transfer_sibling_path(&target, token, "stage")?;
    let backup = transfer_sibling_path(&target, token, "backup")?;
    if storage_metadata(&stage, "chapter media: inspect transfer stage")?.is_some()
        || storage_metadata(&backup, "chapter media: inspect transfer backup")?.is_some()
    {
        return Err("chapter media: chapter storage transfer workspace already exists".to_string());
    }

    let mut replaced_target = false;
    let mut published_target = false;
    let result = (|| -> Result<ChapterStorageTransferPreparedEntry, String> {
        copy_storage_tree(&source, &stage)?;
        let marker = transfer_marker_path(&stage, token)?;
        if storage_metadata(&marker, "chapter media: inspect transfer marker")?.is_some() {
            return Err("chapter media: transfer marker already exists in copied source".to_string());
        }
        fs::write(&marker, token)
            .map_err(|err| format!("chapter media: write transfer marker: {err}"))?;
        let staged_artifacts = inspect_transfer_artifacts(&stage)?.ok_or_else(|| {
            "chapter media: copied transfer stage has no final content".to_string()
        })?;
        if staged_artifacts.content_bytes != source_artifacts.content_bytes
            || staged_artifacts.media_bytes != source_artifacts.media_bytes
        {
            return Err(
                "chapter media: copied transfer stage failed artifact verification".to_string(),
            );
        }

        if let Some(target_artifacts) = inspect_transfer_artifacts(&target)? {
            remove_transfer_path(&stage, "chapter media: remove superseded transfer stage")?;
            return transfer_prepared_entry(
                root,
                entry.clone(),
                ChapterStorageTransferOutcome::KeptTarget,
                false,
                Some(target_artifacts),
            );
        }

        replaced_target = storage_metadata(&target, "chapter media: inspect transfer target")?
            .is_some();
        if replaced_target {
            fs::rename(&target, &backup)
                .map_err(|err| format!("chapter media: backup invalid transfer target: {err}"))?;
        }
        fs::rename(&stage, &target)
            .map_err(|err| format!("chapter media: publish chapter storage transfer: {err}"))?;
        published_target = true;
        let target_artifacts = inspect_transfer_artifacts(&target)?.ok_or_else(|| {
            "chapter media: published transfer target has no final content".to_string()
        })?;
        transfer_prepared_entry(
            root,
            entry.clone(),
            ChapterStorageTransferOutcome::CopiedSource,
            replaced_target,
            Some(target_artifacts),
        )
    })();
    match result {
        Ok(prepared) => Ok(prepared),
        Err(error) => {
            let mut recovery_errors = Vec::new();
            if published_target {
                if let Err(recovery_error) = remove_transfer_path(
                    &target,
                    "chapter media: remove failed published transfer target",
                ) {
                    recovery_errors.push(recovery_error);
                }
            }
            if replaced_target {
                match storage_metadata(&backup, "chapter media: inspect transfer backup") {
                    Ok(Some(_)) => {
                        if let Err(restore_error) = fs::rename(&backup, &target) {
                            recovery_errors.push(format!(
                                "chapter media: restore failed transfer target: {restore_error}"
                            ));
                        }
                    }
                    Ok(None) => recovery_errors.push(
                        "chapter media: transfer backup is missing during recovery".to_string(),
                    ),
                    Err(inspect_error) => recovery_errors.push(inspect_error),
                }
            }
            if let Err(recovery_error) =
                remove_transfer_path(&stage, "chapter media: remove failed transfer stage")
            {
                recovery_errors.push(recovery_error);
            }
            if recovery_errors.is_empty() {
                Err(error)
            } else {
                Err(format!(
                    "{error}; chapter storage transfer entry recovery failed: {}",
                    recovery_errors.join("; ")
                ))
            }
        }
    }
}

fn validate_transfer_entries(entries: &[ChapterStorageTransferEntry]) -> Result<(), String> {
    if entries.is_empty() {
        return Err("chapter media: chapter storage transfer is empty".to_string());
    }
    let mut entry_ids = HashSet::new();
    let mut sources = HashSet::new();
    let mut targets = HashSet::new();
    for entry in entries {
        if entry.entry_id.trim().is_empty() || !entry_ids.insert(entry.entry_id.clone()) {
            return Err("chapter media: duplicate or empty transfer entry id".to_string());
        }
        let source = safe_chapter_storage_relative_dir(&entry.source_relative_dir)?;
        let target = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
        if source == target {
            return Err("chapter media: transfer source and target must differ".to_string());
        }
        if !sources.insert(source) {
            return Err("chapter media: duplicate transfer source".to_string());
        }
        if !targets.insert(target) {
            return Err("chapter media: duplicate target in chapter storage transfer".to_string());
        }
    }
    Ok(())
}

fn prepare_chapter_storage_transfer_at_root(
    root: &Path,
    entries: Vec<ChapterStorageTransferEntry>,
    token: &str,
) -> Result<ChapterStorageTransferPreparation, String> {
    validate_transfer_token(token)?;
    validate_transfer_entries(&entries)?;
    fs::create_dir_all(root)
        .map_err(|err| format!("chapter media: create storage root for transfer: {err}"))?;
    ensure_contents_nomedia(root)?;
    let mut preparation = ChapterStorageTransferPreparation {
        token: token.to_string(),
        entries: Vec::with_capacity(entries.len()),
    };
    for entry in entries {
        match prepare_chapter_storage_transfer_entry_at_root(root, entry, token) {
            Ok(prepared) => preparation.entries.push(prepared),
            Err(error) => {
                return match rollback_chapter_storage_transfer_at_root(root, &preparation) {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(format!(
                        "{error}; chapter storage transfer rollback failed: {rollback_error}"
                    )),
                };
            }
        }
    }
    Ok(preparation)
}

fn validate_transfer_preparation(
    preparation: &ChapterStorageTransferPreparation,
) -> Result<(), String> {
    validate_transfer_token(&preparation.token)?;
    let entries = preparation
        .entries
        .iter()
        .map(|entry| ChapterStorageTransferEntry {
            entry_id: entry.entry_id.clone(),
            source_relative_dir: entry.source_relative_dir.clone(),
            target_relative_dir: entry.target_relative_dir.clone(),
        })
        .collect::<Vec<_>>();
    validate_transfer_entries(&entries)
}

fn finalize_chapter_storage_transfer_at_root(
    root: &Path,
    preparation: &ChapterStorageTransferPreparation,
) -> Result<(), String> {
    validate_transfer_preparation(preparation)?;
    for entry in &preparation.entries {
        let source_relative = safe_chapter_storage_relative_dir(&entry.source_relative_dir)?;
        let target_relative = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
        validate_storage_path_ancestors(root, &source_relative)?;
        validate_storage_path_ancestors(root, &target_relative)?;
        let target = root.join(target_relative);
        let stage = transfer_sibling_path(&target, &preparation.token, "stage")?;
        let backup = transfer_sibling_path(&target, &preparation.token, "backup")?;
        remove_transfer_path(&stage, "chapter media: remove finalized transfer stage")?;
        if entry.outcome == ChapterStorageTransferOutcome::CopiedSource {
            if inspect_transfer_artifacts(&target)?.is_none() {
                return Err(
                    "chapter media: cannot finalize transfer without final target content"
                        .to_string(),
                );
            }
            let source = root.join(source_relative);
            let source_exists = storage_metadata(
                &source,
                "chapter media: inspect finalized transfer source",
            )?
            .is_some();
            if source_exists && !has_transfer_marker(&target, &preparation.token)? {
                return Err(
                    "chapter media: cannot finalize an unmarked transfer target".to_string(),
                );
            }
            if source_exists {
                remove_transfer_path(
                    &source,
                    "chapter media: remove finalized transfer source",
                )?;
            }
            remove_transfer_path(
                &transfer_marker_path(&target, &preparation.token)?,
                "chapter media: remove finalized transfer marker",
            )?;
        }
        remove_transfer_path(&backup, "chapter media: remove finalized transfer backup")?;
    }
    Ok(())
}

fn rollback_chapter_storage_transfer_at_root(
    root: &Path,
    preparation: &ChapterStorageTransferPreparation,
) -> Result<(), String> {
    validate_transfer_preparation(preparation)?;
    for entry in preparation.entries.iter().rev() {
        let target_relative = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
        validate_storage_path_ancestors(root, &target_relative)?;
        let target = root.join(target_relative);
        let stage = transfer_sibling_path(&target, &preparation.token, "stage")?;
        let backup = transfer_sibling_path(&target, &preparation.token, "backup")?;
        remove_transfer_path(&stage, "chapter media: remove rolled back transfer stage")?;
        if entry.outcome != ChapterStorageTransferOutcome::CopiedSource {
            continue;
        }
        if entry.replaced_target {
            if storage_metadata(&backup, "chapter media: inspect transfer backup")?.is_some() {
                if has_transfer_marker(&target, &preparation.token)? {
                    remove_transfer_path(
                        &target,
                        "chapter media: remove rolled back transfer target",
                    )?;
                }
                if storage_metadata(&target, "chapter media: inspect rollback target")?.is_some() {
                    return Err(
                        "chapter media: cannot restore transfer backup over an unmarked target"
                            .to_string(),
                    );
                }
                fs::rename(&backup, &target)
                    .map_err(|err| format!("chapter media: restore transfer target: {err}"))?;
            }
        } else if has_transfer_marker(&target, &preparation.token)? {
            remove_transfer_path(&target, "chapter media: remove rolled back transfer target")?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_storage_prepare_transfer(
    app: AppHandle,
    entries: Vec<ChapterStorageTransferEntry>,
) -> Result<ChapterStorageTransferPreparation, String> {
    chapter_media_blocking("prepare chapter storage transfer", move || {
        let root = media_root(&app)?;
        let preparation = prepare_chapter_storage_transfer_at_root(
            &root,
            entries,
            &chapter_storage_transfer_token(),
        )?;
        delete_legacy_storage_manifest(&root)?;
        Ok(preparation)
    })
    .await
}

#[tauri::command]
pub async fn chapter_storage_finalize_transfer(
    app: AppHandle,
    preparation: ChapterStorageTransferPreparation,
) -> Result<(), String> {
    chapter_media_blocking("finalize chapter storage transfer", move || {
        let root = media_root(&app)?;
        finalize_chapter_storage_transfer_at_root(&root, &preparation)?;
        delete_legacy_storage_manifest(&root)
    })
    .await
}

#[tauri::command]
pub async fn chapter_storage_rollback_transfer(
    app: AppHandle,
    preparation: ChapterStorageTransferPreparation,
) -> Result<(), String> {
    chapter_media_blocking("rollback chapter storage transfer", move || {
        let root = media_root(&app)?;
        rollback_chapter_storage_transfer_at_root(&root, &preparation)?;
        delete_legacy_storage_manifest(&root)
    })
    .await
}

#[tauri::command]
pub async fn chapter_storage_remove_dir(
    app: AppHandle,
    relative_dir: String,
) -> Result<(), String> {
    chapter_media_blocking("remove storage dir", move || {
        chapter_storage_remove_dir_sync(app, relative_dir)
    })
    .await
}

fn chapter_storage_remove_dir_sync(app: AppHandle, relative_dir: String) -> Result<(), String> {
    let media_root = media_root(&app)?;
    let relative_dir = safe_chapter_storage_removal_relative_dir(&relative_dir)?;
    if storage_metadata(&media_root, "chapter media: inspect storage root")?.is_none() {
        return Ok(());
    }
    validate_storage_path_ancestors(&media_root, &relative_dir)?;
    let path = media_root.join(relative_dir);
    remove_transfer_path(&path, "chapter media: remove chapter storage dir")?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub async fn chapter_storage_relocate_dir(
    app: AppHandle,
    old_relative_dir: String,
    new_relative_dir: String,
) -> Result<(), String> {
    chapter_media_blocking("relocate storage dir", move || {
        chapter_storage_relocate_dir_sync(app, old_relative_dir, new_relative_dir)
    })
    .await
}

fn chapter_storage_relocate_dir_sync(
    app: AppHandle,
    old_relative_dir: String,
    new_relative_dir: String,
) -> Result<(), String> {
    let media_root = media_root(&app)?;
    let old_relative_dir = safe_relative_storage_path(&old_relative_dir)?;
    let new_relative_dir = safe_relative_storage_path(&new_relative_dir)?;
    if old_relative_dir == new_relative_dir {
        return Ok(());
    }

    let old_path = media_root.join(old_relative_dir);
    let new_path = media_root.join(new_relative_dir);
    if !old_path.exists() {
        return Ok(());
    }
    if !old_path.is_dir() {
        return Err("chapter media: old chapter storage path is not a directory".to_string());
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("chapter media: create relocated storage parent: {err}"))?;
    }
    remove_existing_path(&new_path, "chapter media: remove relocated storage target")?;
    fs::rename(&old_path, &new_path)
        .map_err(|err| format!("chapter media: relocate chapter storage dir: {err}"))?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub async fn chapter_storage_prune_dir_children(
    app: AppHandle,
    relative_dir: String,
    keep_names: Vec<String>,
) -> Result<(), String> {
    chapter_media_blocking("prune storage dir children", move || {
        chapter_storage_prune_dir_children_sync(app, relative_dir, keep_names)
    })
    .await
}

fn chapter_storage_prune_dir_children_sync(
    app: AppHandle,
    relative_dir: String,
    keep_names: Vec<String>,
) -> Result<(), String> {
    let media_root = media_root(&app)?;
    let relative_dir = safe_relative_storage_path(&relative_dir)?;
    let path = media_root.join(relative_dir);
    if !path.is_dir() {
        return Ok(());
    }
    let keep_names = keep_names
        .into_iter()
        .filter(|name| !name.is_empty() && !name.contains('/') && !name.contains('\\'))
        .collect::<std::collections::HashSet<_>>();
    for entry in fs::read_dir(&path).map_err(|err| format!("chapter media: read dir: {err}"))? {
        let entry = entry.map_err(|err| format!("chapter media: read entry: {err}"))?;
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if keep_names.contains(&entry_name) {
            continue;
        }
        let child_path = entry.path();
        if child_path.is_dir() {
            fs::remove_dir_all(&child_path)
                .map_err(|err| format!("chapter media: remove stale storage dir: {err}"))?;
        }
    }
    delete_legacy_storage_manifest(&media_root)
}

fn restore_token() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn validate_restore_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || !token
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err("chapter media: invalid restore token".to_string());
    }
    Ok(())
}

fn restore_backup_path(root: &Path, token: &str, index: usize) -> Result<PathBuf, String> {
    validate_restore_token(token)?;
    let parent = root
        .parent()
        .ok_or_else(|| "chapter media: storage root has no parent".to_string())?;
    let name = root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("chapter-media");
    Ok(parent.join(format!("{name}{MEDIA_RESTORE_BACKUP_INFIX}{token}-{index}")))
}

fn restore_backup_roots(app: &AppHandle, token: &str) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    media_roots_for_lookup(app)?
        .into_iter()
        .enumerate()
        .map(|(index, root)| {
            let backup = restore_backup_path(&root, token, index)?;
            Ok((root, backup))
        })
        .collect()
}

#[tauri::command]
pub async fn chapter_media_begin_restore(app: AppHandle) -> Result<String, String> {
    chapter_media_blocking("begin restore", move || {
        chapter_media_begin_restore_sync(app)
    })
    .await
}

fn chapter_media_begin_restore_sync(app: AppHandle) -> Result<String, String> {
    let token = restore_token();
    let mut moved_roots: Vec<(PathBuf, PathBuf)> = Vec::new();
    let result = (|| -> Result<(), String> {
        for (root, backup) in restore_backup_roots(&app, &token)? {
            remove_existing_path(&backup, "chapter media: remove stale restore backup")?;
            if root.exists() {
                if let Some(parent) = backup.parent() {
                    fs::create_dir_all(parent).map_err(|err| {
                        format!("chapter media: create restore backup dir: {err}")
                    })?;
                }
                fs::rename(&root, &backup)
                    .map_err(|err| format!("chapter media: backup storage root: {err}"))?;
                moved_roots.push((root.clone(), backup));
            }
            ensure_contents_nomedia(&root)?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        for (root, backup) in moved_roots.into_iter().rev() {
            let _ = remove_existing_path(&root, "chapter media: remove failed restore root");
            let _ = fs::rename(&backup, &root);
        }
        return Err(error);
    }
    Ok(token)
}

#[tauri::command]
pub async fn chapter_media_commit_restore(app: AppHandle, token: String) -> Result<(), String> {
    chapter_media_blocking("commit restore", move || {
        chapter_media_commit_restore_sync(app, token)
    })
    .await
}

fn chapter_media_commit_restore_sync(app: AppHandle, token: String) -> Result<(), String> {
    for (_, backup) in restore_backup_roots(&app, &token)? {
        remove_existing_path(&backup, "chapter media: remove restore backup")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_rollback_restore(app: AppHandle, token: String) -> Result<(), String> {
    chapter_media_blocking("rollback restore", move || {
        chapter_media_rollback_restore_sync(app, token)
    })
    .await
}

fn chapter_media_rollback_restore_sync(app: AppHandle, token: String) -> Result<(), String> {
    for (root, backup) in restore_backup_roots(&app, &token)? {
        remove_existing_path(&root, "chapter media: remove failed restore root")?;
        if backup.exists() {
            if let Some(parent) = root.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("chapter media: create restore root parent: {err}"))?;
            }
            fs::rename(&backup, &root)
                .map_err(|err| format!("chapter media: rollback restore backup: {err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_prune(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    chapter_media_blocking("prune", move || {
        chapter_media_prune_sync(
            app,
            chapter_id,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

fn chapter_media_prune_sync(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    for root in media_roots_for_lookup(&app)? {
        if let Some(chapter_dir) = content_chapter_dir_from_context(
            &root,
            novel_id,
            source_id.as_deref(),
            novel_path.as_deref(),
            novel_name.as_deref(),
            chapter_id,
            chapter_number.as_deref(),
            chapter_name.as_deref(),
            chapter_position,
        )? {
            prune_chapter_dir(&chapter_dir)?;
        }
        for chapter_dir in content_chapter_dirs_for_lookup(&root, chapter_id)? {
            prune_chapter_dir(&chapter_dir)?;
        }
        prune_chapter_dir(&chapter_dir_at(&root, chapter_id)?)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_clear(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    chapter_media_blocking("clear", move || {
        chapter_media_clear_sync(
            app,
            chapter_id,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

fn chapter_media_clear_sync<R: Runtime>(
    app: AppHandle<R>,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    for root in media_roots_for_lookup(&app)? {
        if let Some(chapter_dir) = content_chapter_dir_from_context(
            &root,
            novel_id,
            source_id.as_deref(),
            novel_path.as_deref(),
            novel_name.as_deref(),
            chapter_id,
            chapter_number.as_deref(),
            chapter_name.as_deref(),
            chapter_position,
        )? {
            clear_content_media_artifacts(&chapter_dir)?;
        }

        for chapter_dir in content_chapter_dirs_for_lookup(&root, chapter_id)? {
            clear_content_media_artifacts(&chapter_dir)?;
        }

        let dir = chapter_dir_at(&root, chapter_id)?;
        if dir.exists() {
            fs::remove_dir_all(dir)
                .map_err(|err| format!("chapter media: remove chapter dir: {err}"))?;
        }
    }
    Ok(())
}

pub(crate) fn clear_downloaded_chapter_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    context: &ChapterMediaClearContext,
) -> Result<(), String> {
    for root in media_roots_for_lookup(app)? {
        let mut chapter_dirs = HashSet::new();
        let has_storage_identity = if let (Some(novel_id), Some(source_id), Some(novel_path)) = (
            context.novel_id,
            context.source_id.as_deref(),
            context.novel_path.as_deref(),
        ) {
            let identity_dirs = content_chapter_dirs_matching_identity(
                &root,
                source_id,
                novel_id,
                novel_path,
                context.chapter_id,
                context.chapter_number.as_deref(),
                context.chapter_position,
            )?;
            if identity_dirs.len() > 1 {
                return Err(format!(
                    "chapter media: multiple stored chapter folders match chapter {}; delete the intended chapter folders manually",
                    context.chapter_id
                ));
            }
            chapter_dirs.insert(content_chapter_dir_at(
                &root,
                source_id,
                novel_id,
                Some(novel_path),
                context.novel_name.as_deref(),
                context.chapter_id,
                context.chapter_number.as_deref(),
                context.chapter_name.as_deref(),
                context.chapter_position,
            )?);
            chapter_dirs.extend(identity_dirs);
            true
        } else {
            false
        };
        if !has_storage_identity {
            chapter_dirs.extend(content_chapter_dirs_for_lookup(&root, context.chapter_id)?);
        }

        for chapter_dir in chapter_dirs {
            match fs::metadata(&chapter_dir) {
                Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&chapter_dir)
                    .map_err(|err| format!("chapter media: remove chapter dir: {err}"))?,
                Ok(_) => {
                    return Err(format!(
                        "chapter media: chapter storage path is not a directory: {}",
                        chapter_dir.display()
                    ));
                }
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => return Err(format!("chapter media: inspect chapter dir: {err}")),
            }
        }

        delete_legacy_storage_manifest(&root)?;

        let legacy_dir = chapter_dir_at(&root, context.chapter_id)?;
        if legacy_dir.exists() {
            fs::remove_dir_all(legacy_dir)
                .map_err(|err| format!("chapter media: remove chapter dir: {err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_clear_all(app: AppHandle) -> Result<(), String> {
    chapter_media_blocking("clear all", move || chapter_media_clear_all_sync(app)).await
}

fn chapter_media_clear_all_sync(app: AppHandle) -> Result<(), String> {
    for root in media_roots_for_lookup(&app)? {
        if root.exists() {
            clear_storage_root(&root)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn store_input(file_name: &str) -> ChapterMediaStoreInput {
        ChapterMediaStoreInput {
            chapter_id: 42,
            file_name: file_name.to_string(),
            novel_id: Some(7),
            source_id: Some("demo".to_string()),
            novel_name: Some("Novel".to_string()),
            novel_path: Some("novel/path".to_string()),
            chapter_number: Some("1".to_string()),
            chapter_name: Some("Opening".to_string()),
            chapter_position: Some(1),
        }
    }

    fn stored_media_path(root: &Path, file_name: &str) -> PathBuf {
        root.join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Novel-novel-path")
            .join("1-Opening")
            .join(MEDIA_DOWNLOAD_DIR)
            .join(file_name)
    }

    fn novel_cover_manifest(
        file_name: &str,
        source_url: &str,
        updated_at: u64,
        identity: Option<(&str, &str)>,
    ) -> String {
        let mut manifest = serde_json::json!({
            "contentType": "image/jpeg",
            "fileName": file_name,
            "sourceUrl": source_url,
            "updatedAt": updated_at,
            "version": 1
        });
        if let Some((source_id, novel_path)) = identity {
            manifest["sourceId"] = serde_json::json!(source_id);
            manifest["novelPath"] = serde_json::json!(novel_path);
        }
        manifest.to_string()
    }

    fn write_novel_cover(
        root: &Path,
        novel_dir_name: &str,
        source_url: &str,
        updated_at: u64,
        identity: Option<(&str, &str)>,
    ) {
        let novel_dir = root
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join(novel_dir_name);
        fs::create_dir_all(&novel_dir).expect("create novel cover directory");
        fs::write(novel_dir.join("cover.jpg"), b"cover").expect("write novel cover");
        fs::write(
            novel_dir.join(NOVEL_COVER_MANIFEST_FILE),
            novel_cover_manifest("cover.jpg", source_url, updated_at, identity),
        )
        .expect("write novel cover manifest");
    }

    #[test]
    fn content_novel_dir_accepts_a_path_without_a_persisted_novel_id() {
        let dir = content_novel_dir_at(
            Path::new("root"),
            "demo",
            0,
            Some("/foo//bar"),
            Some("Novel"),
        )
        .expect("resolve source search novel directory");

        assert_eq!(
            dir,
            Path::new("root")
                .join(CONTENTS_ROOT_DIR)
                .join("demo")
                .join("Novel-foo--bar")
        );
        assert_eq!(
            relative_storage_path(Path::new("root"), &dir.join("cover.jpg"))
                .expect("resolve native cover path"),
            "contents/demo/Novel-foo--bar/cover.jpg"
        );
    }

    #[test]
    fn content_novel_dir_rejects_a_missing_id_and_path() {
        let error = content_novel_dir_at(Path::new("root"), "demo", 0, None, Some("Novel"))
            .expect_err("reject an unidentified novel directory");

        assert_eq!(error, "chapter media: invalid novel id");
    }

    #[test]
    fn content_novel_dir_rejects_a_negative_id_even_with_a_path() {
        assert!(content_novel_dir_at(
            Path::new("root"),
            "demo",
            -1,
            Some("novel/path"),
            Some("Novel"),
        )
        .is_err());
    }

    #[test]
    fn novel_cover_lookup_accepts_a_legacy_manifest_in_the_preferred_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Current-Title-novel-path",
            "https://source.test/current.jpg",
            1,
            None,
        );

        let cover = novel_cover_read_manifest_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            None,
        )
        .expect("read preferred cover")
        .expect("preferred cover");

        assert_eq!(
            cover.relative_path,
            "contents/demo/Current-Title-novel-path/cover.jpg"
        );
        assert!(cover.manifest.contains("current.jpg"));
    }

    #[test]
    fn novel_cover_lookup_returns_none_without_an_identity_match() {
        let dir = tempfile::tempdir().expect("tempdir");

        assert!(
            novel_cover_read_manifest_at(
                dir.path(),
                7,
                "demo",
                "Current Title",
                "novel/path",
                None,
            )
            .expect("read missing cover")
            .is_none()
        );
    }

    #[test]
    fn novel_cover_lookup_ignores_an_empty_cover_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Old-Title-novel-path",
            "https://source.test/old.jpg",
            1,
            Some(("demo", "novel/path")),
        );
        fs::write(
            dir.path()
                .join(CONTENTS_ROOT_DIR)
                .join("demo")
                .join("Old-Title-novel-path")
                .join("cover.jpg"),
            b"",
        )
        .expect("empty novel cover");

        assert!(
            novel_cover_read_manifest_at(
                dir.path(),
                7,
                "demo",
                "Current Title",
                "novel/path",
                None,
            )
            .expect("read empty cover")
            .is_none()
        );
    }

    #[test]
    fn novel_cover_lookup_reuses_an_identity_manifest_from_an_older_title_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Old-Title-novel-path",
            "https://source.test/old.jpg",
            1,
            Some(("demo", "novel/path")),
        );

        let cover = novel_cover_read_manifest_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            None,
        )
        .expect("read renamed cover")
        .expect("renamed cover");

        assert_eq!(
            cover.relative_path,
            "contents/demo/Old-Title-novel-path/cover.jpg"
        );
    }

    #[test]
    fn novel_cover_lookup_rejects_a_mismatched_identity_in_the_preferred_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Current-Title-novel-path",
            "https://source.test/other.jpg",
            1,
            Some(("demo", "other/path")),
        );

        assert!(
            novel_cover_read_manifest_at(
                dir.path(),
                7,
                "demo",
                "Current Title",
                "novel/path",
                None,
            )
            .expect("read mismatched preferred cover")
            .is_none()
        );
    }

    #[test]
    fn novel_cover_lookup_requires_an_exact_source_url_for_a_legacy_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Old-Title-novel-path",
            "https://source.test/cover.jpg",
            1,
            None,
        );

        assert!(
            novel_cover_read_manifest_at(
                dir.path(),
                7,
                "demo",
                "Current Title",
                "novel/path",
                None,
            )
            .expect("read legacy cover without a source URL")
            .is_none()
        );
        assert!(
            novel_cover_read_manifest_at(
                dir.path(),
                7,
                "demo",
                "Current Title",
                "novel/path",
                Some("https://source.test/other.jpg"),
            )
            .expect("read legacy cover with a different source URL")
            .is_none()
        );

        let cover = novel_cover_read_manifest_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            Some("https://source.test/cover.jpg"),
        )
        .expect("read matching legacy cover")
        .expect("matching legacy cover");

        assert_eq!(
            cover.relative_path,
            "contents/demo/Old-Title-novel-path/cover.jpg"
        );
    }

    #[test]
    fn novel_cover_lookup_excludes_a_suffix_collision_using_manifest_identity() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Other-Title-foo-abc",
            "https://source.test/other.jpg",
            1,
            Some(("demo", "foo/abc")),
        );

        assert!(
            novel_cover_read_manifest_at(
                dir.path(),
                7,
                "demo",
                "Current Title",
                "abc",
                None,
            )
            .expect("read colliding cover")
            .is_none()
        );
    }

    #[test]
    fn novel_cover_lookup_selects_the_latest_matching_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "First-Title-novel-path",
            "https://source.test/first.jpg",
            2,
            Some(("demo", "novel/path")),
        );
        write_novel_cover(
            dir.path(),
            "Second-Title-novel-path",
            "https://source.test/second.jpg",
            3,
            Some(("demo", "novel/path")),
        );

        let cover = novel_cover_read_manifest_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            None,
        )
        .expect("read latest cover")
        .expect("latest cover");

        assert_eq!(
            cover.relative_path,
            "contents/demo/Second-Title-novel-path/cover.jpg"
        );
    }

    #[test]
    fn novel_cover_lookup_prefers_the_current_title_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Current-Title-novel-path",
            "https://source.test/current.jpg",
            1,
            Some(("demo", "novel/path")),
        );
        write_novel_cover(
            dir.path(),
            "Old-Title-novel-path",
            "https://source.test/old.jpg",
            2,
            Some(("demo", "novel/path")),
        );

        let cover = novel_cover_read_manifest_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            None,
        )
        .expect("read preferred cover")
        .expect("preferred cover");

        assert_eq!(
            cover.relative_path,
            "contents/demo/Current-Title-novel-path/cover.jpg"
        );
    }

    #[test]
    fn novel_cover_lookup_breaks_updated_at_ties_by_relative_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Second-Title-novel-path",
            "https://source.test/second.jpg",
            3,
            Some(("demo", "novel/path")),
        );
        write_novel_cover(
            dir.path(),
            "First-Title-novel-path",
            "https://source.test/first.jpg",
            3,
            Some(("demo", "novel/path")),
        );

        let cover = novel_cover_read_manifest_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            None,
        )
        .expect("read deterministic cover")
        .expect("deterministic cover");

        assert_eq!(
            cover.relative_path,
            "contents/demo/First-Title-novel-path/cover.jpg"
        );
    }

    #[test]
    fn novel_cover_store_reuses_a_matching_identity_title_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Old-Title-novel-path",
            "https://source.test/cover.jpg",
            1,
            Some(("demo", "novel/path")),
        );
        let manifest = novel_cover_manifest(
            "new-cover.webp",
            "https://source.test/cover.jpg",
            2,
            Some(("demo", "novel/path")),
        );

        novel_cover_store_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            "new-cover.webp",
            b"new cover",
            &manifest,
        )
        .expect("store cover in the existing title directory");

        let old_title_dir = dir
            .path()
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Old-Title-novel-path");
        assert_eq!(
            fs::read(old_title_dir.join("new-cover.webp")).expect("read updated cover"),
            b"new cover"
        );
        assert_eq!(
            fs::read_to_string(old_title_dir.join(NOVEL_COVER_MANIFEST_FILE))
                .expect("read updated manifest"),
            manifest
        );
        assert!(!old_title_dir.join("cover.jpg").exists());
        assert!(!dir
            .path()
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Current-Title-novel-path")
            .exists());
    }

    #[test]
    fn novel_cover_store_does_not_reuse_a_legacy_title_fallback() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_novel_cover(
            dir.path(),
            "Old-Title-novel-path",
            "https://source.test/cover.jpg",
            1,
            None,
        );
        let manifest = novel_cover_manifest(
            "cover.jpg",
            "https://source.test/cover.jpg",
            2,
            Some(("demo", "novel/path")),
        );

        novel_cover_store_at(
            dir.path(),
            7,
            "demo",
            "Current Title",
            "novel/path",
            "cover.jpg",
            b"new cover",
            &manifest,
        )
        .expect("store cover in the current title directory");

        let old_title_dir = dir
            .path()
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Old-Title-novel-path");
        let current_title_dir = dir
            .path()
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Current-Title-novel-path");
        assert_eq!(
            fs::read(old_title_dir.join("cover.jpg")).expect("read legacy cover"),
            b"cover"
        );
        assert_eq!(
            fs::read(current_title_dir.join("cover.jpg")).expect("read current cover"),
            b"new cover"
        );
        assert_eq!(
            fs::read_to_string(current_title_dir.join(NOVEL_COVER_MANIFEST_FILE))
                .expect("read current manifest"),
            manifest
        );
    }

    #[test]
    fn image_signature_overrides_disguised_media_extension() {
        let cases: &[(&[u8], &str)] = &[
            (b"\xff\xd8\xff\xe0image-body", "image/jpeg"),
            (b"\x89PNG\r\n\x1a\nimage-body", "image/png"),
            (b"GIF89aimage-body", "image/gif"),
            (b"RIFF\x08\x00\x00\x00WEBPimage-body", "image/webp"),
            (b"BMimage-body", "image/bmp"),
            (
                b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00avifmif1",
                "image/avif",
            ),
        ];

        for (body, expected) in cases {
            assert_eq!(
                norea_media_content_type(Path::new("page.woff"), body),
                *expected
            );
            assert_eq!(media_mime_type(Path::new("page.css"), body), *expected);
        }
    }

    #[test]
    fn non_image_media_preserves_extension_fallback() {
        assert_eq!(
            media_mime_type(Path::new("audio.mp3"), b"not-an-image"),
            "audio/mpeg"
        );
    }

    #[test]
    fn store_chapter_media_body_writes_contextual_media_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = store_chapter_media_at_root(
            dir.path(),
            store_input("page.png"),
            ChapterMediaStoreSource::Bytes(vec![1, 2, 3]),
        )
        .expect("store media");

        assert_eq!(src, "norea-media://reader-asset/page.png");
        assert_eq!(
            fs::read(stored_media_path(dir.path(), "page.png")).expect("stored media"),
            vec![1, 2, 3]
        );
        assert!(
            dir.path()
                .join(CONTENTS_ROOT_DIR)
                .join(NO_MEDIA_FILE)
                .exists()
        );
    }

    #[test]
    fn store_chapter_media_file_consumes_source_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source_path = dir.path().join("stream.bin");
        fs::write(&source_path, [7, 8, 9]).expect("write stream");

        let src = store_chapter_media_at_root(
            dir.path(),
            store_input("page.png"),
            ChapterMediaStoreSource::File(source_path.clone()),
        )
        .expect("store media handle");

        assert_eq!(src, "norea-media://reader-asset/page.png");
        assert!(!source_path.exists());
        assert_eq!(
            fs::read(stored_media_path(dir.path(), "page.png")).expect("stored media"),
            vec![7, 8, 9]
        );
    }

    #[test]
    fn media_path_from_chapter_dir_does_not_extract_archived_media() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = dir.path().join("chapter");
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        {
            let archive_file = File::create(&archive_path).expect("create archive");
            let mut archive = ZipWriter::new(BufWriter::new(archive_file));
            archive
                .start_file("page.png", SimpleFileOptions::default())
                .expect("start archive entry");
            io::copy(&mut &b"image-body"[..], &mut archive).expect("write archive entry");
            archive.finish().expect("finish archive");
        }

        let path =
            media_path_from_chapter_dir(&chapter_dir, "page.png").expect("resolve archived media");
        let body = media_body_from_chapter_dir(&chapter_dir, "page.png")
            .expect("read archived media")
            .expect("archived media body");

        assert!(path.is_none());
        assert_eq!(body, b"image-body");
        assert!(
            !chapter_dir
                .join(MEDIA_DOWNLOAD_DIR)
                .join("page.png")
                .exists()
        );
    }

    #[test]
    fn write_chapter_media_manifest_replaces_existing_manifest() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_path = dir.path().join(CHAPTER_MEDIA_MANIFEST_FILE);

        write_chapter_media_manifest(
            &manifest_path,
            &serde_json::json!({
                "version": 1,
                "complete": false,
                "media": { "files": [{ "fileName": "old.png" }] }
            }),
        )
        .expect("write initial manifest");
        write_chapter_media_manifest(
            &manifest_path,
            &serde_json::json!({
                "version": 1,
                "complete": true,
                "media": { "files": [{ "fileName": "new.png" }] }
            }),
        )
        .expect("replace manifest");

        let manifest = fs::read_to_string(&manifest_path).expect("read replaced media manifest");
        assert!(manifest.contains("new.png"));
        assert!(!manifest.contains("old.png"));
        assert!(!manifest_path.with_extension("json.tmp").exists());
        assert!(!chapter_media_manifest_backup_path(&manifest_path).exists());
    }

    #[test]
    fn manifest_publication_replaces_current_when_recovery_slots_are_occupied() {
        let dir = tempfile::tempdir().expect("tempdir");
        let manifest_path = dir.path().join(CHAPTER_MEDIA_MANIFEST_FILE);
        let backup_path = chapter_media_manifest_backup_path(&manifest_path);
        let rollback_path = chapter_media_manifest_rollback_path(&manifest_path);
        fs::write(&manifest_path, b"current").expect("write current manifest");
        fs::write(&backup_path, b"recovery").expect("write recovery manifest");
        fs::write(&rollback_path, b"blocked").expect("write rollback blocker");

        write_chapter_media_manifest(
            &manifest_path,
            &serde_json::json!({
                "version": 1,
                "complete": true,
                "updatedAt": 1,
                "media": { "files": [] }
            }),
        )
        .expect("publish manifest");

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&manifest_path).expect("read published manifest"),
        )
        .expect("parse published manifest");
        assert_eq!(manifest["complete"], true);
        assert!(!backup_path.exists());
        assert!(!rollback_path.exists());
    }

    fn write_recovery_manifest(chapter_dir: &Path, complete: bool, files: serde_json::Value) {
        write_chapter_media_manifest(
            &chapter_media_manifest_path(chapter_dir),
            &serde_json::json!({
                "version": 1,
                "complete": complete,
                "updatedAt": 1,
                "media": { "files": files }
            }),
        )
        .expect("write recovery manifest");
    }

    fn stored_manifest_file(file_name: &str, bytes: u64) -> serde_json::Value {
        serde_json::json!({
            "bytes": bytes,
            "contentType": "image/png",
            "fileName": file_name,
            "path": format!("media/{file_name}"),
            "sourceUrl": format!("https://example.test/{file_name}"),
            "status": "stored",
            "updatedAt": 1
        })
    }

    #[test]
    fn chapter_media_manifest_rejects_unsafe_stored_file_names() {
        let manifest = serde_json::json!({
            "version": 1,
            "complete": false,
            "updatedAt": 1,
            "media": { "files": [stored_manifest_file("page:stream.png", 5)] }
        });

        let error = parse_chapter_media_archive_manifest(&manifest.to_string())
            .expect_err("reject unsafe stored media name");

        assert!(error.contains("invalid stored media path"));
    }

    fn remote_manifest_file(file_name: &str) -> serde_json::Value {
        serde_json::json!({
            "bytes": 0,
            "fileName": file_name,
            "path": format!("media/{file_name}"),
            "sourceUrl": format!("https://example.test/{file_name}"),
            "status": "remote",
            "updatedAt": 1
        })
    }

    fn write_test_media_archive(chapter_dir: &Path, entries: &[(&str, &[u8])]) {
        let archive_file =
            File::create(chapter_dir.join(MEDIA_ARCHIVE_FILE)).expect("create media archive");
        let mut archive = ZipWriter::new(BufWriter::new(archive_file));
        for (file_name, body) in entries {
            archive
                .start_file(*file_name, SimpleFileOptions::default())
                .expect("start media archive entry");
            io::copy(&mut &body[..], &mut archive).expect("write media archive entry");
        }
        archive.finish().expect("finish media archive");
    }

    fn recovery_chapter_dir(root: &Path) -> PathBuf {
        root.join(CONTENTS_ROOT_DIR)
            .join("source")
            .join("Novel-path")
            .join("1-Chapter")
    }

    #[test]
    fn chapter_media_finalization_uses_one_lock_per_chapter() {
        use std::sync::TryLockError;

        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        let first_lock = chapter_media_finalization_lock(&chapter_dir).expect("first lock");
        let second_lock = chapter_media_finalization_lock(&chapter_dir).expect("second lock");
        assert!(Arc::ptr_eq(&first_lock, &second_lock));

        let _guard = first_lock.lock().expect("lock chapter finalization");
        assert!(matches!(
            second_lock.try_lock(),
            Err(TryLockError::WouldBlock)
        ));
    }

    #[test]
    fn chapter_media_recovery_archives_complete_loose_media_before_adoption() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            true,
            serde_json::json!([
                stored_manifest_file("page.png", 5),
                remote_manifest_file("fallback.png")
            ]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(inspection.media_bytes > 0);
        assert!(!media_dir.exists());
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let archive_file = File::open(&archive_path).expect("open recovered archive");
        let mut archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 1);
        let mut body = Vec::new();
        archive
            .by_name("page.png")
            .expect("open recovered entry")
            .read_to_end(&mut body)
            .expect("read recovered entry");
        assert_eq!(body, b"image");
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
                .expect("read finalized manifest"),
        )
        .expect("parse finalized manifest");
        assert_eq!(manifest["complete"], true);
    }

    #[test]
    fn chapter_media_recovery_rejects_missing_stored_media_without_mutation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter");

        assert!(inspection.is_none());
        assert!(media_dir.is_dir());
        assert!(!chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
                .expect("read incomplete manifest"),
        )
        .expect("parse incomplete manifest");
        assert_eq!(manifest["complete"], false);
    }

    #[test]
    fn chapter_media_recovery_rejects_unexpected_loose_files_without_mutation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
        fs::write(media_dir.join("stale.part"), b"partial").expect("write unexpected media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter");

        assert!(inspection.is_none());
        assert!(media_dir.join("page.png").is_file());
        assert!(media_dir.join("stale.part").is_file());
        assert!(!chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn chapter_media_recovery_rejects_a_chapter_directory_symlink_escape() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("tempdir");
        let external_dir = tempfile::tempdir().expect("external tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(chapter_dir.parent().expect("chapter parent"))
            .expect("create chapter parent");
        let external_chapter_dir = external_dir.path().join("chapter");
        let external_media_dir = external_chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&external_media_dir).expect("create external media dir");
        fs::write(external_chapter_dir.join("content.html"), b"chapter")
            .expect("write external content");
        fs::write(external_media_dir.join("page.png"), b"image").expect("write external media");
        write_recovery_manifest(
            &external_chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );
        symlink(&external_chapter_dir, &chapter_dir).expect("create chapter symlink");

        let error = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect_err("reject chapter symlink escape");

        assert!(error.contains("symbolic link"));
        assert!(external_media_dir.join("page.png").is_file());
        assert!(!external_chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(chapter_media_manifest_path(&external_chapter_dir))
                .expect("read external manifest"),
        )
        .expect("parse external manifest");
        assert_eq!(manifest["complete"], false);
    }

    #[test]
    fn chapter_media_recovery_combines_existing_archive_and_loose_media() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("new.png"), b"newer").expect("write new loose media");
        write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([
                stored_manifest_file("old.png", 3),
                stored_manifest_file("new.png", 5)
            ]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(!media_dir.exists());
        let archive_file =
            File::open(chapter_dir.join(MEDIA_ARCHIVE_FILE)).expect("open combined archive");
        let mut archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 2);
        let mut old_body = Vec::new();
        archive
            .by_name("old.png")
            .expect("open old entry")
            .read_to_end(&mut old_body)
            .expect("read old entry");
        assert_eq!(old_body, b"old");
        let mut new_body = Vec::new();
        archive
            .by_name("new.png")
            .expect("open new entry")
            .read_to_end(&mut new_body)
            .expect("read new entry");
        assert_eq!(new_body, b"newer");
    }

    #[test]
    fn chapter_media_recovery_removes_partial_loose_copy_of_a_complete_archive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("new.png"), b"newer").expect("write leftover loose media");
        write_test_media_archive(&chapter_dir, &[("old.png", b"old"), ("new.png", b"older")]);
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        let rollback_path = archive_rollback_path(&archive_path);
        fs::copy(&archive_path, &backup_path).expect("copy archive backup");
        fs::copy(&archive_path, &rollback_path).expect("copy archive rollback");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([
                stored_manifest_file("old.png", 3),
                stored_manifest_file("new.png", 5)
            ]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(!media_dir.exists());
        assert!(!backup_path.exists());
        assert!(!rollback_path.exists());
        let archive_file = File::open(&archive_path).expect("open complete archive");
        let mut archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 2);
        let mut new_body = Vec::new();
        archive
            .by_name("new.png")
            .expect("open rebuilt entry")
            .read_to_end(&mut new_body)
            .expect("read rebuilt entry");
        assert_eq!(new_body, b"newer");
    }

    #[test]
    fn chapter_media_recovery_restores_an_interrupted_manifest_backup() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        let backup_path = chapter_media_manifest_backup_path(&manifest_path);
        fs::write(
            &backup_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "complete": false,
                "updatedAt": 1,
                "media": { "files": [stored_manifest_file("page.png", 5)] }
            }))
            .expect("encode backup manifest"),
        )
        .expect("write backup manifest");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(manifest_path.is_file());
        assert!(!backup_path.exists());
        assert!(!media_dir.exists());
        assert!(chapter_dir.join(MEDIA_ARCHIVE_FILE).is_file());
    }

    #[test]
    fn chapter_media_recovery_prefers_valid_manifest_temp_over_valid_final() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([remote_manifest_file("page.png")]),
        );
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        let temp_path = manifest_path.with_extension("json.tmp");
        fs::write(
            &temp_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": 1,
                "complete": false,
                "updatedAt": 0,
                "media": { "files": [stored_manifest_file("page.png", 5)] }
            }))
            .expect("encode temp manifest"),
        )
        .expect("write temp manifest");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(!temp_path.exists());
        assert!(!media_dir.exists());
        assert!(chapter_dir.join(MEDIA_ARCHIVE_FILE).is_file());
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&manifest_path).expect("read recovered manifest"),
        )
        .expect("parse recovered manifest");
        assert_eq!(manifest["complete"], true);
        assert_eq!(manifest["media"]["files"][0]["status"], "stored");
    }

    #[test]
    fn chapter_media_recovery_uses_backup_when_the_final_manifest_is_invalid() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        let backup_path = chapter_media_manifest_backup_path(&manifest_path);
        fs::copy(&manifest_path, &backup_path).expect("copy recovery manifest");
        fs::write(&manifest_path, b"invalid manifest").expect("corrupt final manifest");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(!backup_path.exists());
        assert!(!media_dir.exists());
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&manifest_path).expect("read recovered manifest"),
        )
        .expect("parse recovered manifest");
        assert_eq!(manifest["complete"], true);
    }

    #[test]
    fn chapter_media_recovery_restores_an_interrupted_manifest_rollback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        let rollback_path = chapter_media_manifest_rollback_path(&manifest_path);
        fs::rename(&manifest_path, &rollback_path).expect("stage manifest rollback");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(manifest_path.is_file());
        assert!(!rollback_path.exists());
        assert!(!media_dir.exists());
        assert!(chapter_dir.join(MEDIA_ARCHIVE_FILE).is_file());
    }

    #[test]
    fn chapter_media_recovery_publishes_a_valid_interrupted_archive_temp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("new.png"), b"newer").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([
                stored_manifest_file("old.png", 3),
                stored_manifest_file("new.png", 5)
            ]),
        );
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
        write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
        fs::rename(&archive_path, &backup_path).expect("move old archive to backup");
        write_test_media_archive(&chapter_dir, &[("old.png", b"old"), ("new.png", b"newer")]);
        fs::rename(&archive_path, &temp_path).expect("move new archive to temp");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(archive_path.is_file());
        assert!(!backup_path.exists());
        assert!(!temp_path.exists());
        assert!(!media_dir.exists());
        let archive_file = File::open(&archive_path).expect("open published archive");
        let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 2);
    }

    #[test]
    fn chapter_media_recovery_publishes_exact_temp_when_all_slots_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        let rollback_path = archive_rollback_path(&archive_path);
        let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
        write_test_media_archive(&chapter_dir, &[]);
        fs::rename(&archive_path, &backup_path).expect("stage archive backup");
        write_test_media_archive(&chapter_dir, &[]);
        fs::rename(&archive_path, &rollback_path).expect("stage archive rollback");
        write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
        fs::rename(&archive_path, &temp_path).expect("stage exact archive temp");
        write_test_media_archive(&chapter_dir, &[]);

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(archive_path.is_file());
        assert!(!backup_path.exists());
        assert!(!rollback_path.exists());
        assert!(!temp_path.exists());
        let archive_file = File::open(&archive_path).expect("open published archive");
        let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 1);
    }

    #[test]
    fn chapter_media_recovery_combines_archive_backup_with_loose_media() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("new.png"), b"newer").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([
                stored_manifest_file("old.png", 3),
                stored_manifest_file("new.png", 5)
            ]),
        );
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
        fs::rename(&archive_path, &backup_path).expect("move archive to backup");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(archive_path.is_file());
        assert!(!backup_path.exists());
        assert!(!media_dir.exists());
        let archive_file = File::open(&archive_path).expect("open combined archive");
        let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 2);
    }

    #[test]
    fn chapter_media_recovery_combines_archive_rollback_with_loose_media() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(media_dir.join("new.png"), b"newer").expect("write loose media");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([
                stored_manifest_file("old.png", 3),
                stored_manifest_file("new.png", 5)
            ]),
        );
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        let rollback_path = archive_rollback_path(&archive_path);
        write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
        fs::rename(&archive_path, &rollback_path).expect("stage archive rollback");
        write_test_media_archive(&chapter_dir, &[]);
        fs::rename(&archive_path, &backup_path).expect("stage incomplete archive backup");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(archive_path.is_file());
        assert!(!backup_path.exists());
        assert!(!rollback_path.exists());
        assert!(!media_dir.exists());
        let archive_file = File::open(&archive_path).expect("open combined archive");
        let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
        assert_eq!(archive.len(), 2);
    }

    #[test]
    fn chapter_media_recovery_preserves_incomplete_archive_candidates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([
                stored_manifest_file("old.png", 3),
                stored_manifest_file("new.png", 5)
            ]),
        );
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
        write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
        fs::rename(&archive_path, &backup_path).expect("move archive to backup");
        fs::copy(&backup_path, &temp_path).expect("copy partial archive temp");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter");

        assert!(inspection.is_none());
        assert!(!archive_path.exists());
        assert!(backup_path.is_file());
        assert!(temp_path.is_file());
    }

    #[test]
    fn chapter_media_recovery_finishes_from_an_existing_valid_archive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(inspection.media_bytes > 0);
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
                .expect("read finalized manifest"),
        )
        .expect("parse finalized manifest");
        assert_eq!(manifest["complete"], true);
    }

    #[test]
    fn chapter_media_recovery_does_not_reopen_a_structurally_complete_archive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        fs::write(chapter_dir.join(MEDIA_ARCHIVE_FILE), b"not-opened")
            .expect("write structurally complete archive");
        write_recovery_manifest(
            &chapter_dir,
            true,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("completed chapter");

        assert_eq!(inspection.status, "present");
        assert_eq!(inspection.media_bytes, 10);
    }

    #[test]
    fn chapter_media_recovery_cleans_stale_archive_publication_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
        write_recovery_manifest(
            &chapter_dir,
            true,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let backup_path = archive_backup_path(&archive_path);
        let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
        fs::copy(&archive_path, &backup_path).expect("copy stale archive backup");
        fs::write(&temp_path, b"invalid temp").expect("write stale archive temp");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        assert!(archive_path.is_file());
        assert!(!backup_path.exists());
        assert!(!temp_path.exists());
    }

    #[test]
    fn chapter_media_recovery_cleans_stale_manifest_publication_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
        write_recovery_manifest(
            &chapter_dir,
            true,
            serde_json::json!([stored_manifest_file("page.png", 5)]),
        );
        let manifest_paths = chapter_media_manifest_publication_paths(&chapter_dir);
        for path in &manifest_paths {
            fs::write(path, b"stale manifest publication file")
                .expect("write stale manifest publication file");
        }

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.status, "present");
        for path in manifest_paths {
            assert!(!path.exists());
        }
    }

    #[test]
    fn clear_content_media_artifacts_removes_transaction_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = dir.path().join("chapter");
        fs::create_dir_all(chapter_dir.join(MEDIA_DOWNLOAD_DIR)).expect("create media dir");
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        let mut paths = vec![archive_path, manifest_path];
        paths.extend(chapter_media_archive_publication_paths(&chapter_dir));
        paths.extend(chapter_media_manifest_publication_paths(&chapter_dir));
        for path in &paths {
            fs::write(path, b"transaction artifact").expect("write transaction artifact");
        }

        clear_content_media_artifacts(&chapter_dir).expect("clear media artifacts");

        assert!(!chapter_dir.join(MEDIA_DOWNLOAD_DIR).exists());
        for path in paths {
            assert!(!path.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn stale_archive_publication_symlink_is_preserved() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = dir.path().join("chapter");
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        let target_path = dir.path().join("target");
        fs::write(&target_path, b"target").expect("write target");
        let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
        symlink(&target_path, &temp_path).expect("create temp symlink");

        remove_stale_chapter_media_archive_publication_files(&chapter_dir)
            .expect_err("reject publication symlink");

        assert!(fs::symlink_metadata(&temp_path)
            .expect("inspect temp symlink")
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&target_path).expect("read target"), b"target");
    }

    #[test]
    fn chapter_media_recovery_completes_remote_only_manifest_without_an_archive() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        fs::create_dir_all(&media_dir).expect("create empty media dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
        write_recovery_manifest(
            &chapter_dir,
            false,
            serde_json::json!([remote_manifest_file("fallback.png")]),
        );

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("recovered chapter");

        assert_eq!(inspection.media_bytes, 0);
        assert!(!media_dir.exists());
        assert!(!chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
                .expect("read finalized manifest"),
        )
        .expect("parse finalized manifest");
        assert_eq!(manifest["complete"], true);
    }

    #[test]
    fn chapter_media_recovery_keeps_manifestless_legacy_content_present() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = recovery_chapter_dir(dir.path());
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");

        let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
            .expect("inspect chapter")
            .expect("legacy chapter");

        assert_eq!(inspection.status, "present");
        assert_eq!(inspection.media_bytes, 0);
    }

    fn transfer_entry(entry_id: &str, source: &str, target: &str) -> ChapterStorageTransferEntry {
        ChapterStorageTransferEntry {
            entry_id: entry_id.to_string(),
            source_relative_dir: source.to_string(),
            target_relative_dir: target.to_string(),
        }
    }

    fn write_downloaded_chapter(root: &Path, relative_dir: &str, body: &[u8]) {
        let chapter_dir = root.join(relative_dir);
        fs::create_dir_all(chapter_dir.join(MEDIA_DOWNLOAD_DIR)).expect("create chapter storage");
        fs::write(chapter_dir.join("content.html"), body).expect("write chapter content");
        fs::write(
            chapter_dir.join(MEDIA_DOWNLOAD_DIR).join("page.png"),
            b"image",
        )
        .expect("write chapter media");
        fs::write(chapter_dir.join(MEDIA_ARCHIVE_FILE), b"archive").expect("write media archive");
        fs::write(chapter_dir.join(CHAPTER_MEDIA_MANIFEST_FILE), b"manifest")
            .expect("write media manifest");
    }

    #[test]
    fn chapter_storage_transfer_copies_the_complete_directory_before_finalize() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = "contents/source-a/Novel-a/1-Opening";
        let target = "contents/source-b/Novel-b/1-Opening";
        write_downloaded_chapter(dir.path(), source, b"source chapter");

        let preparation = prepare_chapter_storage_transfer_at_root(
            dir.path(),
            vec![transfer_entry("chapter-1", source, target)],
            "transfer-1",
        )
        .expect("prepare transfer");

        assert_eq!(preparation.entries[0].outcome, ChapterStorageTransferOutcome::CopiedSource);
        assert_eq!(preparation.entries[0].media_bytes, 12);
        assert!(dir.path().join(source).is_dir());
        assert_eq!(
            fs::read(dir.path().join(target).join("content.html")).expect("target content"),
            b"source chapter"
        );
        assert_eq!(
            fs::read(dir.path().join(target).join(MEDIA_DOWNLOAD_DIR).join("page.png"))
                .expect("target media"),
            b"image"
        );
        assert!(dir.path().join(target).join(MEDIA_ARCHIVE_FILE).is_file());
        assert!(
            dir.path()
                .join(target)
                .join(CHAPTER_MEDIA_MANIFEST_FILE)
                .is_file()
        );

        finalize_chapter_storage_transfer_at_root(dir.path(), &preparation)
            .expect("finalize transfer");
        finalize_chapter_storage_transfer_at_root(dir.path(), &preparation)
            .expect("finalize transfer again");
        assert!(!dir.path().join(source).exists());
        assert!(dir.path().join(target).is_dir());
    }

    #[test]
    fn chapter_storage_transfer_keeps_an_existing_target_download() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = "contents/source-a/Novel-a/1-Opening";
        let target = "contents/source-b/Novel-b/1-Opening";
        write_downloaded_chapter(dir.path(), source, b"source chapter");
        write_downloaded_chapter(dir.path(), target, b"target chapter");

        let preparation = prepare_chapter_storage_transfer_at_root(
            dir.path(),
            vec![transfer_entry("chapter-1", source, target)],
            "transfer-2",
        )
        .expect("prepare transfer");

        assert_eq!(preparation.entries[0].outcome, ChapterStorageTransferOutcome::KeptTarget);
        assert_eq!(
            fs::read(dir.path().join(target).join("content.html")).expect("target content"),
            b"target chapter"
        );
        assert!(dir.path().join(source).is_dir());
    }

    #[test]
    fn chapter_storage_transfer_restores_an_invalid_target_on_rollback() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = "contents/source-a/Novel-a/1-Opening";
        let target = "contents/source-b/Novel-b/1-Opening";
        write_downloaded_chapter(dir.path(), source, b"source chapter");
        fs::create_dir_all(dir.path().join(target)).expect("create partial target");
        fs::write(dir.path().join(target).join(CHAPTER_PARTIAL_CONTENT_FILE), b"partial")
            .expect("write partial target");

        let preparation = prepare_chapter_storage_transfer_at_root(
            dir.path(),
            vec![transfer_entry("chapter-1", source, target)],
            "transfer-3",
        )
        .expect("prepare transfer");

        assert!(preparation.entries[0].replaced_target);
        rollback_chapter_storage_transfer_at_root(dir.path(), &preparation)
            .expect("rollback transfer");
        rollback_chapter_storage_transfer_at_root(dir.path(), &preparation)
            .expect("rollback transfer again");
        assert!(dir.path().join(source).is_dir());
        assert_eq!(
            fs::read(dir.path().join(target).join(CHAPTER_PARTIAL_CONTENT_FILE))
                .expect("restored partial target"),
            b"partial"
        );
        assert!(!dir.path().join(target).join("content.html").exists());
    }

    #[test]
    fn repeated_transfer_rollback_does_not_remove_a_new_target_download() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = "contents/source-a/Novel-a/1-Opening";
        let target = "contents/source-b/Novel-b/1-Opening";
        write_downloaded_chapter(dir.path(), source, b"source chapter");
        let preparation = prepare_chapter_storage_transfer_at_root(
            dir.path(),
            vec![transfer_entry("chapter-1", source, target)],
            "transfer-retry",
        )
        .expect("prepare transfer");

        rollback_chapter_storage_transfer_at_root(dir.path(), &preparation)
            .expect("rollback transfer");
        write_downloaded_chapter(dir.path(), target, b"new target chapter");
        rollback_chapter_storage_transfer_at_root(dir.path(), &preparation)
            .expect("repeat rollback transfer");

        assert_eq!(
            fs::read(dir.path().join(target).join("content.html")).expect("new target content"),
            b"new target chapter"
        );
    }

    #[test]
    fn chapter_storage_transfer_rejects_invalid_and_duplicate_target_paths() {
        assert!(safe_chapter_storage_relative_dir("contents/source/novel").is_err());
        assert!(safe_chapter_storage_relative_dir("chapter-media/source/novel/chapter").is_err());
        assert!(safe_chapter_storage_relative_dir("contents/source/../novel/chapter").is_err());
        assert!(safe_chapter_storage_removal_relative_dir("contents/source/novel").is_ok());
        assert!(safe_chapter_storage_removal_relative_dir("contents/source").is_err());

        let dir = tempfile::tempdir().expect("tempdir");
        let source_one = "contents/source-a/Novel-a/1-Opening";
        let source_two = "contents/source-a/Novel-a/2-Next";
        let target = "contents/source-b/Novel-b/1-Opening";
        write_downloaded_chapter(dir.path(), source_one, b"one");
        write_downloaded_chapter(dir.path(), source_two, b"two");

        let error = prepare_chapter_storage_transfer_at_root(
            dir.path(),
            vec![
                transfer_entry("chapter-1", source_one, target),
                transfer_entry("chapter-2", source_two, target),
            ],
            "transfer-4",
        )
        .expect_err("reject duplicate target");

        assert!(error.contains("duplicate target"));
        assert!(!dir.path().join(target).exists());
    }

    #[cfg(unix)]
    #[test]
    fn chapter_storage_transfer_rolls_back_prior_entries_after_copy_failure() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("tempdir");
        let source_one = "contents/source-a/Novel-a/1-Opening";
        let source_two = "contents/source-a/Novel-a/2-Next";
        let target_one = "contents/source-b/Novel-b/1-Opening";
        let target_two = "contents/source-b/Novel-b/2-Next";
        write_downloaded_chapter(dir.path(), source_one, b"one");
        write_downloaded_chapter(dir.path(), source_two, b"two");
        symlink(
            dir.path().join(source_one).join("content.html"),
            dir.path().join(source_two).join("unsafe-link"),
        )
        .expect("create source symlink");

        let error = prepare_chapter_storage_transfer_at_root(
            dir.path(),
            vec![
                transfer_entry("chapter-1", source_one, target_one),
                transfer_entry("chapter-2", source_two, target_two),
            ],
            "transfer-5",
        )
        .expect_err("reject source symlink");

        assert!(error.contains("symbolic link"));
        assert!(!dir.path().join(target_one).exists());
        assert!(!dir.path().join(target_two).exists());
        assert!(dir.path().join(source_one).is_dir());
        assert!(dir.path().join(source_two).is_dir());
    }
}
