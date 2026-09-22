//! Chapter media manifest parsing and recovery.

use super::paths::{safe_media_relative_path, MEDIA_DOWNLOAD_DIR};
use super::publication::{
    chapter_media_manifest_backup_path, chapter_media_manifest_path,
    chapter_media_manifest_rollback_path, replace_file_preserving_recovery_backup,
    write_chapter_media_manifest,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::{Component, Path},
};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterMediaArchiveManifest {
    complete: bool,
    media: ChapterMediaArchiveManifestMedia,
    #[serde(rename = "updatedAt")]
    _updated_at: u64,
    version: u64,
}

#[derive(Debug, serde::Deserialize)]
struct ChapterMediaArchiveManifestMedia {
    files: Vec<ChapterMediaArchiveManifestFile>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterMediaArchiveManifestFile {
    bytes: u64,
    #[serde(rename = "contentType")]
    _content_type: Option<String>,
    file_name: String,
    path: String,
    #[serde(rename = "sourceUrl")]
    _source_url: String,
    status: ChapterMediaArchiveManifestFileStatus,
    #[serde(rename = "updatedAt")]
    _updated_at: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChapterMediaArchiveManifestFileStatus {
    Remote,
    Stored,
}

#[derive(Debug)]
pub(super) struct ExpectedStoredChapterMedia {
    pub(super) bytes: u64,
    pub(super) file_name: String,
}

#[derive(Debug)]
pub(super) struct ValidChapterMediaArchiveManifest {
    pub(super) complete: bool,
    pub(super) raw: serde_json::Value,
    pub(super) stored_files: Vec<ExpectedStoredChapterMedia>,
}

#[derive(Debug)]
pub(super) enum ChapterMediaArchiveManifestState {
    Invalid(String),
    Missing,
    Valid(ValidChapterMediaArchiveManifest),
}

#[derive(Debug)]
pub(super) enum ChapterMediaArtifactState {
    Invalid(String),
    Missing,
    Valid(HashSet<String>),
}

#[derive(Debug)]
pub(super) enum ChapterMediaFinalization {
    Incomplete(String),
    ManifestMissing,
    Ready(u64),
}

pub(super) fn is_safe_manifest_media_file_name(file_name: &str) -> bool {
    safe_media_relative_path(file_name).is_ok()
        && matches!(
            Path::new(file_name)
                .components()
                .collect::<Vec<_>>()
                .as_slice(),
            [Component::Normal(_)]
        )
}

pub(super) fn parse_chapter_media_archive_manifest(
    raw: &str,
) -> Result<ValidChapterMediaArchiveManifest, String> {
    let raw_value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => value,
        Err(err) => return Err(format!("invalid manifest JSON: {err}")),
    };
    let manifest = match serde_json::from_value::<ChapterMediaArchiveManifest>(raw_value.clone()) {
        Ok(manifest) => manifest,
        Err(err) => return Err(format!("invalid manifest schema: {err}")),
    };
    if manifest.version != 1 {
        return Err(format!("unsupported manifest version {}", manifest.version));
    }

    let mut stored_file_names = HashSet::new();
    let mut stored_files = Vec::new();
    for file in manifest.media.files {
        if !matches!(file.status, ChapterMediaArchiveManifestFileStatus::Stored) {
            continue;
        }
        if !is_safe_manifest_media_file_name(&file.file_name)
            || file.file_name.to_ascii_lowercase().ends_with(".part")
            || file.path != format!("{MEDIA_DOWNLOAD_DIR}/{}", file.file_name)
        {
            return Err(format!("invalid stored media path '{}'", file.path));
        }
        if !stored_file_names.insert(file.file_name.clone()) {
            return Err(format!("duplicate stored media file '{}'", file.file_name));
        }
        stored_files.push(ExpectedStoredChapterMedia {
            bytes: file.bytes,
            file_name: file.file_name,
        });
    }
    stored_files.sort_by(|left, right| left.file_name.cmp(&right.file_name));

    Ok(ValidChapterMediaArchiveManifest {
        complete: manifest.complete,
        raw: raw_value,
        stored_files,
    })
}

fn read_chapter_media_archive_manifest_at(
    manifest_path: &Path,
) -> Result<ChapterMediaArchiveManifestState, String> {
    match fs::symlink_metadata(manifest_path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => {
            return Ok(ChapterMediaArchiveManifestState::Invalid(format!(
                "manifest candidate '{}' is not a regular file",
                manifest_path.display()
            )));
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(ChapterMediaArchiveManifestState::Missing);
        }
        Err(err) => return Err(format!("chapter media: inspect media manifest: {err}")),
    }
    let raw = fs::read_to_string(manifest_path)
        .map_err(|err| format!("chapter media: read media manifest: {err}"))?;
    Ok(match parse_chapter_media_archive_manifest(&raw) {
        Ok(manifest) => ChapterMediaArchiveManifestState::Valid(manifest),
        Err(reason) => ChapterMediaArchiveManifestState::Invalid(reason),
    })
}

pub(super) fn read_chapter_media_archive_manifest(
    chapter_dir: &Path,
) -> Result<ChapterMediaArchiveManifestState, String> {
    let manifest_path = chapter_media_manifest_path(chapter_dir);
    let manifest = read_chapter_media_archive_manifest_at(&manifest_path)?;
    let final_was_missing = matches!(&manifest, ChapterMediaArchiveManifestState::Missing);
    let mut invalid_candidates = Vec::new();
    let final_manifest = match manifest {
        ChapterMediaArchiveManifestState::Valid(manifest) => Some(manifest),
        ChapterMediaArchiveManifestState::Invalid(reason) => {
            invalid_candidates.push(format!("final manifest: {reason}"));
            None
        }
        ChapterMediaArchiveManifestState::Missing => None,
    };
    let temp_path = manifest_path.with_extension("json.tmp");
    match read_chapter_media_archive_manifest_at(&temp_path)? {
        ChapterMediaArchiveManifestState::Invalid(reason) => {
            invalid_candidates.push(format!("{}: {reason}", temp_path.display()));
        }
        ChapterMediaArchiveManifestState::Missing => {}
        ChapterMediaArchiveManifestState::Valid(temp_manifest) => {
            replace_file_preserving_recovery_backup(
                &temp_path,
                &manifest_path,
                &chapter_media_manifest_backup_path(&manifest_path),
                &chapter_media_manifest_rollback_path(&manifest_path),
                "chapter media: recover media manifest publication",
            )?;
            return Ok(ChapterMediaArchiveManifestState::Valid(temp_manifest));
        }
    }
    if let Some(manifest) = final_manifest {
        return Ok(ChapterMediaArchiveManifestState::Valid(manifest));
    }

    let candidate_paths = [
        chapter_media_manifest_backup_path(&manifest_path),
        chapter_media_manifest_rollback_path(&manifest_path),
    ];
    for candidate_path in candidate_paths {
        match read_chapter_media_archive_manifest_at(&candidate_path)? {
            ChapterMediaArchiveManifestState::Invalid(reason) => {
                invalid_candidates.push(format!("{}: {reason}", candidate_path.display()));
            }
            ChapterMediaArchiveManifestState::Missing => {}
            ChapterMediaArchiveManifestState::Valid(manifest) => {
                write_chapter_media_manifest(&manifest_path, &manifest.raw)?;
                return Ok(ChapterMediaArchiveManifestState::Valid(manifest));
            }
        }
    }
    if final_was_missing && invalid_candidates.is_empty() {
        Ok(ChapterMediaArchiveManifestState::Missing)
    } else {
        Ok(ChapterMediaArchiveManifestState::Invalid(format!(
            "interrupted manifest publication has no valid candidate: {}",
            invalid_candidates.join("; ")
        )))
    }
}

pub(super) fn expected_stored_media_by_name(
    stored_files: &[ExpectedStoredChapterMedia],
) -> HashMap<&str, u64> {
    stored_files
        .iter()
        .map(|file| (file.file_name.as_str(), file.bytes))
        .collect()
}
