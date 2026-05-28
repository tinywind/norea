use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, BufReader, BufWriter, ErrorKind, Read},
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager};
use zip::result::ZipError;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::native_stream::{self, NativeStreamState};
use tauri::State;

pub(crate) const MEDIA_ROOT_DIR: &str = "chapter-media";
const MEDIA_URI_PREFIX: &str = "norea-media://reader-asset/";
const CONTENTS_ROOT_DIR: &str = "contents";
const NO_MEDIA_FILE: &str = ".nomedia";
const MEDIA_DOWNLOAD_DIR: &str = "media";
const MEDIA_ARCHIVE_FILE: &str = "media.zip";
const LEGACY_STORAGE_MANIFEST_FILE: &str = "storage-manifest.json";
const CHAPTER_MEDIA_MANIFEST_FILE: &str = "manifest.json";
const STORAGE_ROOT_CONFIG_FILE: &str = "chapter-media-storage-root.txt";
const MEDIA_RESTORE_BACKUP_INFIX: &str = ".restore-backup-";
const CHAPTER_MEDIA_STREAM_DOMAIN: &str = "chapter-media";

async fn chapter_media_blocking<T, F>(context: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("chapter media: {context} task: {err}"))?
}

fn legacy_media_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("chapter media: app data dir: {err}"))?
        .join(MEDIA_ROOT_DIR))
}

fn storage_root_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|err| format!("chapter media: app config dir: {err}"))?
        .join(STORAGE_ROOT_CONFIG_FILE))
}

fn configured_media_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
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

fn media_root(app: &AppHandle) -> Result<PathBuf, String> {
    configured_media_root(app)?.map_or_else(|| legacy_media_root(app), Ok)
}

