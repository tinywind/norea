//! Whole-storage restore transactions.

use super::cache::remove_existing_path;
use super::chapter_media_blocking;
use super::paths::{ensure_contents_nomedia, media_roots_for_lookup, MEDIA_RESTORE_BACKUP_INFIX};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

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
