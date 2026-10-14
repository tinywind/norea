use serde_json::{json, Value};
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

const MAX_ZIP_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const LOCAL_MEDIA: &str = "norea-media://reader-asset/";
static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);
static INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn failure(error: impl std::fmt::Display) -> String {
    format!("content sync: {error}")
}

fn safe_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains(['\\', ':', '\0'])
        || value.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.ends_with(['.', ' '])
                || part.chars().any(char::is_control)
                || part.contains(['*', '?', '"', '<', '>', '|'])
                || matches!(
                    part.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
    {
        return Err(failure("unsafe package path"));
    }
    Ok(())
}

#[cfg(test)]
fn file_hash(path: &Path) -> Result<(u64, String), String> {
    let mut input = File::open(path).map_err(failure)?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(failure)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_EXPANDED_BYTES {
            return Err(failure("file exceeds package limit"));
        }
        hash.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

fn copy_limited(input: &mut impl Read, output: &mut impl Write, limit: u64) -> Result<u64, String> {
    let bytes = std::io::copy(&mut input.take(limit + 1), output).map_err(failure)?;
    if bytes > limit {
        return Err(failure("package exceeds byte limit"));
    }
    Ok(bytes)
}

fn read_json(path: &Path) -> Result<Value, String> {
    if fs::metadata(path).map_err(failure)?.len() > 16 * 1024 * 1024 {
        return Err(failure("manifest exceeds byte limit"));
    }
    serde_json::from_reader(File::open(path).map_err(failure)?).map_err(failure)
}

fn media_files(manifest: &Value) -> Result<Vec<(String, u64)>, String> {
    if manifest["version"] != 1 || manifest["complete"] != true {
        return Err(failure("chapter media is incomplete"));
    }
    let files = manifest["media"]["files"]
        .as_array()
        .ok_or_else(|| failure("invalid media manifest"))?;
    let mut names = HashSet::new();
    let mut result = Vec::new();
    for file in files {
        let name = file["fileName"]
            .as_str()
            .ok_or_else(|| failure("invalid media filename"))?;
        safe_path(name)?;
        if name.contains('/')
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            || !names.insert(name.to_ascii_lowercase())
            || file["status"] != "stored"
            || file["path"] != format!("media/{name}")
        {
            return Err(failure("incomplete or duplicate chapter media"));
        }
        result.push((
            name.to_string(),
            file["bytes"]
                .as_u64()
                .ok_or_else(|| failure("invalid media size"))?,
        ));
    }
    Ok(result)
}

fn validate_chapter_media(source: &Path) -> Result<(), String> {
    if !source.join("manifest.json").is_file() {
        return if source.join("media.zip").exists() {
            Err(failure("chapter media manifest is missing"))
        } else {
            Ok(())
        };
    }
    let media = media_files(&read_json(&source.join("manifest.json"))?)?;
    if media.len() + 2 > MAX_FILES {
        return Err(failure("too many chapter media files"));
    }
    let mut archive = if source.join("media.zip").is_file() {
        Some(ZipArchive::new(File::open(source.join("media.zip")).map_err(failure)?).map_err(failure)?)
    } else {
        None
    };
    if archive.as_ref().is_some_and(|archive| archive.len() != media.len()) {
        return Err(failure("media archive inventory does not match its manifest"));
    }
    let mut media_bytes = 0;
    for (name, size) in media {
        if size > MAX_EXPANDED_BYTES - media_bytes {
            return Err(failure("chapter media exceeds byte limit"));
        }
        media_bytes += size;
        let actual = if let Some(archive) = archive.as_mut() {
            let file = archive.by_name(&name).map_err(failure)?;
            if file.is_dir() || file.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
                return Err(failure("invalid chapter media artifact"));
            }
            file.size()
        } else {
            fs::metadata(source.join("media").join(name)).map_err(failure)?.len()
        };
        if actual != size {
            return Err(failure("incomplete media file"));
        }
    }
    Ok(())
}

fn convert_references(body: &str, files: &HashSet<String>, export: bool) -> Result<String, String> {
    let bytes = body.as_bytes();
    let mut result = String::new();
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        if body[index..].starts_with("<!--") {
            index = body[index + 4..]
                .find("-->")
                .map_or(bytes.len(), |end| index + 4 + end + 3);
            continue;
        }
        index += 1;
        while index < bytes.len() && !bytes[index].is_ascii_whitespace() && bytes[index] != b'>' {
            index += 1;
        }
        while index < bytes.len() && bytes[index] != b'>' {
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            let name_start = index;
            while index < bytes.len()
                && !bytes[index].is_ascii_whitespace()
                && !matches!(bytes[index], b'=' | b'>')
            {
                index += 1;
            }
            let name = body[name_start..index].to_ascii_lowercase();
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            if index >= bytes.len() || bytes[index] != b'=' {
                continue;
            }
            index += 1;
            while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            let quote = bytes
                .get(index)
                .copied()
                .filter(|byte| matches!(byte, b'\'' | b'"'));
            if quote.is_some() {
                index += 1;
            }
            let start = index;
            while index < bytes.len()
                && if let Some(quote) = quote {
                    bytes[index] != quote
                } else {
                    !bytes[index].is_ascii_whitespace() && bytes[index] != b'>'
                }
            {
                index += 1;
            }
            let end = index;
            if matches!(
                name.as_str(),
                "src"
                    | "srcset"
                    | "poster"
                    | "data-src"
                    | "data-original"
                    | "data-lazy-src"
                    | "style"
            ) {
                result.push_str(&body[copied..start]);
                result.push_str(&convert_asset_attribute(
                    &body[start..end],
                    &name,
                    files,
                    export,
                )?);
                copied = end;
            }
            if quote.is_some() && index < bytes.len() {
                index += 1;
            }
        }
        if index < bytes.len() {
            index += 1;
        }
    }
    result.push_str(&body[copied..]);
    Ok(result)
}

fn convert_asset_attribute(
    value: &str,
    attribute: &str,
    files: &HashSet<String>,
    export: bool,
) -> Result<String, String> {
    let prefix = if export { LOCAL_MEDIA } else { "media/" };
    let target = if export { "media/" } else { LOCAL_MEDIA };
    let mut result = String::new();
    let mut remaining = value;
    while let Some(start) = remaining.find(prefix) {
        let before = &remaining[..start];
        let candidate = if attribute == "style" {
            let before = before.trim_end_matches([' ', '\'', '"']);
            before.to_ascii_lowercase().ends_with("url(")
        } else if attribute == "srcset" {
            start == 0 || before.ends_with(|c: char| c.is_ascii_whitespace() || c == ',')
        } else {
            start == 0 || before.trim().is_empty()
        };
        if !candidate {
            result.push_str(&remaining[..start + prefix.len()]);
            remaining = &remaining[start + prefix.len()..];
            continue;
        }
        result.push_str(&remaining[..start]);
        let after = &remaining[start + prefix.len()..];
        let end = after
            .find(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '-' | '_' | '/'))
            .unwrap_or(after.len());
        let name = &after[..end];
        if !files.contains(name) {
            return Err(failure(format!("body references missing media: {name}")));
        }
        result.push_str(target);
        result.push_str(name);
        remaining = &after[end..];
    }
    result.push_str(remaining);
    Ok(result)
}

