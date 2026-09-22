//! Chapter media archives, finalization, and download workspaces.

use super::chapter_media_blocking;
use super::content::content_chapter_dir_from_context;
use super::manifest::{
    expected_stored_media_by_name, is_safe_manifest_media_file_name,
    read_chapter_media_archive_manifest, ChapterMediaArchiveManifestState,
    ChapterMediaArtifactState, ChapterMediaFinalization, ExpectedStoredChapterMedia,
    ValidChapterMediaArchiveManifest,
};
use super::paths::{
    content_chapter_dir_at, content_chapter_dirs_for_lookup, ensure_contents_nomedia, media_root,
    media_roots_for_lookup, validate_chapter_dir_under_storage_root, MEDIA_ARCHIVE_FILE,
    MEDIA_DOWNLOAD_DIR,
};
use super::publication::{
    chapter_media_archive_publication_paths, chapter_media_manifest_path,
    chapter_media_manifest_publication_paths, create_publication_temp_file,
    remove_known_publication_file, remove_stale_chapter_media_archive_publication_files,
    remove_stale_chapter_media_manifest_publication_files, replace_media_archive,
    write_chapter_media_manifest,
};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, BufReader, BufWriter, ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

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

pub(super) fn clear_content_media_artifacts(chapter_dir: &Path) -> Result<(), String> {
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    if media_dir.exists() {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove media dir: {err}"))?;
    }
    for archive_path in chapter_archives_in_dir(chapter_dir)? {
        fs::remove_file(&archive_path)
            .map_err(|err| format!("chapter media: remove media archive: {err}"))?;
    }
    remove_known_publication_file(
        &chapter_dir.join(MEDIA_ARCHIVE_FILE),
        "chapter media: remove media archive",
    )?;
    remove_stale_chapter_media_archive_publication_files(chapter_dir)?;
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    remove_known_publication_file(&manifest_path, "chapter media: remove media manifest")?;
    remove_stale_chapter_media_manifest_publication_files(chapter_dir)?;
    Ok(())
}

fn validate_loose_chapter_media(
    media_dir: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
) -> Result<ChapterMediaArtifactState, String> {
    match fs::symlink_metadata(media_dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "loose media path is not a directory".to_string(),
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(ChapterMediaArtifactState::Missing);
        }
        Err(err) => return Err(format!("chapter media: inspect loose media dir: {err}")),
    }

    let expected = expected_stored_media_by_name(stored_files);
    let mut found = HashSet::new();
    for entry in fs::read_dir(media_dir)
        .map_err(|err| format!("chapter media: read loose media dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read loose media entry: {err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("chapter media: read loose media entry type: {err}"))?;
        let file_name = match entry.file_name().into_string() {
            Ok(file_name) => file_name,
            Err(_) => {
                return Ok(ChapterMediaArtifactState::Invalid(
                    "loose media contains a non-Unicode entry name".to_string(),
                ));
            }
        };
        if !file_type.is_file() {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "loose media entry '{file_name}' is not a regular file"
            )));
        }
        let Some(expected_bytes) = expected.get(file_name.as_str()) else {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "unexpected loose media file '{file_name}'"
            )));
        };
        let actual_bytes = entry
            .metadata()
            .map_err(|err| format!("chapter media: read loose media file metadata: {err}"))?
            .len();
        if actual_bytes != *expected_bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "loose media file '{file_name}' has {actual_bytes} bytes, expected {expected_bytes}"
            )));
        }
        if !found.insert(file_name) {
            return Ok(ChapterMediaArtifactState::Invalid(
                "loose media contains duplicate file names".to_string(),
            ));
        }
    }

    Ok(ChapterMediaArtifactState::Valid(found))
}

