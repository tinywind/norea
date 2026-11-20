//! Reader media protocol responses and encoded media access.

use super::chapter_media_blocking;
use super::media::{
    chapter_media_body_from_src_with_context, chapter_media_path_from_src_with_context,
    open_archive_reader, parse_media_src, ArchiveReaderOpenError, MAX_CHAPTER_MEDIA_ARCHIVE_BYTES,
};
use super::paths::{
    media_root, safe_media_relative_path, safe_relative_storage_path, CONTENTS_ROOT_DIR,
    IMMUTABLE_COVER_CACHE_CONTROL,
};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{
    http::{self, header, StatusCode},
    AppHandle, Manager,
};
use zip::{result::ZipError, ZipArchive};

const READER_MEDIA_CACHE_DIR: &str = "reader-media";
const READER_MEDIA_CACHE_REQUEST_PREFIX: &str = "reader-asset/~cache/";
const MAX_READER_CACHE_ENTRIES: usize = 100_000;
const MAX_READER_CACHE_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_READER_CACHE_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn norea_media_protocol_response(
    app: &AppHandle,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let request_path = request.uri().path();
    match norea_media_protocol_body(app, request_path) {
        Ok((body, content_type)) => {
            norea_media_success_response(request_path, body, content_type)
        }
        Err((status, message)) => http::Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.into_bytes())
            .unwrap_or_else(|_| http::Response::new(Vec::new())),
    }
}

fn norea_media_success_response(
    request_path: &str,
    body: Vec<u8>,
    content_type: &'static str,
) -> http::Response<Vec<u8>> {
    let mut response = http::Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
        );
    if is_novel_cover_media_path(request_path) {
        response = response.header(header::CACHE_CONTROL, IMMUTABLE_COVER_CACHE_CONTROL);
    }
    response
        .body(body)
        .unwrap_or_else(|_| http::Response::new(Vec::new()))
}

fn is_novel_cover_media_path(request_path: &str) -> bool {
    let parts = request_path
        .trim_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let file_name = parts.get(3).copied().unwrap_or_default();
    parts.len() == 4
        && parts.first() == Some(&CONTENTS_ROOT_DIR)
        && (super::work_metadata::is_cover_file(file_name)
            || super::work_metadata::is_override_cover_file(file_name))
}

fn norea_media_protocol_body(
    app: &AppHandle,
    request_path: &str,
) -> Result<(Vec<u8>, &'static str), (StatusCode, String)> {
    let decoded = percent_decode_utf8(request_path.trim_start_matches('/'))
        .map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    if decoded.starts_with(READER_MEDIA_CACHE_REQUEST_PREFIX) {
        let cache_base = app
            .path()
            .app_cache_dir()
            .map_err(|err| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("norea media: app cache dir: {err}"),
                )
            })?
            .join(READER_MEDIA_CACHE_DIR);
        return read_reader_media_cache_body(&cache_base, &decoded);
    }

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

fn safe_reader_media_cache_token(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 96
        || trimmed == "."
        || trimmed == ".."
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err("chapter media: invalid reader media cache token".to_string());
    }
    Ok(trimmed.to_string())
}

fn read_reader_media_cache_body(
    cache_base: &Path,
    decoded_request_path: &str,
) -> Result<(Vec<u8>, &'static str), (StatusCode, String)> {
    let rest = decoded_request_path
        .strip_prefix(READER_MEDIA_CACHE_REQUEST_PREFIX)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "norea media: invalid reader cache path".to_string(),
            )
        })?;
    let (raw_token, raw_entry) = rest.split_once('/').ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            "norea media: missing reader cache entry".to_string(),
        )
    })?;
    let token =
        safe_reader_media_cache_token(raw_token).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;
    let entry_path =
        safe_media_relative_path(raw_entry).map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;
    let path = cache_base.join(token).join(&entry_path);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err((
                StatusCode::NOT_FOUND,
                "norea media: cached file not found".to_string(),
            ));
        }
        Err(err) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("norea media: inspect cached file: {err}"),
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err((
            StatusCode::NOT_FOUND,
            "norea media: cached file not found".to_string(),
        ));
    }
    if metadata.len() > MAX_READER_CACHE_ENTRY_BYTES {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "norea media: cached file exceeds byte limit".to_string(),
        ));
    }
    let body = fs::read(&path).map_err(|err| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("norea media: read cached file: {err}"),
        )
    })?;
    let content_type = media_mime_type(&path, &body);
    Ok((body, content_type))
}

