//! Authoritative chapter content mirrors and their inspection.

use super::chapter_media_blocking;
use super::paths::{
    chapter_number_segment, content_chapter_dir_at, content_chapter_dirs_matching_identity,
    content_chapter_dirs_matching_segments, content_chapter_relative_dir, ensure_contents_nomedia,
    media_root, relative_storage_path, safe_relative_storage_path, CHAPTER_PARTIAL_CONTENT_FILE,
    MEDIA_ARCHIVE_FILE,
};
use super::publication::replace_storage_file;
use super::types::ChapterContentInspection;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

fn stored_content_path_in_dir(
    chapter_dir: &Path,
    preferred_file_name: &str,
) -> Result<Option<PathBuf>, String> {
    crate::content_sync::recover_content_directory(chapter_dir)?;
    let mut file_names = vec![preferred_file_name.to_string()];
    for file_name in ["content.html", "content.pdf", CHAPTER_PARTIAL_CONTENT_FILE] {
        if !file_names.iter().any(|candidate| candidate == file_name) {
            file_names.push(file_name.to_string());
        }
    }

    for file_name in file_names {
        let path = chapter_dir.join(file_name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => return Ok(Some(path)),
            Ok(_) => {
                return Err(format!(
                    "chapter media: stored content path is not a regular file: {}",
                    path.display()
                ));
            }
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => {
                return Err(format!(
                    "chapter media: inspect stored chapter '{}': {err}",
                    path.to_string_lossy()
                ));
            }
        }
    }
    Ok(None)
}

fn stored_media_archive_bytes(chapter_dir: &Path) -> u64 {
    fs::symlink_metadata(chapter_dir.join(MEDIA_ARCHIVE_FILE))
        .ok()
        .filter(|metadata| metadata.file_type().is_file())
        .map_or(0, |metadata| metadata.len())
}

pub(super) fn inspect_content_chapter_dir(
    root: &Path,
    chapter_dir: &Path,
    preferred_file_name: &str,
) -> Result<Option<ChapterContentInspection>, String> {
    let Some(content_path) = stored_content_path_in_dir(chapter_dir, preferred_file_name)? else {
        return Ok(None);
    };
    let content_metadata = fs::symlink_metadata(&content_path)
        .map_err(|err| format!("chapter media: read stored chapter size: {err}"))?;
    if !content_metadata.file_type().is_file() {
        return Err(format!(
            "chapter media: stored content path is not a regular file: {}",
            content_path.display()
        ));
    }
    let content_bytes = content_metadata.len();
    let media_complete = match crate::content_sync::validate_chapter_media(chapter_dir) {
        Ok(()) => true,
        Err(reason) => {
            log::warn!(
                "[chapter-media] stored chapter is incomplete dir={} reason={reason}",
                chapter_dir.display()
            );
            false
        }
    };
    let media_bytes = stored_media_archive_bytes(chapter_dir);
    Ok(Some(ChapterContentInspection {
        status: "present".to_string(),
        content_file: Some(relative_storage_path(root, &content_path)?),
        content_bytes,
        media_bytes,
        media_complete,
    }))
}

