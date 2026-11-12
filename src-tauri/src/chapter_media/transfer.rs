//! Chapter storage transfers and explicit directory operations.

use super::cache::remove_existing_path;
use super::chapter_media_blocking;
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

const MOVE_MARKER: &[u8] = b"{\"mode\":\"move\"}";

fn restore_transfer_candidate(source: &Path, candidate: &Path, token: &str) -> Result<(), String> {
    if !has_transfer_marker(candidate, token)? {
        return Ok(());
    }
    let marker = transfer_marker_path(candidate, token)?;
    if candidate == source {
        return remove_transfer_path(&marker, "chapter media: remove source move marker");
    }
    if fs::read(&marker).map_err(|error| format!("chapter media: read transfer marker: {error}"))? == MOVE_MARKER {
        if candidate != source {
            if storage_metadata(source, "chapter media: inspect move rollback source")?.is_some() {
                return Err("chapter media: cannot restore a moved chapter over an occupied source".into());
            }
            fs::rename(candidate, source).map_err(|error| format!("chapter media: restore moved chapter: {error}"))?;
        }
        remove_transfer_path(&transfer_marker_path(source, token)?, "chapter media: remove restored move marker")
    } else {
        remove_transfer_path(candidate, "chapter media: remove rolled back transfer copy")
    }
}

