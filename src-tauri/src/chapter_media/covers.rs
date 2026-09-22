//! Novel cover identity lookup and persistence.

use super::chapter_media_blocking;
use super::media::move_media_source_to_part_path;
use super::paths::{
    content_novel_dir_at, ensure_contents_nomedia, media_root, relative_storage_path,
    safe_relative_storage_path, safe_segment, CONTENTS_ROOT_DIR, NOVEL_COVER_MANIFEST_FILE,
};
use super::types::NovelCoverReadResult;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

fn novel_cover_manifest_path(novel_dir: &Path) -> PathBuf {
    novel_dir.join(NOVEL_COVER_MANIFEST_FILE)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NovelCoverManifestMetadata {
    file_name: String,
    #[serde(default)]
    novel_path: Option<String>,
    #[serde(default)]
    source_id: Option<String>,
    source_url: String,
    #[serde(default)]
    updated_at: u64,
    version: u64,
}

fn novel_cover_manifest_metadata(raw: &str) -> Option<NovelCoverManifestMetadata> {
    serde_json::from_str(raw)
        .ok()
        .filter(|manifest: &NovelCoverManifestMetadata| manifest.version == 1)
}

fn novel_cover_file_name_from_manifest(raw: &str) -> Option<String> {
    novel_cover_manifest_metadata(raw).map(|manifest| manifest.file_name)
}

fn read_existing_novel_cover_manifest(novel_dir: &Path) -> Result<Option<String>, String> {
    let manifest_path = novel_cover_manifest_path(novel_dir);
    let raw = match fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("chapter media: read novel cover manifest: {err}")),
    };
    let file_name = match novel_cover_file_name_from_manifest(&raw) {
        Some(file_name) => safe_segment(&file_name, "cover"),
        None => return Ok(None),
    };
    let cover_path = novel_dir.join(file_name);
    match fs::metadata(&cover_path) {
        Ok(metadata) if metadata.is_file() && metadata.len() > 0 => Ok(Some(raw)),
        Ok(_) => Ok(None),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("chapter media: inspect novel cover file: {err}")),
    }
}

#[derive(Debug)]
struct NovelCoverCandidate {
    cover: NovelCoverReadResult,
    updated_at: u64,
}

fn novel_cover_manifest_matches_identity(
    manifest: &NovelCoverManifestMetadata,
    source_id: &str,
    novel_path: &str,
    expected_source_url: Option<&str>,
    is_preferred: bool,
) -> bool {
    match (
        manifest.source_id.as_deref(),
        manifest.novel_path.as_deref(),
    ) {
        (Some(stored_source_id), Some(stored_novel_path)) => {
            stored_source_id == source_id && stored_novel_path == novel_path
        }
        (None, None) => {
            is_preferred
                || expected_source_url.is_some_and(|source_url| manifest.source_url == source_url)
        }
        _ => false,
    }
}

fn read_novel_cover_candidate_at(
    media_root: &Path,
    novel_dir: &Path,
    source_id: &str,
    novel_path: &str,
    expected_source_url: Option<&str>,
    is_preferred: bool,
) -> Result<Option<NovelCoverCandidate>, String> {
    let Some(manifest) = read_existing_novel_cover_manifest(novel_dir)? else {
        return Ok(None);
    };
    let Some(metadata) = novel_cover_manifest_metadata(&manifest) else {
        return Ok(None);
    };
    if !novel_cover_manifest_matches_identity(
        &metadata,
        source_id,
        novel_path,
        expected_source_url,
        is_preferred,
    ) {
        return Ok(None);
    }
    let file_name = safe_segment(&metadata.file_name, "cover");
    let relative_path = relative_storage_path(media_root, &novel_dir.join(file_name))?;
    Ok(Some(NovelCoverCandidate {
        cover: NovelCoverReadResult {
            manifest,
            relative_path,
        },
        updated_at: metadata.updated_at,
    }))
}

fn novel_cover_dirs_matching_identity(
    media_root: &Path,
    source_id: &str,
    novel_id: i64,
    novel_path: &str,
) -> Result<Vec<PathBuf>, String> {
    let source_dir = media_root
        .join(CONTENTS_ROOT_DIR)
        .join(safe_segment(source_id, "source"));
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

    let identity_suffix = format!("-{}", safe_segment(novel_path, &novel_id.to_string()));
    let mut matches = Vec::new();
    for entry in
        fs::read_dir(&source_dir).map_err(|err| format!("chapter media: read source: {err}"))?
    {
        let entry = entry.map_err(|err| format!("chapter media: read source entry: {err}"))?;
        if entry
            .file_type()
            .map_err(|err| format!("chapter media: read source entry type: {err}"))?
            .is_dir()
            && entry
                .file_name()
                .to_string_lossy()
                .ends_with(&identity_suffix)
        {
            matches.push(entry.path());
        }
    }
    matches.sort();
    Ok(matches)
}