fn chapter_content_mirror_inspect_sync(
    app: AppHandle,
    preferred_chapter_dir: String,
    source_dir: String,
    novel_directory_name: String,
    chapter_directory_name: String,
    preferred_content_file_name: String,
) -> Result<ChapterContentInspection, String> {
    let root = media_root(&app)?;
    let preferred_relative_dir = safe_relative_storage_path(&preferred_chapter_dir)?;
    let source_relative_dir = safe_relative_storage_path(&source_dir)?;
    let preferred_file_name = Path::new(&preferred_content_file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "chapter media: invalid preferred content file name".to_string())?;

    if let Some(inspection) = inspect_content_chapter_dir(
        &root,
        &root.join(&preferred_relative_dir),
        preferred_file_name,
    )? {
        return Ok(inspection);
    }

    let mut matches = Vec::new();
    for chapter_path in content_chapter_dirs_matching_segments(
        &root.join(source_relative_dir),
        &novel_directory_name,
        &chapter_directory_name,
    )? {
        if let Some(inspection) =
            inspect_content_chapter_dir(&root, &chapter_path, preferred_file_name)?
        {
            matches.push(inspection);
        }
    }

    match matches.len() {
        0 => Ok(ChapterContentInspection {
            status: "missing".to_string(),
            content_file: None,
            content_bytes: 0,
            media_bytes: 0,
            media_complete: false,
        }),
        1 => Ok(matches.remove(0)),
        _ => Err(format!(
            "chapter media: multiple stored chapter folders match source identity {chapter_directory_name}"
        )),
    }
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
    source_novel_id: Option<&str>,
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
            source_novel_id,
            novel_name,
            chapter_id,
            chapter_number,
            chapter_name,
            chapter_position,
        )?
    ))
}

fn remove_chapter_content_files_in_dir(
    chapter_dir: &Path,
    keep_path: Option<&Path>,
) -> Result<(), String> {
    for file_name in ["content.html", "content.pdf", CHAPTER_PARTIAL_CONTENT_FILE] {
        let path = chapter_dir.join(file_name);
        if keep_path.is_some_and(|keep_path| path == keep_path) {
            continue;
        }
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => return Err(format!("chapter media: remove content mirror: {err}")),
        }
    }
    Ok(())
}