fn checked_storage_contents_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let rel = safe_relative_storage_path(relative_path)?;
    let mut components = rel.components();
    match components.next() {
        Some(Component::Normal(first)) if first == CONTENTS_ROOT_DIR => {}
        _ => return Err("chapter media: storage path must start with contents".to_string()),
    }
    let mut current = root.to_path_buf();
    for component in rel.components() {
        let Component::Normal(segment) = component else {
            return Err("chapter media: invalid storage path component".to_string());
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("chapter media: symbolic links are not supported".to_string());
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("chapter media: inspect storage path: {err}")),
        }
    }
    Ok(current)
}

fn copy_reader_bounded<R: Read, W: Write>(
    mut reader: R,
    mut writer: W,
    max_bytes: u64,
    context: &str,
) -> Result<u64, String> {
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("{context}: {err}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| format!("{context}: byte count overflow"))?;
        if total > max_bytes {
            return Err(format!("{context}: exceeds the {max_bytes} byte limit"));
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|err| format!("{context}: write cache: {err}"))?;
    }
    Ok(total)
}

fn copy_media_dir_to_reader_cache(
    source_dir: &Path,
    prefix: &str,
    cache_dir: &Path,
    entry_count: &mut usize,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Ok(());
    }
    let mut entries = fs::read_dir(source_dir)
        .map_err(|err| format!("chapter media: read media directory: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("chapter media: read media entry: {err}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|err| format!("chapter media: inspect media entry: {err}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let child_name = entry.file_name().to_string_lossy().into_owned();
        let candidate = if prefix.is_empty() {
            child_name
        } else {
            format!("{prefix}/{child_name}")
        };
        let Ok(entry_name) = safe_media_relative_path(&candidate) else {
            continue;
        };
        if file_type.is_dir() {
            copy_media_dir_to_reader_cache(
                &entry.path(),
                &entry_name,
                cache_dir,
                entry_count,
                total_bytes,
            )?;
            continue;
        }
        if !file_type.is_file() || entry_name.ends_with(".part") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| format!("chapter media: inspect media file: {err}"))?;
        if metadata.len() > MAX_READER_CACHE_ENTRY_BYTES {
            return Err("chapter media: reader media file exceeds entry size limit".to_string());
        }
        *entry_count += 1;
        if *entry_count > MAX_READER_CACHE_ENTRIES {
            return Err("chapter media: reader media directory exceeds entry limit".to_string());
        }
        let target = cache_dir.join(&entry_name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("chapter media: create reader cache parent: {err}"))?;
        }
        let input = File::open(entry.path())
            .map_err(|err| format!("chapter media: open reader media file: {err}"))?;
        let output = File::create(&target)
            .map_err(|err| format!("chapter media: create reader cache file: {err}"))?;
        let copied = copy_reader_bounded(
            input,
            output,
            MAX_READER_CACHE_ENTRY_BYTES,
            "chapter media: copy reader media file",
        )?;
        *total_bytes = total_bytes
            .checked_add(copied)
            .filter(|sum| *sum <= MAX_READER_CACHE_TOTAL_BYTES)
            .ok_or_else(|| "chapter media: reader media cache exceeds total byte limit".to_string())?;
    }
    Ok(())
}

fn copy_media_archive_to_reader_cache(
    archive_path: &Path,
    cache_dir: &Path,
    entry_count: &mut usize,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if !archive_path.is_file() {
        return Ok(());
    }
    let archive_reader =
        open_archive_reader(archive_path, MAX_CHAPTER_MEDIA_ARCHIVE_BYTES).map_err(|err| {
            match err {
                ArchiveReaderOpenError::TooLarge => {
                    "chapter media: reader media archive exceeds byte limit".to_string()
                }
                ArchiveReaderOpenError::Io(io_err) => {
                    format!("chapter media: open reader media archive: {io_err}")
                }
            }
        })?;
    let mut archive = ZipArchive::new(archive_reader)
        .map_err(|err| format!("chapter media: read reader media archive: {err}"))?;
    if archive.len() > MAX_READER_CACHE_ENTRIES {
        return Err("chapter media: reader media archive exceeds entry limit".to_string());
    }
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("chapter media: open reader archive entry: {err}"))?;
        *entry_count += 1;
        if *entry_count > MAX_READER_CACHE_ENTRIES {
            return Err("chapter media: reader media archive exceeds entry limit".to_string());
        }
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry
            .name()
            .map_err(|err| format!("chapter media: read reader archive entry name: {err}"))?
            .replace('\\', "/");
        let Ok(entry_name) = safe_media_relative_path(raw_name.trim_matches('/')) else {
            continue;
        };
        if entry.size() > MAX_READER_CACHE_ENTRY_BYTES {
            return Err("chapter media: reader archive entry exceeds size limit".to_string());
        }
        let target = cache_dir.join(&entry_name);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("chapter media: create reader cache parent: {err}"))?;
        }
        let output = File::create(&target)
            .map_err(|err| format!("chapter media: create reader cache file: {err}"))?;
        let copied = copy_reader_bounded(
            &mut entry,
            output,
            MAX_READER_CACHE_ENTRY_BYTES,
            "chapter media: extract reader archive entry",
        )?;
        *total_bytes = total_bytes
            .checked_add(copied)
            .filter(|sum| *sum <= MAX_READER_CACHE_TOTAL_BYTES)
            .ok_or_else(|| "chapter media: reader media cache exceeds total byte limit".to_string())?;
    }
    Ok(())
}