fn write_zip(path: &Path, root: &Path, files: &[String]) -> Result<(), String> {
    let mut zip = ZipWriter::new(File::create(path).map_err(failure)?);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for name in files {
        zip.start_file(name, options).map_err(failure)?;
        copy_limited(
            &mut File::open(root.join(name)).map_err(failure)?,
            &mut zip,
            MAX_EXPANDED_BYTES,
        )?;
    }
    zip.finish().map_err(failure)?.sync_all().map_err(failure)?;
    if fs::metadata(path).map_err(failure)?.len() > MAX_ZIP_BYTES {
        return Err(failure("ZIP exceeds byte limit"));
    }
    Ok(())
}

#[cfg(test)]
fn export_package(source: &Path, stage: &Path, mut manifest: Value) -> Result<Value, String> {
    let body_path = if manifest["chapter"]["contentType"] == "pdf" {
        "content.pdf"
    } else {
        "content.html"
    };
    let portable = stage.join("portable");
    fs::create_dir_all(portable.join("media")).map_err(failure)?;
    let media_manifest = source.join("manifest.json");
    let mut files = Vec::new();
    let media = if media_manifest.is_file() {
        let mut value = read_json(&media_manifest)?;
        let media = media_files(&value)?;
        value["updatedAt"] = json!(0);
        for file in value["media"]["files"].as_array_mut().unwrap() {
            file["updatedAt"] = json!(0);
        }
        fs::write(
            portable.join("media-manifest.json"),
            serde_json::to_vec(&value).map_err(failure)?,
        )
        .map_err(failure)?;
        files.push("media-manifest.json".to_string());
        media
    } else {
        Vec::new()
    };
    let mut archive = if source.join("media.zip").is_file() {
        Some(
            ZipArchive::new(File::open(source.join("media.zip")).map_err(failure)?)
                .map_err(failure)?,
        )
    } else {
        None
    };
    for (name, size) in &media {
        let destination = portable.join("media").join(name);
        let mut output = File::create(destination).map_err(failure)?;
        let bytes = if let Some(zip) = archive.as_mut() {
            copy_limited(&mut zip.by_name(name).map_err(failure)?, &mut output, *size)?
        } else {
            let path = source.join("media").join(name);
            if fs::symlink_metadata(&path)
                .map_err(failure)?
                .file_type()
                .is_symlink()
            {
                return Err(failure("symbolic media file"));
            }
            copy_limited(&mut File::open(path).map_err(failure)?, &mut output, *size)?
        };
        if bytes != *size {
            return Err(failure("incomplete media file"));
        }
        files.push(format!("media/{name}"));
    }
    let body_source = source.join(body_path);
    if fs::symlink_metadata(&body_source)
        .map_err(failure)?
        .file_type()
        .is_symlink()
    {
        return Err(failure("symbolic body file"));
    }
    if body_path == "content.pdf" {
        copy_limited(
            &mut File::open(body_source).map_err(failure)?,
            &mut File::create(portable.join(body_path)).map_err(failure)?,
            MAX_EXPANDED_BYTES,
        )?;
    } else {
        let body = fs::read_to_string(body_source).map_err(failure)?;
        let names = media.iter().map(|(name, _)| name.clone()).collect();
        fs::write(
            portable.join(body_path),
            convert_references(&body, &names, true)?,
        )
        .map_err(failure)?;
    }
    files.push(body_path.to_string());
    files.sort();
    if files.len() + 1 > MAX_FILES {
        return Err(failure("too many package files"));
    }
    let mut total = 0;
    let mut records = Vec::new();
    for path in &files {
        let (size, sha256) = file_hash(&portable.join(path))?;
        total += size;
        records.push(json!({"path":path,"size":size,"sha256":sha256}));
    }
    if total > MAX_EXPANDED_BYTES {
        return Err(failure("package exceeds expanded limit"));
    }
    manifest["files"] = Value::Array(records);
    manifest["bodyPath"] = json!(body_path);
    fs::write(
        portable.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(failure)?,
    )
    .map_err(failure)?;
    files.push("manifest.json".to_string());
    write_zip(&stage.join("package.zip"), &portable, &files)?;
    Ok(manifest)
}

