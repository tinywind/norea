//! Chapter storage transfers and explicit directory operations.

use super::cache::remove_existing_path;
use super::chapter_media_blocking;
use super::content::delete_legacy_storage_manifest;
use super::paths::{
    ensure_contents_nomedia, media_root, relative_storage_path, safe_relative_storage_path,
    CONTENTS_ROOT_DIR, MEDIA_ARCHIVE_FILE, MEDIA_DOWNLOAD_DIR,
};
use super::types::{
    ChapterStorageTransferEntry, ChapterStorageTransferOutcome, ChapterStorageTransferPreparation,
    ChapterStorageTransferPreparedEntry,
};
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

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
        return Err(
            "chapter media: storage root must be a directory without symbolic links".to_string(),
        );
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
                return Err(
                    "chapter media: chapter storage path escaped the storage root".to_string(),
                );
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
    for entry in
        fs::read_dir(source).map_err(|err| format!("chapter media: read transfer source: {err}"))?
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
    for entry in
        fs::read_dir(path).map_err(|err| format!("chapter media: read transfer media: {err}"))?
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
            .checked_add(storage_tree_file_bytes(
                &chapter_dir.join(MEDIA_ARCHIVE_FILE),
            )?)
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
            return Err(
                "chapter media: transfer marker already exists in copied source".to_string(),
            );
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

        replaced_target =
            storage_metadata(&target, "chapter media: inspect transfer target")?.is_some();
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
            let source_exists =
                storage_metadata(&source, "chapter media: inspect finalized transfer source")?
                    .is_some();
            if source_exists && !has_transfer_marker(&target, &preparation.token)? {
                return Err(
                    "chapter media: cannot finalize an unmarked transfer target".to_string()
                );
            }
            if source_exists {
                remove_transfer_path(&source, "chapter media: remove finalized transfer source")?;
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

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