pub(super) fn prepare_reader_media_cache_at(
    storage_root: &Path,
    cache_base: &Path,
    media_relative_path: &str,
    archive_relative_path: &str,
    cache_token: &str,
) -> Result<(), String> {
    let safe_token = safe_reader_media_cache_token(cache_token)?;
    let media_dir = checked_storage_contents_path(storage_root, media_relative_path)?;
    let archive_path = checked_storage_contents_path(storage_root, archive_relative_path)?;

    fs::create_dir_all(cache_base)
        .map_err(|err| format!("chapter media: create reader cache root: {err}"))?;
    let canonical_base = fs::canonicalize(cache_base)
        .map_err(|err| format!("chapter media: resolve reader cache root: {err}"))?;
    let token_dir = canonical_base.join(&safe_token);
    fs::create_dir_all(&token_dir)
        .map_err(|err| format!("chapter media: create reader cache token dir: {err}"))?;
    let canonical_token = fs::canonicalize(&token_dir)
        .map_err(|err| format!("chapter media: resolve reader cache token dir: {err}"))?;
    if !canonical_token.starts_with(&canonical_base) || canonical_token == canonical_base {
        return Err("chapter media: reader cache token escapes cache directory".to_string());
    }

    let mut media_entries = 0_usize;
    let mut total_bytes = 0_u64;
    copy_media_dir_to_reader_cache(
        &media_dir,
        "",
        &canonical_token,
        &mut media_entries,
        &mut total_bytes,
    )?;

    let mut archive_entries = 0_usize;
    let mut total_with_archive = total_bytes;
    if let Err(err) = copy_media_archive_to_reader_cache(
        &archive_path,
        &canonical_token,
        &mut archive_entries,
        &mut total_with_archive,
    ) {
        if media_entries == 0 {
            return Err(err);
        }
        log::warn!("reader media archive overlay failed for '{archive_relative_path}': {err}");
    }

    if media_entries == 0 && archive_entries == 0 {
        return Err("chapter media: reader media source not found".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_prepare_reader_cache(
    app: AppHandle,
    media_relative_path: String,
    archive_relative_path: String,
    cache_token: String,
) -> Result<(), String> {
    chapter_media_blocking("prepare reader media cache", move || {
        let storage_root = media_root(&app)?;
        let cache_base = app
            .path()
            .app_cache_dir()
            .map_err(|err| format!("chapter media: app cache dir: {err}"))?
            .join(READER_MEDIA_CACHE_DIR);
        prepare_reader_media_cache_at(
            &storage_root,
            &cache_base,
            &media_relative_path,
            &archive_relative_path,
            &cache_token,
        )
    })
    .await
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

pub(super) fn archive_contains_file(archive_path: &Path, file_name: &str) -> Result<bool, String> {
    let archive_reader =
        open_archive_reader(archive_path, MAX_CHAPTER_MEDIA_ARCHIVE_BYTES).map_err(|err| {
            match err {
                ArchiveReaderOpenError::TooLarge => {
                    "chapter media: archive exceeds byte limit".to_string()
                }
                ArchiveReaderOpenError::Io(io_err) => {
                    format!("chapter media: open archive: {io_err}")
                }
            }
        })?;
    let mut archive = ZipArchive::new(archive_reader)
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
    source_novel_id: Option<String>,
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
        source_novel_id.as_deref(),
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
    source_novel_id: Option<String>,
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
            source_novel_id.as_deref(),
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

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
