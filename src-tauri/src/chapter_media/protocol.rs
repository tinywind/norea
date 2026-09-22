//! Reader media protocol responses and encoded media access.

use super::media::{
    chapter_media_body_from_src_with_context, chapter_media_path_from_src_with_context,
    parse_media_src,
};
use super::paths::{
    media_root, CONTENTS_ROOT_DIR, IMMUTABLE_COVER_CACHE_CONTROL, NOVEL_COVER_MANIFEST_FILE,
};
use std::{
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
};
use tauri::{
    http::{self, header, StatusCode},
    AppHandle,
};
use zip::{result::ZipError, ZipArchive};

pub fn norea_media_protocol_response(
    app: &AppHandle,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let request_path = request.uri().path();
    match norea_media_protocol_body(app, request_path) {
        Ok((body, content_type)) => {
            let mut response = http::Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type);
            if is_novel_cover_media_path(request_path) {
                response = response.header(header::CACHE_CONTROL, IMMUTABLE_COVER_CACHE_CONTROL);
            }
            response
                .body(body)
                .unwrap_or_else(|_| http::Response::new(Vec::new()))
        }
        Err((status, message)) => http::Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.into_bytes())
            .unwrap_or_else(|_| http::Response::new(Vec::new())),
    }
}

fn is_novel_cover_media_path(request_path: &str) -> bool {
    let parts = request_path
        .trim_matches('/')
        .split('/')
        .collect::<Vec<_>>();
    let file_name = parts.get(3).copied().unwrap_or_default();
    parts.len() == 4
        && parts.first() == Some(&CONTENTS_ROOT_DIR)
        && file_name != NOVEL_COVER_MANIFEST_FILE
        && file_name.starts_with("cover.")
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

pub(super) fn archive_contains_file(archive_path: &Path, file_name: &str) -> Result<bool, String> {
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

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
