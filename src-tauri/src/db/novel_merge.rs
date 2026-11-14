use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::chapter_media::is_storage_id;
use crate::database::AppDatabase;

use super::chapter::{
    apply_source_chapter_number_changes_in_tx, assert_source_chapter_number_changes_supported,
    commit_source_chapter_renumber_in_tx, read_renumber_chapters_in_conn, RenumberWorkDto,
    SourceChapterNumberChangeDto, StoredRenumberChapterDto, SOURCE_CHAPTER_RENUMBER_PREFIX,
};
use super::chapter_composition::{
    canonical_chapter_number_str, chapter_composition_catalog, get_chapter_composition_in_tx,
    materialize_chapter_composition_in_tx, set_chapter_composition_in_tx,
    ChapterCompositionPreparedCopyDto, ChapterCompositionV1Dto,
};
use super::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use super::user_state::{
    core::{
        has_user_state_schema_in_tx, record_chapters_in_tx, record_composition_in_tx,
        record_library_in_tx, record_membership_in_tx, record_public_novel_reading_in_tx,
    },
    defer_user_state_for_novel_in_tx,
    migration::{remap_pending_user_state_in_tx, transfer_settled_novel_merge_resume_in_tx},
    types::random_uuid_v4,
};
use super::work_metadata::{
    canonical_json_value, decode_base64, encode_base64, flush_dirty_in_tx, parse_novel_metadata,
};
use super::{decode_sqlite_f64, decode_sqlite_opt_f64, DbMutationEnvelope, ReadMode};

pub const NOVEL_MERGE_STORAGE_PREFIX: &str = "norea-novel-merge-storage:";
pub const NOVEL_MIGRATION_CACHE_PREFIX: &str = "norea-content-novel-migration:";
pub const INCOMING_MIGRATION_CACHE_PREFIX: &str = "norea-content-incoming-migration:";
pub const WORK_SYNC_CACHE_PREFIX: &str = "norea-content-work-sync:";

const SQLITE_BIND_PARAMETER_BUDGET: usize = 900;
const NOVEL_MERGE_UPDATE_PARAM_COUNT: usize = 10;
const NOVEL_MERGE_UPDATE_CHUNK_SIZE: usize =
    SQLITE_BIND_PARAMETER_BUDGET / NOVEL_MERGE_UPDATE_PARAM_COUNT;
const MAX_SAFE_INT_I64: i64 = 9_007_199_254_740_991;
const MAX_NOVEL_COVER_BYTES: usize = 10 * 1024 * 1024;

fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_known_chapter_content_type(value: &str) -> bool {
    matches!(value, "html" | "pdf")
}

fn is_valid_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn is_valid_asset_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("media/") else {
        return false;
    };
    if rest.is_empty() || key.len() > 261 || key.to_ascii_lowercase().ends_with(".part") {
        return false;
    }
    let mut bytes = rest.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric() || first == b'_' || first == b'-') {
        return false;
    }
    bytes.all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

pub fn is_valid_chapter_payload_inventory(value: &JsonValue) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    let valid_digest = |digest: &JsonValue| -> bool {
        let Some(d) = digest.as_object() else {
            return false;
        };
        let Some(sha) = d.get("sha256").and_then(JsonValue::as_str) else {
            return false;
        };
        let Some(bytes) = d.get("bytes").and_then(JsonValue::as_i64) else {
            return false;
        };
        is_valid_hex_sha256(sha) && (0..=MAX_SAFE_INT_I64).contains(&bytes)
    };
    match obj.get("body") {
        Some(JsonValue::Null) => {}
        Some(body) if valid_digest(body) => {}
        _ => return false,
    }
    let Some(stored_assets) = obj.get("storedAssets").and_then(JsonValue::as_array) else {
        return false;
    };
    if stored_assets.len() > 100_000 {
        return false;
    }
    match obj.get("expectedAssetKeys") {
        Some(JsonValue::Null) => {}
        Some(JsonValue::Array(keys)) => {
            if keys.len() > 100_000 {
                return false;
            }
            let mut exact = HashSet::with_capacity(keys.len());
            let mut lower = HashSet::with_capacity(keys.len());
            for raw_key in keys {
                let Some(k) = raw_key.as_str() else {
                    return false;
                };
                if !is_valid_asset_key(k)
                    || !exact.insert(k)
                    || !lower.insert(k.to_ascii_lowercase())
                {
                    return false;
                }
            }
        }
        _ => return false,
    }
    let mut seen = HashSet::with_capacity(stored_assets.len());
    for asset in stored_assets {
        let Some(asset_obj) = asset.as_object() else {
            return false;
        };
        let Some(key) = asset_obj.get("key").and_then(JsonValue::as_str) else {
            return false;
        };
        if !is_valid_asset_key(key)
            || !seen.insert(key.to_ascii_lowercase())
            || !valid_digest(asset)
        {
            return false;
        }
    }
    true
}

