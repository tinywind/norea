//! Media cache accounting, pruning, and clearing.

use super::archives::clear_content_media_artifacts;
use super::chapter_media_blocking;
use super::content::{content_chapter_dir_from_context, delete_legacy_storage_manifest};
use super::media::{media_path_in_chapter_dir, media_src_chapter_id, parse_media_src};
use super::paths::{
    chapter_dir_at, content_chapter_dir_at, content_chapter_dirs_for_lookup,
    content_chapter_dirs_matching_identity, ensure_contents_nomedia, media_roots_for_lookup,
    CONTENTS_ROOT_DIR, MEDIA_ARCHIVE_FILE, MEDIA_DOWNLOAD_DIR,
};
use super::protocol::archive_contains_file;
use super::publication::archive_backup_path;
use super::types::ChapterMediaClearContext;
use std::{collections::HashSet, fs, io::ErrorKind, path::Path};
use tauri::{AppHandle, Runtime};

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

pub(super) fn remove_existing_path(path: &Path, context: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|err| format!("{context}: {err}"))
    } else {
        fs::remove_file(path).map_err(|err| format!("{context}: {err}"))
    }
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
