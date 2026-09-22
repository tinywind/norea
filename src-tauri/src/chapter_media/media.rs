//! Media body lookup and completed download storage.

use super::chapter_media_blocking;
use super::content::content_chapter_dir_from_context;
use super::paths::{
    chapter_dir_at, content_chapter_dir_at, content_chapter_dirs_for_lookup,
    ensure_contents_nomedia, media_root, media_roots_for_lookup, safe_media_relative_path,
    safe_segment, MEDIA_ARCHIVE_FILE, MEDIA_DOWNLOAD_DIR, MEDIA_ROOT_DIR, MEDIA_URI_PREFIX,
};
use crate::native_stream::{self, NativeStreamState, CHAPTER_MEDIA_STREAM_DOMAIN};
use std::{
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, State};
use zip::{result::ZipError, ZipArchive};

#[derive(Debug)]
pub(super) struct ParsedMediaSrc {
    pub(super) file_name: String,
}

pub(super) fn parse_media_src(media_src: &str) -> Result<ParsedMediaSrc, String> {
    let payload = media_src
        .strip_prefix(MEDIA_URI_PREFIX)
        .ok_or_else(|| "chapter media: unsupported media uri".to_string())?;
    Ok(ParsedMediaSrc {
        file_name: safe_media_relative_path(payload)?,
    })
}

pub(super) fn media_src_chapter_id(context_chapter_id: Option<i64>) -> Result<i64, String> {
    let chapter_id = context_chapter_id
        .ok_or_else(|| "chapter media: missing chapter id context".to_string())?;
    if chapter_id <= 0 {
        return Err("chapter media: chapter id must be positive".to_string());
    }
    Ok(chapter_id)
}

pub(super) fn media_path_in_chapter_dir(chapter_dir: &Path, file_name: &str) -> Option<PathBuf> {
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

pub(super) fn chapter_media_path_from_src_with_context(
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

pub(super) fn move_media_source_to_part_path(
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

#[cfg(test)]
#[path = "media_tests.rs"]
mod tests;