pub fn normalize_content_server_url_strict(raw: &str, trim_first: bool) -> Result<String, String> {
    let candidate = if trim_first { raw.trim() } else { raw };
    let parsed = reqwest::Url::parse(candidate)
        .map_err(|_| "Content server URL is invalid.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Content server URL is invalid.".to_string());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn safe_metadata_child(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 255
        && segment != "."
        && segment != ".."
        && !segment.contains('/')
        && !segment.contains('\\')
        && !segment.bytes().any(|b| b < 0x20 || b == 0x7f)
}

fn valid_storage_directory(path: &str, depth: usize) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    parts.len() == depth
        && path.starts_with("contents/")
        && parts.into_iter().all(safe_metadata_child)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelMergeTargetPreviewDbDto {
    pub novel_id: i64,
    pub composition: Option<ChapterCompositionV1Dto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStorageWorkDto {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeStorageSnapshotDto {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub path: String,
    pub directory: String,
    pub metadata_body: Option<String>,
    pub next_metadata_body: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferEntryDto {
    pub entry_id: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparedEntryDto {
    pub entry_id: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
    pub outcome: String,
    pub replaced_target: bool,
    pub content_file: Option<String>,
    pub content_bytes: i64,
    pub media_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparationDto {
    pub token: String,
    pub entries: Vec<ChapterStorageTransferPreparedEntryDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelMergeStorageJournalDto {
    pub version: i64,
    pub token: String,
    pub phase: String,
    pub source: MergeStorageSnapshotDto,
    pub target: MergeStorageSnapshotDto,
    pub entries: Vec<ChapterStorageTransferEntryDto>,
    pub cleanup_directories: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation: Option<ChapterStorageTransferPreparationDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNovelMergeStorageJournalInputDto {
    #[serde(default)]
    pub token: Option<String>,
    pub source: MergeStorageWorkDto,
    pub source_directory: String,
    pub source_metadata_body: Option<String>,
    pub target: MergeStorageWorkDto,
    pub target_directory: String,
    pub target_metadata_body: Option<String>,
    pub entries: Vec<ChapterStorageTransferEntryDto>,
    pub cleanup_directories: Vec<String>,
    #[serde(default)]
    pub composition: Option<ChapterCompositionV1Dto>,
}

pub fn validate_novel_merge_storage_journal(
    job: &NovelMergeStorageJournalDto,
) -> Result<(), String> {
    let valid_token = !job.token.is_empty()
        && job.token.len() <= 128
        && job
            .token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let valid_phase = matches!(job.phase.as_str(), "preparing" | "committed");
    let valid_work = |work: &MergeStorageSnapshotDto| -> bool {
        work.id > 0
            && work.id <= MAX_SAFE_INT_I64
            && work.source_novel_id.is_some()
            && valid_storage_directory(&work.directory, 3)
    };
    let source_prefix = format!("{}/", job.source.directory);
    let target_prefix = format!("{}/", job.target.directory);
    if job.version != 1
        || !valid_token
        || !valid_phase
        || job.source.id == job.target.id
        || job.source.directory == job.target.directory
        || !valid_work(&job.source)
        || !valid_work(&job.target)
        || job.entries.is_empty()
        || job.entries.iter().any(|entry| {
            entry.entry_id.is_empty()
                || !valid_storage_directory(&entry.source_relative_dir, 4)
                || !valid_storage_directory(&entry.target_relative_dir, 4)
                || !entry.source_relative_dir.starts_with(&source_prefix)
                || !entry.target_relative_dir.starts_with(&target_prefix)
        })
        || job
            .cleanup_directories
            .iter()
            .any(|path| path != &job.source.directory)
    {
        return Err(
            "Work merge storage recovery journal is invalid. Existing files were retained."
                .to_string(),
        );
    }

    if let Some(ref prep) = job.preparation {
        let mismatch = prep.token != job.token
            || prep.entries.len() != job.entries.len()
            || prep
                .entries
                .iter()
                .zip(job.entries.iter())
                .any(|(actual, expected)| {
                    actual.entry_id != expected.entry_id
                        || actual.source_relative_dir != expected.source_relative_dir
                        || actual.target_relative_dir != expected.target_relative_dir
                        || !matches!(
                            actual.outcome.as_str(),
                            "movedSource" | "copiedSource" | "keptTarget" | "sourceNotDownloaded"
                        )
                });
        if mismatch {
            return Err(
                "Work merge storage receipt does not match its journal. Existing files were retained."
                    .to_string(),
            );
        }
    }

    Ok(())
}

pub fn parse_novel_merge_storage_journal(
    payload: &str,
) -> Result<NovelMergeStorageJournalDto, String> {
    let job: NovelMergeStorageJournalDto = serde_json::from_str(payload).map_err(|_| {
        "Work merge storage recovery journal is invalid. Existing files were retained.".to_string()
    })?;
    validate_novel_merge_storage_journal(&job)?;
    Ok(job)
}

async fn save_novel_merge_storage_journal_in_tx(
    conn: &mut SqliteConnection,
    job: &NovelMergeStorageJournalDto,
) -> Result<(), String> {
    validate_novel_merge_storage_journal(job)?;
    let encoded = serde_json::to_string(job)
        .map_err(|err| format!("db novel merge: encode storage journal: {err}"))?;
    let _ = parse_novel_merge_storage_journal(&encoded)?;
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(format!("{NOVEL_MERGE_STORAGE_PREFIX}{}", job.token))
    .bind(encoded)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: save storage journal: {err}"))?;
    Ok(())
}

pub async fn create_novel_merge_storage_journal_in_tx(
    conn: &mut SqliteConnection,
    input: &CreateNovelMergeStorageJournalInputDto,
) -> Result<NovelMergeStorageJournalDto, String> {
    let source_fp: Option<String> = sqlx::query_scalar(
        "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id = ?1",
    )
    .bind(input.source.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: read source fingerprint: {err}"))?;
    let target_fp: Option<String> = sqlx::query_scalar(
        "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id = ?1",
    )
    .bind(input.target.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: read target fingerprint: {err}"))?;

    let mut next_target_metadata_body = input.target_metadata_body.clone();
    if let Some(ref composition) = input.composition {
        let Some(ref raw_base64) = input.target_metadata_body else {
            return Err("Target work metadata is missing before its folder move.".to_string());
        };
        let decoded = decode_base64(raw_base64)?;
        let raw_json: JsonValue = serde_json::from_slice(&decoded)
            .map_err(|err| format!("work metadata: invalid JSON: {err}"))?;
        let mut parsed = parse_novel_metadata(&raw_json)?;
        let catalog = chapter_composition_catalog(composition);
        parsed.chapters = super::work_metadata::ChaptersMap::default();
        for (num, title) in catalog {
            parsed.chapters.insert(num, title);
        }
        parsed.chapter_composition = Some(composition.clone());
        let encoded_bytes = serde_json::to_vec(&parsed)
            .map_err(|err| format!("db novel merge: encode composed target metadata: {err}"))?;
        next_target_metadata_body = Some(encode_base64(&encoded_bytes));
    }

    let mut cleanup_directories = Vec::new();
    let mut seen_dirs = HashSet::new();
    for path in &input.cleanup_directories {
        let prefix = path.split('/').take(3).collect::<Vec<_>>().join("/");
        if seen_dirs.insert(prefix.clone()) {
            cleanup_directories.push(prefix);
        }
    }

    let token = match input.token {
        Some(ref explicit) if !explicit.is_empty() => explicit.clone(),
        _ => random_uuid_v4()?,
    };

    let job = NovelMergeStorageJournalDto {
        version: 1,
        token,
        phase: "preparing".to_string(),
        source: MergeStorageSnapshotDto {
            id: input.source.id,
            plugin_id: input.source.plugin_id.clone(),
            source_novel_id: input.source.source_novel_id.clone(),
            path: input.source.path.clone(),
            directory: input.source_directory.clone(),
            metadata_body: input.source_metadata_body.clone(),
            next_metadata_body: None,
            fingerprint: source_fp,
        },
        target: MergeStorageSnapshotDto {
            id: input.target.id,
            plugin_id: input.target.plugin_id.clone(),
            source_novel_id: input.target.source_novel_id.clone(),
            path: input.target.path.clone(),
            directory: input.target_directory.clone(),
            metadata_body: input.target_metadata_body.clone(),
            next_metadata_body: next_target_metadata_body,
            fingerprint: target_fp,
        },
        entries: input.entries.clone(),
        cleanup_directories,
        preparation: None,
    };

    save_novel_merge_storage_journal_in_tx(conn, &job).await?;
    Ok(job)
}

pub async fn commit_novel_merge_storage_in_tx(
    conn: &mut SqliteConnection,
    token: &str,
) -> Result<(), String> {
    let result = sqlx::query(
        "UPDATE content_sync_cache \
         SET payload = json_set(payload, '$.phase', 'committed') \
         WHERE cache_key = ?1 AND json_extract(payload, '$.phase') = 'preparing'",
    )
    .bind(format!("{NOVEL_MERGE_STORAGE_PREFIX}{token}"))
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: commit storage journal: {err}"))?;
    if result.rows_affected() != 1 {
        return Err("Work merge storage journal changed before commit.".to_string());
    }
    Ok(())
}

pub async fn list_novel_merge_storage_journals_in_conn(
    conn: &mut SqliteConnection,
    work_ids: Option<&[i64]>,
) -> Result<Vec<String>, String> {
    let prefix = format!("{NOVEL_MERGE_STORAGE_PREFIX}%");
    let rows: Vec<String> = match work_ids {
        Some(ids) => {
            let ids_json = serde_json::to_string(ids)
                .map_err(|err| format!("db novel merge: encode work ids: {err}"))?;
            sqlx::query_scalar(
                "SELECT payload FROM content_sync_cache \
                 WHERE cache_key LIKE ?1 \
                   AND (json_extract(payload, '$.source.id') IN (SELECT value FROM json_each(?2)) \
                     OR json_extract(payload, '$.target.id') IN (SELECT value FROM json_each(?2))) \
                 ORDER BY cache_key",
            )
            .bind(prefix)
            .bind(ids_json)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: list filtered storage journals: {err}"))?
        }
        None => sqlx::query_scalar(
            "SELECT payload FROM content_sync_cache WHERE cache_key LIKE ?1 ORDER BY cache_key",
        )
        .bind(prefix)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel merge: list storage journals: {err}"))?,
    };
    Ok(rows)
}

pub async fn verify_novel_merge_storage_recovery_in_conn(
    conn: &mut SqliteConnection,
    token: &str,
) -> Result<Option<NovelMergeStorageJournalDto>, String> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT payload FROM content_sync_cache WHERE cache_key = ?1")
            .bind(format!("{NOVEL_MERGE_STORAGE_PREFIX}{token}"))
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: read storage journal: {err}"))?;
    let Some(payload) = row else {
        return Ok(None);
    };
    let job = parse_novel_merge_storage_journal(&payload)?;
    if job.token != token {
        return Err("Work merge storage journal token does not match its key.".to_string());
    }

    for work in [&job.source, &job.target] {
        let current = sqlx::query(
            "SELECT id, plugin_id, source_novel_id, path FROM novel WHERE id = ?1",
        )
        .bind(work.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db novel merge: read current work: {err}"))?;

        if job.phase == "committed" && work.id == job.source.id {
            if current.is_some() {
                return Err(
                    "Committed work merge storage recovery still has its source work.".to_string(),
                );
            }
        } else {
            let Some(ref row) = current else {
                return Err(
                    "Work merge storage recovery identity changed. Existing files were retained."
                        .to_string(),
                );
            };
            let cur_plugin: String = row.get("plugin_id");
            let cur_source_id: Option<String> = row.get("source_novel_id");
            let cur_path: String = row.get("path");
            if cur_plugin != work.plugin_id
                || cur_source_id != work.source_novel_id
                || cur_path != work.path
            {
                return Err(
                    "Work merge storage recovery identity changed. Existing files were retained."
                        .to_string(),
                );
            }
        }

        if job.phase == "preparing" {
            let cached_fp: Option<String> = sqlx::query_scalar(
                "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id = ?1",
            )
            .bind(work.id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: read cached fingerprint: {err}"))?;
            if cached_fp != work.fingerprint {
                return Err(
                    "Work merge metadata changed before recovery. Existing files were retained."
                        .to_string(),
                );
            }
        }
    }

    Ok(Some(job))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NovelMergeChapterDecisionDto {
    #[serde(rename_all = "camelCase")]
    Map {
        source_chapter_id: i64,
        target_chapter_path: String,
    },
    #[serde(rename_all = "camelCase")]
    Exclude { source_chapter_id: i64 },
}

impl NovelMergeChapterDecisionDto {
    fn source_chapter_id(&self) -> i64 {
        match self {
            Self::Map {
                source_chapter_id, ..
            }
            | Self::Exclude { source_chapter_id } => *source_chapter_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedNovelMergeDownloadDto {
    pub source_chapter_id: i64,
    pub content_type: String,
    pub content_bytes: i64,
    pub media_bytes: i64,
    pub transferred_from_source: bool,
    #[serde(default)]
    pub media_complete: Option<bool>,
    #[serde(default)]
    pub target_inventory: Option<JsonValue>,
    #[serde(default)]
    pub target_inventory_body_only: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseMigratedTargetWorkDto {
    pub work_id: String,
    pub plugin_id: String,
    pub novel_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMigrationCommitDto {
    pub server_url: String,
    pub expected_operation_id: String,
    pub expected_sequence: i64,
    pub chain: Vec<JsonValue>,
    #[serde(default)]
    pub release_target_work: Option<ReleaseMigratedTargetWorkDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyNovelMergeInputDto {
    pub source_novel_id: i64,
    pub target_novel_id: i64,
    pub decisions: Vec<NovelMergeChapterDecisionDto>,
    pub prepared_downloads: Vec<PreparedNovelMergeDownloadDto>,
    #[serde(default)]
    pub composition: Option<ChapterCompositionV1Dto>,
    #[serde(default)]
    pub prepared_composition_copies: Vec<ChapterCompositionPreparedCopyDto>,
    #[serde(default)]
    pub reading_state_source_path_by_target_path: HashMap<String, String>,
    #[serde(default)]
    pub skip_source_content_chapter_ids: Vec<i64>,
    #[serde(default)]
    pub content_sync_server_url: Option<String>,
    #[serde(default)]
    pub content_sync_source_snapshot: Option<JsonValue>,
    #[serde(default)]
    pub content_sync_target_metadata: Option<JsonValue>,
    #[serde(default)]
    pub incoming_migration_commit: Option<IncomingMigrationCommitDto>,
    #[serde(default)]
    pub storage_transfer_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelMergeDatabaseResultDto {
    pub target_novel_id: i64,
    pub chapter_id_map: HashMap<i64, i64>,
    pub preferred_last_read_chapter_id: Option<i64>,
    pub transferred_downloads: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPendingNovelMergeDownloadDto {
    pub source_chapter_id: i64,
    pub transferred_from_source: bool,
    #[serde(default)]
    pub target_inventory: Option<JsonValue>,
    #[serde(default)]
    pub target_inventory_body_only: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPendingNovelMergeInputDto {
    pub server_url: String,
    pub source_novel_id: i64,
    pub target_novel_id: i64,
    pub chapter_id_map: HashMap<i64, i64>,
    #[serde(default)]
    pub skip_source_content_chapter_ids: Vec<i64>,
    #[serde(default)]
    pub explicit_server_discard_by_source_id: HashMap<i64, JsonValue>,
    #[serde(default)]
    pub source_snapshot: Option<JsonValue>,
    #[serde(default)]
    pub target_metadata: Option<JsonValue>,
    pub prepared_downloads: Vec<RecordPendingNovelMergeDownloadDto>,
}

fn assert_positive_id(value: i64, label: &str) -> Result<(), String> {
    if value <= 0 {
        return Err(format!("{label} must be a positive integer."));
    }
    Ok(())
}

fn valid_non_empty_identity_part(value: Option<&str>) -> bool {
    value.is_some_and(|s| !s.trim().is_empty())
}

pub async fn record_pending_novel_merge_in_tx(
    conn: &mut SqliteConnection,
    input: &RecordPendingNovelMergeInputDto,
) -> Result<String, String> {
    let server_url = normalize_content_server_url_strict(&input.server_url, false)?;

    let works = sqlx::query(
        "SELECT id, plugin_id, source_novel_id, path, name, author, artist, summary, status, \
                genres, rating, is_local, cover \
         FROM novel WHERE id IN (?1, ?2)",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: load merged works: {err}"))?;

    let source_row = works
        .iter()
        .find(|r| r.get::<i64, _>("id") == input.source_novel_id);
    let target_row = works
        .iter()
        .find(|r| r.get::<i64, _>("id") == input.target_novel_id);

    let (Some(source_row), Some(target_row)) = (source_row, target_row) else {
        return Err(
            "Both merged works need stable source identities before server migration.".to_string(),
        );
    };
    if input.source_novel_id == input.target_novel_id {
        return Err(
            "Both merged works need stable source identities before server migration.".to_string(),
        );
    }

    let src_plugin: String = source_row.get("plugin_id");
    let src_novel_id: Option<String> = source_row.get("source_novel_id");
    let src_path: String = source_row.get("path");
    let tgt_plugin: String = target_row.get("plugin_id");
    let tgt_novel_id: Option<String> = target_row.get("source_novel_id");
    let tgt_path: String = target_row.get("path");

    if !valid_non_empty_identity_part(Some(&src_plugin))
        || !valid_non_empty_identity_part(src_novel_id.as_deref())
        || !valid_non_empty_identity_part(Some(&src_path))
        || !valid_non_empty_identity_part(Some(&tgt_plugin))
        || !valid_non_empty_identity_part(tgt_novel_id.as_deref())
        || !valid_non_empty_identity_part(Some(&tgt_path))
    {
        return Err(
            "Both merged works need stable source identities before server migration.".to_string(),
        );
    }
    let src_novel_id = src_novel_id.unwrap();
    let tgt_novel_id = tgt_novel_id.unwrap();

    if let Some(ref expected) = input.target_metadata {
        let Some(exp_obj) = expected.as_object() else {
            return Err("The captured target metadata is invalid. No novels were merged.".to_string());
        };
        let exp_novel = exp_obj.get("novel").cloned().unwrap_or(JsonValue::Null);
        let exp_cover = exp_obj.get("cover").cloned().unwrap_or(JsonValue::Null);
        let exp_cover_sha = exp_obj.get("coverSha256");

        let candidate_doc = json!({
            "schemaVersion": 1,
            "identity": {
                "pluginId": tgt_plugin,
                "novelId": tgt_novel_id,
                "novelPath": tgt_path,
            },
            "novel": exp_novel,
            "cover": exp_cover,
            "chapters": {},
        });
        let parsed = parse_novel_metadata(&candidate_doc).map_err(|_| {
            "The captured target metadata is invalid. No novels were merged.".to_string()
        })?;
        let parsed_json = serde_json::to_value(&parsed).unwrap();

        let tgt_rating = decode_sqlite_opt_f64(target_row, "rating");
        let tgt_rating_json = match tgt_rating {
            Some(v) if v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 => {
                json!(v as i64)
            }
            Some(v) => json!(v),
            None => JsonValue::Null,
        };
        let actual_novel = json!({
            "name": target_row.get::<String, _>("name"),
            "author": target_row.get::<Option<String>, _>("author"),
            "artist": target_row.get::<Option<String>, _>("artist"),
            "summary": target_row.get::<Option<String>, _>("summary"),
            "status": target_row.get::<Option<String>, _>("status"),
            "genres": target_row.get::<Option<String>, _>("genres"),
            "rating": tgt_rating_json,
            "isLocal": target_row.get::<i64, _>("is_local") != 0,
        });

        let same_json = |lhs: &JsonValue, rhs: &JsonValue| -> bool {
            let l = canonical_json_value(lhs);
            let r = canonical_json_value(rhs);
            serde_json::to_string(&l).ok() == serde_json::to_string(&r).ok()
        };

        let valid_sha = if exp_cover.is_null() {
            matches!(exp_cover_sha, None | Some(JsonValue::Null))
        } else {
            exp_cover_sha
                .and_then(JsonValue::as_str)
                .is_some_and(is_valid_hex_sha256)
        };

        if !same_json(&parsed_json["novel"], &exp_novel)
            || !same_json(&parsed_json["cover"], &exp_cover)
            || parsed.novel.is_local
            || !valid_sha
        {
            return Err(
                "The captured target metadata is invalid. No novels were merged.".to_string(),
            );
        }

        let target_has_cover = target_row
            .get::<Option<String>, _>("cover")
            .is_some_and(|c| !c.trim().is_empty());
        let expected_has_cover = !exp_cover.is_null();
        if !same_json(&actual_novel, &exp_novel) || target_has_cover != expected_has_cover {
            return Err("The target metadata changed before the merge could commit.".to_string());
        }
    }

    if let Some(ref snap) = input.source_snapshot {
        let valid_snap = snap
            .as_object()
            .and_then(|obj| {
                let work = obj.get("work")?.as_object()?;
                let ident = work.get("identity")?.as_object()?;
                let rev = work.get("revision")?.as_str()?;
                let chapters = obj.get("chapters")?.as_array()?;
                Some(
                    ident.get("pluginId").and_then(JsonValue::as_str) == Some(src_plugin.as_str())
                        && ident.get("novelId").and_then(JsonValue::as_str)
                            == Some(src_novel_id.as_str())
                        && ident.get("novelPath").and_then(JsonValue::as_str)
                            == Some(src_path.as_str())
                        && !rev.is_empty()
                        && chapters.len() <= 1_000_000,
                )
            })
            .unwrap_or(false);
        if !valid_snap {
            return Err(
                "The source server snapshot no longer matches the local work.".to_string(),
            );
        }
    }

    struct ChapterBrief {
        id: i64,
        novel_id: i64,
        path: String,
        chapter_number: Option<String>,
        name: String,
        position: i64,
        page: String,
    }

    let chapter_rows = sqlx::query(
        "SELECT id, novel_id, path, chapter_number, name, position, page \
         FROM chapter WHERE novel_id IN (?1, ?2) ORDER BY id",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: load chapters for pending migration: {err}"))?;

    let all_chapters: Vec<ChapterBrief> = chapter_rows
        .into_iter()
        .map(|r| ChapterBrief {
            id: r.get("id"),
            novel_id: r.get("novel_id"),
            path: r.get("path"),
            chapter_number: r.get("chapter_number"),
            name: r.get("name"),
            position: r.get("position"),
            page: r.get("page"),
        })
        .collect();

    let target_chapters: HashMap<i64, &ChapterBrief> = all_chapters
        .iter()
        .filter(|c| c.novel_id == input.target_novel_id)
        .map(|c| (c.id, c))
        .collect();
    let prepared_by_source: HashMap<i64, &RecordPendingNovelMergeDownloadDto> = input
        .prepared_downloads
        .iter()
        .map(|d| (d.source_chapter_id, d))
        .collect();
    let skipped_source_content: HashSet<i64> =
        input.skip_source_content_chapter_ids.iter().copied().collect();
    let valid_source_ids: HashSet<i64> = all_chapters
        .iter()
        .filter(|c| c.novel_id == input.source_novel_id)
        .map(|c| c.id)
        .collect();

    if skipped_source_content
        .iter()
        .any(|id| !valid_source_ids.contains(id))
        || input
            .explicit_server_discard_by_source_id
            .keys()
            .any(|id| !valid_source_ids.contains(id))
    {
        return Err("A skipped or discarded source chapter no longer exists.".to_string());
    }

    let mut chapters_json = Vec::new();
    for row in all_chapters
        .iter()
        .filter(|c| c.novel_id == input.source_novel_id)
    {
        let destination_id = input.chapter_id_map.get(&row.id).copied();
        let destination = match destination_id {
            Some(dest_id) => Some(
                *target_chapters
                    .get(&dest_id)
                    .ok_or_else(|| "A server migration target chapter is missing.".to_string())?,
            ),
            None => None,
        };
        let artifact = prepared_by_source.get(&row.id).copied();
        if artifact.is_some() && destination.is_none() {
            return Err("A server migration download is not mapped.".to_string());
        }
        if skipped_source_content.contains(&row.id)
            && (destination.is_none() || artifact.is_some_and(|a| a.transferred_from_source))
        {
            return Err(
                "Skipped local source content must keep a target mapping without copying the source body."
                    .to_string(),
            );
        }

        if let Some(explicit_discard) = input.explicit_server_discard_by_source_id.get(&row.id) {
            let approved = explicit_discard
                .get("approvedByUser")
                .and_then(JsonValue::as_bool)
                == Some(true);
            let inv_valid = explicit_discard
                .get("expectedSourceInventory")
                .is_some_and(|inv| {
                    is_valid_chapter_payload_inventory(inv)
                        && inv.get("body").is_some_and(|b| !b.is_null())
                });
            if !approved || !inv_valid || artifact.is_some_and(|a| a.transferred_from_source) {
                return Err(
                    "Explicit server content discard requires a verified source inventory without copying the source body."
                        .to_string(),
                );
            }
            let mut item = serde_json::Map::new();
            item.insert("sourceChapterPath".to_string(), json!(row.path));
            item.insert("sourceChapterNumber".to_string(), json!(row.chapter_number));
            item.insert(
                "targetChapterPath".to_string(),
                json!(destination.map(|d| d.path.as_str())),
            );
            item.insert(
                "targetChapterNumber".to_string(),
                json!(destination.and_then(|d| d.chapter_number.as_deref())),
            );
            item.insert("decision".to_string(), JsonValue::Null);
            if let Some(dest) = destination {
                item.insert("discardSourceContent".to_string(), json!(true));
                item.insert("explicitSourceDiscard".to_string(), explicit_discard.clone());
                item.insert(
                    "targetChapter".to_string(),
                    json!({
                        "name": dest.name,
                        "position": dest.position,
                        "page": dest.page,
                    }),
                );
            } else {
                item.insert("explicitSourceDiscard".to_string(), explicit_discard.clone());
            }
            chapters_json.push(JsonValue::Object(item));
            continue;
        }

        let decision = match artifact {
            Some(art) if art.transferred_from_source => Some("copy-source"),
            Some(_) => Some("keep-target"),
            None if destination.is_some() => Some("copy-source"),
            None => None,
        };

        if decision == Some("keep-target") {
            let art = artifact.unwrap();
            let valid_keep = art.target_inventory.as_ref().is_some_and(|inv| {
                if !is_valid_chapter_payload_inventory(inv)
                    || inv.get("body").is_none_or(JsonValue::is_null)
                {
                    return false;
                }
                let stored_keys: HashSet<&str> = inv["storedAssets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|a| a.get("key").and_then(JsonValue::as_str))
                    .collect();
                match inv.get("expectedAssetKeys") {
                    Some(JsonValue::Null) => {
                        art.target_inventory_body_only == Some(true) && stored_keys.is_empty()
                    }
                    Some(JsonValue::Array(expected_keys)) => expected_keys
                        .iter()
                        .filter_map(JsonValue::as_str)
                        .all(|k| stored_keys.contains(k)),
                    _ => false,
                }
            });
            if !valid_keep {
                return Err(
                    "The retained B download needs a complete verified inventory before merging."
                        .to_string(),
                );
            }
        }

        let mut item = serde_json::Map::new();
        item.insert("sourceChapterPath".to_string(), json!(row.path));
        item.insert("sourceChapterNumber".to_string(), json!(row.chapter_number));
        item.insert(
            "targetChapterPath".to_string(),
            json!(destination.map(|d| d.path.as_str())),
        );
        item.insert(
            "targetChapterNumber".to_string(),
            json!(destination.and_then(|d| d.chapter_number.as_deref())),
        );
        item.insert("decision".to_string(), json!(decision));
        if artifact.is_some_and(|a| a.transferred_from_source) {
            item.insert("requiresTargetUpload".to_string(), json!(true));
        }
        if let Some(dest) = destination {
            item.insert(
                "targetChapter".to_string(),
                json!({
                    "name": dest.name,
                    "position": dest.position,
                    "page": dest.page,
                }),
            );
        }
        if decision == Some("keep-target") {
            if let Some(ref inv) = artifact.unwrap().target_inventory {
                item.insert("expectedTargetInventory".to_string(), inv.clone());
            }
        }
        chapters_json.push(JsonValue::Object(item));
    }

    let operation_id = random_uuid_v4()?;
    let now = now_unix_millis();
    let mut job_obj = serde_json::Map::new();
    job_obj.insert("version".to_string(), json!(1));
    job_obj.insert("operationId".to_string(), json!(operation_id));
    job_obj.insert("serverUrl".to_string(), json!(server_url));
    job_obj.insert(
        "source".to_string(),
        json!({
            "pluginId": src_plugin,
            "novelId": src_novel_id,
            "novelPath": src_path,
        }),
    );
    job_obj.insert(
        "target".to_string(),
        json!({
            "pluginId": tgt_plugin,
            "novelId": tgt_novel_id,
            "novelPath": tgt_path,
        }),
    );
    job_obj.insert("targetLocalNovelId".to_string(), json!(input.target_novel_id));
    job_obj.insert("chapters".to_string(), JsonValue::Array(chapters_json));
    if let Some(ref snap) = input.source_snapshot {
        job_obj.insert("sourceSnapshot".to_string(), snap.clone());
    }
    if let Some(ref meta) = input.target_metadata {
        job_obj.insert("targetMetadata".to_string(), meta.clone());
    }
    job_obj.insert(
        "status".to_string(),
        json!(if input.source_snapshot.is_some() {
            "pending"
        } else {
            "blocked"
        }),
    );
    job_obj.insert("attempts".to_string(), json!(0));
    job_obj.insert("createdAt".to_string(), json!(now));
    job_obj.insert("updatedAt".to_string(), json!(now));
    if input.source_snapshot.is_none() {
        job_obj.insert(
            "error".to_string(),
            json!(
                "The source server snapshot was unavailable before the local merge. Review the original server work before completing its migration."
            ),
        );
    }

    let payload = serde_json::to_string(&JsonValue::Object(job_obj))
        .map_err(|err| format!("db novel merge: encode pending novel migration: {err}"))?;
    sqlx::query("INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)")
        .bind(format!("{NOVEL_MIGRATION_CACHE_PREFIX}{operation_id}"))
        .bind(payload)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel merge: insert pending novel migration: {err}"))?;

    Ok(operation_id)
}

fn immutable_lineage_proof(lineage: &JsonValue) -> Result<String, String> {
    let Some(obj) = lineage.as_object() else {
        return Err(
            "Incoming work migration is invalid: expected an object. Synchronization was held."
                .to_string(),
        );
    };
    let mut proof = obj.clone();
    proof.remove("sequence");
    proof.remove("active");
    proof.remove("legacyOperationId");
    serde_json::to_string(&canonical_json_value(&JsonValue::Object(proof)))
        .map_err(|err| format!("db novel merge: encode lineage proof: {err}"))
}

pub async fn release_migrated_target_metadata_in_tx(
    conn: &mut SqliteConnection,
    normalized_server_url: &str,
    target: &ReleaseMigratedTargetWorkDto,
) -> Result<(), String> {
    let key = format!("{WORK_SYNC_CACHE_PREFIX}{normalized_server_url}");
    let row: Option<String> =
        sqlx::query_scalar("SELECT payload FROM content_sync_cache WHERE cache_key = ?1")
            .bind(&key)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: read work sync cache: {err}"))?;
    let Some(payload) = row else {
        return Ok(());
    };
    let mut cache: JsonValue = serde_json::from_str(&payload)
        .map_err(|err| format!("db novel merge: parse work sync cache: {err}"))?;
    if let Some(deleted) = cache.get_mut("deleted").and_then(JsonValue::as_object_mut) {
        deleted.remove(&target.work_id);
    }
    if let Some(fps) = cache
        .get_mut("fingerprints")
        .and_then(JsonValue::as_object_mut)
    {
        fps.remove(&target.work_id);
    }
    let identity_key = serde_json::to_string(&(&target.plugin_id, &target.novel_path))
        .map_err(|err| format!("db novel merge: encode target identity key: {err}"))?;
    if let Some(vers) = cache
        .get_mut("fileVersions")
        .and_then(JsonValue::as_object_mut)
    {
        vers.remove(&identity_key);
    }
    let encoded = serde_json::to_string(&cache)
        .map_err(|err| format!("db novel merge: encode work sync cache: {err}"))?;
    sqlx::query("UPDATE content_sync_cache SET payload = ?1 WHERE cache_key = ?2")
        .bind(encoded)
        .bind(&key)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel merge: update work sync cache: {err}"))?;
    Ok(())
}

pub async fn commit_incoming_migration_in_tx(
    conn: &mut SqliteConnection,
    commit: &IncomingMigrationCommitDto,
) -> Result<(), String> {
    let server_url = normalize_content_server_url_strict(&commit.server_url, true)?;
    let prefix = {
        let arr = serde_json::to_string(&[&server_url])
            .map_err(|err| format!("db novel merge: encode server prefix: {err}"))?;
        format!("{INCOMING_MIGRATION_CACHE_PREFIX}{},", &arr[..arr.len() - 1])
    };
    let rows = sqlx::query(
        "SELECT cache_key, payload FROM content_sync_cache \
         WHERE substr(cache_key, 1, length(?1)) = ?1 ORDER BY cache_key",
    )
    .bind(&prefix)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: load incoming migrations: {err}"))?;

    let mut saved_chain: HashMap<String, (String, JsonValue)> = HashMap::with_capacity(rows.len());
    for row in rows {
        let cache_key: String = row.get("cache_key");
        let payload: String = row.get("payload");
        let parsed: JsonValue = serde_json::from_str(&payload).map_err(|_| {
            "Incoming work migration is invalid: stored receipt. Synchronization was held."
                .to_string()
        })?;
        let op_id = parsed
            .get("operationId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                "Incoming work migration is invalid: operation ID. Synchronization was held."
                    .to_string()
            })?
            .to_string();
        let expected_key = format!(
            "{INCOMING_MIGRATION_CACHE_PREFIX}{}",
            serde_json::to_string(&(&server_url, &op_id)).unwrap()
        );
        if cache_key != expected_key {
            return Err(
                "Incoming work migration is invalid: receipt cache identity. Synchronization was held."
                    .to_string(),
            );
        }
        saved_chain.insert(op_id, (cache_key, parsed));
    }

    for edge in &commit.chain {
        let edge_op_id = edge
            .get("operationId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                "The received work migration chain changed before its local commit.".to_string()
            })?;
        let edge_seq = edge.get("sequence").and_then(JsonValue::as_i64);
        let edge_active = edge.get("active").and_then(JsonValue::as_bool);
        let Some((_, saved_record)) = saved_chain.get(edge_op_id) else {
            return Err(
                "The received work migration chain changed before its local commit.".to_string(),
            );
        };
        let saved_seq = saved_record.get("sequence").and_then(JsonValue::as_i64);
        let saved_lineage = saved_record.get("lineage").unwrap_or(&JsonValue::Null);
        let saved_active = saved_lineage.get("active").and_then(JsonValue::as_bool);
        if saved_seq != edge_seq || saved_active != Some(true) || edge_active != Some(true) {
            return Err(
                "The received work migration chain changed before its local commit.".to_string(),
            );
        }
        if immutable_lineage_proof(saved_lineage)? != immutable_lineage_proof(edge)? {
            return Err(
                "Incoming work migration is invalid: immutable lineage changed. Synchronization was held."
                    .to_string(),
            );
        }
        let saved_legacy = saved_lineage
            .get("legacyOperationId")
            .and_then(JsonValue::as_str);
        let edge_legacy = edge.get("legacyOperationId").and_then(JsonValue::as_str);
        if saved_legacy.is_some() && saved_legacy != edge_legacy {
            return Err(
                "Incoming work migration is invalid: immutable lineage changed. Synchronization was held."
                    .to_string(),
            );
        }
    }

    let Some((expected_cache_key, current_record)) = saved_chain.get(&commit.expected_operation_id)
    else {
        return Err("The received work migration changed before its local commit.".to_string());
    };
    let cur_seq = current_record.get("sequence").and_then(JsonValue::as_i64);
    let cur_status = current_record.get("status").and_then(JsonValue::as_str);
    let cur_active = current_record
        .get("lineage")
        .and_then(|l| l.get("active"))
        .and_then(JsonValue::as_bool);
    if cur_seq != Some(commit.expected_sequence)
        || cur_status != Some("pending")
        || cur_active != Some(true)
    {
        return Err("The received work migration changed before its local commit.".to_string());
    }

    if let Some(ref target_work) = commit.release_target_work {
        release_migrated_target_metadata_in_tx(conn, &server_url, target_work).await?;
    }

    let mut completed = current_record.clone();
    if let Some(obj) = completed.as_object_mut() {
        obj.insert("status".to_string(), json!("completed"));
        obj.remove("error");
    }
    let encoded = serde_json::to_string(&completed)
        .map_err(|err| format!("db novel merge: encode completed incoming migration: {err}"))?;
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(expected_cache_key)
    .bind(encoded)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: save completed incoming migration: {err}"))?;

    Ok(())
}

pub async fn apply_novel_merge_in_tx(
    metadata_root: &MetadataRoot,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &ApplyNovelMergeInputDto,
) -> Result<NovelMergeDatabaseResultDto, String> {
    if input.incoming_migration_commit.is_some() && input.content_sync_server_url.is_some() {
        return Err("An incoming migration cannot create an outgoing migration.".to_string());
    }
    assert_positive_id(input.source_novel_id, "Source novel id")?;
    assert_positive_id(input.target_novel_id, "Target novel id")?;
    if input.source_novel_id == input.target_novel_id {
        return Err("Source and target novels must be different.".to_string());
    }

    struct MergeNovelRow {
        id: i64,
        in_library: bool,
        is_local: bool,
        library_added_at: Option<i64>,
        last_read_at: Option<i64>,
    }

    let novel_rows = sqlx::query(
        "SELECT id, in_library, is_local, library_added_at, last_read_at \
         FROM novel WHERE id IN (?1, ?2)",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: load novels: {err}"))?;

    let mut source_novel = None;
    let mut target_novel = None;
    for r in novel_rows {
        let row = MergeNovelRow {
            id: r.get("id"),
            in_library: r.get::<i64, _>("in_library") != 0,
            is_local: r.get::<i64, _>("is_local") != 0,
            library_added_at: r.get("library_added_at"),
            last_read_at: r.get("last_read_at"),
        };
        if row.id == input.source_novel_id {
            source_novel = Some(row);
        } else if row.id == input.target_novel_id {
            target_novel = Some(row);
        }
    }
    let (Some(source_novel), Some(target_novel)) = (source_novel, target_novel) else {
        return Err("Source or target novel no longer exists.".to_string());
    };
    if source_novel.is_local || target_novel.is_local {
        return Err("Novel merge supports remote novels only.".to_string());
    }

    let resolved_root = metadata_root.resolve()?;
    if let Some(ref composition) = input.composition {
        #[derive(Clone, Copy)]
        struct PreviousState {
            bookmark: i64,
            unread: i64,
            progress: f64,
            read_at: Option<i64>,
            excluded_at: Option<i64>,
        }
        let prev_rows = sqlx::query(
            "SELECT path, bookmark, unread, progress, read_at, \
                    (SELECT created_at FROM chapter_download_goal_exclusion WHERE chapter_id = chapter.id) AS excluded_at \
             FROM chapter WHERE novel_id = ?1",
        )
        .bind(input.target_novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel merge: load previous target chapters: {err}"))?;

        let mut prev_by_path: HashMap<String, PreviousState> =
            HashMap::with_capacity(prev_rows.len());
        for r in prev_rows {
            prev_by_path.insert(
                r.get("path"),
                PreviousState {
                    bookmark: r.get("bookmark"),
                    unread: r.get("unread"),
                    progress: decode_sqlite_f64(&r, "progress"),
                    read_at: r.get("read_at"),
                    excluded_at: r.get("excluded_at"),
                },
            );
        }

        materialize_chapter_composition_in_tx(
            resolved_root.as_deref(),
            conn,
            input.target_novel_id,
            composition,
            &input.prepared_composition_copies,
        )
        .await?;
        set_chapter_composition_in_tx(conn, input.target_novel_id, Some(composition)).await?;

        for (target_path, previous_path) in &input.reading_state_source_path_by_target_path {
            let Some(state) = prev_by_path.get(previous_path) else {
                return Err(
                    "A destination chapter changed before its reading state could be retained."
                        .to_string(),
                );
            };
            sqlx::query(
                "UPDATE chapter \
                 SET bookmark = ?3, unread = ?4, progress = ?5, read_at = ?6 \
                 WHERE novel_id = ?1 AND path = ?2",
            )
            .bind(input.target_novel_id)
            .bind(target_path)
            .bind(state.bookmark)
            .bind(state.unread)
            .bind(state.progress)
            .bind(state.read_at)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: restore retained reading state: {err}"))?;

            if let Some(excluded_at) = state.excluded_at {
                sqlx::query(
                    "INSERT OR IGNORE INTO chapter_download_goal_exclusion(chapter_id, created_at) \
                     SELECT id, ?3 FROM chapter WHERE novel_id = ?1 AND path = ?2",
                )
                .bind(input.target_novel_id)
                .bind(target_path)
                .bind(excluded_at)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db novel merge: restore retained exclusion: {err}"))?;
            }
        }
    }

    #[derive(Clone)]
    struct MergeChapterRow {
        id: i64,
        novel_id: i64,
        path: String,
        bookmark: bool,
        unread: bool,
        progress: f64,
        is_downloaded: bool,
        content_bytes: i64,
        read_at: Option<i64>,
    }

    let ch_rows = sqlx::query(
        "SELECT id, novel_id, path, bookmark, unread, progress, is_downloaded, \
                content_bytes, read_at \
         FROM chapter WHERE novel_id IN (?1, ?2)",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: load merge chapters: {err}"))?;

    let mut source_chapters = Vec::new();
    let mut target_chapters = Vec::new();
    for r in ch_rows {
        let ch = MergeChapterRow {
            id: r.get("id"),
            novel_id: r.get("novel_id"),
            path: r.get("path"),
            bookmark: r.get::<i64, _>("bookmark") != 0,
            unread: r.get::<i64, _>("unread") != 0,
            progress: decode_sqlite_f64(&r, "progress"),
            is_downloaded: r.get::<i64, _>("is_downloaded") != 0,
            content_bytes: r.get("content_bytes"),
            read_at: r.get("read_at"),
        };
        if ch.novel_id == input.source_novel_id {
            source_chapters.push(ch);
        } else {
            target_chapters.push(ch);
        }
    }

    let source_by_id: HashMap<i64, &MergeChapterRow> =
        source_chapters.iter().map(|c| (c.id, c)).collect();
    let target_by_path: HashMap<&str, &MergeChapterRow> = target_chapters
        .iter()
        .map(|c| (c.path.as_str(), c))
        .collect();

    let mut decision_by_source_id: HashMap<i64, &NovelMergeChapterDecisionDto> = HashMap::new();
    for decision in &input.decisions {
        let src_id = decision.source_chapter_id();
        assert_positive_id(src_id, "Source chapter id")?;
        if decision_by_source_id.contains_key(&src_id) {
            return Err("Each source chapter must have exactly one decision.".to_string());
        }
        if !source_by_id.contains_key(&src_id) {
            return Err(
                "A decision references a source chapter that no longer exists.".to_string(),
            );
        }
        if let NovelMergeChapterDecisionDto::Map {
            ref target_chapter_path,
            ..
        } = decision
        {
            if !target_by_path.contains_key(target_chapter_path.as_str()) {
                return Err("Target chapter no longer exists.".to_string());
            }
        }
        decision_by_source_id.insert(src_id, decision);
    }
    if decision_by_source_id.len() != source_chapters.len()
        || source_chapters
            .iter()
            .any(|c| !decision_by_source_id.contains_key(&c.id))
    {
        return Err("Every source chapter must have one decision before merging.".to_string());
    }

    let mut mapped_sources_by_target_id: HashMap<i64, Vec<&MergeChapterRow>> = HashMap::new();
    let mut chapter_id_map: HashMap<i64, i64> = HashMap::new();
    for source in &source_chapters {
        let decision = decision_by_source_id[&source.id];
        if let NovelMergeChapterDecisionDto::Map {
            ref target_chapter_path,
            ..
        } = decision
        {
            let target = target_by_path[target_chapter_path.as_str()];
            mapped_sources_by_target_id
                .entry(target.id)
                .or_default()
                .push(source);
            chapter_id_map.insert(source.id, target.id);
        }
    }

    let mut prepared_by_source_id: HashMap<i64, &PreparedNovelMergeDownloadDto> = HashMap::new();
    let mut prepared_source_id_by_target_id: HashMap<i64, i64> = HashMap::new();
    for prepared in &input.prepared_downloads {
        assert_positive_id(prepared.source_chapter_id, "Prepared source chapter id")?;
        if prepared_by_source_id.contains_key(&prepared.source_chapter_id) {
            return Err("Prepared source chapter ids must be unique.".to_string());
        }
        if !is_known_chapter_content_type(&prepared.content_type) {
            return Err("Prepared download content type is unsupported.".to_string());
        }
        if !(0..=MAX_SAFE_INT_I64).contains(&prepared.content_bytes)
            || !(0..=MAX_SAFE_INT_I64).contains(&prepared.media_bytes)
        {
            return Err(
                "Prepared download byte counts must be non-negative safe integers.".to_string(),
            );
        }
        let source = source_by_id.get(&prepared.source_chapter_id).copied();
        let decision = decision_by_source_id
            .get(&prepared.source_chapter_id)
            .copied();
        let (Some(source), Some(NovelMergeChapterDecisionDto::Map { target_chapter_path, .. })) =
            (source, decision)
        else {
            return Err("Prepared content must belong to a mapped source chapter.".to_string());
        };
        let has_incoming_verified_body = input.incoming_migration_commit.is_some()
            && input.storage_transfer_token.is_some()
            && prepared
                .target_inventory
                .as_ref()
                .and_then(|inv| inv.get("body"))
                .is_some_and(|b| !b.is_null());
        if prepared.transferred_from_source
            && !source.is_downloaded
            && source.content_bytes <= 0
            && !has_incoming_verified_body
        {
            return Err(
                "Transferred content must belong to a downloaded source chapter.".to_string(),
            );
        }
        let target = target_by_path[target_chapter_path.as_str()];
        if prepared_source_id_by_target_id.contains_key(&target.id) {
            return Err(
                "Only one source download can be transferred to a target chapter.".to_string(),
            );
        }
        prepared_by_source_id.insert(prepared.source_chapter_id, prepared);
        prepared_source_id_by_target_id.insert(target.id, prepared.source_chapter_id);
    }

    sqlx::query(
        "DELETE FROM chapter_download_queue \
         WHERE chapter_id IN (SELECT id FROM chapter WHERE novel_id IN (?1, ?2))",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: clear download queue: {err}"))?;

    sqlx::query(
        "INSERT OR IGNORE INTO novel_category (novel_id, category_id) \
         SELECT ?2, category_id FROM novel_category WHERE novel_id = ?1",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: copy categories: {err}"))?;

    sqlx::query(
        "INSERT OR IGNORE INTO novel_download_goal (novel_id, kind, count, updated_at) \
         SELECT ?2, kind, count, updated_at FROM novel_download_goal WHERE novel_id = ?1",
    )
    .bind(input.source_novel_id)
    .bind(input.target_novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: copy download goal: {err}"))?;

    let mut chapter_mappings: Vec<(i64, i64)> =
        chapter_id_map.iter().map(|(&s, &t)| (s, t)).collect();
    chapter_mappings.sort_unstable_by_key(|(s, _)| *s);
    for chunk in chapter_mappings.chunks(450) {
        let values: Vec<String> = (0..chunk.len())
            .map(|idx| format!("(?{}, ?{})", idx * 2 + 1, idx * 2 + 2))
            .collect();
        let sql = format!(
            "WITH chapter_mappings (source_id, target_id) AS (VALUES {}) \
             INSERT OR IGNORE INTO chapter_download_goal_exclusion (chapter_id, created_at) \
             SELECT mapping.target_id, MIN(exclusion.created_at) \
             FROM chapter_mappings AS mapping \
             JOIN chapter_download_goal_exclusion AS exclusion ON exclusion.chapter_id = mapping.source_id \
             GROUP BY mapping.target_id",
            values.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for &(src_id, tgt_id) in chunk {
            query = query.bind(src_id).bind(tgt_id);
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: copy download goal exclusions: {err}"))?;
    }

    struct ChapterMergeUpdate {
        id: i64,
        bookmark: i64,
        unread: i64,
        progress: f64,
        read_at: Option<i64>,
        apply_download_metadata: i64,
        content_type: Option<String>,
        content_bytes: i64,
        media_bytes: i64,
        media_complete: i64,
    }

    let mut transferred_downloads: i64 = 0;
    let mut merged_read_at_in_order: Vec<(i64, Option<i64>)> =
        Vec::with_capacity(target_chapters.len());
    let mut chapter_updates = Vec::new();

    for target in &target_chapters {
        let Some(mapped_sources) = mapped_sources_by_target_id.get(&target.id) else {
            merged_read_at_in_order.push((target.id, target.read_at));
            continue;
        };
        if mapped_sources.is_empty() {
            merged_read_at_in_order.push((target.id, target.read_at));
            continue;
        }
        let bookmark = target.bookmark || mapped_sources.iter().any(|s| s.bookmark);
        let unread = target.unread && mapped_sources.iter().all(|s| s.unread);
        let progress = mapped_sources
            .iter()
            .fold(target.progress, |acc, s| acc.max(s.progress));
        let read_at = std::iter::once(target.read_at)
            .chain(mapped_sources.iter().map(|s| s.read_at))
            .flatten()
            .max();

        let prepared = prepared_source_id_by_target_id
            .get(&target.id)
            .and_then(|src_id| prepared_by_source_id.get(src_id))
            .copied();
        if prepared.is_some_and(|p| p.transferred_from_source) {
            transferred_downloads += 1;
        }
        chapter_updates.push(ChapterMergeUpdate {
            id: target.id,
            bookmark: i64::from(bookmark),
            unread: i64::from(unread),
            progress,
            read_at,
            apply_download_metadata: i64::from(prepared.is_some()),
            content_type: prepared.map(|p| p.content_type.clone()),
            content_bytes: prepared.map_or(0, |p| p.content_bytes),
            media_bytes: prepared.map_or(0, |p| p.media_bytes),
            media_complete: i64::from(prepared.and_then(|p| p.media_complete) != Some(false)),
        });
        merged_read_at_in_order.push((target.id, read_at));
    }

    for chunk in chapter_updates.chunks(NOVEL_MERGE_UPDATE_CHUNK_SIZE) {
        let values: Vec<String> = (0..chunk.len())
            .map(|idx| {
                let b = idx * NOVEL_MERGE_UPDATE_PARAM_COUNT;
                format!(
                    "(?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{})",
                    b + 1,
                    b + 2,
                    b + 3,
                    b + 4,
                    b + 5,
                    b + 6,
                    b + 7,
                    b + 8,
                    b + 9,
                    b + 10
                )
            })
            .collect();
        let sql = format!(
            "WITH merge_updates ( \
               target_id, bookmark, unread, progress, read_at, apply_download_metadata, \
               stored_content_type, content_bytes, media_bytes, media_complete \
             ) AS (VALUES {}) \
             UPDATE chapter \
             SET \
               bookmark = (SELECT bookmark FROM merge_updates WHERE target_id = chapter.id), \
               unread = (SELECT unread FROM merge_updates WHERE target_id = chapter.id), \
               progress = (SELECT progress FROM merge_updates WHERE target_id = chapter.id), \
               read_at = (SELECT read_at FROM merge_updates WHERE target_id = chapter.id), \
               stored_content_type = CASE \
                 WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1 \
                 THEN (SELECT stored_content_type FROM merge_updates WHERE target_id = chapter.id) \
                 ELSE stored_content_type \
               END, \
               content_bytes = CASE \
                 WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1 \
                 THEN (SELECT content_bytes FROM merge_updates WHERE target_id = chapter.id) \
                 ELSE content_bytes \
               END, \
               media_bytes = CASE \
                 WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1 \
                 THEN (SELECT media_bytes FROM merge_updates WHERE target_id = chapter.id) \
                 ELSE media_bytes \
               END, \
               media_repair_needed = CASE \
                 WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1 \
                 THEN 1 - (SELECT media_complete FROM merge_updates WHERE target_id = chapter.id) \
                 ELSE media_repair_needed \
               END, \
               media_bytes_checked_at = CASE \
                 WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1 \
                 THEN unixepoch() \
                 ELSE media_bytes_checked_at \
               END, \
               is_downloaded = CASE \
                 WHEN (SELECT apply_download_metadata FROM merge_updates WHERE target_id = chapter.id) = 1 \
                 THEN (SELECT media_complete FROM merge_updates WHERE target_id = chapter.id) \
                 ELSE is_downloaded \
               END, \
               updated_at = unixepoch() \
             WHERE id IN (SELECT target_id FROM merge_updates)",
            values.join(", ")
        );
        let mut query = sqlx::query(&sql);
        for u in chunk {
            query = query
                .bind(u.id)
                .bind(u.bookmark)
                .bind(u.unread)
                .bind(u.progress)
                .bind(u.read_at)
                .bind(u.apply_download_metadata)
                .bind(&u.content_type)
                .bind(u.content_bytes)
                .bind(u.media_bytes)
                .bind(u.media_complete);
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel merge: update merged chapters: {err}"))?;
    }

    let merged_last_read_at = std::iter::once(target_novel.last_read_at)
        .chain(merged_read_at_in_order.iter().map(|(_, ts)| *ts))
        .flatten()
        .max();

    sqlx::query(
        "UPDATE novel \
         SET \
           in_library = MAX(in_library, ?2), \
           library_added_at = CASE \
             WHEN library_added_at IS NULL THEN ?3 \
             WHEN ?3 IS NULL THEN library_added_at \
             ELSE MIN(library_added_at, ?3) \
           END, \
           last_read_at = ?4, \
           updated_at = unixepoch() \
         WHERE id = ?1",
    )
    .bind(input.target_novel_id)
    .bind(i64::from(source_novel.in_library))
    .bind(source_novel.library_added_at)
    .bind(merged_last_read_at)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: update target novel: {err}"))?;

    let mut read_candidates: Vec<(i64, i64)> = merged_read_at_in_order
        .into_iter()
        .filter_map(|(id, ts)| ts.map(|t| (id, t)))
        .collect();
    read_candidates.sort_by(|lhs, rhs| rhs.1.cmp(&lhs.1));
    let mut preferred_last_read_chapter_id = read_candidates.first().map(|(id, _)| *id);

    if let Some(ref server_url) = input.content_sync_server_url {
        let pending_downloads: Vec<RecordPendingNovelMergeDownloadDto> = input
            .prepared_downloads
            .iter()
            .map(|p| RecordPendingNovelMergeDownloadDto {
                source_chapter_id: p.source_chapter_id,
                transferred_from_source: p.transferred_from_source,
                target_inventory: p.target_inventory.clone(),
                target_inventory_body_only: p.target_inventory_body_only,
            })
            .collect();
        record_pending_novel_merge_in_tx(
            conn,
            &RecordPendingNovelMergeInputDto {
                server_url: server_url.clone(),
                source_novel_id: input.source_novel_id,
                target_novel_id: input.target_novel_id,
                chapter_id_map: chapter_id_map.clone(),
                skip_source_content_chapter_ids: input.skip_source_content_chapter_ids.clone(),
                explicit_server_discard_by_source_id: HashMap::new(),
                source_snapshot: input.content_sync_source_snapshot.clone(),
                target_metadata: input.content_sync_target_metadata.clone(),
                prepared_downloads: pending_downloads,
            },
        )
        .await?;
    }

    let remapped_state = remap_pending_user_state_in_tx(
        resolved_root.as_deref(),
        conn,
        ctx,
        input.source_novel_id,
        input.target_novel_id,
        &chapter_id_map,
        &input.reading_state_source_path_by_target_path,
        &HashSet::new(),
    )
    .await?;
    let explicit_resume = remapped_state.resumes.last().cloned();
    if let Some(ref resume) = explicit_resume {
        preferred_last_read_chapter_id = resume.chapter_id;
    }

    if input.incoming_migration_commit.is_none() {
        if let Some(settled_resume) = transfer_settled_novel_merge_resume_in_tx(
            conn,
            ctx,
            input.source_novel_id,
            input.target_novel_id,
            &chapter_id_map,
            explicit_resume.is_some(),
        )
        .await?
        {
            preferred_last_read_chapter_id = settled_resume.chapter_id;
        }
        record_library_in_tx(conn, ctx, Some(&[input.source_novel_id]), true).await?;
        record_library_in_tx(conn, ctx, Some(&[input.target_novel_id]), false).await?;
        record_public_novel_reading_in_tx(conn, ctx, &[input.target_novel_id], false).await?;
        if has_user_state_schema_in_tx(conn).await? {
            let target_ids: Vec<i64> =
                sqlx::query_scalar("SELECT id FROM chapter WHERE novel_id = ?1")
                    .bind(input.target_novel_id)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db novel merge: list target chapter ids: {err}"))?;
            record_chapters_in_tx(conn, ctx, &target_ids, "bookmark").await?;
            let category_ids: Vec<i64> =
                sqlx::query_scalar("SELECT category_id FROM novel_category WHERE novel_id = ?1")
                    .bind(input.target_novel_id)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db novel merge: list target category ids: {err}"))?;
            for cat_id in category_ids {
                record_membership_in_tx(conn, ctx, &[input.target_novel_id], cat_id, true, false)
                    .await?;
            }
        }
        record_composition_in_tx(conn, ctx, input.target_novel_id).await?;
    }

    defer_user_state_for_novel_in_tx(conn, ctx, input.target_novel_id).await?;

    if let Some(ref incoming_commit) = input.incoming_migration_commit {
        commit_incoming_migration_in_tx(conn, incoming_commit).await?;
    }

    if let Some(ref token) = input.storage_transfer_token {
        commit_novel_merge_storage_in_tx(conn, token).await?;
    }

    let delete_result = sqlx::query("DELETE FROM novel WHERE id = ?1")
        .bind(input.source_novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel merge: delete source novel: {err}"))?;
    if delete_result.rows_affected() != 1 {
        return Err("Source novel changed before it could be deleted.".to_string());
    }

    Ok(NovelMergeDatabaseResultDto {
        target_novel_id: input.target_novel_id,
        chapter_id_map,
        preferred_last_read_chapter_id,
        transferred_downloads,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRenumberWorkInspectionDto {
    pub work: RenumberWorkDto,
    pub has_composition: bool,
    pub pending_journal_payloads: Vec<String>,
    pub stored_chapters: Vec<StoredRenumberChapterDto>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushAndReadRenumberWorkInputDto {
    pub work_id: i64,
    pub plugin_id: String,
    pub path: String,
    pub source_novel_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushAndReadRenumberWorkResultDto {
    pub work: RenumberWorkDto,
    pub stored_chapters: Vec<StoredRenumberChapterDto>,
    pub metadata_fingerprint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRenumberMetadataFileDto {
    pub path: String,
    pub body: Option<String>,
    pub sha256: Option<String>,
    pub next_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSourceChapterRenumberJournalInputDto {
    #[serde(default)]
    pub operation_id: Option<String>,
    pub work: RenumberWorkDto,
    pub changes: Vec<SourceChapterNumberChangeDto>,
    pub metadata_body: Option<String>,
    pub server_url: Option<String>,
    #[serde(default)]
    pub metadata_files: Option<Vec<ChapterRenumberMetadataFileDto>>,
    #[serde(default)]
    pub expected_fingerprint: Option<Option<String>>,
}

fn is_valid_cover_filename_ci(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let Some(ext) = lower.strip_prefix("cover.") else {
        return false;
    };
    matches!(
        ext,
        "avif" | "bmp" | "gif" | "img" | "jpg" | "jpeg" | "png" | "svg" | "webp"
    )
}

fn validate_renumber_metadata_files(
    version: i64,
    work: &RenumberWorkDto,
    metadata_files: Option<&[ChapterRenumberMetadataFileDto]>,
) -> Result<(), String> {
    if (version == 1 && metadata_files.is_some())
        || (version == 2 && metadata_files.is_none_or(|files| files.len() != 1))
    {
        return Err("Stored chapter reconciliation metadata backup is invalid.".to_string());
    }
    let root = format!("contents/{}/{}", work.plugin_id, work.source_novel_id);
    for file in metadata_files.unwrap_or(&[]) {
        let expected_prefix = format!("{root}/");
        let Some(name) = file.path.strip_prefix(&expected_prefix) else {
            return Err("Stored chapter reconciliation cover identity is invalid.".to_string());
        };
        if !is_valid_cover_filename_ci(name) || !is_valid_hex_sha256(&file.next_sha256) {
            return Err("Stored chapter reconciliation cover identity is invalid.".to_string());
        }
        match (&file.body, &file.sha256) {
            (None, None) => {}
            (Some(_), Some(sha)) if is_valid_hex_sha256(sha) => {}
            _ => return Err("Stored chapter reconciliation cover identity is invalid.".to_string()),
        }
        if let Some(ref body) = file.body {
            if body.len() > MAX_NOVEL_COVER_BYTES.div_ceil(3) * 4 {
                return Err("Stored cover backup exceeds the byte limit.".to_string());
            }
            let bytes = decode_base64(body)
                .map_err(|_| "Stored cover backup encoding is invalid.".to_string())?;
            if bytes.len() > MAX_NOVEL_COVER_BYTES || encode_base64(&bytes) != *body {
                return Err("Stored cover backup encoding is invalid.".to_string());
            }
        }
    }
    Ok(())
}

pub async fn inspect_source_renumber_work_in_conn(
    conn: &mut SqliteConnection,
    plugin_id: &str,
    path: &str,
) -> Result<Option<SourceRenumberWorkInspectionDto>, String> {
    let row = sqlx::query(
        "SELECT id, plugin_id, source_novel_id, path FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(plugin_id)
    .bind(path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db source renumber: lookup work: {err}"))?;

    let Some(row) = row else {
        return Ok(None);
    };
    let Some(source_novel_id) = row.get::<Option<String>, _>("source_novel_id") else {
        return Ok(None);
    };
    let work = RenumberWorkDto {
        id: row.get("id"),
        plugin_id: row.get("plugin_id"),
        source_novel_id,
        path: row.get("path"),
    };
    let has_composition = get_chapter_composition_in_tx(conn, work.id).await?.is_some();
    let pending_journal_payloads: Vec<String> = sqlx::query_scalar(
        "SELECT payload FROM content_sync_cache \
         WHERE cache_key LIKE ?1 AND json_extract(payload, '$.work.id') = ?2 \
         ORDER BY cache_key",
    )
    .bind(format!("{SOURCE_CHAPTER_RENUMBER_PREFIX}%"))
    .bind(work.id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db source renumber: list work journals: {err}"))?;
    let stored_chapters = read_renumber_chapters_in_conn(conn, work.id).await?;

    Ok(Some(SourceRenumberWorkInspectionDto {
        work,
        has_composition,
        pending_journal_payloads,
        stored_chapters,
    }))
}

pub async fn list_source_renumber_journals_in_conn(
    conn: &mut SqliteConnection,
    work_id: Option<i64>,
) -> Result<Vec<String>, String> {
    let prefix = format!("{SOURCE_CHAPTER_RENUMBER_PREFIX}%");
    let rows: Vec<String> = match work_id {
        Some(id) => sqlx::query_scalar(
            "SELECT payload FROM content_sync_cache \
             WHERE cache_key LIKE ?1 AND json_extract(payload, '$.work.id') = ?2 \
             ORDER BY cache_key",
        )
        .bind(prefix)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db source renumber: list filtered journals: {err}"))?,
        None => sqlx::query_scalar(
            "SELECT payload FROM content_sync_cache WHERE cache_key LIKE ?1 ORDER BY cache_key",
        )
        .bind(prefix)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db source renumber: list journals: {err}"))?,
    };
    Ok(rows)
}

pub async fn create_source_chapter_renumber_journal_in_tx(
    conn: &mut SqliteConnection,
    input: &CreateSourceChapterRenumberJournalInputDto,
) -> Result<JsonValue, String> {
    assert_source_chapter_number_changes_supported(&input.changes)?;
    if !is_storage_id(&input.work.plugin_id) || !is_storage_id(&input.work.source_novel_id) {
        return Err(
            "Stored chapter number reconciliation is invalid; existing files were retained."
                .to_string(),
        );
    }
    if let Some(ref files) = input.metadata_files {
        if files.len() > 1 {
            return Err("Chapter reconciliation supports one incoming cover target.".to_string());
        }
    }
    let version = if input
        .metadata_files
        .as_ref()
        .is_some_and(|f| !f.is_empty())
    {
        2
    } else {
        1
    };
    validate_renumber_metadata_files(version, &input.work, input.metadata_files.as_deref())?;

    let cached_fp: Option<String> = sqlx::query_scalar(
        "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id = ?1",
    )
    .bind(input.work.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db source renumber: read metadata fingerprint: {err}"))?;

    if let Some(ref expected_fp) = input.expected_fingerprint {
        if &cached_fp != expected_fp {
            return Err(
                "The work changed before its chapter numbers could be reconciled.".to_string(),
            );
        }
    }

    let operation_id = match input.operation_id {
        Some(ref explicit) if !explicit.is_empty() => explicit.clone(),
        _ => random_uuid_v4()?,
    };

    let mut job_obj = serde_json::Map::new();
    job_obj.insert("version".to_string(), json!(version));
    job_obj.insert("operationId".to_string(), json!(operation_id));
    job_obj.insert("phase".to_string(), json!("preparing"));
    job_obj.insert("work".to_string(), serde_json::to_value(&input.work).unwrap());
    job_obj.insert(
        "changes".to_string(),
        serde_json::to_value(&input.changes).unwrap(),
    );
    job_obj.insert("metadataBody".to_string(), json!(input.metadata_body));
    job_obj.insert("metadataFingerprint".to_string(), json!(cached_fp));
    job_obj.insert("serverUrl".to_string(), json!(input.server_url));
    if let Some(ref files) = input.metadata_files {
        if !files.is_empty() {
            job_obj.insert(
                "metadataFiles".to_string(),
                serde_json::to_value(files).unwrap(),
            );
        }
    }
    let job = JsonValue::Object(job_obj);
    save_source_chapter_renumber_journal_in_tx(conn, &job).await?;
    Ok(job)
}

pub async fn save_source_chapter_renumber_journal_in_tx(
    conn: &mut SqliteConnection,
    job: &JsonValue,
) -> Result<(), String> {
    let op_id = job
        .get("operationId")
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Stored chapter number reconciliation is invalid; existing files were retained."
                .to_string()
        })?;
    let payload = serde_json::to_string(job)
        .map_err(|err| format!("db source renumber: encode journal: {err}"))?;
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(format!("{SOURCE_CHAPTER_RENUMBER_PREFIX}{op_id}"))
    .bind(payload)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db source renumber: save journal: {err}"))?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRenumberJournalDto {
    phase: String,
    work: RenumberWorkDto,
    changes: Vec<SourceChapterNumberChangeDto>,
    metadata_fingerprint: Option<String>,
}

pub async fn verify_source_chapter_renumber_recovery_in_conn(
    conn: &mut SqliteConnection,
    raw_job: &JsonValue,
) -> Result<(), String> {
    let job: VerifyRenumberJournalDto =
        serde_json::from_value(raw_job.clone()).map_err(|_| {
            "Stored chapter number reconciliation is invalid; existing files were retained."
                .to_string()
        })?;
    let row = sqlx::query(
        "SELECT id, plugin_id, source_novel_id, path FROM novel WHERE id = ?1",
    )
    .bind(job.work.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db source renumber: verify work row: {err}"))?;

    let rows = read_renumber_chapters_in_conn(conn, job.work.id).await?;
    let committed = job.phase == "committed";

    let work_matches = row.as_ref().is_some_and(|r| {
        let cur_plugin: String = r.get("plugin_id");
        let cur_source_id: Option<String> = r.get("source_novel_id");
        let cur_path: String = r.get("path");
        cur_plugin == job.work.plugin_id
            && cur_source_id.as_deref() == Some(job.work.source_novel_id.as_str())
            && cur_path == job.work.path
    });

    let changes_mismatch = job.changes.iter().any(|change| {
        let Some(row) = rows.iter().find(|cur| cur.id == change.id) else {
            return true;
        };
        let expected_path = if committed {
            &change.next_path
        } else {
            &change.path
        };
        let expected_number = if committed {
            &change.next_chapter_number
        } else {
            &change.chapter_number
        };
        let expected_dir = if committed {
            &change.target_relative_dir
        } else {
            &change.source_relative_dir
        };
        let actual_number = row
            .chapter_number
            .as_deref()
            .and_then(canonical_chapter_number_str);
        let dir_mismatch = if committed {
            row.directory.as_deref() != Some(expected_dir.as_str())
        } else {
            row.directory
                .as_deref()
                .is_some_and(|d| d != expected_dir.as_str())
        };
        row.path != *expected_path
            || actual_number.as_deref() != Some(expected_number.as_str())
            || dir_mismatch
    });

    if !work_matches || changes_mismatch {
        return Err(
            "Chapter number recovery does not match the current database. Existing files were retained."
                .to_string(),
        );
    }

    if !committed {
        let cached_fp: Option<String> = sqlx::query_scalar(
            "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id = ?1",
        )
        .bind(job.work.id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db source renumber: verify metadata fingerprint: {err}"))?;
        if cached_fp != job.metadata_fingerprint {
            return Err(
                "Work metadata changed after chapter reconciliation was prepared. Existing files were retained."
                    .to_string(),
            );
        }
    }

    Ok(())
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn db_chapter_composition_get(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Option<ChapterCompositionV1Dto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter composition: acquire connection: {err}"))?;
    get_chapter_composition_in_tx(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_novel_merge_find_target_preview(
    db: State<'_, AppDatabase>,
    plugin_id: String,
    path: String,
    source_novel_id: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<NovelMergeTargetPreviewDbDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel merge: acquire connection: {err}"))?;
    let novel_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM novel \
         WHERE plugin_id = ?1 AND (path = ?2 OR source_novel_id = ?3) \
         ORDER BY CASE WHEN path = ?2 THEN 0 ELSE 1 END \
         LIMIT 1",
    )
    .bind(&plugin_id)
    .bind(&path)
    .bind(&source_novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel merge: find target preview: {err}"))?;

    let Some(novel_id) = novel_id else {
        return Ok(None);
    };
    let composition = get_chapter_composition_in_tx(&mut conn, novel_id).await?;
    Ok(Some(NovelMergeTargetPreviewDbDto {
        novel_id,
        composition,
    }))
}

#[tauri::command]
pub async fn db_novel_merge_create_storage_journal(
    db: State<'_, AppDatabase>,
    input: CreateNovelMergeStorageJournalInputDto,
) -> Result<DbMutationEnvelope<NovelMergeStorageJournalDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { create_novel_merge_storage_journal_in_tx(conn, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_merge_save_storage_preparation(
    db: State<'_, AppDatabase>,
    mut job: NovelMergeStorageJournalDto,
    preparation: ChapterStorageTransferPreparationDto,
) -> Result<DbMutationEnvelope<()>, String> {
    job.preparation = Some(preparation);
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { save_novel_merge_storage_journal_in_tx(conn, &job).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_merge_commit_storage_journal(
    db: State<'_, AppDatabase>,
    token: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { commit_novel_merge_storage_in_tx(conn, &token).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_merge_list_storage_journals(
    db: State<'_, AppDatabase>,
    work_ids: Option<Vec<i64>>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<String>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel merge: acquire connection: {err}"))?;
    list_novel_merge_storage_journals_in_conn(&mut conn, work_ids.as_deref()).await
}

#[tauri::command]
pub async fn db_novel_merge_verify_storage_recovery(
    db: State<'_, AppDatabase>,
    token: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<NovelMergeStorageJournalDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel merge: acquire connection: {err}"))?;
    verify_novel_merge_storage_recovery_in_conn(&mut conn, &token).await
}

#[tauri::command]
pub async fn db_novel_merge_delete_storage_journal(
    db: State<'_, AppDatabase>,
    token: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                sqlx::query("DELETE FROM content_sync_cache WHERE cache_key = ?1")
                    .bind(format!("{NOVEL_MERGE_STORAGE_PREFIX}{token}"))
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db novel merge: delete storage journal: {err}"))?;
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_merge_apply(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: ApplyNovelMergeInputDto,
) -> Result<DbMutationEnvelope<NovelMergeDatabaseResultDto>, String> {
    let metadata_root = MetadataRoot::App(app.clone());
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move { apply_novel_merge_in_tx(&metadata_root, conn, ctx, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_merge_complete_incoming_migration(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    commit: IncomingMigrationCommitDto,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| Box::pin(async move { commit_incoming_migration_in_tx(conn, &commit).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_source_renumber_inspect_work(
    db: State<'_, AppDatabase>,
    plugin_id: String,
    path: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<SourceRenumberWorkInspectionDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db source renumber: acquire connection: {err}"))?;
    inspect_source_renumber_work_in_conn(&mut conn, &plugin_id, &path).await
}

#[tauri::command]
pub async fn db_source_renumber_read_chapters(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Vec<StoredRenumberChapterDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db source renumber: acquire connection: {err}"))?;
    read_renumber_chapters_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_source_renumber_list_journals(
    db: State<'_, AppDatabase>,
    work_id: Option<i64>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<String>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db source renumber: acquire connection: {err}"))?;
    list_source_renumber_journals_in_conn(&mut conn, work_id).await
}

#[tauri::command]
pub async fn db_source_renumber_read_journal(
    db: State<'_, AppDatabase>,
    operation_id: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<String>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db source renumber: acquire connection: {err}"))?;
    sqlx::query_scalar("SELECT payload FROM content_sync_cache WHERE cache_key = ?1")
        .bind(format!("{SOURCE_CHAPTER_RENUMBER_PREFIX}{operation_id}"))
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db source renumber: read journal: {err}"))
}

#[tauri::command]
pub async fn db_source_renumber_flush_and_read_work(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: FlushAndReadRenumberWorkInputDto,
) -> Result<DbMutationEnvelope<FlushAndReadRenumberWorkResultDto>, String> {
    let metadata_root = MetadataRoot::App(app.clone());
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            metadata_root: MetadataRoot::App(app),
            ..Default::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT id, plugin_id, source_novel_id, path FROM novel WHERE id = ?1",
                )
                .bind(input.work_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db source renumber: verify work before flush: {err}"))?;
                let valid = row.as_ref().is_some_and(|r| {
                    r.get::<String, _>("plugin_id") == input.plugin_id
                        && r.get::<String, _>("path") == input.path
                        && r.get::<Option<String>, _>("source_novel_id").as_deref()
                            == Some(input.source_novel_id.as_str())
                });
                if !valid {
                    return Err(
                        "The work changed before its chapter numbers could be reconciled."
                            .to_string(),
                    );
                }
                flush_dirty_in_tx(&metadata_root, conn, ctx, None).await?;
                let stored_chapters = read_renumber_chapters_in_conn(conn, input.work_id).await?;
                let metadata_fingerprint: Option<String> = sqlx::query_scalar(
                    "SELECT fingerprint FROM work_metadata_file_cache WHERE novel_id = ?1",
                )
                .bind(input.work_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db source renumber: read flushed fingerprint: {err}"))?;
                Ok(FlushAndReadRenumberWorkResultDto {
                    work: RenumberWorkDto {
                        id: input.work_id,
                        plugin_id: input.plugin_id,
                        source_novel_id: input.source_novel_id,
                        path: input.path,
                    },
                    stored_chapters,
                    metadata_fingerprint,
                })
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_source_renumber_create_journal(
    db: State<'_, AppDatabase>,
    input: CreateSourceChapterRenumberJournalInputDto,
) -> Result<DbMutationEnvelope<JsonValue>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { create_source_chapter_renumber_journal_in_tx(conn, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_source_renumber_save_journal(
    db: State<'_, AppDatabase>,
    job: JsonValue,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { save_source_chapter_renumber_journal_in_tx(conn, &job).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_source_renumber_apply_changes(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    job: JsonValue,
) -> Result<DbMutationEnvelope<Vec<String>>, String> {
    let metadata_root = MetadataRoot::App(app.clone());
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move {
                let root = metadata_root.resolve()?;
                apply_source_chapter_number_changes_in_tx(
                    root.as_deref(),
                    conn,
                    ctx,
                    novel_id,
                    &job,
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_source_renumber_commit(
    db: State<'_, AppDatabase>,
    job: JsonValue,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { commit_source_chapter_renumber_in_tx(conn, &job).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_source_renumber_verify_recovery(
    db: State<'_, AppDatabase>,
    job: JsonValue,
    read_mode: Option<ReadMode>,
) -> Result<(), String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db source renumber: acquire connection: {err}"))?;
    verify_source_chapter_renumber_recovery_in_conn(&mut conn, &job).await
}

#[tauri::command]
pub async fn db_source_renumber_delete_journal(
    db: State<'_, AppDatabase>,
    operation_id: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..Default::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                sqlx::query("DELETE FROM content_sync_cache WHERE cache_key = ?1")
                    .bind(format!("{SOURCE_CHAPTER_RENUMBER_PREFIX}{operation_id}"))
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db source renumber: delete journal: {err}"))?;
                Ok(())
            })
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;

    #[tokio::test]
    async fn apply_novel_merge_transfers_state_downloads_pending_server_job_and_rolls_back_atomically()
    {
        let test_db = open_test_db().await;
        with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library, library_added_at, last_read_at) \
                     VALUES (1, 'source-a', 'a-1', '/a', 'Work A', 1, 10, 40), \
                            (2, 'source-b', 'b-1', '/b', 'Work B', 0, NULL, 30)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO chapter (id, novel_id, path, name, chapter_number, position, bookmark, unread, progress, is_downloaded, content_bytes, read_at) \
                     VALUES (11, 1, '/a/1', 'A1', '1', 1, 1, 0, 75, 1, 120, 40), \
                            (12, 1, '/a/2', 'A2', '2', 2, 0, 1, 0, 0, 0, NULL), \
                            (21, 2, '/b/1', 'B1', '1', 1, 0, 1, 20, 0, 0, 30)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO novel_download_goal (novel_id, kind, count, updated_at) VALUES (1, 'entire', NULL, 99)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO chapter_download_goal_exclusion (chapter_id, created_at) VALUES (11, 5)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                Ok(())
            })
        })
        .await
        .unwrap();

        let journal = with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, _ctx| {
            Box::pin(async move {
                create_novel_merge_storage_journal_in_tx(
                    conn,
                    &CreateNovelMergeStorageJournalInputDto {
                        token: Some("move-1".to_string()),
                        source: MergeStorageWorkDto {
                            id: 1,
                            plugin_id: "source-a".to_string(),
                            source_novel_id: Some("a-1".to_string()),
                            path: "/a".to_string(),
                        },
                        source_directory: "contents/source-a/a-1".to_string(),
                        source_metadata_body: Some("source-before".to_string()),
                        target: MergeStorageWorkDto {
                            id: 2,
                            plugin_id: "source-b".to_string(),
                            source_novel_id: Some("b-1".to_string()),
                            path: "/b".to_string(),
                        },
                        target_directory: "contents/source-b/b-1".to_string(),
                        target_metadata_body: Some("target-before".to_string()),
                        entries: vec![ChapterStorageTransferEntryDto {
                            entry_id: "11".to_string(),
                            source_relative_dir: "contents/source-a/a-1/1".to_string(),
                            target_relative_dir: "contents/source-b/b-1/1".to_string(),
                        }],
                        cleanup_directories: vec!["contents/source-a/a-1/1".to_string()],
                        composition: None,
                    },
                )
                .await
            })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(journal.cleanup_directories, vec!["contents/source-a/a-1"]);

        // Trigger failure on source delete -> full rollback including storage journal & server job
        with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "CREATE TRIGGER reject_src_del BEFORE DELETE ON novel WHEN OLD.id = 1 \
                     BEGIN SELECT RAISE(ABORT, 'source busy'); END",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                Ok(())
            })
        })
        .await
        .unwrap();

        let merge_input = ApplyNovelMergeInputDto {
            source_novel_id: 1,
            target_novel_id: 2,
            decisions: vec![
                NovelMergeChapterDecisionDto::Map {
                    source_chapter_id: 11,
                    target_chapter_path: "/b/1".to_string(),
                },
                NovelMergeChapterDecisionDto::Exclude {
                    source_chapter_id: 12,
                },
            ],
            prepared_downloads: vec![PreparedNovelMergeDownloadDto {
                source_chapter_id: 11,
                content_type: "html".to_string(),
                content_bytes: 120,
                media_bytes: 0,
                transferred_from_source: true,
                media_complete: Some(true),
                target_inventory: None,
                target_inventory_body_only: None,
            }],
            composition: None,
            prepared_composition_copies: Vec::new(),
            reading_state_source_path_by_target_path: HashMap::new(),
            skip_source_content_chapter_ids: Vec::new(),
            content_sync_server_url: Some("https://content.example.test/".to_string()),
            content_sync_source_snapshot: None,
            content_sync_target_metadata: None,
            incoming_migration_commit: None,
            storage_transfer_token: Some("move-1".to_string()),
        };

        let failed = with_write_tx(test_db.db.writer(), TxOptions::default(), {
            let input = merge_input.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    apply_novel_merge_in_tx(&MetadataRoot::None, conn, ctx, &input).await
                })
            }
        })
        .await;
        assert!(failed.unwrap_err().contains("source busy"));

        // Storage journal must still be in preparing phase after rollback
        {
            let mut conn = test_db.db.writer().acquire().await.unwrap();
            let verified = verify_novel_merge_storage_recovery_in_conn(&mut conn, "move-1")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(verified.phase, "preparing");
        }

        // Drop trigger and commit merge
        let merged = with_write_tx(test_db.db.writer(), TxOptions::default(), move |conn, ctx| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_src_del")
                    .execute(&mut *conn)
                    .await
                    .unwrap();
                apply_novel_merge_in_tx(&MetadataRoot::None, conn, ctx, &merge_input).await
            })
        })
        .await
        .unwrap()
        .value;

        assert_eq!(merged.target_novel_id, 2);
        assert_eq!(merged.transferred_downloads, 1);
        assert_eq!(merged.preferred_last_read_chapter_id, Some(21));
        assert_eq!(merged.chapter_id_map.get(&11), Some(&21));

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        let remaining_ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM novel ORDER BY id")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        assert_eq!(remaining_ids, vec![2]);

        let verified = verify_novel_merge_storage_recovery_in_conn(&mut conn, "move-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(verified.phase, "committed");

        let pending_migrations: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM content_sync_cache WHERE cache_key LIKE 'norea-content-novel-migration:%'",
        )
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        assert_eq!(pending_migrations, 1);
    }

    #[tokio::test]
    async fn source_renumber_inspect_create_and_verify_recovery_match_db_state() {
        let test_db = open_test_db().await;
        with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name) \
                     VALUES (7, 'demo-plugin', 'book', '/book', 'Book')",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO chapter (id, novel_id, path, name, chapter_number, position, is_downloaded) \
                     VALUES (71, 7, 'norea-folder:1000', 'First', '1000', 1, 1)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO work_metadata_file_cache (plugin_id, path, novel_id, directory, fingerprint) \
                     VALUES ('demo-plugin', '/book', 7, 'contents/demo-plugin/book', 'fp-1')",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                Ok(())
            })
        })
        .await
        .unwrap();

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        let inspected = inspect_source_renumber_work_in_conn(&mut conn, "demo-plugin", "/book")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inspected.work.id, 7);
        assert!(!inspected.has_composition);
        assert_eq!(inspected.stored_chapters.len(), 1);
        drop(conn);

        let change = SourceChapterNumberChangeDto {
            id: 71,
            path: "norea-folder:1000".to_string(),
            chapter_number: "1000".to_string(),
            next_path: "/chapter/1000".to_string(),
            next_chapter_number: "1".to_string(),
            source_relative_dir: "contents/demo-plugin/book/1000".to_string(),
            target_relative_dir: "contents/demo-plugin/book/1".to_string(),
            is_downloaded: true,
        };
        let created = with_write_tx(test_db.db.writer(), TxOptions::default(), {
            let work = inspected.work.clone();
            let change = change.clone();
            move |conn, _ctx| {
                Box::pin(async move {
                    create_source_chapter_renumber_journal_in_tx(
                        conn,
                        &CreateSourceChapterRenumberJournalInputDto {
                            operation_id: Some("op-1".to_string()),
                            work,
                            changes: vec![change],
                            metadata_body: None,
                            server_url: Some("https://content.test".to_string()),
                            metadata_files: None,
                            expected_fingerprint: Some(Some("fp-1".to_string())),
                        },
                    )
                    .await
                })
            }
        })
        .await
        .unwrap()
        .value;

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        verify_source_chapter_renumber_recovery_in_conn(&mut conn, &created)
            .await
            .unwrap();
    }
}