fn import_package(archive: &Path, stage: &Path, expected: &Value) -> Result<Value, String> {
    if fs::metadata(archive).map_err(failure)?.len() > MAX_ZIP_BYTES {
        return Err(failure("ZIP exceeds byte limit"));
    }
    let mut zip = ZipArchive::new(File::open(archive).map_err(failure)?).map_err(failure)?;
    if zip.len() > MAX_FILES {
        return Err(failure("too many package entries"));
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(failure)?;
        safe_path(entry.name())?;
        if entry.is_dir()
            || !seen.insert(entry.name().to_ascii_lowercase())
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(failure("duplicate or non-file ZIP entry"));
        }
        total += entry.size();
        if total > MAX_EXPANDED_BYTES {
            return Err(failure("expanded ZIP exceeds byte limit"));
        }
    }
    let manifest: Value = {
        let entry = zip.by_name("manifest.json").map_err(failure)?;
        if entry.size() > 16 * 1024 * 1024 {
            return Err(failure("manifest exceeds byte limit"));
        }
        serde_json::from_reader(entry.take(16 * 1024 * 1024 + 1)).map_err(failure)?
    };
    if &manifest != expected || manifest["packageVersion"] != 1 {
        return Err(failure("package manifest differs from catalog"));
    }
    let body = manifest["bodyPath"]
        .as_str()
        .ok_or_else(|| failure("missing body path"))?;
    let expected_body = if manifest["chapter"]["contentType"] == "pdf" {
        "content.pdf"
    } else {
        "content.html"
    };
    if body != expected_body {
        return Err(failure("invalid package body"));
    }
    let records = manifest["files"]
        .as_array()
        .ok_or_else(|| failure("missing file list"))?;
    if records.len() + 1 != zip.len() {
        return Err(failure("unlisted ZIP entries"));
    }
    let mut declared = BTreeMap::new();
    for record in records {
        let name = record["path"]
            .as_str()
            .ok_or_else(|| failure("invalid file path"))?;
        safe_path(name)?;
        if !(name == body || name == "media-manifest.json" || name.starts_with("media/"))
            || declared.insert(name, record).is_some()
        {
            return Err(failure("invalid or duplicate declared file"));
        }
        let size = record["size"]
            .as_u64()
            .ok_or_else(|| failure("invalid file size"))?;
        let mut entry = zip.by_name(name).map_err(failure)?;
        if entry.size() != size {
            return Err(failure("file size mismatch"));
        }
        let path = stage.join(name);
        fs::create_dir_all(path.parent().unwrap()).map_err(failure)?;
        if copy_limited(&mut entry, &mut File::create(&path).map_err(failure)?, size)? != size {
            return Err(failure("file size mismatch"));
        }
    }
    if !declared.contains_key(body) {
        return Err(failure("body is absent"));
    }
    let media_path = stage.join("media-manifest.json");
    let media = if media_path.exists() {
        media_files(&read_json(&media_path)?)?
    } else {
        Vec::new()
    };
    let mut names = HashSet::new();
    for (name, size) in &media {
        let path = format!("media/{name}");
        if declared
            .get(path.as_str())
            .is_none_or(|record| record["size"] != *size)
        {
            return Err(failure("media manifest does not match package"));
        }
        names.insert(name.clone());
    }
    if declared
        .keys()
        .filter(|name| name.starts_with("media/"))
        .count()
        != media.len()
    {
        return Err(failure("unlisted chapter media"));
    }
    if body != "content.pdf" {
        let text = fs::read_to_string(stage.join(body)).map_err(failure)?;
        fs::write(stage.join(body), convert_references(&text, &names, false)?).map_err(failure)?;
    }
    let media_bytes = if !media.is_empty() {
        write_zip(
            &stage.join("media.zip"),
            &stage.join("media"),
            &media
                .iter()
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>(),
        )?;
        fs::metadata(stage.join("media.zip"))
            .map_err(failure)?
            .len()
    } else {
        0
    };
    if media_path.exists() {
        fs::rename(media_path, stage.join("manifest.json")).map_err(failure)?;
    }
    if stage.join("media").exists() {
        fs::remove_dir_all(stage.join("media")).map_err(failure)?;
    }
    Ok(
        json!({"contentBytes":fs::metadata(stage.join(body)).map_err(failure)?.len(),"mediaBytes":media_bytes}),
    )
}

fn checked_storage_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    safe_path(relative)?;
    let segments: Vec<_> = relative.split('/').collect();
    if segments.len() != 4 || segments[0] != "contents" {
        return Err(failure("expected readable chapter directory"));
    }
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(failure("unsafe storage directory"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failure(error)),
        }
    }
    Ok(path)
}

fn storage_directory(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = checked_storage_directory(root, relative)?;
    recover_content_directory(&path)?;
    Ok(path)
}

fn content_backup_path(destination: &Path) -> Result<PathBuf, String> {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| failure("invalid chapter directory"))?;
    Ok(destination.with_file_name(format!(".{name}.norea-sync-backup")))
}

fn recover_content_directory_locked(destination: &Path) -> Result<(), String> {
    let backup = content_backup_path(destination)?;
    let metadata = match fs::symlink_metadata(&backup) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(failure(error)),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure("invalid chapter recovery directory"));
    }
    if !destination.exists() {
        fs::rename(&backup, destination).map_err(failure)?;
    }
    Ok(())
}

pub(crate) fn recover_content_directory(destination: &Path) -> Result<(), String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| failure("chapter install lock failed"))?;
    recover_content_directory_locked(destination)
}

