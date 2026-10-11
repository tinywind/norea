//! Portable work metadata files and bounded, recoverable publication.

use super::{chapter_media_blocking, paths::media_root};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::{ErrorKind, Read, Write}, path::{Path, PathBuf}, sync::{LazyLock, Mutex}};
use tauri::AppHandle;

const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_COVER_BYTES: usize = 10 * 1024 * 1024;

static CHAPTER_DIRECTORIES: LazyLock<Mutex<HashMap<(PathBuf, i64), PathBuf>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn registered_chapter_directory(root: &Path, chapter_id: i64) -> Option<PathBuf> {
    CHAPTER_DIRECTORIES.lock().ok()?.get(&(root.to_path_buf(), chapter_id)).cloned()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataOperation {
    operation: String,
    path: Option<String>,
    body: Option<Vec<u8>>,
    chapter_directories: Option<HashMap<String, String>>,
    reset: Option<bool>,
}

#[derive(Default, Serialize)]
pub struct WorkMetadataResult {
    paths: Option<Vec<String>>,
    body: Option<Vec<u8>>,
}

fn safe_child(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.ends_with(['.', ' '])
        && !value.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() != 4 || parts[0] != "contents" || !parts.iter().all(|s| safe_child(s)) {
        return Err("work metadata: invalid file path".into());
    }
    let name = parts[3];
    if name != "novel.json" && name != "cover.json" && !(name.starts_with("cover.") && name[6..].chars().all(|c| c.is_ascii_alphanumeric())) {
        return Err("work metadata: unsupported file".into());
    }
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => return Err("work metadata: symbolic links are not supported".into()),
            Ok(_) => {},
            Err(error) if error.kind() == ErrorKind::NotFound => {},
            Err(error) => return Err(format!("work metadata: inspect path: {error}")),
        }
    }
    Ok(path)
}

fn read_file(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let backup = path.with_extension(format!("{}.bak", path.extension().unwrap_or_default().to_string_lossy()));
    let source = if !path.exists() && backup.is_file() { backup.as_path() } else { path };
    let file = match fs::File::open(source) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("work metadata: read file: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|error| format!("work metadata: read bytes: {error}"))?;
    if bytes.len() > limit { return Err("work metadata: file exceeds size limit".into()); }
    Ok(Some(bytes))
}

fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("work metadata: missing parent")?;
    fs::create_dir_all(parent).map_err(|error| format!("work metadata: create directory: {error}"))?;
    let name = path.file_name().ok_or("work metadata: missing filename")?.to_string_lossy();
    let temporary = path.with_file_name(format!("{name}.tmp"));
    let backup = path.with_file_name(format!("{name}.bak"));
    for candidate in [&temporary, &backup] {
        if fs::symlink_metadata(candidate).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("work metadata: unsafe publication artifact".into());
        }
    }
    if !path.exists() && backup.exists() {
        fs::rename(&backup, path).map_err(|error| format!("work metadata: recover backup: {error}"))?;
    }
    let mut file = fs::File::create(&temporary).map_err(|error| format!("work metadata: create temporary file: {error}"))?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|error| format!("work metadata: write temporary file: {error}"))?;
    drop(file);
    super::publication::replace_storage_file(&temporary, path, &backup, "work metadata")
}

fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let contents = root.join("contents");
    if !contents.exists() { return Ok(Vec::new()); }
    let mut paths = Vec::new();
    for source in fs::read_dir(&contents).map_err(|e| format!("work metadata: list sources: {e}"))? {
        let source = source.map_err(|e| e.to_string())?;
        if !source.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
        for work in fs::read_dir(source.path()).map_err(|e| e.to_string())? {
            let work = work.map_err(|e| e.to_string())?;
            if !work.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
            if work.path().join("novel.json").exists() || work.path().join("novel.json.bak").exists() {
                let relative = format!("contents/{}/{}/novel.json", source.file_name().to_string_lossy(), work.file_name().to_string_lossy());
                checked_path(root, &relative)?;
                paths.push(relative);
            }
        }
    }
    paths.sort();
    Ok(paths)
}

