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


pub(super) const CHAPTER_MEDIA_MANIFEST_FILE: &str = "manifest.json";

pub(super) const CHAPTER_PARTIAL_CONTENT_FILE: &str = ".chapter-content.partial";

const STORAGE_ROOT_CONFIG_FILE: &str = "chapter-media-storage-root.txt";
const EXTERNAL_STORAGE_TREE_URI_PREFIX: &str =
    "content://com.android.externalstorage.documents/tree/";

pub(super) const MEDIA_RESTORE_BACKUP_INFIX: &str = ".restore-backup-";

pub(super) const IMMUTABLE_COVER_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

fn default_media_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
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

pub(crate) fn configured_storage_root_value<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<String>, String> {
    let config_path = storage_root_config_path(app)?;
    match fs::read_to_string(&config_path) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: read storage root: {err}")),
    }
}

fn decode_percent_utf8(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("chapter media: invalid storage root percent encoding".to_string());
            }
            let decode_hex = |byte: u8| -> Option<u8> {
                match byte {
                    b'0'..=b'9' => Some(byte - b'0'),
                    b'a'..=b'f' => Some(byte - b'a' + 10),
                    b'A'..=b'F' => Some(byte - b'A' + 10),
                    _ => None,
                }
            };
            let high = decode_hex(bytes[index + 1])
                .ok_or_else(|| "chapter media: invalid storage root percent encoding".to_string())?;
            let low = decode_hex(bytes[index + 2])
                .ok_or_else(|| "chapter media: invalid storage root percent encoding".to_string())?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "chapter media: invalid utf-8 storage root".to_string())
}

pub(crate) fn resolve_storage_root_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("chapter media: storage root is empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("chapter media: storage root contains an invalid character".to_string());
    }
    if let Some(rest) = trimmed.strip_prefix(EXTERNAL_STORAGE_TREE_URI_PREFIX) {
        let encoded_tree_id = rest
            .split(['/', '?', '#'])
            .next()
            .filter(|segment| !segment.is_empty())
            .ok_or_else(|| "Android storage folder is unavailable.".to_string())?;
        let tree_id = decode_percent_utf8(encoded_tree_id)?;
        if tree_id.contains('\0') {
            return Err("chapter media: storage root contains an invalid character".to_string());
        }
        let (volume, tree_path) = match tree_id.split_once(':') {
            Some((vol, rel)) => (vol.trim(), rel),
            None => (tree_id.trim(), ""),
        };
        if volume.is_empty()
            || volume == "."
            || volume == ".."
            || volume.contains('/')
            || volume.contains('\\')
        {
            return Err("Android storage folder is unavailable.".to_string());
        }
        let mut resolved = if volume == "primary" {
            #[cfg(target_os = "android")]
            {
                crate::android_content_io::external_storage_root_path()
            }
            #[cfg(not(target_os = "android"))]
            {
                PathBuf::from("/storage/emulated/0")
            }
        } else {
            PathBuf::from("/storage").join(volume)
        };
        for segment in tree_path.replace('\\', "/").split('/') {
            let segment = segment.trim();
            if segment.is_empty() {
                continue;
            }
            if segment == "." || segment == ".." {
                return Err("chapter media: invalid storage root path segment".to_string());
            }
            resolved.push(segment);
        }
        return Ok(resolved);
    }
    if trimmed.starts_with("content://") {
        return Err("Android storage folder must be on device storage.".to_string());
    }
    if trimmed.starts_with("file://") {
        return crate::android_content_io::resolve_filesystem_path(trimmed);
    }
    Ok(PathBuf::from(trimmed))
}

pub(crate) fn media_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let raw = configured_storage_root_value(app)?
            .ok_or_else(|| "Android media storage folder has not been selected.".to_string())?;
        crate::android_content_io::ensure_all_files_access()?;
        return resolve_storage_root_path(&raw);
    }
    #[cfg(not(target_os = "android"))]
    {
        match configured_storage_root_value(app)? {
            Some(raw) => resolve_storage_root_path(&raw),
            None => default_media_root(app),
        }
    }
}

fn save_configured_media_root_value<R: Runtime>(
    app: &AppHandle<R>,
    raw_value: &str,
) -> Result<String, String> {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return Err("chapter media: storage root is empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("chapter media: storage root contains an invalid character".to_string());
    }
    #[cfg(target_os = "android")]
    crate::android_content_io::ensure_all_files_access()?;

    let resolved_path = resolve_storage_root_path(trimmed)?;
    fs::create_dir_all(&resolved_path)
        .map_err(|err| format!("chapter media: create storage root: {err}"))?;
    ensure_contents_nomedia(&resolved_path)?;

    let config_path = storage_root_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("chapter media: create config dir: {err}"))?;
    }
    fs::write(&config_path, trimmed)
        .map_err(|err| format!("chapter media: write storage root: {err}"))?;
    Ok(trimmed.to_string())
}

pub(super) fn ensure_contents_nomedia(root: &Path) -> Result<(), String> {
    let contents_dir = root.join(CONTENTS_ROOT_DIR);
    fs::create_dir_all(&contents_dir)
        .map_err(|err| format!("chapter media: create contents dir: {err}"))?;
    let nomedia_path = contents_dir.join(NO_MEDIA_FILE);
    #[cfg(target_os = "android")]
    let existed = nomedia_path.is_file();
    File::options()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&nomedia_path)
        .map(|_| ())
        .map_err(|err| format!("chapter media: create .nomedia: {err}"))?;
    #[cfg(target_os = "android")]
    if !existed {
        crate::android_content_io::scan_file(&nomedia_path);
    }
    Ok(())
}