fn save_configured_media_root(app: &AppHandle, root_path: &Path) -> Result<String, String> {
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

fn ensure_contents_nomedia(root: &Path) -> Result<(), String> {
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

fn media_roots_for_lookup(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut roots = Vec::new();
    roots.push(media_root(app)?);
    let legacy_root = legacy_media_root(app)?;
    if !roots.iter().any(|root| root == &legacy_root) {
        roots.push(legacy_root);
    }
    Ok(roots)
}

#[tauri::command]
pub fn chapter_media_get_storage_root(app: AppHandle) -> Result<Option<String>, String> {
    configured_media_root(&app).map(|root| root.map(|path| path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn chapter_media_set_storage_root(app: AppHandle, root: String) -> Result<String, String> {
    let trimmed = root.trim();
    if trimmed.is_empty() {
        return Err("chapter media: storage root is empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("chapter media: storage root contains an invalid character".to_string());
    }

    let root_path = PathBuf::from(trimmed);
    save_configured_media_root(&app, &root_path)
}

#[tauri::command]
pub fn chapter_media_use_default_storage_root(app: AppHandle) -> Result<String, String> {
    let root_path = legacy_media_root(&app)?;
    save_configured_media_root(&app, &root_path)
}

fn safe_segment(value: &str, fallback: &str) -> String {
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

fn safe_media_relative_path(value: &str) -> Result<String, String> {
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

fn chapter_number_segment(
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

fn chapter_dir_at(root: &Path, chapter_id: i64) -> Result<PathBuf, String> {
    if chapter_id <= 0 {
        return Err("chapter media: invalid chapter id".to_string());
    }
    Ok(root.join(chapter_id.to_string()))
}

fn content_chapter_dir_at(
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
    let source_id = safe_segment(source_id, "source");
    let novel_segment = novel_folder_segment(novel_name, novel_path, novel_id);
    let chapter_segment =
        chapter_folder_segment(chapter_number, chapter_name, chapter_position, chapter_id);
    Ok(root
        .join(CONTENTS_ROOT_DIR)
        .join(source_id)
        .join(novel_segment)
        .join(chapter_segment))
}

fn content_chapter_relative_dir(
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

fn content_chapter_dirs_for_lookup(root: &Path, chapter_id: i64) -> Result<Vec<PathBuf>, String> {
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

fn legacy_storage_manifest_path(root: &Path) -> PathBuf {
    root.join(LEGACY_STORAGE_MANIFEST_FILE)
}

fn safe_relative_storage_path(value: &str) -> Result<PathBuf, String> {
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

fn chapter_archive_path_at(
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
    Ok(content_chapter_dir_at(
        root,
        source_id,
        novel_id,
        novel_path,
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?
    .join(MEDIA_ARCHIVE_FILE))
}

fn chapter_archives_in_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut archives = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| format!("chapter media: read dir: {err}"))? {
        let entry = entry.map_err(|err| format!("chapter media: read entry: {err}"))?;
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        {
            archives.push(path);
        }
    }
    archives.sort();
    Ok(archives)
}

fn clear_content_media_artifacts(chapter_dir: &Path) -> Result<(), String> {
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    if media_dir.exists() {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
    }
    for archive_path in chapter_archives_in_dir(chapter_dir)? {
        fs::remove_file(&archive_path)
            .map_err(|err| format!("chapter media: remove media archive: {err}"))?;
    }
    let backup_path = archive_backup_path(&chapter_dir.join(MEDIA_ARCHIVE_FILE));
    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|err| format!("chapter media: remove media archive backup: {err}"))?;
    }
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    if manifest_path.exists() {
        fs::remove_file(&manifest_path)
            .map_err(|err| format!("chapter media: remove media manifest: {err}"))?;
    }
    Ok(())
}

fn archive_backup_path(archive_path: &Path) -> PathBuf {
    archive_path.with_file_name(format!("{MEDIA_ARCHIVE_FILE}.bak"))
}

fn replace_media_archive(temp_archive_path: &Path, archive_path: &Path) -> Result<(), String> {
    let backup_path = archive_backup_path(archive_path);
    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|err| format!("chapter media: remove stale archive backup: {err}"))?;
    }
    let had_archive = archive_path.exists();
    if had_archive {
        fs::rename(archive_path, &backup_path)
            .map_err(|err| format!("chapter media: backup archive: {err}"))?;
    }

    if let Err(err) = fs::rename(temp_archive_path, archive_path) {
        if had_archive {
            let _ = fs::rename(&backup_path, archive_path);
        }
        return Err(format!("chapter media: move archive: {err}"));
    }

    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|err| format!("chapter media: remove archive backup: {err}"))?;
    }
    Ok(())
}

fn chapter_media_manifest_path(chapter_dir: &Path) -> PathBuf {
    chapter_dir.join(CHAPTER_MEDIA_MANIFEST_FILE)
}

fn write_chapter_media_manifest(path: &Path, manifest: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("chapter media: create media manifest dir: {err}"))?;
    }
    let temp_path = path.with_extension("json.tmp");
    let mut body = serde_json::to_vec_pretty(manifest)
        .map_err(|err| format!("chapter media: encode media manifest: {err}"))?;
    body.push(b'\n');
    fs::write(&temp_path, body)
        .map_err(|err| format!("chapter media: write media manifest temp: {err}"))?;
    fs::rename(&temp_path, path).map_err(|err| format!("chapter media: move media manifest: {err}"))
}

fn delete_legacy_storage_manifest(root: &Path) -> Result<(), String> {
    let manifest_path = legacy_storage_manifest_path(root);
    if manifest_path.exists() {
        fs::remove_file(&manifest_path)
            .map_err(|err| format!("chapter media: remove legacy storage manifest: {err}"))?;
    }
    Ok(())
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

#[derive(Debug)]
struct ParsedMediaSrc {
    file_name: String,
}

fn parse_media_src(media_src: &str) -> Result<ParsedMediaSrc, String> {
    let payload = media_src
        .strip_prefix(MEDIA_URI_PREFIX)
        .ok_or_else(|| "chapter media: unsupported media uri".to_string())?;
    Ok(ParsedMediaSrc {
        file_name: safe_media_relative_path(payload)?,
    })
}

fn media_src_chapter_id(context_chapter_id: Option<i64>) -> Result<i64, String> {
    let chapter_id = context_chapter_id
        .ok_or_else(|| "chapter media: missing chapter id context".to_string())?;
    if chapter_id <= 0 {
        return Err("chapter media: chapter id must be positive".to_string());
    }
    Ok(chapter_id)
}

fn content_chapter_dir_from_context(
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
    Ok(Some(content_chapter_dir_at(
        root,
        source_id,
        novel_id,
        Some(novel_path),
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?))
}

fn media_path_in_chapter_dir(chapter_dir: &Path, file_name: &str) -> Option<PathBuf> {
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

fn chapter_media_path_from_src_with_context(
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

fn move_media_source_to_part_path(
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

fn archive_cache_entry_paths(dir: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(|err| format!("chapter media: read cache dir: {err}"))? {
        let entry = entry.map_err(|err| format!("chapter media: read cache entry: {err}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = safe_segment(&entry.file_name().to_string_lossy(), "media");
        if file_name.ends_with(".part") {
            continue;
        }
        entries.push((file_name, path));
    }
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(entries)
}

#[tauri::command]
pub async fn chapter_media_archive_cache(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<u64, String> {
    chapter_media_blocking("archive cache", move || {
        chapter_media_archive_cache_sync(
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

fn chapter_media_archive_cache_sync(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<u64, String> {
    let novel_id = novel_id.ok_or_else(|| "chapter media: missing novel id".to_string())?;
    let source_id = source_id
        .as_deref()
        .ok_or_else(|| "chapter media: missing source id".to_string())?;
    let media_root = media_root(&app)?;
    ensure_contents_nomedia(&media_root)?;
    let chapter_dir = content_chapter_dir_at(
        &media_root,
        source_id,
        novel_id,
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_id,
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let archive_path = chapter_archive_path_at(
        &media_root,
        source_id,
        novel_id,
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_id,
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let cache_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);

    if !cache_dir.is_dir() {
        match fs::metadata(&archive_path) {
            Ok(metadata) if metadata.is_file() => return Ok(metadata.len()),
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => return Err(format!("chapter media: read archive metadata: {err}")),
        }
        return Ok(0);
    }

    let entries = archive_cache_entry_paths(&cache_dir)?;
    if entries.is_empty() {
        fs::remove_dir_all(&cache_dir)
            .map_err(|err| format!("chapter media: remove empty cache dir: {err}"))?;
        match fs::metadata(&archive_path) {
            Ok(metadata) if metadata.is_file() => return Ok(metadata.len()),
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => return Err(format!("chapter media: read archive metadata: {err}")),
        }
        return Ok(0);
    }

    fs::create_dir_all(&chapter_dir)
        .map_err(|err| format!("chapter media: create chapter dir: {err}"))?;
    let temp_archive_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    let temp_file = File::create(&temp_archive_path)
        .map_err(|err| format!("chapter media: create archive: {err}"))?;
    let mut archive = ZipWriter::new(BufWriter::new(temp_file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let new_entry_names: HashSet<String> = entries
        .iter()
        .map(|(entry_name, _)| entry_name.clone())
        .collect();
    let mut written_entry_names = HashSet::new();

    if archive_path.is_file() {
        let archive_file = File::open(&archive_path)
            .map_err(|err| format!("chapter media: open existing archive: {err}"))?;
        let mut existing_archive = ZipArchive::new(BufReader::new(archive_file))
            .map_err(|err| format!("chapter media: read existing archive: {err}"))?;
        for index in 0..existing_archive.len() {
            let mut entry = existing_archive
                .by_index(index)
                .map_err(|err| format!("chapter media: open existing archive entry: {err}"))?;
            if !entry.is_file() {
                continue;
            }
            let entry_name = safe_segment(entry.name(), "media");
            if entry_name.ends_with(".part")
                || new_entry_names.contains(&entry_name)
                || !written_entry_names.insert(entry_name.clone())
            {
                continue;
            }
            archive
                .start_file(&entry_name, options)
                .map_err(|err| format!("chapter media: start archive entry: {err}"))?;
            io::copy(&mut entry, &mut archive)
                .map_err(|err| format!("chapter media: copy existing archive entry: {err}"))?;
        }
    }

    for (entry_name, path) in entries {
        if !written_entry_names.insert(entry_name.clone()) {
            continue;
        }
        archive
            .start_file(&entry_name, options)
            .map_err(|err| format!("chapter media: start archive entry: {err}"))?;
        let mut input =
            File::open(&path).map_err(|err| format!("chapter media: open cache file: {err}"))?;
        io::copy(&mut input, &mut archive)
            .map_err(|err| format!("chapter media: write archive entry: {err}"))?;
    }

    archive
        .finish()
        .map_err(|err| format!("chapter media: finalize archive: {err}"))?;
    replace_media_archive(&temp_archive_path, &archive_path)?;
    fs::remove_dir_all(&cache_dir)
        .map_err(|err| format!("chapter media: remove media dir: {err}"))?;

    for root in media_roots_for_lookup(&app)? {
        for old_chapter_dir in content_chapter_dirs_for_lookup(&root, chapter_id)? {
            if old_chapter_dir != chapter_dir {
                clear_content_media_artifacts(&old_chapter_dir)?;
            }
        }
    }

    fs::metadata(&archive_path)
        .map(|metadata| metadata.len())
        .map_err(|err| format!("chapter media: read archive size: {err}"))
}

fn required_content_chapter_dir(
    app: &AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<&str>,
    novel_path: Option<&str>,
    novel_name: Option<&str>,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<PathBuf, String> {
    let novel_id = novel_id.ok_or_else(|| "chapter media: missing novel id".to_string())?;
    let source_id = source_id.ok_or_else(|| "chapter media: missing source id".to_string())?;
    let novel_path = novel_path.ok_or_else(|| "chapter media: missing novel path".to_string())?;
    let root = media_root(app)?;
    ensure_contents_nomedia(&root)?;
    content_chapter_dir_at(
        &root,
        source_id,
        novel_id,
        Some(novel_path),
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )
}

#[tauri::command]
pub async fn chapter_media_prepare_workspace(
    app: AppHandle,
    chapter_id: i64,
    repair: bool,
    preserve_existing: Option<bool>,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    chapter_media_blocking("prepare workspace", move || {
        chapter_media_prepare_workspace_sync(
            app,
            chapter_id,
            repair,
            preserve_existing.unwrap_or(false),
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

fn chapter_media_prepare_workspace_sync(
    app: AppHandle,
    chapter_id: i64,
    repair: bool,
    preserve_existing: bool,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    if !repair && !preserve_existing {
        let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
        if media_dir.exists() {
            fs::remove_dir_all(&media_dir)
                .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
        }
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        if archive_path.exists() {
            fs::remove_file(&archive_path)
                .map_err(|err| format!("chapter media: remove media archive: {err}"))?;
        }
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        if manifest_path.exists() {
            fs::remove_file(&manifest_path)
                .map_err(|err| format!("chapter media: remove media manifest: {err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn chapter_media_cleanup_workspace(
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
    chapter_media_blocking("cleanup workspace", move || {
        chapter_media_cleanup_workspace_sync(
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

fn chapter_media_cleanup_workspace_sync(
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
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    if media_dir.exists() {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn chapter_media_write_manifest(
    app: AppHandle,
    chapter_id: i64,
    complete: Option<bool>,
    files: serde_json::Value,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<(), String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let files = match files {
        serde_json::Value::Array(files) => files,
        _ => Vec::new(),
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let manifest = serde_json::json!({
        "version": 1,
        "complete": complete.unwrap_or(false),
        "updatedAt": now,
        "media": {
            "files": files
        }
    });
    write_chapter_media_manifest(&chapter_media_manifest_path(&chapter_dir), &manifest)
}

#[tauri::command]
pub fn chapter_media_read_manifest(
    app: AppHandle,
    chapter_id: i64,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<Option<String>, String> {
    let chapter_dir = required_content_chapter_dir(
        &app,
        chapter_id,
        novel_id,
        source_id.as_deref(),
        novel_path.as_deref(),
        novel_name.as_deref(),
        chapter_number.as_deref(),
        chapter_name.as_deref(),
        chapter_position,
    )?;
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    match fs::read_to_string(&manifest_path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: read media manifest: {err}")),
    }
}

#[tauri::command]
pub fn chapter_content_mirror_store(
    app: AppHandle,
    chapter_id: i64,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
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
    fs::rename(&temp_content_path, &content_path)
        .map_err(|err| format!("chapter media: move content mirror: {err}"))?;
    remove_stored_chapter_content_files(&media_root, chapter_id, Some(&content_path))?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub fn chapter_content_mirror_clear(app: AppHandle, chapter_id: i64) -> Result<(), String> {
    let media_root = media_root(&app)?;
    remove_stored_chapter_content_files(&media_root, chapter_id, None)?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub fn chapter_content_mirror_cleanup_legacy_manifest(app: AppHandle) -> Result<(), String> {
    let media_root = media_root(&app)?;
    delete_legacy_storage_manifest(&media_root)
}

#[tauri::command]
pub fn chapter_content_mirror_read_file(
    app: AppHandle,
    content_file: String,
) -> Result<Option<String>, String> {
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
}

fn archive_contains_file(archive_path: &Path, file_name: &str) -> Result<bool, String> {
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

fn media_mime_type(path: &Path) -> &'static str {
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
            media_mime_type(Path::new(&file_name)),
            encode_base64(&body)
        ))
    })
    .await
    .map_err(|err| format!("chapter media: read media task: {err}"))?
}

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

fn remove_existing_path(path: &Path, context: &str) -> Result<(), String> {
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
    let relative_dir = safe_relative_storage_path(&relative_dir)?;
    let path = media_root.join(relative_dir);
    remove_existing_path(&path, "chapter media: remove chapter storage dir")?;
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

fn chapter_media_clear_sync(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    fn store_input(file_name: &str) -> ChapterMediaStoreInput {
        ChapterMediaStoreInput {
            chapter_id: 42,
            file_name: file_name.to_string(),
            novel_id: Some(7),
            source_id: Some("demo".to_string()),
            novel_name: Some("Novel".to_string()),
            novel_path: Some("novel/path".to_string()),
            chapter_number: Some("1".to_string()),
            chapter_name: Some("Opening".to_string()),
            chapter_position: Some(1),
        }
    }

    fn stored_media_path(root: &Path, file_name: &str) -> PathBuf {
        root.join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Novel-novel-path")
            .join("1-Opening")
            .join(MEDIA_DOWNLOAD_DIR)
            .join(file_name)
    }

    #[test]
    fn store_chapter_media_body_writes_contextual_media_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = store_chapter_media_at_root(
            dir.path(),
            store_input("page.png"),
            ChapterMediaStoreSource::Bytes(vec![1, 2, 3]),
        )
        .expect("store media");

        assert_eq!(src, "norea-media://reader-asset/page.png");
        assert_eq!(
            fs::read(stored_media_path(dir.path(), "page.png")).expect("stored media"),
            vec![1, 2, 3]
        );
        assert!(dir
            .path()
            .join(CONTENTS_ROOT_DIR)
            .join(NO_MEDIA_FILE)
            .exists());
    }

    #[test]
    fn store_chapter_media_file_consumes_source_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source_path = dir.path().join("stream.bin");
        fs::write(&source_path, [7, 8, 9]).expect("write stream");

        let src = store_chapter_media_at_root(
            dir.path(),
            store_input("page.png"),
            ChapterMediaStoreSource::File(source_path.clone()),
        )
        .expect("store media handle");

        assert_eq!(src, "norea-media://reader-asset/page.png");
        assert!(!source_path.exists());
        assert_eq!(
            fs::read(stored_media_path(dir.path(), "page.png")).expect("stored media"),
            vec![7, 8, 9]
        );
    }

    #[test]
    fn media_path_from_chapter_dir_does_not_extract_archived_media() {
        let dir = tempfile::tempdir().expect("tempdir");
        let chapter_dir = dir.path().join("chapter");
        fs::create_dir_all(&chapter_dir).expect("create chapter dir");
        let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
        {
            let archive_file = File::create(&archive_path).expect("create archive");
            let mut archive = ZipWriter::new(BufWriter::new(archive_file));
            archive
                .start_file("page.png", SimpleFileOptions::default())
                .expect("start archive entry");
            io::copy(&mut &b"image-body"[..], &mut archive).expect("write archive entry");
            archive.finish().expect("finish archive");
        }

        let path =
            media_path_from_chapter_dir(&chapter_dir, "page.png").expect("resolve archived media");
        let body = media_body_from_chapter_dir(&chapter_dir, "page.png")
            .expect("read archived media")
            .expect("archived media body");

        assert!(path.is_none());
        assert_eq!(body, b"image-body");
        assert!(!chapter_dir
            .join(MEDIA_DOWNLOAD_DIR)
            .join("page.png")
            .exists());
    }
}