pub(super) fn content_chapter_dir_from_context(
    root: &Path,
    novel_id: Option<i64>,
    source_id: Option<&str>,
    source_novel_id: Option<&str>,
    novel_name: Option<&str>,
    chapter_id: i64,
    chapter_number: Option<&str>,
    chapter_name: Option<&str>,
    chapter_position: Option<i64>,
) -> Result<Option<PathBuf>, String> {
    if let Some(directory) = super::work_metadata::registered_chapter_directory(root, chapter_id) {
        return Ok(Some(directory));
    }
    let Some(novel_id) = novel_id else {
        return Ok(None);
    };
    let Some(source_id) = source_id else {
        return Ok(None);
    };
    let Some(source_novel_id) = source_novel_id else {
        return Ok(None);
    };
    let preferred_dir = content_chapter_dir_at(
        root,
        source_id,
        novel_id,
        Some(source_novel_id),
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?;
    match fs::metadata(&preferred_dir) {
        Ok(metadata) if metadata.is_dir() => {
            if stored_content_path_in_dir(&preferred_dir, "content.html")?.is_some() {
                return Ok(Some(preferred_dir));
            }
        }
        Ok(_) => {
            return Err(format!(
                "chapter media: chapter storage path is not a directory: {}",
                preferred_dir.display()
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(format!("chapter media: inspect chapter storage: {err}")),
    }

    let chapter_directory_name = chapter_number_segment(chapter_number, chapter_position, chapter_id)?;
    let candidate_dirs = content_chapter_dirs_matching_identity(
        root,
        source_id,
        novel_id,
        source_novel_id,
        chapter_id,
        chapter_number,
        chapter_position,
    )?;
    let mut matches = Vec::new();
    for chapter_dir in candidate_dirs {
        if stored_content_path_in_dir(&chapter_dir, "content.html")?.is_some() {
            matches.push(chapter_dir);
        }
    }

    match matches.len() {
        0 => Ok(Some(preferred_dir)),
        1 => Ok(matches.pop()),
        _ => Err(format!(
            "chapter media: multiple stored chapter folders match source identity {chapter_directory_name}"
        )),
    }
}

#[tauri::command]
pub async fn chapter_content_mirror_store(
    app: AppHandle,
    chapter_id: i64,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    chapter_media_blocking("store content mirror", move || {
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
        let source_novel_id = novel.get("sourceNovelId").and_then(serde_json::Value::as_str);
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
            source_novel_id,
            novel_name,
            chapter_id,
            chapter_number,
            chapter_name,
            position,
            extension,
        )?;
        let content_path = if let Some(directory) = metadata.get("storageDir").and_then(serde_json::Value::as_str) {
            media_root.join(safe_relative_storage_path(directory)?).join(format!("content.{extension}"))
        } else { media_root.join(&content_file) };

        if let Some(parent) = content_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("chapter media: create content mirror dir: {err}"))?;
        }
        let temp_content_path = content_path.with_extension(format!("{extension}.tmp"));
        fs::write(&temp_content_path, content)
            .map_err(|err| format!("chapter media: write content mirror temp: {err}"))?;
        let backup_content_path = content_path.with_extension(format!("{extension}.bak"));
        replace_storage_file(
            &temp_content_path,
            &content_path,
            &backup_content_path,
            "chapter media: replace content mirror",
        )?;
        let partial_path = content_path.with_file_name(CHAPTER_PARTIAL_CONTENT_FILE);
        if partial_path.exists() {
            fs::remove_file(&partial_path)
                .map_err(|err| format!("chapter media: remove partial content: {err}"))?;
        }
        let chapter_dir = content_path
            .parent()
            .ok_or_else(|| "chapter media: content mirror has no parent directory".to_string())?;
        remove_chapter_content_files_in_dir(chapter_dir, Some(&content_path))
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_store_partial(
    app: AppHandle,
    content: String,
    metadata: serde_json::Value,
) -> Result<(), String> {
    chapter_media_blocking("store partial content mirror", move || {
        let media_root = media_root(&app)?;
        ensure_contents_nomedia(&media_root)?;
        let novel = metadata
            .get("novel")
            .ok_or_else(|| "chapter media: missing novel metadata".to_string())?;
        let chapter = metadata
            .get("chapter")
            .ok_or_else(|| "chapter media: missing chapter metadata".to_string())?;
        let novel_id = novel
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "chapter media: invalid novel metadata id".to_string())?;
        let source_id = novel
            .get("pluginId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "chapter media: invalid novel metadata plugin id".to_string())?;
        let chapter_id = chapter
            .get("id")
            .and_then(serde_json::Value::as_i64)
            .ok_or_else(|| "chapter media: invalid chapter metadata id".to_string())?;
        let chapter_dir = content_chapter_dir_at(
            &media_root,
            source_id,
            novel_id,
            novel.get("sourceNovelId").and_then(serde_json::Value::as_str),
            novel.get("name").and_then(serde_json::Value::as_str),
            chapter_id,
            chapter
                .get("chapterNumber")
                .and_then(serde_json::Value::as_str),
            chapter.get("name").and_then(serde_json::Value::as_str),
            chapter.get("position").and_then(serde_json::Value::as_i64),
        )?;
        let chapter_dir = if let Some(directory) = metadata.get("storageDir").and_then(serde_json::Value::as_str) {
            media_root.join(safe_relative_storage_path(directory)?)
        } else { chapter_dir };
        fs::create_dir_all(&chapter_dir)
            .map_err(|err| format!("chapter media: create partial content dir: {err}"))?;
        let partial_path = chapter_dir.join(CHAPTER_PARTIAL_CONTENT_FILE);
        let temp_path = chapter_dir.join(format!("{CHAPTER_PARTIAL_CONTENT_FILE}.tmp"));
        let backup_path = chapter_dir.join(format!("{CHAPTER_PARTIAL_CONTENT_FILE}.bak"));
        fs::write(&temp_path, content)
            .map_err(|err| format!("chapter media: write partial content: {err}"))?;
        replace_storage_file(
            &temp_path,
            &partial_path,
            &backup_path,
            "chapter media: replace partial content",
        )
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_clear(app: AppHandle, chapter_dir: String) -> Result<(), String> {
    chapter_media_blocking("clear content mirror", move || {
        let media_root = media_root(&app)?;
        let relative_dir = safe_relative_storage_path(&chapter_dir)?;
        remove_chapter_content_files_in_dir(&media_root.join(relative_dir), None)
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_inspect(
    app: AppHandle,
    preferred_chapter_dir: String,
    source_dir: String,
    novel_directory_name: String,
    chapter_directory_name: String,
    preferred_content_file_name: String,
) -> Result<ChapterContentInspection, String> {
    chapter_media_blocking("inspect stored chapter", move || {
        chapter_content_mirror_inspect_sync(
            app,
            preferred_chapter_dir,
            source_dir,
            novel_directory_name,
            chapter_directory_name,
            preferred_content_file_name,
        )
    })
    .await
}

#[tauri::command]
pub async fn chapter_content_mirror_read_file(
    app: AppHandle,
    content_file: String,
) -> Result<Option<String>, String> {
    chapter_media_blocking("read content mirror", move || {
        let media_root = media_root(&app)?;
        let relative_path = safe_relative_storage_path(&content_file)?;
        let content_path = media_root.join(relative_path);
        if let Some(chapter_dir) = content_path.parent() {
            crate::content_sync::recover_content_directory(chapter_dir)?;
        }
        match fs::read_to_string(&content_path) {
            Ok(content) => Ok(Some(content)),
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!(
                "chapter media: read mirrored chapter '{}': {err}",
                content_path.to_string_lossy()
            )),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_inventory_archive(directory: &Path, names: &[&str]) {
        use std::io::Write;
        let file = fs::File::create(directory.join(MEDIA_ARCHIVE_FILE)).expect("create archive");
        let mut zip = zip::ZipWriter::new(file);
        for name in names {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).expect("start entry");
            zip.write_all(b"image").expect("write entry");
        }
        zip.finish().expect("finish archive");
    }

    fn write_inventory_manifest(directory: &Path, complete: bool, status: &str) {
        fs::write(directory.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "updatedAt": 1,
            "complete": complete,
            "media": { "files": [
                { "fileName": "first.png", "path": "", "bytes": 0, "sourceUrl": "https://site/first.png", "contentType": "image/png", "status": status, "updatedAt": 1 },
                { "fileName": "second.png", "path": "media/second.png", "bytes": 999, "sourceUrl": "https://site/second.png", "contentType": "image/png", "status": status, "updatedAt": 1 }
            ] }
        })).expect("serialize manifest")).expect("write manifest");
    }

    #[test]
    fn stored_chapter_inspection_uses_every_declared_zip_entry_without_rewriting_files() {
        let root = tempfile::tempdir().expect("storage");
        let directory = root.path().join("chapter");
        fs::create_dir(&directory).expect("chapter directory");
        fs::write(directory.join("content.html"), b"body").expect("body");
        write_inventory_manifest(&directory, false, "remote");
        write_inventory_archive(&directory, &["first.png", "second.png", "extra.png"]);
        let original = fs::read(directory.join("manifest.json")).expect("manifest");
        let inspect = || inspect_content_chapter_dir(root.path(), &directory, "content.html")
            .expect("inspect chapter").expect("body present");

        assert!(inspect().media_complete);
        write_inventory_archive(&directory, &["first.png"]);
        assert!(!inspect().media_complete);
        write_inventory_archive(&directory, &["first.png", "second.png"]);
        assert!(inspect().media_complete);
        assert_eq!(fs::read(directory.join("manifest.json")).expect("unchanged manifest"), original);

        write_inventory_manifest(&directory, true, "stored");
        fs::remove_file(directory.join(MEDIA_ARCHIVE_FILE)).expect("remove archive");
        fs::create_dir(directory.join("media")).expect("loose directory");
        fs::write(directory.join("media/first.png"), b"image").expect("loose first");
        fs::write(directory.join("media/second.png"), b"image").expect("loose second");
        assert!(!inspect().media_complete);
        assert!(!directory.join(MEDIA_ARCHIVE_FILE).exists());
        assert!(directory.join("media/first.png").is_file());
    }

    #[test]
    fn stored_chapter_inspection_rejects_invalid_artifacts_and_accepts_body_only_content() {
        let root = tempfile::tempdir().expect("storage");
        let directory = root.path().join("chapter");
        fs::create_dir(&directory).expect("chapter directory");
        fs::write(directory.join("content.pdf"), b"pdf").expect("body");
        let inspect = || inspect_content_chapter_dir(root.path(), &directory, "content.pdf")
            .expect("inspect chapter").expect("body present");

        assert!(inspect().media_complete);
        write_inventory_archive(&directory, &["first.png"]);
        assert!(!inspect().media_complete);
        fs::write(directory.join("manifest.json"), b"{\"version\":1,\"complete\":true}").expect("bad manifest");
        assert!(!inspect().media_complete);
        write_inventory_manifest(&directory, true, "stored");
        fs::write(directory.join(MEDIA_ARCHIVE_FILE), b"not a zip").expect("bad archive");
        assert!(!inspect().media_complete);
        assert_eq!(inspect().status, "present");
    }

    #[test]
    fn stored_chapter_inspection_keeps_partial_body_when_media_is_incomplete() {
        let root = tempfile::tempdir().expect("storage");
        let directory = root.path().join("chapter");
        fs::create_dir(&directory).expect("chapter directory");
        fs::write(directory.join(CHAPTER_PARTIAL_CONTENT_FILE), b"body").expect("partial body");
        write_inventory_manifest(&directory, false, "remote");
        write_inventory_archive(&directory, &["first.png"]);
        let original_manifest = fs::read(directory.join("manifest.json")).expect("manifest");
        let original_archive = fs::read(directory.join(MEDIA_ARCHIVE_FILE)).expect("archive");

        let inspected = inspect_content_chapter_dir(root.path(), &directory, "content.html")
            .expect("inspect chapter").expect("partial body present");

        assert_eq!(inspected.status, "present");
        assert_eq!(inspected.content_file.as_deref(), Some("chapter/.chapter-content.partial"));
        assert_eq!(inspected.content_bytes, 4);
        assert!(!inspected.media_complete);
        assert_eq!(fs::read(directory.join(CHAPTER_PARTIAL_CONTENT_FILE)).unwrap(), b"body");
        assert_eq!(fs::read(directory.join("manifest.json")).unwrap(), original_manifest);
        assert_eq!(fs::read(directory.join(MEDIA_ARCHIVE_FILE)).unwrap(), original_archive);
    }

    #[test]
    fn stored_chapter_inspection_prefers_published_body_over_partial_body() {
        let root = tempfile::tempdir().expect("storage");
        let directory = root.path().join("chapter");
        fs::create_dir(&directory).expect("chapter directory");
        fs::write(directory.join("content.html"), b"published").expect("published body");
        fs::write(directory.join(CHAPTER_PARTIAL_CONTENT_FILE), b"partial").expect("partial body");

        let inspected = inspect_content_chapter_dir(root.path(), &directory, "content.html")
            .expect("inspect chapter").expect("published body present");

        assert_eq!(inspected.content_file.as_deref(), Some("chapter/content.html"));
        assert_eq!(inspected.content_bytes, 9);
        assert!(inspected.media_complete);
    }

    #[test]
    fn content_cleanup_only_removes_current_body_files() {
        let root = tempfile::tempdir().expect("temporary storage");
        for file_name in [
            "content.html", "content.pdf", CHAPTER_PARTIAL_CONTENT_FILE,
            "content.html.tmp", "content.html.bak", "content.txt", "chapter-42.html",
        ] {
            fs::write(root.path().join(file_name), b"content").expect("write content");
        }
        let keep = root.path().join("content.html");

        remove_chapter_content_files_in_dir(root.path(), Some(&keep)).expect("clean current body");

        assert!(keep.exists());
        assert!(!root.path().join("content.pdf").exists());
        assert!(!root.path().join(CHAPTER_PARTIAL_CONTENT_FILE).exists());
        for file_name in ["content.html.tmp", "content.html.bak", "content.txt", "chapter-42.html"] {
            assert!(root.path().join(file_name).exists());
        }
    }
}