fn novel_cover_read_manifest_at(
    media_root: &Path,
    novel_id: i64,
    source_id: &str,
    novel_name: &str,
    novel_path: &str,
    expected_source_url: Option<&str>,
) -> Result<Option<NovelCoverReadResult>, String> {
    let preferred_dir = content_novel_dir_at(
        media_root,
        source_id,
        novel_id,
        Some(novel_path),
        Some(novel_name),
    )?;
    if let Some(cover) = read_novel_cover_candidate_at(
        media_root,
        &preferred_dir,
        source_id,
        novel_path,
        expected_source_url,
        true,
    )? {
        return Ok(Some(cover.cover));
    }

    let mut matches = Vec::new();
    for novel_dir in
        novel_cover_dirs_matching_identity(media_root, source_id, novel_id, novel_path)?
    {
        if novel_dir == preferred_dir {
            continue;
        }
        if let Some(cover) = read_novel_cover_candidate_at(
            media_root,
            &novel_dir,
            source_id,
            novel_path,
            expected_source_url,
            false,
        )? {
            matches.push(cover);
        }
    }

    matches.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.cover.relative_path.cmp(&right.cover.relative_path))
    });
    Ok(matches.into_iter().next().map(|candidate| candidate.cover))
}

#[tauri::command]
pub async fn novel_cover_read_manifest(
    app: AppHandle,
    novel_id: i64,
    source_id: String,
    novel_name: String,
    novel_path: String,
    expected_source_url: Option<String>,
) -> Result<Option<NovelCoverReadResult>, String> {
    chapter_media_blocking("read novel cover manifest", move || {
        let media_root = media_root(&app)?;
        novel_cover_read_manifest_at(
            &media_root,
            novel_id,
            &source_id,
            &novel_name,
            &novel_path,
            expected_source_url.as_deref(),
        )
    })
    .await
}

fn novel_cover_store_at(
    media_root: &Path,
    novel_id: i64,
    source_id: &str,
    novel_name: &str,
    novel_path: &str,
    file_name: &str,
    body: &[u8],
    manifest: &str,
) -> Result<(), String> {
    if body.is_empty() {
        return Err("chapter media: novel cover body is empty".to_string());
    }
    let incoming_manifest = novel_cover_manifest_metadata(manifest)
        .ok_or_else(|| "chapter media: invalid novel cover manifest".to_string())?;
    if incoming_manifest.source_id.as_deref() != Some(source_id)
        || incoming_manifest.novel_path.as_deref() != Some(novel_path)
    {
        return Err("chapter media: novel cover manifest identity does not match".to_string());
    }

    ensure_contents_nomedia(media_root)?;
    let existing_cover = novel_cover_read_manifest_at(
        media_root, novel_id, source_id, novel_name, novel_path, None,
    )?;
    let novel_dir = match existing_cover {
        Some(existing_cover) => {
            let relative_cover_path = safe_relative_storage_path(&existing_cover.relative_path)?;
            media_root
                .join(relative_cover_path)
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "chapter media: invalid stored novel cover path".to_string())?
        }
        None => content_novel_dir_at(
            media_root,
            source_id,
            novel_id,
            Some(novel_path),
            Some(novel_name),
        )?,
    };
    fs::create_dir_all(&novel_dir)
        .map_err(|err| format!("chapter media: create novel cover dir: {err}"))?;

    let previous_file_name = read_existing_novel_cover_manifest(&novel_dir)?
        .as_deref()
        .and_then(novel_cover_file_name_from_manifest)
        .map(|file_name| safe_segment(&file_name, "cover"));
    let file_name = safe_segment(file_name, "cover");
    let cover_path = novel_dir.join(&file_name);
    let temp_cover_path = novel_dir.join(format!("{file_name}.tmp"));
    fs::write(&temp_cover_path, body)
        .map_err(|err| format!("chapter media: write novel cover temp: {err}"))?;
    move_media_source_to_part_path(&temp_cover_path, &cover_path, "chapter media: novel cover")?;

    let manifest_path = novel_cover_manifest_path(&novel_dir);
    let temp_manifest_path = novel_dir.join(format!("{NOVEL_COVER_MANIFEST_FILE}.tmp"));
    fs::write(&temp_manifest_path, manifest)
        .map_err(|err| format!("chapter media: write novel cover manifest temp: {err}"))?;
    move_media_source_to_part_path(
        &temp_manifest_path,
        &manifest_path,
        "chapter media: novel cover manifest",
    )?;

    if let Some(previous_file_name) = previous_file_name {
        if previous_file_name != file_name {
            let _ = fs::remove_file(novel_dir.join(previous_file_name));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn novel_cover_store(
    app: AppHandle,
    novel_id: i64,
    source_id: String,
    novel_name: String,
    novel_path: String,
    file_name: String,
    body: Vec<u8>,
    manifest: String,
) -> Result<(), String> {
    chapter_media_blocking("store novel cover", move || {
        let media_root = media_root(&app)?;
        novel_cover_store_at(
            &media_root,
            novel_id,
            &source_id,
            &novel_name,
            &novel_path,
            &file_name,
            &body,
            &manifest,
        )
    })
    .await
}

#[cfg(test)]
#[path = "covers_tests.rs"]
mod tests;
