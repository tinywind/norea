use super::chapter_media_blocking;
use super::manifest::is_safe_manifest_media_file_name;
use super::paths::{
    media_root, safe_relative_storage_path, validate_chapter_dir_under_storage_root,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use zip::ZipArchive;

const MAX_ENTRY: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
const MAX_TOTAL: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 100_000;
const PAYLOAD_NAMES: &[&str] = &[
    "content.html",
    "content.pdf",
    ".chapter-content.partial",
    "content.html.tmp",
    "content.pdf.tmp",
    ".chapter-content.partial.tmp",
    "media.zip",
    "media.zip.tmp",
    "media.zip.tmp.zip",
    "media.zip.bak",
    "media.zip.rollback",
];

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDigest {
    sha256: String,
    bytes: u64,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAsset {
    key: String,
    sha256: String,
    bytes: u64,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterPayloadSnapshot {
    body: Option<PayloadDigest>,
    expected_asset_keys: Option<Vec<String>>,
    stored_assets: Vec<StoredAsset>,
    fingerprint: String,
    payload_bytes: u64,
    content_bytes: u64,
    media_bytes: u64,
    media_complete: bool,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadFileError {
    path: String,
    message: String,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDeleteResult {
    snapshot: ChapterPayloadSnapshot,
    errors: Vec<PayloadFileError>,
}

fn digest_reader(mut reader: impl Read, limit: u64) -> Result<PayloadDigest, String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut bytes = 0u64;
    loop {
        let n = reader
            .read(&mut buffer)
            .map_err(|e| format!("read payload: {e}"))?;
        if n == 0 {
            break;
        }
        bytes = bytes.checked_add(n as u64).ok_or("payload size overflow")?;
        if bytes > limit {
            return Err("payload exceeds size limit".into());
        }
        hasher.update(&buffer[..n]);
    }
    Ok(PayloadDigest {
        sha256: hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        bytes,
    })
}

fn regular_file(path: &Path) -> Result<Option<File>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => File::open(path)
            .map(Some)
            .map_err(|e| format!("open {}: {e}", path.display())),
        Ok(_) => Err(format!("not a regular file: {}", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("inspect {}: {e}", path.display())),
    }
}

fn payload_paths(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for name in PAYLOAD_NAMES {
        let path = dir.join(name);
        if regular_file(&path)?.is_some() {
            paths.push(path);
        }
    }
    let media = dir.join("media");
    match fs::symlink_metadata(&media) {
        Ok(meta) if meta.file_type().is_dir() => {
            for entry in fs::read_dir(&media).map_err(|e| format!("read media directory: {e}"))? {
                let entry = entry.map_err(|e| format!("read media entry: {e}"))?;
                let name = entry.file_name().to_string_lossy().to_string();
                let base = name.strip_suffix(".part").unwrap_or(&name);
                if is_safe_manifest_media_file_name(base) && !base.starts_with('.') {
                    if regular_file(&entry.path())?.is_some() {
                        paths.push(entry.path());
                    }
                }
                if paths.len() > MAX_FILES {
                    return Err("too many payload files".into());
                }
            }
        }
        Ok(_) => return Err("media directory is not a directory".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("inspect media directory: {e}")),
    }
    paths.sort();
    Ok(paths)
}

fn fingerprint(dir: &Path, paths: &[PathBuf]) -> Result<(String, u64), String> {
    let mut hash = Sha256::new();
    let canonical_dir =
        fs::canonicalize(dir).map_err(|e| format!("resolve chapter directory: {e}"))?;
    hash.update(b"present\0");
    hash.update(canonical_dir.to_string_lossy().as_bytes());
    let mut bytes = 0u64;
    let mut all = paths.to_vec();
    let manifest = dir.join("manifest.json");
    if regular_file(&manifest)?.is_some() {
        all.push(manifest);
    }
    all.sort();
    for path in all {
        let relative = path
            .strip_prefix(dir)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let file = regular_file(&path)?.ok_or("payload changed during inspection")?;
        let limit = if relative == "manifest.json" {
            16 * 1024 * 1024
        } else if relative.contains("media.zip") {
            MAX_ARCHIVE
        } else {
            MAX_TOTAL
        };
        let digest = digest_reader(file, limit)?;
        if relative != "manifest.json" {
            bytes = bytes
                .checked_add(digest.bytes)
                .ok_or("payload size overflow")?;
            if bytes > MAX_TOTAL {
                return Err("payload exceeds total size limit".into());
            }
        }
        hash.update((relative.len() as u64).to_be_bytes());
        hash.update(relative.as_bytes());
        hash.update(digest.bytes.to_be_bytes());
        hash.update(digest.sha256.as_bytes());
    }
    Ok((
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        bytes,
    ))
}

fn declarations(dir: &Path) -> Result<Option<Vec<String>>, String> {
    let Some(file) = regular_file(&dir.join("manifest.json"))? else {
        return Ok(None);
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Ok(None);
    }
    let value: serde_json::Value = match serde_json::from_reader(file) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if value["version"].as_u64() != Some(1)
        || value["complete"].as_bool().is_none()
        || value["updatedAt"].as_u64().is_none()
    {
        return Ok(None);
    }
    let Some(files) = value["media"]["files"].as_array() else {
        return Ok(None);
    };
    if files.len() > MAX_FILES {
        return Ok(None);
    }
    let mut keys = Vec::new();
    let mut names = HashSet::new();
    let mut urls = HashSet::new();
    for file in files {
        let Some(name) = file["fileName"].as_str() else {
            return Ok(None);
        };
        let Some(path) = file["path"].as_str() else {
            return Ok(None);
        };
        let Some(url) = file["sourceUrl"].as_str() else {
            return Ok(None);
        };
        if file["bytes"]
            .as_u64()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .is_none()
            || file["updatedAt"]
                .as_u64()
                .filter(|v| *v <= 9_007_199_254_740_991)
                .is_none()
            || !matches!(file["status"].as_str(), Some("stored" | "remote"))
            || !urls.insert(url.to_string())
            || !is_safe_manifest_media_file_name(name)
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || name.starts_with('.')
            || name.to_ascii_lowercase().ends_with(".part")
            || (!path.is_empty() && path != format!("media/{name}"))
            || !names.insert(name.to_ascii_lowercase())
        {
            return Ok(None);
        }
        keys.push(format!("media/{name}"));
    }
    keys.sort();
    Ok(Some(keys))
}

fn inspect_inventory(dir: &Path) -> Result<ChapterPayloadSnapshot, String> {
    if !dir.exists() {
        let mut ancestor = dir;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or("missing storage root")?;
        }
        let canonical = fs::canonicalize(ancestor)
            .map_err(|e| e.to_string())?
            .join(dir.strip_prefix(ancestor).map_err(|e| e.to_string())?);
        let mut hash = Sha256::new();
        hash.update(b"missing\0");
        hash.update(canonical.to_string_lossy().as_bytes());
        return Ok(ChapterPayloadSnapshot {
            body: None,
            expected_asset_keys: None,
            stored_assets: Vec::new(),
            fingerprint: hash
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            payload_bytes: 0,
            content_bytes: 0,
            media_bytes: 0,
            media_complete: true,
        });
    }
    let paths = payload_paths(dir)?;
    let (before, payload_bytes) = fingerprint(dir, &paths)?;
    if paths.contains(&dir.join("content.html")) && paths.contains(&dir.join("content.pdf")) {
        return Err("multiple published chapter bodies are present".into());
    }
    let body = ["content.html", "content.pdf", ".chapter-content.partial"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| paths.contains(path));
    let body = body
        .map(|p| digest_reader(regular_file(&p)?.ok_or("body disappeared")?, MAX_TOTAL))
        .transpose()?
        .filter(|body| body.bytes > 0);
    let mut keys = declarations(dir)?;
    let mut stored = HashMap::<String, StoredAsset>::new();
    {
        if let Some(file) = regular_file(&dir.join("media.zip"))? {
            if file.metadata().map_err(|e| e.to_string())?.len() > MAX_ARCHIVE {
                return Err("media archive exceeds size limit".into());
            }
            match ZipArchive::new(file) {
                Ok(mut zip) => {
                    if zip.len() > MAX_FILES {
                        return Err("too many archive entries".into());
                    }
                    let mut archive_file =
                        regular_file(&dir.join("media.zip"))?.ok_or("archive disappeared")?;
                    if !super::repair::repair_archive_duplicates(
                        &mut archive_file,
                        zip.central_directory_start(),
                    )?
                    .is_empty()
                    {
                        keys = None;
                    }
                    let mut seen = HashSet::new();
                    let mut total = 0u64;
                    for i in 0..zip.len() {
                        let mut entry = match zip.by_index(i) {
                            Ok(v) => v,
                            Err(_) => {
                                keys = None;
                                break;
                            }
                        };
                        let name = match entry.name() {
                            Ok(name) => name.into_owned(),
                            Err(_) => {
                                keys = None;
                                break;
                            }
                        };
                        if !is_safe_manifest_media_file_name(&name)
                            || !seen.insert(name.to_ascii_lowercase())
                            || !entry.is_file()
                            || entry.is_symlink()
                        {
                            keys = None;
                            break;
                        }
                        total = total
                            .checked_add(entry.size())
                            .ok_or("archive size overflow")?;
                        if entry.size() > MAX_ENTRY || total > MAX_TOTAL {
                            return Err("archive exceeds expanded size limit".into());
                        }
                        let key = format!("media/{name}");
                        if let Ok(digest) = digest_reader(&mut entry, MAX_ENTRY) {
                            if digest.bytes == entry.size() && digest.bytes > 0 {
                                stored.insert(
                                    key.clone(),
                                    StoredAsset {
                                        key,
                                        sha256: digest.sha256,
                                        bytes: digest.bytes,
                                    },
                                );
                            }
                        }
                    }
                }
                Err(_) => keys = None,
            }
        }
        for path in &paths {
            if path.parent() != Some(dir.join("media").as_path()) {
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy();
            if name.ends_with(".part") {
                continue;
            }
            let key = format!("media/{name}");
            let digest = digest_reader(regular_file(path)?.ok_or("asset disappeared")?, MAX_ENTRY)?;
            if digest.bytes > 0 {
                if stored.get(&key).is_some_and(|existing| {
                    existing.sha256 != digest.sha256 || existing.bytes != digest.bytes
                }) {
                    keys = None;
                }
                stored.insert(
                    key.clone(),
                    StoredAsset {
                        key,
                        sha256: digest.sha256,
                        bytes: digest.bytes,
                    },
                );
            }
        }
    }
    let mut stored_assets: Vec<_> = stored.into_values().collect();
    stored_assets.sort_by(|a, b| a.key.cmp(&b.key));
    let content_bytes = body.as_ref().map_or(0, |item| item.bytes);
    let media_bytes = regular_file(&dir.join("media.zip"))?
        .map(|file| {
            file.metadata()
                .map(|metadata| metadata.len())
                .map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or(0);
    let stored_keys: HashSet<_> = stored_assets
        .iter()
        .map(|asset| asset.key.as_str())
        .collect();
    let media_complete = match &keys {
        Some(expected) => expected
            .iter()
            .all(|key| stored_keys.contains(key.as_str())),
        None => !dir.join("manifest.json").exists() && media_bytes == 0,
    };
    let paths_after = payload_paths(dir)?;
    let (after, _) = fingerprint(dir, &paths_after)?;
    if before != after {
        return Err("payload changed during inspection".into());
    }
    Ok(ChapterPayloadSnapshot {
        body,
        expected_asset_keys: keys,
        stored_assets,
        fingerprint: after,
        payload_bytes,
        content_bytes,
        media_bytes,
        media_complete,
    })
}

fn resolved_dir(app: &AppHandle, chapter_dir: &str) -> Result<PathBuf, String> {
    let root = media_root(app)?;
    let relative = safe_relative_storage_path(chapter_dir)?;
    let dir = root.join(&relative);
    let backup = dir.with_file_name(format!(
        ".{}.norea-sync-backup",
        dir.file_name()
            .ok_or("invalid chapter name")?
            .to_string_lossy()
    ));
    match fs::symlink_metadata(&backup) {
        Ok(_) => return Err("chapter recovery backup requires resolution before cleanup".into()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("inspect chapter recovery backup: {e}")),
    }
    let mut current = root.clone();
    if !fs::metadata(&root)
        .map_err(|e| format!("inspect storage root: {e}"))?
        .is_dir()
    {
        return Err("storage root is not a directory".into());
    }
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err("chapter path is not a regular directory".into()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => break,
            Err(e) => return Err(format!("inspect chapter path: {e}")),
        }
    }
    if dir.exists() {
        validate_chapter_dir_under_storage_root(&root, &dir)?;
    }
    Ok(dir)
}

#[tauri::command]
pub async fn chapter_payload_inventory(
    app: AppHandle,
    chapter_dir: String,
) -> Result<ChapterPayloadSnapshot, String> {
    chapter_media_blocking("inspect payload inventory", move || {
        inspect_inventory(&resolved_dir(&app, &chapter_dir)?)
    })
    .await
}

#[tauri::command]
pub async fn chapter_payload_delete(
    app: AppHandle,
    chapter_dir: String,
    expected_fingerprint: String,
) -> Result<PayloadDeleteResult, String> {
    chapter_media_blocking("delete chapter payload", move || {
        delete_inventory(&resolved_dir(&app, &chapter_dir)?, &expected_fingerprint)
    })
    .await
}

fn delete_inventory(dir: &Path, expected_fingerprint: &str) -> Result<PayloadDeleteResult, String> {
    let snapshot = inspect_inventory(dir)?;
    if snapshot.fingerprint != expected_fingerprint {
        return Err("chapter payload changed since preview".into());
    }
    let mut errors = Vec::new();
    for path in payload_paths(dir)? {
        if let Err(e) = fs::remove_file(&path) {
            errors.push(PayloadFileError {
                path: path
                    .strip_prefix(dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned(),
                message: e.to_string(),
            });
        }
    }
    let snapshot = inspect_inventory(dir).map_err(|error| {
        let failures = errors
            .iter()
            .map(|failure| format!("{}: {}", failure.path, failure.message))
            .collect::<Vec<_>>()
            .join("; ");
        if failures.is_empty() {
            format!("post-delete inspection failed: {error}")
        } else {
            format!("post-delete inspection failed: {error}; deletion errors: {failures}")
        }
    })?;
    Ok(PayloadDeleteResult { snapshot, errors })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn rejects_multiple_published_bodies_and_ignores_empty_body() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("content.html"), b"").unwrap();
        assert!(inspect_inventory(dir.path()).unwrap().body.is_none());
        fs::write(dir.path().join("content.pdf"), b"pdf").unwrap();
        assert!(inspect_inventory(dir.path()).is_err());
    }

    #[test]
    fn missing_chapter_has_empty_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing").join("chapter");
        let snapshot = inspect_inventory(&missing).unwrap();
        assert!(snapshot.body.is_none());
        assert_eq!(snapshot.payload_bytes, 0);
        assert!(snapshot.expected_asset_keys.is_none());
    }

    #[test]
    fn deletion_rejects_stale_snapshot_and_preserves_metadata() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("manifest.json"), b"malformed but retained").unwrap();
        fs::write(dir.path().join("content.html"), b"first").unwrap();
        fs::write(dir.path().join("unrelated.txt"), b"keep").unwrap();
        let snapshot = inspect_inventory(dir.path()).unwrap();
        fs::write(dir.path().join("content.html"), b"other").unwrap();
        assert!(delete_inventory(dir.path(), &snapshot.fingerprint).is_err());
        let current = inspect_inventory(dir.path()).unwrap();
        let result = delete_inventory(dir.path(), &current.fingerprint).unwrap();
        assert!(result.errors.is_empty());
        assert_eq!(result.snapshot.payload_bytes, 0);
        assert_eq!(
            fs::read(dir.path().join("manifest.json")).unwrap(),
            b"malformed but retained"
        );
        assert_eq!(fs::read(dir.path().join("unrelated.txt")).unwrap(), b"keep");
    }

    #[test]
    fn rejects_corrupt_zip_entries_from_inventory() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("content.html"), b"body").unwrap();
        fs::write(dir.path().join("manifest.json"), br#"{"version":1,"complete":false,"updatedAt":0,"media":{"files":[{"fileName":"a.png","path":"media/a.png","bytes":5,"sourceUrl":"https://example.test/a","status":"stored","updatedAt":0}]}}"#).unwrap();
        let path = dir.path().join("media.zip");
        let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
        zip.start_file(
            "a.png",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(b"image").unwrap();
        zip.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let offset = bytes.windows(5).position(|part| part == b"image").unwrap();
        bytes[offset] ^= 1;
        fs::write(&path, bytes).unwrap();
        let snapshot = inspect_inventory(dir.path()).unwrap();
        assert_eq!(snapshot.expected_asset_keys.unwrap(), vec!["media/a.png"]);
        assert!(snapshot.stored_assets.is_empty());
        assert!(!snapshot.media_complete);
    }

    #[test]
    fn hashes_body_and_valid_declared_assets_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("content.html"), b"body").unwrap();
        fs::write(
            dir.path().join("manifest.json"),
            br#"{"version":1,"complete":false,"updatedAt":0,"media":{"files":[{"fileName":"a.png","path":"media/a.png","bytes":5,"sourceUrl":"https://example.test/a","status":"remote","updatedAt":0}]}}"#,
        )
        .unwrap();
        let file = File::create(dir.path().join("media.zip")).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("a.png", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"image").unwrap();
        zip.finish().unwrap();
        let snapshot = inspect_inventory(dir.path()).unwrap();
        assert_eq!(snapshot.body.unwrap().bytes, 4);
        assert_eq!(snapshot.expected_asset_keys.unwrap(), vec!["media/a.png"]);
        assert_eq!(snapshot.stored_assets[0].bytes, 5);
    }
}