fn rollback_transfer_entry(root: &Path, entry: &ChapterStorageTransferEntry, token: &str) -> Result<(), String> {
    let source_relative = safe_chapter_storage_relative_dir(&entry.source_relative_dir)?;
    let target_relative = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
    validate_storage_path_ancestors(root, &source_relative)?;
    validate_storage_path_ancestors(root, &target_relative)?;
    let source = root.join(source_relative);
    let target = root.join(target_relative);
    let stage = transfer_sibling_path(&target, token, "stage")?;
    let backup = transfer_sibling_path(&target, token, "backup")?;
    restore_transfer_candidate(&source, &target, token)?;
    restore_transfer_candidate(&source, &stage, token)?;
    remove_transfer_path(&stage, "chapter media: remove rolled back transfer stage")?;
    if storage_metadata(&backup, "chapter media: inspect transfer backup")?.is_some() {
        if storage_metadata(&target, "chapter media: inspect rollback target")?.is_some() {
            return Err("chapter media: cannot restore transfer backup over an unmarked target".into());
        }
        fs::rename(&backup, &target).map_err(|error| format!("chapter media: restore transfer target: {error}"))?;
    }
    if has_transfer_marker(&source, token)? {
        restore_transfer_candidate(&source, &source, token)?;
    }
    Ok(())
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
    require_empty_targets: bool,
    move_source: bool,
) -> Result<ChapterStorageTransferPreparedEntry, String> {
    let source_relative = safe_chapter_storage_relative_dir(&entry.source_relative_dir)?;
    let target_relative = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
    validate_storage_path_ancestors(root, &source_relative)?;
    validate_storage_path_ancestors(root, &target_relative)?;
    let source = root.join(&source_relative);
    let target = root.join(&target_relative);

    if storage_metadata(&target, "chapter media: inspect transfer target")?.is_some() {
        if require_empty_targets {
            return Err("chapter media: transfer target must be absent".to_string());
        }
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
        if require_empty_targets {
            return Err("chapter media: transfer source has unfinished content".to_string());
        }
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
    let mut moved_source = false;
    let result = (|| -> Result<ChapterStorageTransferPreparedEntry, String> {
        if move_source {
            validate_storage_tree_without_symlinks(&source)?;
            let source_marker = transfer_marker_path(&source, token)?;
            fs::OpenOptions::new().write(true).create_new(true).open(&source_marker)
                .and_then(|mut file| std::io::Write::write_all(&mut file, MOVE_MARKER))
                .map_err(|error| format!("chapter media: write source move marker: {error}"))?;
            match fs::rename(&source, &stage) {
                Ok(()) => moved_source = true,
                Err(error) => {
                    remove_transfer_path(&source_marker, "chapter media: remove unsupported move marker")?;
                    if error.kind() != ErrorKind::CrossesDevices {
                        return Err(format!("chapter media: move transfer directory: {error}"));
                    }
                }
            }
        }
        if !moved_source { copy_storage_tree(&source, &stage)?; }
        let marker = transfer_marker_path(&stage, token)?;
        if !moved_source && storage_metadata(&marker, "chapter media: inspect transfer marker")?.is_some() {
            return Err(
                "chapter media: transfer marker already exists in copied source".to_string(),
            );
        }
        if !moved_source {
            fs::write(&marker, token)
                .map_err(|err| format!("chapter media: write transfer marker: {err}"))?;
        }
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

        if require_empty_targets
            && storage_metadata(&target, "chapter media: inspect transfer target")?.is_some()
        {
            return Err("chapter media: transfer target appeared during preparation".to_string());
        }
        if let Some(target_artifacts) = inspect_transfer_artifacts(&target)? {
            if moved_source { restore_transfer_candidate(&source, &stage, token)?; }
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
        if require_empty_targets && replaced_target {
            return Err("chapter media: transfer target appeared during preparation".to_string());
        }
        if replaced_target {
            fs::rename(&target, &backup)
                .map_err(|err| format!("chapter media: backup invalid transfer target: {err}"))?;
        }
        fs::rename(&stage, &target)
            .map_err(|err| format!("chapter media: publish chapter storage transfer: {err}"))?;
        let target_artifacts = inspect_transfer_artifacts(&target)?.ok_or_else(|| {
            "chapter media: published transfer target has no final content".to_string()
        })?;
        transfer_prepared_entry(
            root,
            entry.clone(),
            if moved_source { ChapterStorageTransferOutcome::MovedSource } else { ChapterStorageTransferOutcome::CopiedSource },
            replaced_target,
            Some(target_artifacts),
        )
    })();
    match result {
        Ok(prepared) => Ok(prepared),
        Err(error) => {
            match rollback_transfer_entry(root, &entry, token) {
                Ok(()) => Err(error),
                Err(recovery_error) => Err(format!("{error}; chapter storage transfer entry recovery failed: {recovery_error}")),
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
    require_empty_targets: bool,
    move_source: bool,
) -> Result<ChapterStorageTransferPreparation, String> {
    validate_transfer_token(token)?;
    validate_transfer_entries(&entries)?;
    fs::create_dir_all(root)
        .map_err(|err| format!("chapter media: create storage root for transfer: {err}"))?;
    if require_empty_targets || move_source {
        let sources = entries
            .iter()
            .map(|entry| safe_chapter_storage_relative_dir(&entry.source_relative_dir))
            .collect::<Result<HashSet<_>, _>>()?;
        for entry in &entries {
            let source_relative = safe_chapter_storage_relative_dir(&entry.source_relative_dir)?;
            let target_relative = safe_chapter_storage_relative_dir(&entry.target_relative_dir)?;
            if sources.contains(&target_relative) {
                return Err(
                    "chapter media: transfer sources and targets must be disjoint".to_string(),
                );
            }
            validate_storage_path_ancestors(root, &source_relative)?;
            validate_storage_path_ancestors(root, &target_relative)?;
            let source = root.join(&source_relative);
            let target = root.join(&target_relative);
            if require_empty_targets && storage_metadata(&target, "chapter media: inspect transfer target")?.is_some() {
                return Err("chapter media: transfer target must be absent".to_string());
            }
            for kind in ["stage", "backup"] {
                let workspace = transfer_sibling_path(&target, token, kind)?;
                if storage_metadata(&workspace, "chapter media: inspect transfer workspace")?
                    .is_some()
                {
                    return Err(
                        "chapter media: chapter storage transfer workspace already exists"
                            .to_string(),
                    );
                }
            }
            if let Some(metadata) =
                storage_metadata(&source, "chapter media: inspect transfer source")?
            {
                if !metadata.is_dir() {
                    return Err("chapter media: transfer source is not a directory".to_string());
                }
                validate_storage_tree_without_symlinks(&source)?;
                if inspect_transfer_artifacts(&source)?.is_none() {
                    return Err("chapter media: transfer source has unfinished content".to_string());
                }
            }
        }
    }
    ensure_contents_nomedia(root)?;
    let mut preparation = ChapterStorageTransferPreparation {
        token: token.to_string(),
        entries: Vec::with_capacity(entries.len()),
    };
    for entry in entries {
        match prepare_chapter_storage_transfer_entry_at_root(
            root,
            entry,
            token,
            require_empty_targets,
            move_source,
        ) {
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
        if matches!(entry.outcome, ChapterStorageTransferOutcome::CopiedSource | ChapterStorageTransferOutcome::MovedSource) {
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
            if entry.outcome == ChapterStorageTransferOutcome::CopiedSource && source_exists && !has_transfer_marker(&target, &preparation.token)? {
                return Err(
                    "chapter media: cannot finalize an unmarked transfer target".to_string()
                );
            }
            if entry.outcome == ChapterStorageTransferOutcome::CopiedSource && source_exists {
                remove_transfer_path(&source, "chapter media: remove finalized transfer source")?;
            }
            remove_transfer_path(
                &transfer_marker_path(&target, &preparation.token)?,
                "chapter media: remove finalized transfer marker",
            )?;
        }
        remove_transfer_path(&stage, "chapter media: remove finalized transfer stage")?;
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
        if !matches!(entry.outcome, ChapterStorageTransferOutcome::CopiedSource | ChapterStorageTransferOutcome::MovedSource) { continue; }
        rollback_transfer_entry(root, &ChapterStorageTransferEntry {
            entry_id: entry.entry_id.clone(), source_relative_dir: entry.source_relative_dir.clone(), target_relative_dir: entry.target_relative_dir.clone(),
        }, &preparation.token)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_storage_prepare_transfer(
    app: AppHandle,
    entries: Vec<ChapterStorageTransferEntry>,
    token: Option<String>,
    require_empty_targets: Option<bool>,
    move_source: Option<bool>,
) -> Result<ChapterStorageTransferPreparation, String> {
    chapter_media_blocking("prepare chapter storage transfer", move || {
        let root = media_root(&app)?;
        let token = token.unwrap_or_else(chapter_storage_transfer_token);
        let preparation = prepare_chapter_storage_transfer_at_root(
            &root,
            entries,
            &token,
            require_empty_targets.unwrap_or(false),
            move_source.unwrap_or(false),
        )?;
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
        finalize_chapter_storage_transfer_at_root(&root, &preparation)
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
        rollback_chapter_storage_transfer_at_root(&root, &preparation)
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
    let path = media_root.join(&relative_dir);
    if storage_metadata(&media_root, "chapter media: inspect storage root")?.is_some() {
        validate_storage_path_ancestors(&media_root, &relative_dir)?;
        remove_transfer_path(&path, "chapter media: remove chapter storage dir")?;
    }
    super::work_metadata::forget_chapter_directories_under(&path)
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
        .map_err(|err| format!("chapter media: relocate chapter storage dir: {err}"))
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
    Ok(())
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