fn completed_manifest_media_bytes(
    chapter_dir: &Path,
    manifest: &ValidChapterMediaArchiveManifest,
) -> Result<Option<u64>, String> {
    if !manifest.complete {
        return Ok(None);
    }

    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    match fs::symlink_metadata(&media_dir) {
        Ok(_) => return Ok(None),
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(format!("chapter media: inspect loose media dir: {err}")),
    }
    for path in chapter_media_archive_publication_paths(chapter_dir)
        .into_iter()
        .chain(chapter_media_manifest_publication_paths(chapter_dir))
    {
        match fs::symlink_metadata(&path) {
            Ok(_) => return Ok(None),
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => {
                return Err(format!(
                    "chapter media: inspect media publication file: {err}"
                ));
            }
        }
    }

    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    if manifest.stored_files.is_empty() {
        return match fs::symlink_metadata(&archive_path) {
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(Some(0)),
            Err(err) => Err(format!("chapter media: inspect media archive: {err}")),
            Ok(_) => Ok(None),
        };
    }

    match fs::symlink_metadata(&archive_path) {
        Ok(metadata) if metadata.file_type().is_file() && metadata.len() > 0 => {
            Ok(Some(metadata.len()))
        }
        Ok(_) => Ok(None),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: inspect media archive: {err}")),
    }
}

fn validate_chapter_media_archive(
    archive_path: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
) -> Result<ChapterMediaArtifactState, String> {
    match fs::symlink_metadata(archive_path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "media archive path is not a regular file".to_string(),
            ));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(ChapterMediaArtifactState::Missing);
        }
        Err(err) => return Err(format!("chapter media: inspect media archive: {err}")),
    }

    let archive_file = File::open(archive_path)
        .map_err(|err| format!("chapter media: open media archive: {err}"))?;
    let mut archive = match ZipArchive::new(BufReader::new(archive_file)) {
        Ok(archive) => archive,
        Err(err) => {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "invalid media archive: {err}"
            )));
        }
    };
    let expected = expected_stored_media_by_name(stored_files);
    let mut found = HashSet::new();

    for index in 0..archive.len() {
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(err) => {
                return Ok(ChapterMediaArtifactState::Invalid(format!(
                    "invalid media archive entry: {err}"
                )));
            }
        };
        let file_name = entry.name().to_string();
        if !entry.is_file() || !is_safe_manifest_media_file_name(&file_name) {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "invalid media archive entry '{file_name}'"
            )));
        }
        let Some(expected_bytes) = expected.get(file_name.as_str()) else {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "unexpected media archive entry '{file_name}'"
            )));
        };
        if !found.insert(file_name.clone()) {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "duplicate media archive entry '{file_name}'"
            )));
        }
        if entry.size() != *expected_bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "media archive entry '{file_name}' has {} bytes, expected {expected_bytes}",
                entry.size()
            )));
        }

        let mut sink = io::sink();
        let actual_bytes = match io::copy(&mut entry, &mut sink) {
            Ok(bytes) => bytes,
            Err(err) => {
                return Ok(ChapterMediaArtifactState::Invalid(format!(
                    "cannot read media archive entry '{file_name}': {err}"
                )));
            }
        };
        if actual_bytes != *expected_bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "media archive entry '{file_name}' read {actual_bytes} bytes, expected {expected_bytes}"
            )));
        }
    }

    Ok(ChapterMediaArtifactState::Valid(found))
}

fn stored_media_sources_cover_manifest(
    stored_files: &[ExpectedStoredChapterMedia],
    loose_file_names: &HashSet<String>,
    archive_file_names: &HashSet<String>,
) -> bool {
    stored_files.iter().all(|file| {
        loose_file_names.contains(&file.file_name) || archive_file_names.contains(&file.file_name)
    })
}