fn list_chapter_files(root: &Path, relative: &str) -> Result<Vec<String>, String> {
    let metadata = checked_path(root, relative)?;
    if !relative.ends_with("/novel.json") { return Err("work metadata: chapter scan requires a work path".into()); }
    let work = metadata.parent().ok_or("work metadata: missing work directory")?;
    let mut paths = Vec::new();
    let children = match fs::read_dir(work) {
        Ok(children) => children,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(paths),
        Err(error) => return Err(format!("work metadata: list chapters: {error}")),
    };
    for child in children {
        let child = child.map_err(|error| format!("work metadata: chapter entry: {error}"))?;
        if !child.file_type().map_err(|error| error.to_string())?.is_dir() { continue; }
        let name = child.file_name().to_string_lossy().into_owned();
        let Some((number, title)) = name.split_once('-') else { continue; };
        if !safe_child(&name) || title.is_empty() || number.is_empty() || !number.chars().all(|c| c.is_ascii_digit() || c == '.') || number.parse::<f64>().is_err() { continue; }
        let directory = child.path();
        for filename in ["content.pdf", "content.html"] {
            if fs::symlink_metadata(directory.join(filename)).is_ok_and(|metadata| metadata.file_type().is_file() && metadata.len() > 0) {
                paths.push(format!("{}/{name}/{filename}", relative.trim_end_matches("/novel.json")));
                break;
            }
        }
    }
    paths.sort();
    Ok(paths)
}

fn operate(root: &Path, input: WorkMetadataOperation) -> Result<WorkMetadataResult, String> {
    if input.operation == "list" { return Ok(WorkMetadataResult { paths: Some(list_files(root)?), body: None }); }
    if input.operation == "chapters" { return Ok(WorkMetadataResult { paths: Some(list_chapter_files(root, input.path.as_deref().ok_or("work metadata: missing path")?)?), body: None }); }
    if input.operation == "register" {
        let mut directories = CHAPTER_DIRECTORIES.lock().map_err(|_| "work metadata: path registry unavailable")?;
        let incoming = input.chapter_directories.unwrap_or_default();
        if input.reset.unwrap_or(false) { directories.retain(|(storage_root, _), _| storage_root != root); }
        for (id, relative) in incoming {
            let parts: Vec<_> = relative.split('/').collect();
            if parts.len() != 4 || parts[0] != "contents" || !parts.iter().all(|part| safe_child(part)) {
                return Err("work metadata: invalid chapter directory".into());
            }
            let chapter_id: i64 = id.parse().map_err(|_| "work metadata: invalid chapter id")?;
            if chapter_id <= 0 { return Err("work metadata: invalid chapter id".into()); }
            let mut directory = root.to_path_buf();
            for part in &parts {
                directory.push(part);
                if fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
                    return Err("work metadata: symbolic chapter directory".into());
                }
            }
            directories.insert((root.to_path_buf(), chapter_id), root.join(relative));
        }
        return Ok(WorkMetadataResult::default());
    }
    let relative = input.path.ok_or("work metadata: missing path")?;
    let path = checked_path(root, &relative)?;
    let limit = if relative.ends_with(".json") { MAX_METADATA_BYTES } else { MAX_COVER_BYTES };
    match input.operation.as_str() {
        "read" => Ok(WorkMetadataResult { paths: None, body: read_file(&path, limit)? }),
        "write" => {
            let body = input.body.ok_or("work metadata: missing body")?;
            if body.is_empty() || body.len() > limit { return Err("work metadata: invalid file size".into()); }
            if relative.ends_with(".json") {
                serde_json::from_slice::<serde_json::Value>(&body).map_err(|e| format!("work metadata: invalid JSON: {e}"))?;
            }
            publish(&path, &body)?;
            Ok(WorkMetadataResult::default())
        },
        "remove" => {
            match fs::remove_file(&path) { Ok(()) => {}, Err(e) if e.kind() == ErrorKind::NotFound => {}, Err(e) => return Err(e.to_string()) }
            for suffix in ["bak", "tmp"] {
                let artifact = path.with_file_name(format!("{}.{suffix}", path.file_name().unwrap_or_default().to_string_lossy()));
                if artifact.is_file() { fs::remove_file(artifact).map_err(|e| e.to_string())?; }
            }
            Ok(WorkMetadataResult::default())
        },
        _ => Err("work metadata: unsupported operation".into()),
    }
}

