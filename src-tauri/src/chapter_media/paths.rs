//! Storage roots, safe path components, and chapter identity lookup.

use super::chapter_media_blocking;
use std::{
    fs::{self, File},
    io::ErrorKind,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime};

pub(crate) const MEDIA_ROOT_DIR: &str = "chapter-media";

pub(super) const MEDIA_URI_PREFIX: &str = "norea-media://reader-asset/";

pub(super) const CONTENTS_ROOT_DIR: &str = "contents";

pub(super) const NO_MEDIA_FILE: &str = ".nomedia";

pub(super) const MEDIA_DOWNLOAD_DIR: &str = "media";

pub(super) const MEDIA_ARCHIVE_FILE: &str = "media.zip";

pub(super) const NOVEL_COVER_MANIFEST_FILE: &str = "cover.json";

const LEGACY_STORAGE_MANIFEST_FILE: &str = "storage-manifest.json";

pub(super) const CHAPTER_MEDIA_MANIFEST_FILE: &str = "manifest.json";

pub(super) const CHAPTER_PARTIAL_CONTENT_FILE: &str = ".chapter-content.partial";

const STORAGE_ROOT_CONFIG_FILE: &str = "chapter-media-storage-root.txt";

pub(super) const MEDIA_RESTORE_BACKUP_INFIX: &str = ".restore-backup-";

pub(super) const IMMUTABLE_COVER_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

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

pub(super) fn media_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
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

pub(super) fn ensure_contents_nomedia(root: &Path) -> Result<(), String> {
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

pub(super) fn media_roots_for_lookup<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    roots.push(media_root(app)?);
    let legacy_root = legacy_media_root(app)?;
    if !roots.iter().any(|root| root == &legacy_root) {
        roots.push(legacy_root);
    }
    Ok(roots)
}

#[tauri::command]
pub async fn chapter_media_get_storage_root(app: AppHandle) -> Result<Option<String>, String> {
    chapter_media_blocking("read storage root", move || {
        configured_media_root(&app).map(|root| root.map(|path| path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
pub async fn chapter_media_set_storage_root(
    app: AppHandle,
    root: String,
) -> Result<String, String> {
    chapter_media_blocking("set storage root", move || {
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return Err("chapter media: storage root is empty".to_string());
        }
        if trimmed.contains('\0') {
            return Err("chapter media: storage root contains an invalid character".to_string());
        }

        let root_path = PathBuf::from(trimmed);
        save_configured_media_root(&app, &root_path)
    })
    .await
}

#[tauri::command]
pub async fn chapter_media_use_default_storage_root(app: AppHandle) -> Result<String, String> {
    chapter_media_blocking("use default storage root", move || {
        let root_path = legacy_media_root(&app)?;
        save_configured_media_root(&app, &root_path)
    })
    .await
}

pub(super) fn safe_segment(value: &str, fallback: &str) -> String {
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

pub(super) fn safe_media_relative_path(value: &str) -> Result<String, String> {
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

pub(super) fn content_novel_dir_at(
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

pub(super) fn chapter_number_segment(
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

pub(super) fn chapter_dir_at(root: &Path, chapter_id: i64) -> Result<PathBuf, String> {
    if chapter_id <= 0 {
        return Err("chapter media: invalid chapter id".to_string());
    }
    Ok(root.join(chapter_id.to_string()))
}

pub(super) fn content_chapter_dir_at(
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

pub(super) fn content_chapter_relative_dir(
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

pub(super) fn content_chapter_dirs_for_lookup(
    root: &Path,
    chapter_id: i64,
) -> Result<Vec<PathBuf>, String> {
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

pub(super) fn legacy_storage_manifest_path(root: &Path) -> PathBuf {
    root.join(LEGACY_STORAGE_MANIFEST_FILE)
}

pub(super) fn safe_relative_storage_path(value: &str) -> Result<PathBuf, String> {
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

pub(super) fn relative_storage_path(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .map_err(|_| "chapter media: stored chapter path is outside the storage root".to_string())
}

pub(super) fn validate_chapter_dir_under_storage_root(
    root: &Path,
    chapter_dir: &Path,
) -> Result<(), String> {
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

pub(super) fn content_chapter_dirs_matching_segments(
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

pub(super) fn content_chapter_dirs_matching_identity(
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

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