pub(super) fn media_roots_for_lookup<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    roots.push(media_root(app)?);
    #[cfg(not(target_os = "android"))]
    {
        let default_root = default_media_root(app)?;
        if !roots.iter().any(|root| root == &default_root) {
            roots.push(default_root);
        }
    }
    Ok(roots)
}

#[tauri::command]
pub async fn chapter_media_get_storage_root(app: AppHandle) -> Result<Option<String>, String> {
    chapter_media_blocking("read storage root", move || configured_storage_root_value(&app)).await
}

#[tauri::command]
pub async fn chapter_media_set_storage_root(
    app: AppHandle,
    root: String,
) -> Result<String, String> {
    chapter_media_blocking("set storage root", move || {
        save_configured_media_root_value(&app, &root)
    })
    .await
}

#[tauri::command]
pub async fn chapter_media_pick_storage_root(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        crate::android_content_io::ensure_all_files_access()?;
        let Some(picked) = crate::android_content_io::pick_storage_root().await? else {
            return Ok(None);
        };
        chapter_media_blocking("pick storage root", move || {
            save_configured_media_root_value(&app, &picked).map(Some)
        })
        .await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android storage picker is only supported on Android.".to_string())
    }
}

#[tauri::command]
pub async fn chapter_media_use_default_storage_root(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Err("Android requires selecting an external storage folder.".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        chapter_media_blocking("use default storage root", move || {
            let root_path = default_media_root(&app)?;
            save_configured_media_root_value(&app, &root_path.to_string_lossy())
        })
        .await
    }
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

pub(super) fn is_storage_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 240 || value.starts_with(['.', ' '])
        || value.ends_with(['.', ' '])
        || value.chars().any(|ch| ch < '\u{0020}' || "<>:\"/\\|?*".contains(ch))
    {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    if [".tmp", ".bak", ".part", ".partial", ".norea-sync-backup"]
        .iter().any(|suffix| lower.ends_with(suffix))
    {
        return false;
    }
    let device = lower.split('.').next().unwrap_or_default();
    !matches!(device, "con" | "prn" | "aux" | "nul")
        && !(device.len() == 4
            && (device.starts_with("com") || device.starts_with("lpt"))
            && device.as_bytes()[3].is_ascii_digit())
}

pub(super) fn is_plugin_storage_id(value: &str) -> bool {
    is_storage_id(value) && value.split('-').all(|part| !part.is_empty()
        && part.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
}

pub(super) fn content_novel_dir_at(
    root: &Path,
    source_id: &str,
    _novel_id: i64,
    source_novel_id: Option<&str>,
    _novel_name: Option<&str>,
) -> Result<PathBuf, String> {
    if !is_plugin_storage_id(source_id) {
        return Err("chapter media: invalid plugin id".to_string());
    }
    let source_novel_id = source_novel_id.filter(|id| is_storage_id(id))
        .ok_or_else(|| "chapter media: invalid plugin-owned novel id".to_string())?;
    Ok(root.join(CONTENTS_ROOT_DIR).join(source_id).join(source_novel_id))
}

pub(super) fn chapter_number_segment(
    chapter_number: Option<&str>,
    position: Option<i64>,
    _chapter_id: i64,
) -> Result<String, String> {
    let invalid = || "chapter media: invalid chapter sequence".to_string();
    let number = if let Some(value) = chapter_number {
        let parts: Vec<_> = value.split('.').collect();
        if parts.len() > 2 || parts.iter().any(|part| part.is_empty()
            || !part.bytes().all(|byte| byte.is_ascii_digit()))
        {
            return Err(invalid());
        }
        value.parse::<f64>().map_err(|_| invalid())?
    } else {
        position.filter(|value| *value > 0).ok_or_else(invalid)? as f64
    };
    if !number.is_finite() || number < 0.0 || number >= 1e21
        || (number > 0.0 && number < 1e-6)
    {
        return Err(invalid());
    }
    Ok(if number == 0.0 { "0".to_string() } else { number.to_string() })
}

pub(super) fn is_chapter_directory_name(value: &str) -> bool {
    chapter_number_segment(Some(value), None, 0).is_ok_and(|number| number == value)
}

pub(super) fn content_chapter_dir_at(
    root: &Path,
    source_id: &str,
    novel_id: i64,
    source_novel_id: Option<&str>,
    novel_name: Option<&str>,
    chapter_id: i64,
    chapter_number: Option<&str>,
    _chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<PathBuf, String> {
    let novel_dir = content_novel_dir_at(root, source_id, novel_id, source_novel_id, novel_name)?;
    if let Some(directory) = super::work_metadata::registered_chapter_directory(root, chapter_id) {
        return Ok(directory);
    }
    let chapter_segment = chapter_number_segment(chapter_number, chapter_position, chapter_id)?;
    Ok(novel_dir.join(chapter_segment))
}

pub(super) fn content_chapter_relative_dir(
    source_id: &str,
    novel_id: i64,
    source_novel_id: Option<&str>,
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
        source_novel_id,
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?;
    Ok(dir.to_string_lossy().replace('\\', "/"))
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
    novel_directory_name: &str,
    chapter_directory_name: &str,
) -> Result<Vec<PathBuf>, String> {
    if !is_storage_id(novel_directory_name) || !is_chapter_directory_name(chapter_directory_name) {
        return Err("chapter media: invalid chapter storage identity".to_string());
    }
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
                .eq(novel_directory_name)
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
                    .eq(chapter_directory_name)
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
    source_novel_id: &str,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<Vec<PathBuf>, String> {
    let novel_dir = content_novel_dir_at(root, source_id, novel_id, Some(source_novel_id), None)?;
    let source_dir = novel_dir.parent().ok_or("chapter media: missing source directory")?;
    content_chapter_dirs_matching_segments(
        source_dir,
        source_novel_id,
        &chapter_number_segment(chapter_number, chapter_position, chapter_id)?,
    )
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