#[tauri::command]
pub async fn work_metadata_operation(app: AppHandle, input: WorkMetadataOperation) -> Result<WorkMetadataResult, String> {
    let root = media_root(&app)?;
    chapter_media_blocking("work metadata", move || operate(&root, input)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.tmp/work-metadata-tests");
        fs::create_dir_all(&root).unwrap();
        tempfile::tempdir_in(root).unwrap()
    }
    #[test]
    fn metadata_only_work_roundtrip_and_interrupted_publication() {
        let root = fixture();
        let path = checked_path(root.path(), "contents/source/Book-source/novel.json").unwrap();
        publish(&path, br#"{"schemaVersion":1}"#).unwrap();
        assert_eq!(list_files(root.path()).unwrap().len(), 1);
        fs::rename(&path, path.with_file_name("novel.json.bak")).unwrap();
        fs::write(path.with_file_name("novel.json.tmp"), b"partial").unwrap();
        assert_eq!(read_file(&path, 100).unwrap().unwrap(), br#"{"schemaVersion":1}"#);
        publish(&path, br#"{"schemaVersion":1,"updatedAt":2}"#).unwrap();
        assert!(!path.with_file_name("novel.json.bak").exists());
        assert!(read_file(&path, 1).is_err());
    }
    #[test]
    fn discovers_final_bodies_despite_incomplete_media_or_partial_artifacts() {
        let root = fixture();
        let work = root.path().join("contents/source/Book");
        for name in ["1-Opening", "2-Pdf", "3-Incomplete", "4-Empty", "5-Partial", "6-Final-with-partial", "7-Invalid-manifest", "cover"] {
            fs::create_dir_all(work.join(name)).unwrap();
        }
        fs::write(work.join("1-Opening/content.html"), b"body").unwrap();
        fs::write(work.join("2-Pdf/content.pdf"), b"%PDF-body").unwrap();
        fs::write(work.join("3-Incomplete/content.html"), b"body").unwrap();
        fs::write(work.join("3-Incomplete/manifest.json"), br#"{"complete":false}"#).unwrap();
        fs::write(work.join("4-Empty/content.html"), b"").unwrap();
        fs::write(work.join("5-Partial/content.partial.html"), b"body").unwrap();
        fs::write(work.join("6-Final-with-partial/content.html"), b"body").unwrap();
        fs::write(work.join("6-Final-with-partial/.chapter-content.partial"), b"partial").unwrap();
        fs::write(work.join("7-Invalid-manifest/content.html"), b"body").unwrap();
        fs::write(work.join("7-Invalid-manifest/manifest.json"), b"invalid").unwrap();
        fs::write(work.join("cover/content.html"), b"body").unwrap();
        let result = operate(root.path(), WorkMetadataOperation { operation: "chapters".into(), path: Some("contents/source/Book/novel.json".into()), body: None, chapter_directories: None, reset: None }).unwrap();
        assert_eq!(result.paths.unwrap(), [
            "contents/source/Book/1-Opening/content.html",
            "contents/source/Book/2-Pdf/content.pdf",
            "contents/source/Book/3-Incomplete/content.html",
            "contents/source/Book/6-Final-with-partial/content.html",
            "contents/source/Book/7-Invalid-manifest/content.html",
        ]);
    }
    #[test]
    fn rejects_escape_and_non_metadata_files() {
        let root = fixture();
        for value in ["contents/a/../novel.json", "contents/a/b/content.html", "C:/a/b/novel.json", "contents/a/b/cover../oops"] {
            assert!(checked_path(root.path(), value).is_err());
        }
    }
    #[test]
    fn registers_exact_chapter_directories_for_native_media_writes() {
        let root = fixture();
        operate(root.path(), WorkMetadataOperation { operation: "register".into(), path: None, body: None, reset: None,
            chapter_directories: Some(HashMap::from([("42".into(), "contents/source/Original/chapter-alpha".into())])) }).unwrap();
        let directory = super::super::paths::content_chapter_dir_at(root.path(), "source", 7, Some("/book"), Some("Renamed"), 42, Some("1"), Some("Opening"), Some(1)).unwrap();
        assert_eq!(directory, root.path().join("contents/source/Original/chapter-alpha"));
    }
}