fn recover_chapter_media_archive_source(
    chapter_dir: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
    loose_file_names: &HashSet<String>,
) -> Result<(ChapterMediaArtifactState, PathBuf), String> {
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let [temp_archive_path, backup_archive_path, rollback_archive_path] =
        chapter_media_archive_publication_paths(chapter_dir);
    let archive_state = validate_chapter_media_archive(&archive_path, stored_files)?;
    if matches!(&archive_state, ChapterMediaArtifactState::Valid(file_names)
        if stored_media_sources_cover_manifest(stored_files, loose_file_names, file_names))
    {
        return Ok((archive_state, archive_path));
    }

    let temp_state = validate_chapter_media_archive(&temp_archive_path, stored_files)?;

    let temp_issue = match temp_state {
        ChapterMediaArtifactState::Valid(file_names) => {
            if file_names.len() == stored_files.len() {
                replace_media_archive(&temp_archive_path, &archive_path)?;
                return Ok((ChapterMediaArtifactState::Valid(file_names), archive_path));
            }
            Some("interrupted media archive temp is incomplete".to_string())
        }
        ChapterMediaArtifactState::Invalid(reason) => Some(reason),
        ChapterMediaArtifactState::Missing => None,
    };

    let backup_state = validate_chapter_media_archive(&backup_archive_path, stored_files)?;
    if matches!(&backup_state, ChapterMediaArtifactState::Valid(file_names)
        if stored_media_sources_cover_manifest(stored_files, loose_file_names, file_names))
    {
        return Ok((backup_state, backup_archive_path));
    }

    let rollback_state = validate_chapter_media_archive(&rollback_archive_path, stored_files)?;
    if matches!(&rollback_state, ChapterMediaArtifactState::Valid(file_names)
        if stored_media_sources_cover_manifest(stored_files, loose_file_names, file_names))
    {
        return Ok((rollback_state, rollback_archive_path));
    }

    if matches!(&archive_state, ChapterMediaArtifactState::Valid(_)) {
        return Ok((archive_state, archive_path));
    }
    if matches!(&backup_state, ChapterMediaArtifactState::Valid(_)) {
        return Ok((backup_state, backup_archive_path));
    }
    if matches!(&rollback_state, ChapterMediaArtifactState::Valid(_)) {
        return Ok((rollback_state, rollback_archive_path));
    }
    if matches!(&archive_state, ChapterMediaArtifactState::Invalid(_)) {
        return Ok((archive_state, archive_path));
    }
    if matches!(&backup_state, ChapterMediaArtifactState::Invalid(_)) {
        return Ok((backup_state, backup_archive_path));
    }
    if matches!(&rollback_state, ChapterMediaArtifactState::Invalid(_)) {
        return Ok((rollback_state, rollback_archive_path));
    }
    if let Some(reason) = temp_issue {
        return Ok((
            ChapterMediaArtifactState::Invalid(reason),
            temp_archive_path,
        ));
    }

    Ok((archive_state, archive_path))
}

fn build_validated_chapter_media_archive(
    chapter_dir: &Path,
    stored_files: &[ExpectedStoredChapterMedia],
    loose_file_names: &HashSet<String>,
    archive_file_names: &HashSet<String>,
    archive_source_path: &Path,
) -> Result<ChapterMediaArtifactState, String> {
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let temp_archive_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    let needs_existing_archive = stored_files
        .iter()
        .any(|file| !loose_file_names.contains(&file.file_name));
    let mut existing_archive = if needs_existing_archive {
        let archive_file = File::open(archive_source_path)
            .map_err(|err| format!("chapter media: reopen media archive: {err}"))?;
        Some(
            ZipArchive::new(BufReader::new(archive_file))
                .map_err(|err| format!("chapter media: reopen media archive: {err}"))?,
        )
    } else {
        None
    };
    let temp_file =
        create_publication_temp_file(&temp_archive_path, "chapter media: create media archive")?;
    let mut archive = ZipWriter::new(BufWriter::new(temp_file));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for file in stored_files {
        archive
            .start_file(&file.file_name, options)
            .map_err(|err| format!("chapter media: start media archive entry: {err}"))?;
        let written_bytes = if loose_file_names.contains(&file.file_name) {
            let path = media_dir.join(&file.file_name);
            let mut input = File::open(&path)
                .map_err(|err| format!("chapter media: open loose media file: {err}"))?;
            io::copy(&mut input, &mut archive)
                .map_err(|err| format!("chapter media: write loose media archive entry: {err}"))?
        } else if archive_file_names.contains(&file.file_name) {
            let Some(existing_archive) = existing_archive.as_mut() else {
                return Ok(ChapterMediaArtifactState::Invalid(format!(
                    "media archive source '{}' is unavailable",
                    file.file_name
                )));
            };
            let mut input = match existing_archive.by_name(&file.file_name) {
                Ok(input) => input,
                Err(err) => {
                    return Ok(ChapterMediaArtifactState::Invalid(format!(
                        "cannot reopen media archive entry '{}': {err}",
                        file.file_name
                    )));
                }
            };
            io::copy(&mut input, &mut archive)
                .map_err(|err| format!("chapter media: copy existing media archive entry: {err}"))?
        } else {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "stored media source '{}' is missing",
                file.file_name
            )));
        };
        if written_bytes != file.bytes {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "media file '{}' changed while archiving",
                file.file_name
            )));
        }
    }
    drop(existing_archive);

    let mut output = archive
        .finish()
        .map_err(|err| format!("chapter media: finalize media archive: {err}"))?;
    output
        .flush()
        .map_err(|err| format!("chapter media: flush media archive: {err}"))?;
    drop(output);

    match validate_chapter_media_archive(&temp_archive_path, stored_files)? {
        ChapterMediaArtifactState::Valid(file_names) if file_names.len() == stored_files.len() => {}
        ChapterMediaArtifactState::Valid(_) => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "created media archive is incomplete".to_string(),
            ));
        }
        ChapterMediaArtifactState::Invalid(reason) => {
            return Ok(ChapterMediaArtifactState::Invalid(format!(
                "created media archive failed validation: {reason}"
            )));
        }
        ChapterMediaArtifactState::Missing => {
            return Ok(ChapterMediaArtifactState::Invalid(
                "created media archive is missing".to_string(),
            ));
        }
    }
    replace_media_archive(&temp_archive_path, &archive_path)?;
    Ok(ChapterMediaArtifactState::Valid(
        stored_files
            .iter()
            .map(|file| file.file_name.clone())
            .collect(),
    ))
}

