//! Atomic file publication and recovery artifact paths.

use super::paths::{CHAPTER_MEDIA_MANIFEST_FILE, MEDIA_ARCHIVE_FILE};
use std::{
    fs::{self, File},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

pub(super) fn archive_backup_path(archive_path: &Path) -> PathBuf {
    archive_path.with_file_name(format!("{MEDIA_ARCHIVE_FILE}.bak"))
}

pub(super) fn archive_rollback_path(archive_path: &Path) -> PathBuf {
    archive_path.with_file_name(format!("{MEDIA_ARCHIVE_FILE}.rollback"))
}

pub(super) fn replace_storage_file(
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

pub(super) fn remove_known_publication_file(path: &Path, context: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(path).map_err(|err| format!("{context}: {err}"))
        }
        Ok(_) => Err(format!("{context}: path is not a regular file")),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("{context}: inspect path: {err}")),
    }
}

pub(super) fn create_publication_temp_file(path: &Path, context: &str) -> Result<File, String> {
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

pub(super) fn replace_file_preserving_recovery_backup(
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

pub(super) fn replace_media_archive(
    temp_archive_path: &Path,
    archive_path: &Path,
) -> Result<(), String> {
    let backup_path = archive_backup_path(archive_path);
    replace_file_preserving_recovery_backup(
        temp_archive_path,
        archive_path,
        &backup_path,
        &archive_rollback_path(archive_path),
        "chapter media: publish media archive",
    )
}

pub(super) fn chapter_media_archive_publication_paths(chapter_dir: &Path) -> [PathBuf; 3] {
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    [
        chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp")),
        archive_backup_path(&archive_path),
        archive_rollback_path(&archive_path),
    ]
}

pub(super) fn remove_stale_chapter_media_archive_publication_files(
    chapter_dir: &Path,
) -> Result<(), String> {
    for path in chapter_media_archive_publication_paths(chapter_dir) {
        remove_known_publication_file(
            &path,
            "chapter media: remove stale media archive publication file",
        )?;
    }
    Ok(())
}

pub(super) fn chapter_media_manifest_path(chapter_dir: &Path) -> PathBuf {
    chapter_dir.join(CHAPTER_MEDIA_MANIFEST_FILE)
}

pub(super) fn chapter_media_manifest_backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

pub(super) fn chapter_media_manifest_rollback_path(path: &Path) -> PathBuf {
    path.with_extension("json.rollback")
}

pub(super) fn chapter_media_manifest_publication_paths(chapter_dir: &Path) -> [PathBuf; 3] {
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    [
        manifest_path.with_extension("json.tmp"),
        chapter_media_manifest_backup_path(&manifest_path),
        chapter_media_manifest_rollback_path(&manifest_path),
    ]
}

pub(super) fn remove_stale_chapter_media_manifest_publication_files(
    chapter_dir: &Path,
) -> Result<(), String> {
    for path in chapter_media_manifest_publication_paths(chapter_dir) {
        remove_known_publication_file(
            &path,
            "chapter media: remove stale media manifest publication file",
        )?;
    }
    Ok(())
}

pub(super) fn write_chapter_media_manifest(
    path: &Path,
    manifest: &serde_json::Value,
) -> Result<(), String> {
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