fn install_directory(source: &Path, destination: &Path) -> Result<(), String> {
    let _guard = INSTALL_LOCK
        .lock()
        .map_err(|_| failure("chapter install lock failed"))?;
    recover_content_directory_locked(destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| failure("missing chapter parent"))?;
    fs::create_dir_all(parent).map_err(failure)?;
    let token = stage_token();
    let stage = parent.join(format!(".norea-sync-{token}.stage"));
    let backup = content_backup_path(destination)?;
    if backup.exists() {
        if !destination.join("content.html").is_file() && !destination.join("content.pdf").is_file()
        {
            return Err(failure(
                "previous chapter backup retained because current content is incomplete",
            ));
        }
        fs::remove_dir_all(&backup).map_err(failure)?;
    }
    fs::create_dir(&stage).map_err(failure)?;
    let preparation = (|| {
        for entry in fs::read_dir(source).map_err(failure)? {
            let entry = entry.map_err(failure)?;
            if !entry.file_type().map_err(failure)?.is_file() {
                return Err(failure("invalid installed artifact"));
            }
            let target = stage.join(entry.file_name());
            let original = entry.metadata().map_err(failure)?;
            if fs::copy(entry.path(), &target).map_err(failure)? != original.len() {
                return Err(failure("storage copy size mismatch"));
            }
            let stored = File::options()
                .write(true)
                .open(&target)
                .map_err(failure)?;
            stored.set_times(fs::FileTimes::new().set_modified(original.modified().map_err(failure)?)).map_err(failure)?;
            stored.sync_all().map_err(failure)?;
            if stored.metadata().map_err(failure)?.len() != original.len() {
                return Err(failure("storage copy size mismatch"));
            }
        }
        Ok(())
    })();
    if let Err(error) = preparation {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let previous = destination.exists();
    if previous {
        fs::rename(destination, &backup).map_err(failure)?;
    }
    if let Err(error) = fs::rename(&stage, destination) {
        if previous {
            fs::rename(&backup, destination).map_err(|rollback| {
                failure(format!(
                    "install failed: {error}; previous files retained at {}: {rollback}",
                    backup.display()
                ))
            })?;
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(failure(error));
    }
    if previous {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn stage_token() -> String {
    format!(
        "{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
    )
}

fn chapter_files(source: &Path) -> Result<Vec<String>, String> {
    let metadata = fs::symlink_metadata(source).map_err(failure)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid chapter directory"));
    }
    let mut paths = Vec::new();
    for name in ["content.html", "content.pdf", "manifest.json", "media.zip"] {
        match fs::symlink_metadata(source.join(name)) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                paths.push(name.to_string());
            }
            Ok(_) => return Err(failure("invalid chapter artifact")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(failure(error)),
        }
    }
    if !paths
        .iter()
        .any(|path| path == "content.html" || path == "content.pdf")
    {
        return Err(failure("chapter body is missing"));
    }
    match fs::symlink_metadata(source.join("media")) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            for entry in fs::read_dir(source.join("media")).map_err(failure)? {
                let entry = entry.map_err(failure)?;
                if !entry.file_type().map_err(failure)?.is_file() {
                    return Err(failure("invalid chapter media artifact"));
                }
                let name = entry.file_name();
                let name = name.to_str().ok_or_else(|| failure("invalid media filename"))?;
                safe_path(name)?;
                paths.push(format!("media/{name}"));
            }
        }
        Ok(_) => return Err(failure("invalid chapter media directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(failure(error)),
    }
    if paths.len() > MAX_FILES {
        return Err(failure("too many chapter files"));
    }
    let mut total = 0;
    for path in &paths {
        let size = fs::metadata(source.join(path)).map_err(failure)?.len();
        let limit = match path.as_str() {
            "media.zip" => MAX_ZIP_BYTES,
            "manifest.json" => 16 * 1024 * 1024,
            _ => MAX_EXPANDED_BYTES,
        };
        if size > limit || size > MAX_EXPANDED_BYTES - total {
            return Err(failure("chapter snapshot exceeds byte limit"));
        }
        total += size;
    }
    paths.sort();
    Ok(paths)
}

fn fingerprint_directory(source: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    for path in chapter_files(source)? {
        let (size, modified_at) = file_size_and_modified_at(&source.join(&path))?;
        files.push(json!([path, size, modified_at]));
    }
    serde_json::to_string(&files).map_err(failure)
}

fn file_size_and_modified_at(path: &Path) -> Result<(u64, u64), String> {
    let metadata = fs::metadata(path).map_err(failure)?;
    let modified_at = metadata.modified().map_err(failure)?
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    Ok((metadata.len(), u64::try_from(modified_at).map_err(failure)?))
}

fn snapshot_directory(source: &Path, stage: &Path) -> Result<(), String> {
    let files = chapter_files(source)?;
    let before = fingerprint_directory(source)?;
    let destination = stage.join("source");
    fs::create_dir(&destination).map_err(failure)?;
    let copied = (|| {
        let mut total = 0;
        for path in files {
            let input = source.join(&path);
            let target = destination.join(&path);
            fs::create_dir_all(target.parent().unwrap()).map_err(failure)?;
            let metadata = fs::symlink_metadata(&input).map_err(failure)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(failure("invalid chapter artifact"));
            }
            let size = metadata.len();
            if size > MAX_EXPANDED_BYTES - total {
                return Err(failure("chapter snapshot exceeds byte limit"));
            }
            let mut output = File::create(target).map_err(failure)?;
            let bytes = copy_limited(
                &mut File::open(input).map_err(failure)?,
                &mut output,
                size,
            )?;
            if bytes != size {
                return Err(failure("chapter changed during snapshot"));
            }
            output.set_times(fs::FileTimes::new().set_modified(metadata.modified().map_err(failure)?)).map_err(failure)?;
            total += bytes;
        }
        validate_chapter_media(&destination)?;
        if fingerprint_directory(source)? != before {
            return Err(failure("chapter changed during snapshot"));
        }
        Ok(())
    })();
    if copied.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    copied
}

#[tauri::command]
pub async fn content_sync_snapshot(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<(), String> {
    let stage = checked_stage(&app, &stage_path)?;
    let source = checked_storage_directory(&crate::chapter_media::media_root(&app)?, &storage_dir)?;
    tauri::async_runtime::spawn_blocking(move || snapshot_directory(&source, &stage))
        .await
        .map_err(failure)?
}

#[tauri::command]
pub async fn content_sync_fingerprint(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<String, String> {
    let stage = checked_stage(&app, &stage_path)?;
    safe_path(&storage_dir)?;
    let source = stage.join("source");
    tauri::async_runtime::spawn_blocking(move || fingerprint_directory(&source))
        .await
        .map_err(failure)?
}

fn checked_stage(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(failure)?
        .join("content-sync")
        .canonicalize()
        .map_err(failure)?;
    let stage = PathBuf::from(path).canonicalize().map_err(failure)?;
    if stage.parent() != Some(root.as_path()) || !stage.is_dir() {
        return Err(failure("invalid content staging directory"));
    }
    Ok(stage)
}

#[tauri::command]
pub async fn content_sync_create_stage(app: AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_cache_dir()
        .map_err(failure)?
        .join("content-sync")
        .join(stage_token());
    fs::create_dir_all(&path).map_err(failure)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn content_sync_remove_stage(app: AppHandle, stage_path: String) -> Result<(), String> {
    let stage = checked_stage(&app, &stage_path)?;
    tauri::async_runtime::spawn_blocking(move || fs::remove_dir_all(stage).map_err(failure))
        .await
        .map_err(failure)?
}

fn endpoint(server: &str, suffix: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(server).map_err(failure)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(failure("invalid content server URL"));
    }
    let base = url.path().trim_end_matches('/').trim_end_matches("/api/v1");
    url.set_path(&format!("{base}/api/v1/{suffix}"));
    Ok(url)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(failure)
}

#[tauri::command]
pub async fn content_sync_upload(
    app: AppHandle,
    server_url: String,
    token: String,
    storage_dir: String,
    stage_path: String,
    manifest: Value,
) -> Result<Value, String> {
    let stage = checked_stage(&app, &stage_path)?;
    safe_path(&storage_dir)?;
    let source = stage.join("source");
    tauri::async_runtime::spawn_blocking(move || {
        upload_chapter_files(&source, manifest, &server_url, &token)
    })
    .await
    .map_err(failure)?
}

fn chapter_file_manifest(source: &Path, mut manifest: Value) -> Result<Value, String> {
    let body = if manifest["chapter"]["contentType"] == "pdf" { "content.pdf" } else { "content.html" };
    let mut records = Vec::new();
    for path in chapter_files(source)? {
        if path != body && path != "manifest.json" && path != "media.zip" {
            return Err(failure("chapter file transfer requires the current downloaded file layout"));
        }
        let (size, modified_at) = file_size_and_modified_at(&source.join(&path))?;
        records.push(json!({"path":path,"size":size,"modifiedAt":modified_at}));
    }
    if !records.iter().any(|record| record["path"] == body) {
        return Err(failure("chapter body is missing"));
    }
    validate_chapter_media(source)?;
    manifest["layout"] = json!("chapter-files");
    manifest["bodyPath"] = json!(body);
    manifest["files"] = json!(records);
    Ok(manifest)
}

fn checked_response(mut response: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, String> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let mut bytes = Vec::new();
    let _ = response.by_ref().take(4096).read_to_end(&mut bytes);
    let detail = serde_json::from_slice::<Value>(&bytes).ok()
        .and_then(|value| value["message"].as_str().map(str::to_owned))
        .unwrap_or_else(|| status.canonical_reason().unwrap_or("Request failed").to_string());
    Err(failure(format!("server returned {}: {detail}", status.as_u16())))
}

fn upload_chapter_files(source: &Path, metadata: Value, server_url: &str, token: &str) -> Result<Value, String> {
    let manifest = chapter_file_manifest(source, metadata)?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .text("metadata", serde_json::to_string(&manifest).map_err(failure)?);
    for record in manifest["files"].as_array().unwrap() {
        let path = record["path"].as_str().unwrap();
        let part = reqwest::blocking::multipart::Part::reader_with_length(
            File::open(source.join(path)).map_err(failure)?, record["size"].as_u64().unwrap())
            .file_name(path.to_string());
        form = form.part(path.to_string(), part);
    }
    let response = checked_response(http_client()?.post(endpoint(server_url, "chapter-files")?)
        .bearer_auth(token).multipart(form).send().map_err(failure)?)?;
    serde_json::from_reader(response.take(16 * 1024 * 1024)).map_err(failure)
}

#[tauri::command]
pub async fn content_sync_download(
    app: AppHandle,
    server_url: String,
    token: Option<String>,
    storage_dir: String,
    stage_path: String,
    entry: Value,
) -> Result<Value, String> {
    let stage = checked_stage(&app, &stage_path)?;
    safe_path(&storage_dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        if entry["deleted"] != false {
            return Err(failure("server chapter is deleted"));
        }
        let id = entry["id"]
            .as_str()
            .ok_or_else(|| failure("missing server chapter id"))?;
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err(failure("invalid chapter id"));
        }
        if entry["manifest"]["layout"] == "chapter-files" {
            return download_chapter_files(&server_url, token.as_deref(), &entry, &stage.join("install"));
        }
        let expected_size = entry["zipBytes"]
            .as_u64()
            .ok_or_else(|| failure("missing ZIP size"))?;
        if expected_size > MAX_ZIP_BYTES {
            return Err(failure("ZIP exceeds byte limit"));
        }
        let mut request =
            http_client()?.get(endpoint(&server_url, &format!("chapters/{id}/package"))?);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let mut response = checked_response(request.send().map_err(failure)?)?;
        let archive = stage.join("download.zip");
        let bytes = copy_limited(
            &mut response,
            &mut File::create(&archive).map_err(failure)?,
            expected_size,
        )?;
        if bytes != expected_size {
            return Err(failure("downloaded ZIP size mismatch"));
        }
        let installed = stage.join("install");
        fs::create_dir(&installed).map_err(failure)?;
        import_package(&archive, &installed, &entry["manifest"])
    })
    .await
    .map_err(failure)?
}

fn download_chapter_files(server_url: &str, token: Option<&str>, entry: &Value, destination: &Path) -> Result<Value, String> {
    let manifest = &entry["manifest"];
    let body = if manifest["chapter"]["contentType"] == "pdf" { "content.pdf" } else { "content.html" };
    let id = entry["id"].as_str().ok_or_else(|| failure("missing chapter id"))?;
    let revision = entry["revision"].as_str().ok_or_else(|| failure("missing chapter revision"))?;
    let files = manifest["files"].as_array().ok_or_else(|| failure("missing chapter files"))?;
    if manifest["packageVersion"] != 1 || manifest["bodyPath"] != body || files.is_empty() || files.len() > 3 {
        return Err(failure("invalid chapter file manifest"));
    }
    let mut names = HashSet::new();
    let mut total = 0;
    for file in files {
        let name = file["path"].as_str().ok_or_else(|| failure("missing chapter file path"))?;
        let size = file["size"].as_u64().ok_or_else(|| failure("invalid chapter file size"))?;
        let limit = match name {
            "media.zip" => MAX_ZIP_BYTES,
            "manifest.json" => 16 * 1024 * 1024,
            _ if name == body => MAX_EXPANDED_BYTES,
            _ => return Err(failure("unexpected chapter file")),
        };
        if !names.insert(name) || size > limit || size > MAX_EXPANDED_BYTES - total {
            return Err(failure("duplicate or oversized chapter file"));
        }
        total += size;
    }
    if !names.contains(body) || (names.contains("media.zip") && !names.contains("manifest.json")) {
        return Err(failure("missing chapter body or media manifest"));
    }
    fs::create_dir(destination).map_err(failure)?;
    let client = http_client()?;
    for file in files {
        let name = file["path"].as_str().unwrap();
        let size = file["size"].as_u64().unwrap();
        let mut url = endpoint(server_url, &format!("chapters/{id}/files"))?;
        url.query_pairs_mut().append_pair("revision", revision).append_pair("path", name);
        let mut request = client.get(url);
        if let Some(token) = token { request = request.bearer_auth(token); }
        let mut response = checked_response(request.send().map_err(failure)?)?;
        let path = destination.join(name);
        let mut output = File::create(&path).map_err(failure)?;
        if copy_limited(&mut response, &mut output, size)? != size {
            return Err(failure(format!("downloaded {name} size mismatch")));
        }
        if let Some(value) = file.get("modifiedAt") {
            let millis = value.as_u64().filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or_else(|| failure("invalid chapter file modification time"))?;
            let modified = UNIX_EPOCH.checked_add(Duration::from_millis(millis))
                .ok_or_else(|| failure("invalid chapter file modification time"))?;
            output.set_times(fs::FileTimes::new().set_modified(modified)).map_err(failure)?;
        }
    }
    validate_chapter_media(destination)?;
    Ok(json!({"contentBytes": fs::metadata(destination.join(body)).map_err(failure)?.len(),
        "mediaBytes": if names.contains("media.zip") { fs::metadata(destination.join("media.zip")).map_err(failure)?.len() } else { 0 }}))
}

#[tauri::command]
pub async fn content_sync_install(
    app: AppHandle,
    storage_dir: String,
    stage_path: String,
) -> Result<(), String> {
    let stage = checked_stage(&app, &stage_path)?;
    let source = stage.join("install");
    let metadata = fs::symlink_metadata(&source).map_err(failure)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(failure("invalid staged chapter directory"));
    }
    let destination = storage_directory(&crate::chapter_media::media_root(&app)?, &storage_dir)?;
    tauri::async_runtime::spawn_blocking(move || install_directory(&source, &destination))
        .await
        .map_err(failure)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn workspace() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.tmp/content-sync-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }

    fn metadata() -> Value {
        json!({"packageVersion":1,"identity":{"pluginId":"fixture","novelPath":"/novel","chapterPath":"/chapter"},"novel":{"name":"Work","isLocal":false},"chapter":{"name":"Chapter","position":1,"contentType":"html","page":"/chapter"}})
    }

    fn original_media_archive() -> Vec<u8> {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer.start_file("page.png", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"image").unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn chapter_file_transfer_preserves_original_body_and_media_bytes() {
        let root = workspace();
        let body = b"<img src=\"norea-media://reader-asset/page.png\"><p>Original body</p>";
        let media = original_media_archive();
        let manifest = br#"{"version":1,"complete":true,"updatedAt":123,"media":{"files":[{"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}"#;
        fs::write(root.path().join("content.html"), body).unwrap();
        fs::write(root.path().join("manifest.json"), manifest).unwrap();
        fs::write(root.path().join("media.zip"), &media).unwrap();
        let original = fingerprint_directory(root.path()).unwrap();
        let description = chapter_file_manifest(root.path(), metadata()).unwrap();
        assert_eq!(description["layout"], "chapter-files");
        assert_eq!(description["bodyPath"], "content.html");
        assert_eq!(description["files"].as_array().unwrap().len(), 3);
        for record in description["files"].as_array().unwrap() {
            let name = record["path"].as_str().unwrap();
            let expected: &[u8] = match name {
                "content.html" => body,
                "manifest.json" => manifest,
                "media.zip" => &media,
                _ => panic!("unexpected transfer file"),
            };
            assert_eq!(record["size"], expected.len());
            assert!(record.get("sha256").is_none());
            assert!(record["modifiedAt"].as_u64().is_some());
        }
        assert_eq!(fingerprint_directory(root.path()).unwrap(), original);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
    }

    #[test]
    fn chapter_file_transfer_rejects_wrong_body_and_unpacked_legacy_media() {
        let root = workspace();
        fs::write(root.path().join("content.pdf"), b"pdf").unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
        fs::remove_file(root.path().join("content.pdf")).unwrap();
        fs::write(root.path().join("content.html"), b"text").unwrap();
        fs::create_dir(root.path().join("media")).unwrap();
        fs::write(root.path().join("media/page.png"), b"image").unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
    }

    #[test]
    fn chapter_fingerprint_uses_file_metadata_without_reading_contents() {
        let root = workspace();
        let body = root.path().join("content.html");
        let modified = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::write(&body, b"one").unwrap();
        File::options().write(true).open(&body).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        let original = fingerprint_directory(root.path()).unwrap();
        fs::write(&body, b"two").unwrap();
        File::options().write(true).open(&body).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        assert_eq!(fingerprint_directory(root.path()).unwrap(), original);
        File::options().write(true).open(&body).unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified + Duration::from_secs(1))).unwrap();
        assert_ne!(fingerprint_directory(root.path()).unwrap(), original);
        let stage = root.path().join("snapshot");
        fs::create_dir(&stage).unwrap();
        snapshot_directory(root.path(), &stage).unwrap();
        assert_eq!(fingerprint_directory(root.path()).unwrap(), fingerprint_directory(&stage.join("source")).unwrap());
    }

    #[test]
    fn chapter_file_transfer_rejects_media_inventory_mismatch_without_rewriting() {
        let root = workspace();
        fs::write(root.path().join("content.html"), b"<p>Original</p>").unwrap();
        let archive = original_media_archive();
        fs::write(root.path().join("media.zip"), &archive).unwrap();
        for files in [json!([]), json!([{"fileName":"page.png","path":"media/page.png","status":"stored","bytes":6}])] {
            fs::write(root.path().join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":files}}).to_string()).unwrap();
            assert!(chapter_file_manifest(root.path(), metadata()).is_err());
            assert_eq!(fs::read(root.path().join("media.zip")).unwrap(), archive);
        }
        fs::remove_file(root.path().join("manifest.json")).unwrap();
        assert!(chapter_file_manifest(root.path(), metadata()).is_err());
    }

    #[test]
    fn original_files_use_multipart_upload_and_individual_http_downloads() {
        use std::net::TcpListener;
        let root = workspace();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let files = vec![
            ("content.html", b"<img src=\"norea-media://reader-asset/page.png\">".to_vec()),
            ("manifest.json", br#"{"version":1,"complete":true,"updatedAt":123,"media":{"files":[{"fileName":"page.png","path":"media/page.png","status":"stored","bytes":5}]}}"#.to_vec()),
            ("media.zip", original_media_archive()),
        ];
        for (name, bytes) in &files { fs::write(source.join(name), bytes).unwrap(); }
        let manifest = chapter_file_manifest(&source, metadata()).unwrap();
        let entry = json!({"id":"a".repeat(64),"revision":"b".repeat(64),"manifest":manifest,"deleted":false});
        let reply = serde_json::to_vec(&entry).unwrap();
        let expected = files.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let receiver = std::thread::spawn(move || {
            for index in 0..4 {
                let (mut connection, _) = listener.accept().unwrap();
                connection.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0]; connection.read_exact(&mut byte).unwrap(); head.push(byte[0]);
                    assert!(head.len() < 64 * 1024);
                }
                let head = String::from_utf8(head).unwrap();
                let response = if index == 0 {
                    assert!(head.starts_with("POST /api/v1/chapter-files HTTP/1.1"));
                    assert!(head.to_ascii_lowercase().contains("content-type: multipart/form-data; boundary="));
                    let length = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                    }).unwrap();
                    let mut body = vec![0; length]; connection.read_exact(&mut body).unwrap();
                    for (name, bytes) in &expected {
                        let part = [format!("filename=\"{name}\"\r\n\r\n").as_bytes(), bytes, b"\r\n"].concat();
                        assert!(body.windows(part.len()).any(|window| window == part), "changed file bytes for {name}");
                    }
                    reply.clone()
                } else {
                    let target = head.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                    let url = reqwest::Url::parse(&format!("http://localhost{target}")).unwrap();
                    let path = url.query_pairs().find(|(key, _)| key == "path").unwrap().1.into_owned();
                    assert!(url.query_pairs().any(|(key, value)| key == "revision" && value == "b".repeat(64)));
                    expected.iter().find(|(name, _)| *name == path).unwrap().1.clone()
                };
                write!(connection, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
                connection.write_all(&response).unwrap();
            }
        });
        let uploaded = upload_chapter_files(&source, metadata(), &server, "device").unwrap();
        assert_eq!(uploaded, entry);
        let destination = root.path().join("installed");
        let sizes = download_chapter_files(&server, Some("device"), &entry, &destination).unwrap();
        receiver.join().unwrap();
        assert_eq!(sizes["contentBytes"], files[0].1.len());
        assert_eq!(sizes["mediaBytes"], files[2].1.len());
        for (name, bytes) in files {
            assert_eq!(fs::read(source.join(name)).unwrap(), bytes);
            assert_eq!(fs::read(destination.join(name)).unwrap(), bytes);
        }
        assert_eq!(fs::read_dir(&source).unwrap().count(), 3);
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 3);
    }

    #[test]
    fn snapshot_keeps_upload_generation_after_original_files_change() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir_all(source.join("media")).unwrap();
        fs::create_dir(&stage).unwrap();
        let body = "<p>Original</p><img src=\"norea-media://reader-asset/page.png\">";
        fs::write(source.join("content.html"), body).unwrap();
        fs::write(source.join("media/page.png"), b"picture").unwrap();
        fs::write(source.join("ignored.txt"), b"keep original").unwrap();
        fs::write(source.join("manifest.json"), json!({"version":1,"complete":true,"media":{"files":[{"fileName":"page.png","path":"media/page.png","bytes":7,"status":"stored"}]}}).to_string()).unwrap();

        snapshot_directory(&source, &stage).unwrap();
        let snapshot = stage.join("source");
        let original_fingerprint = fingerprint_directory(&snapshot).unwrap();
        assert_eq!(fs::read_to_string(source.join("content.html")).unwrap(), body);
        assert_eq!(fs::read(source.join("media/page.png")).unwrap(), b"picture");
        assert_eq!(fs::read(source.join("ignored.txt")).unwrap(), b"keep original");
        assert!(!snapshot.join("ignored.txt").exists());

        fs::write(source.join("content.html"), "<p>Replacement</p>").unwrap();
        fs::write(source.join("media/page.png"), b"changed").unwrap();
        assert_eq!(fingerprint_directory(&snapshot).unwrap(), original_fingerprint);
        assert_ne!(fingerprint_directory(&source).unwrap(), original_fingerprint);
        let manifest = export_package(&snapshot, &stage, metadata()).unwrap();
        let restored = root.path().join("restored");
        fs::create_dir(&restored).unwrap();
        import_package(&stage.join("package.zip"), &restored, &manifest).unwrap();
        assert_eq!(fs::read_to_string(restored.join("content.html")).unwrap(), body);
        let mut archive = ZipArchive::new(File::open(restored.join("media.zip")).unwrap()).unwrap();
        let mut media = Vec::new();
        archive.by_name("page.png").unwrap().read_to_end(&mut media).unwrap();
        assert_eq!(media, b"picture");
    }

    #[test]
    fn incomplete_snapshot_is_discarded_without_changing_original_files() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "original").unwrap();
        let manifest = json!({"version":1,"complete":false,"media":{"files":[]}}).to_string();
        fs::write(source.join("manifest.json"), &manifest).unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        assert_eq!(fs::read_to_string(source.join("content.html")).unwrap(), "original");
        assert_eq!(fs::read_to_string(source.join("manifest.json")).unwrap(), manifest);
    }

    #[test]
    fn snapshot_rejects_non_file_artifacts_and_never_replaces_an_existing_snapshot() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir_all(source.join("manifest.json")).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(source.join("content.html"), "original").unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        fs::remove_dir(source.join("manifest.json")).unwrap();
        snapshot_directory(&source, &stage).unwrap();
        fs::write(source.join("content.html"), "replacement").unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert_eq!(fs::read_to_string(stage.join("source/content.html")).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_rejects_symbolic_chapter_artifacts() {
        let root = workspace();
        let source = root.path().join("chapter");
        let stage = root.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        fs::write(root.path().join("external.html"), "external").unwrap();
        std::os::unix::fs::symlink(root.path().join("external.html"), source.join("content.html")).unwrap();
        assert!(snapshot_directory(&source, &stage).is_err());
        assert!(!stage.join("source").exists());
        assert_eq!(fs::read_to_string(root.path().join("external.html")).unwrap(), "external");
    }

    #[test]
    fn complete_chapter_round_trip_restores_reader_media_and_readable_storage() {
        let root = workspace();
        let source = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(source.join("media")).unwrap();
        fs::write(
            source.join("content.html"),
            "<p>Text</p><img src=\"norea-media://reader-asset/page.png\">",
        )
        .unwrap();
        fs::write(source.join("media/page.png"), b"picture").unwrap();
        fs::write(source.join("manifest.json"), json!({"version":1,"complete":true,"updatedAt":1,"media":{"files":[{"fileName":"page.png","path":"media/page.png","bytes":7,"status":"stored","sourceUrl":"https://source/page.png","updatedAt":1}]}}).to_string()).unwrap();
        let exported = root.path().join("export");
        fs::create_dir_all(&exported).unwrap();
        let manifest = export_package(&source, &exported, metadata()).unwrap();
        let installed = root.path().join("import");
        fs::create_dir_all(&installed).unwrap();
        let sizes = import_package(&exported.join("package.zip"), &installed, &manifest).unwrap();
        assert_eq!(
            fs::read_to_string(installed.join("content.html")).unwrap(),
            fs::read_to_string(source.join("content.html")).unwrap()
        );
        assert!(installed.join("media.zip").is_file());
        assert!(sizes["mediaBytes"].as_u64().unwrap() > 0);
        let snapshot = root.path().join("snapshot");
        fs::create_dir(&snapshot).unwrap();
        snapshot_directory(&installed, &snapshot).unwrap();
        assert_eq!(
            fs::read(snapshot.join("source/media.zip")).unwrap(),
            fs::read(installed.join("media.zip")).unwrap()
        );
        assert_eq!(
            export_package(&snapshot.join("source"), &snapshot, metadata()).unwrap(),
            manifest
        );
    }

    #[test]
    fn missing_media_rejects_export_without_touching_source() {
        let root = workspace();
        let source = root.path().join("chapter");
        fs::create_dir_all(&source).unwrap();
        let body = "<img src=\"norea-media://reader-asset/missing.png\">";
        fs::write(source.join("content.html"), body).unwrap();
        assert!(export_package(&source, root.path(), metadata()).is_err());
        assert_eq!(
            fs::read_to_string(source.join("content.html")).unwrap(),
            body
        );
    }

    fn plain_package(root: &Path) -> (PathBuf, Value) {
        let source = root.join("source");
        let stage = root.join("export");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&stage).unwrap();
        fs::write(source.join("content.html"), "<p>New chapter</p>").unwrap();
        let manifest = export_package(&source, &stage, metadata()).unwrap();
        (stage, manifest)
    }

    #[test]
    fn staged_download_preserves_original_until_explicit_install() {
        let root = workspace();
        let (stage, manifest) = plain_package(root.path());
        let destination = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("content.html"), "original").unwrap();
        let installed = stage.join("install");
        fs::create_dir(&installed).unwrap();
        import_package(&stage.join("package.zip"), &installed, &manifest).unwrap();
        assert_eq!(fs::read_to_string(destination.join("content.html")).unwrap(), "original");
        assert_eq!(fs::read_to_string(installed.join("content.html")).unwrap(), "<p>New chapter</p>");
        install_directory(&installed, &destination).unwrap();
        assert_eq!(fs::read_to_string(destination.join("content.html")).unwrap(), "<p>New chapter</p>");
    }

    #[test]
    fn wrong_body_size_fails_before_existing_chapter_is_replaced() {
        let root = workspace();
        let (stage, manifest) = plain_package(root.path());
        fs::write(stage.join("portable/content.html"), "<p>Truncated</p>").unwrap();
        write_zip(
            &stage.join("corrupt.zip"),
            &stage.join("portable"),
            &["manifest.json".into(), "content.html".into()],
        )
        .unwrap();
        let destination = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("content.html"), "original").unwrap();
        let incoming = root.path().join("incoming");
        fs::create_dir_all(&incoming).unwrap();
        assert!(import_package(&stage.join("corrupt.zip"), &incoming, &manifest).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "original"
        );
    }

    #[test]
    fn archive_traversal_is_rejected_before_extraction() {
        let root = workspace();
        let archive = root.path().join("unsafe.zip");
        let mut writer = ZipWriter::new(File::create(&archive).unwrap());
        writer
            .start_file("../escaped.html", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"escape").unwrap();
        writer.finish().unwrap();
        let stage = root.path().join("incoming");
        fs::create_dir_all(&stage).unwrap();
        assert!(import_package(&archive, &stage, &metadata()).is_err());
        assert!(!root.path().join("escaped.html").exists());
    }

    #[test]
    fn unlisted_archive_entry_is_rejected() {
        let root = workspace();
        let (stage, manifest) = plain_package(root.path());
        fs::write(stage.join("portable/extra.txt"), "extra").unwrap();
        write_zip(
            &stage.join("extra.zip"),
            &stage.join("portable"),
            &[
                "manifest.json".into(),
                "content.html".into(),
                "extra.txt".into(),
            ],
        )
        .unwrap();
        assert!(import_package(
            &stage.join("extra.zip"),
            &root.path().join("incoming"),
            &manifest
        )
        .is_err());
    }

    #[test]
    fn failed_install_preparation_preserves_previous_directory() {
        let root = workspace();
        let source = root.path().join("incoming");
        fs::create_dir_all(source.join("unexpected-directory")).unwrap();
        let destination = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("content.html"), "original").unwrap();
        assert!(install_directory(&source, &destination).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_dir(destination.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn replacement_keeps_readable_folder_and_removes_old_media() {
        let root = workspace();
        let (stage, manifest) = plain_package(root.path());
        let incoming = root.path().join("incoming");
        fs::create_dir_all(&incoming).unwrap();
        import_package(&stage.join("package.zip"), &incoming, &manifest).unwrap();
        let destination = root.path().join("contents/fixture/Work/1-Chapter");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("media.zip"), "old").unwrap();
        install_directory(&incoming, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "<p>New chapter</p>"
        );
        assert!(!destination.join("media.zip").exists());
        assert_eq!(
            fs::read_dir(destination.parent().unwrap()).unwrap().count(),
            1
        );
    }

    #[test]
    fn portable_conversion_leaves_prose_links_and_remote_urls_unchanged() {
        let files = HashSet::from(["page.png".to_string()]);
        let body = "<p>Read media/manual or norea-media://reader-asset/example</p><a href=\"media/manual\">link</a><img src=\"https://site/media/remote.png\"><img src=\"media/page.png\"><img srcset=\"media/page.png 1x, https://site/media/remote.png 2x\"><div style=\"background:url('media/page.png')\">text</div>";
        let converted = convert_references(body, &files, false).unwrap();
        assert!(converted.contains("Read media/manual or norea-media://reader-asset/example"));
        assert!(converted.contains("href=\"media/manual\""));
        assert!(converted.contains("src=\"https://site/media/remote.png\""));
        assert!(converted.contains("src=\"norea-media://reader-asset/page.png\""));
        assert!(converted.contains("url('norea-media://reader-asset/page.png')"));
        assert!(converted.contains(
            "srcset=\"norea-media://reader-asset/page.png 1x, https://site/media/remote.png 2x\""
        ));
    }

    #[test]
    fn lookup_restores_chapter_after_interruption_between_directory_renames() {
        let root = workspace();
        let parent = root.path().join("contents/fixture/Work");
        let backup = parent.join(".1-Chapter.norea-sync-backup");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("content.html"), "previous complete chapter").unwrap();
        fs::write(backup.join("media.zip"), "previous media").unwrap();
        let destination =
            storage_directory(root.path(), "contents/fixture/Work/1-Chapter").unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "previous complete chapter"
        );
        assert_eq!(
            fs::read_to_string(destination.join("media.zip")).unwrap(),
            "previous media"
        );
        assert!(!backup.exists());
        let broken = root.path().join("broken");
        fs::create_dir_all(broken.join("unexpected-directory")).unwrap();
        assert!(install_directory(&broken, &destination).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("content.html")).unwrap(),
            "previous complete chapter"
        );
    }

    #[test]
    fn media_acquisition_timestamps_do_not_change_package_identity() {
        let root = workspace();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("media")).unwrap();
        fs::write(
            source.join("content.html"),
            "<img src=\"norea-media://reader-asset/a.png\">",
        )
        .unwrap();
        fs::write(source.join("media/a.png"), "image").unwrap();
        let mut media = json!({"version":1,"complete":true,"updatedAt":123,"media":{"files":[{"fileName":"a.png","path":"media/a.png","bytes":5,"status":"stored","sourceUrl":"https://example/a.png","updatedAt":123}]}});
        fs::write(source.join("manifest.json"), media.to_string()).unwrap();
        let first = root.path().join("first");
        fs::create_dir(&first).unwrap();
        let one = export_package(&source, &first, metadata()).unwrap();
        media["updatedAt"] = json!(999);
        media["media"]["files"][0]["updatedAt"] = json!(999);
        fs::write(source.join("manifest.json"), media.to_string()).unwrap();
        let second = root.path().join("second");
        fs::create_dir(&second).unwrap();
        let two = export_package(&source, &second, metadata()).unwrap();
        assert_eq!(one, two);
        assert_eq!(
            read_json(&source.join("manifest.json")).unwrap()["updatedAt"],
            999
        );
    }
}