fn mark_chapter_media_manifest_complete(
    chapter_dir: &Path,
    manifest: &mut ValidChapterMediaArchiveManifest,
) -> Result<(), String> {
    let Some(manifest_object) = manifest.raw.as_object_mut() else {
        return Err("chapter media: media manifest root is not an object".to_string());
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    manifest_object.insert("complete".to_string(), serde_json::Value::Bool(true));
    manifest_object.insert(
        "updatedAt".to_string(),
        serde_json::Value::Number(now.into()),
    );
    write_chapter_media_manifest(&chapter_media_manifest_path(chapter_dir), &manifest.raw)
}

fn chapter_media_finalization_lock(chapter_dir: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

    let canonical_chapter = fs::canonicalize(chapter_dir)
        .map_err(|err| format!("chapter media: resolve finalization path: {err}"))?;
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&canonical_chapter).and_then(Weak::upgrade) {
        return Ok(lock);
    }

    let lock = Arc::new(Mutex::new(()));
    locks.insert(canonical_chapter, Arc::downgrade(&lock));
    Ok(lock)
}

pub(super) fn finalize_chapter_media_artifacts(
    root: &Path,
    chapter_dir: &Path,
) -> Result<ChapterMediaFinalization, String> {
    validate_chapter_dir_under_storage_root(root, chapter_dir)?;
    let finalization_lock = chapter_media_finalization_lock(chapter_dir)?;
    let _finalization_guard = finalization_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    finalize_chapter_media_artifacts_locked(chapter_dir)
}

