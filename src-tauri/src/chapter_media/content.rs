//! Authoritative chapter content mirrors and their inspection.

use super::archives::finalize_chapter_media_artifacts;
use super::chapter_media_blocking;
use super::manifest::ChapterMediaFinalization;
use super::paths::{
    chapter_number_segment, content_chapter_dir_at, content_chapter_dirs_for_lookup,
    content_chapter_dirs_matching_identity, content_chapter_dirs_matching_segments,
    content_chapter_relative_dir, ensure_contents_nomedia, legacy_storage_manifest_path,
    media_root, relative_storage_path, safe_relative_storage_path, CHAPTER_PARTIAL_CONTENT_FILE,
    MEDIA_ARCHIVE_FILE,
};
use super::publication::replace_storage_file;
use super::types::ChapterContentInspection;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

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

fn stored_media_archive_bytes(chapter_dir: &Path) -> u64 {
    fs::symlink_metadata(chapter_dir.join(MEDIA_ARCHIVE_FILE))
        .ok()
        .filter(|metadata| metadata.file_type().is_file())
        .map_or(0, |metadata| metadata.len())
}

pub(super) fn inspect_content_chapter_dir(
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
            stored_media_archive_bytes(chapter_dir)
        }
        ChapterMediaFinalization::ManifestMissing => stored_media_archive_bytes(chapter_dir),
        ChapterMediaFinalization::Ready(media_bytes) => media_bytes,
    };
    Ok(Some(ChapterContentInspection {
        status: "present".to_string(),
        content_file: Some(relative_storage_path(root, &content_path)?),
        content_bytes,
        media_bytes,
    }))
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

pub(super) fn delete_legacy_storage_manifest(root: &Path) -> Result<(), String> {
    let manifest_path = legacy_storage_manifest_path(root);
    match fs::remove_file(&manifest_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "chapter media: remove legacy storage manifest: {err}"
        )),
    }
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

pub(super) fn content_chapter_dir_from_context(
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

#[tauri::command]
pub async fn chapter_content_mirror_store(
    app: AppHandle,
    chapter_id: i64,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    chapter_media_blocking("store content mirror", move || {
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
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_store_partial(
    app: AppHandle,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    chapter_media_blocking("store partial content mirror", move || {
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
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_clear(app: AppHandle, chapter_id: i64) -> Result<(), String> {
    chapter_media_blocking("clear content mirror", move || {
        let media_root = media_root(&app)?;
        remove_stored_chapter_content_files(&media_root, chapter_id, None)?;
        delete_legacy_storage_manifest(&media_root)
    })
    .await
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
pub async fn chapter_content_mirror_cleanup_legacy_manifest(app: AppHandle) -> Result<(), String> {
    chapter_media_blocking("clean up legacy content manifest", move || {
        let media_root = media_root(&app)?;
        delete_legacy_storage_manifest(&media_root)
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_read_file(
    app: AppHandle,
    content_file: String,
) -> Result<Option<String>, String> {
    chapter_media_blocking("read content mirror", move || {
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
    })
    .await
}