fn finalize_chapter_media_artifacts_locked(
    chapter_dir: &Path,
) -> Result<ChapterMediaFinalization, String> {
    let mut manifest = match read_chapter_media_archive_manifest(chapter_dir)? {
        ChapterMediaArchiveManifestState::Invalid(reason) => {
            return Ok(ChapterMediaFinalization::Incomplete(reason));
        }
        ChapterMediaArchiveManifestState::Missing => {
            return Ok(ChapterMediaFinalization::ManifestMissing);
        }
        ChapterMediaArchiveManifestState::Valid(manifest) => manifest,
    };

    if let Some(media_bytes) = completed_manifest_media_bytes(chapter_dir, &manifest)? {
        return Ok(ChapterMediaFinalization::Ready(media_bytes));
    }

    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let loose_state = validate_loose_chapter_media(&media_dir, &manifest.stored_files)?;

    if let ChapterMediaArtifactState::Invalid(reason) = &loose_state {
        return Ok(ChapterMediaFinalization::Incomplete(reason.clone()));
    }
    let empty_file_names = HashSet::new();
    let loose_file_names = match &loose_state {
        ChapterMediaArtifactState::Valid(file_names) => file_names,
        ChapterMediaArtifactState::Invalid(reason) => {
            return Ok(ChapterMediaFinalization::Incomplete(reason.clone()));
        }
        ChapterMediaArtifactState::Missing => &empty_file_names,
    };
    let (archive_state, archive_source_path) = recover_chapter_media_archive_source(
        chapter_dir,
        &manifest.stored_files,
        loose_file_names,
    )?;

    if manifest.stored_files.is_empty() {
        if let ChapterMediaArtifactState::Invalid(reason) = &archive_state {
            return Ok(ChapterMediaFinalization::Incomplete(reason.clone()));
        }
        if matches!(&archive_state, ChapterMediaArtifactState::Valid(_)) {
            if archive_source_path != archive_path {
                let empty_file_names = HashSet::new();
                match build_validated_chapter_media_archive(
                    chapter_dir,
                    &manifest.stored_files,
                    &empty_file_names,
                    &empty_file_names,
                    &archive_source_path,
                )? {
                    ChapterMediaArtifactState::Valid(_) => {}
                    ChapterMediaArtifactState::Invalid(reason) => {
                        return Ok(ChapterMediaFinalization::Incomplete(reason));
                    }
                    ChapterMediaArtifactState::Missing => {
                        return Ok(ChapterMediaFinalization::Incomplete(
                            "created empty media archive is missing".to_string(),
                        ));
                    }
                }
            }
            match validate_chapter_media_archive(&archive_path, &manifest.stored_files)? {
                ChapterMediaArtifactState::Valid(file_names) if file_names.is_empty() => {}
                ChapterMediaArtifactState::Valid(_) => {
                    return Ok(ChapterMediaFinalization::Incomplete(
                        "published empty media archive contains stored entries".to_string(),
                    ));
                }
                ChapterMediaArtifactState::Invalid(reason) => {
                    return Ok(ChapterMediaFinalization::Incomplete(reason));
                }
                ChapterMediaArtifactState::Missing => {
                    return Ok(ChapterMediaFinalization::Incomplete(
                        "published empty media archive is missing".to_string(),
                    ));
                }
            }
            fs::remove_file(&archive_path)
                .map_err(|err| format!("chapter media: remove empty media archive: {err}"))?;
        }
        remove_stale_chapter_media_archive_publication_files(chapter_dir)?;
        remove_stale_chapter_media_manifest_publication_files(chapter_dir)?;
        if matches!(&loose_state, ChapterMediaArtifactState::Valid(_)) {
            fs::remove_dir_all(&media_dir)
                .map_err(|err| format!("chapter media: remove empty loose media dir: {err}"))?;
        }
        mark_chapter_media_manifest_complete(chapter_dir, &mut manifest)?;
        return Ok(ChapterMediaFinalization::Ready(0));
    }

    let archive_file_names = match &archive_state {
        ChapterMediaArtifactState::Valid(file_names) => file_names,
        ChapterMediaArtifactState::Invalid(_) | ChapterMediaArtifactState::Missing => {
            &empty_file_names
        }
    };
    let missing_file = manifest.stored_files.iter().find(|file| {
        !loose_file_names.contains(&file.file_name) && !archive_file_names.contains(&file.file_name)
    });
    if let Some(missing_file) = missing_file {
        let archive_reason = match &archive_state {
            ChapterMediaArtifactState::Invalid(reason) => format!("; {reason}"),
            _ => String::new(),
        };
        return Ok(ChapterMediaFinalization::Incomplete(format!(
            "stored media source '{}' is missing{archive_reason}",
            missing_file.file_name
        )));
    }

    let archive_is_published_and_complete = archive_source_path == archive_path
        && archive_file_names.len() == manifest.stored_files.len()
        && loose_file_names.is_empty();
    if !archive_is_published_and_complete {
        match build_validated_chapter_media_archive(
            chapter_dir,
            &manifest.stored_files,
            loose_file_names,
            archive_file_names,
            &archive_source_path,
        )? {
            ChapterMediaArtifactState::Valid(_) => {}
            ChapterMediaArtifactState::Invalid(reason) => {
                return Ok(ChapterMediaFinalization::Incomplete(reason));
            }
            ChapterMediaArtifactState::Missing => {
                return Ok(ChapterMediaFinalization::Incomplete(
                    "created media archive is missing".to_string(),
                ));
            }
        }
    }

    let media_bytes = match validate_chapter_media_archive(&archive_path, &manifest.stored_files)? {
        ChapterMediaArtifactState::Valid(file_names)
            if file_names.len() == manifest.stored_files.len() =>
        {
            fs::symlink_metadata(&archive_path)
                .map_err(|err| format!("chapter media: inspect published media archive: {err}"))?
                .len()
        }
        ChapterMediaArtifactState::Valid(_) => {
            return Ok(ChapterMediaFinalization::Incomplete(
                "published media archive is incomplete".to_string(),
            ));
        }
        ChapterMediaArtifactState::Invalid(reason) => {
            return Ok(ChapterMediaFinalization::Incomplete(reason));
        }
        ChapterMediaArtifactState::Missing => {
            return Ok(ChapterMediaFinalization::Incomplete(
                "published media archive is missing".to_string(),
            ));
        }
    };
    remove_stale_chapter_media_archive_publication_files(chapter_dir)?;
    remove_stale_chapter_media_manifest_publication_files(chapter_dir)?;
    if matches!(&loose_state, ChapterMediaArtifactState::Valid(_)) {
        fs::remove_dir_all(&media_dir)
            .map_err(|err| format!("chapter media: remove loose media dir: {err}"))?;
    }
    mark_chapter_media_manifest_complete(chapter_dir, &mut manifest)?;
    Ok(ChapterMediaFinalization::Ready(media_bytes))
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
    validate_chapter_dir_under_storage_root(&media_root, &chapter_dir)?;
    ensure_contents_nomedia(&media_root)?;
    let media_bytes = match finalize_chapter_media_artifacts(&media_root, &chapter_dir)? {
        ChapterMediaFinalization::Incomplete(reason) => {
            return Err(format!(
                "chapter media: media archive finalization incomplete: {reason}"
            ));
        }
        ChapterMediaFinalization::ManifestMissing => {
            return Err("chapter media: media manifest is missing".to_string());
        }
        ChapterMediaFinalization::Ready(media_bytes) => media_bytes,
    };

    for root in media_roots_for_lookup(&app)? {
        for old_chapter_dir in content_chapter_dirs_for_lookup(&root, chapter_id)? {
            if old_chapter_dir != chapter_dir {
                validate_chapter_dir_under_storage_root(&root, &old_chapter_dir)?;
                clear_content_media_artifacts(&old_chapter_dir)?;
            }
        }
    }
    Ok(media_bytes)
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
    content_chapter_dir_from_context(
        &root,
        Some(novel_id),
        Some(source_id),
        Some(novel_path),
        novel_name,
        chapter_id,
        chapter_number,
        chapter_name,
        chapter_position,
    )?
    .ok_or_else(|| "chapter media: cannot resolve chapter storage path".to_string())
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
        remove_known_publication_file(&archive_path, "chapter media: remove media archive")?;
        remove_stale_chapter_media_archive_publication_files(&chapter_dir)?;
        let manifest_path = chapter_media_manifest_path(&chapter_dir);
        remove_known_publication_file(&manifest_path, "chapter media: remove media manifest")?;
        remove_stale_chapter_media_manifest_publication_files(&chapter_dir)?;
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
pub async fn chapter_media_write_manifest(
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
    chapter_media_blocking("write manifest", move || {
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
    })
    .await
}

#[tauri::command]
pub async fn chapter_media_read_manifest(
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
    chapter_media_blocking("read manifest", move || {
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
    })
    .await
}

#[cfg(test)]
#[path = "archives_tests.rs"]
mod tests;
