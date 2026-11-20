use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::chapter_media::is_storage_id;
use crate::database::AppDatabase;

use super::category::UNCATEGORIZED_CATEGORY_ID;
use super::chapter_composition::{
    canonical_chapter_number_str, get_chapter_composition_in_tx,
    materialize_chapter_composition_in_tx, parse_chapter_composition,
    set_chapter_composition_in_tx, ChapterCompositionEntryDto, ChapterCompositionUserDto,
    ChapterCompositionV1Dto, ChapterSourceSnapshotDto,
};
use super::novel::{
    assert_byte_budget, normalize_chapter_content_type, reconcile_imported_novel_identity_in_tx,
    stored_chapter_content_type, upsert_downloaded_chapters_in_tx, BulkChapterMutationResultDto,
    DownloadedChapterUpsertInputDto, ImportedChapterIdentityDto, LOCAL_NOVEL_PATH, LOCAL_PLUGIN_ID,
};
use super::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use super::user_state::{
    core::{
        has_user_state_schema_in_tx, mark_private_chapter_progress_in_tx, record_chapters_in_tx,
        record_novel_chapters_in_tx, record_public_novel_reading_in_tx,
        record_resume_cleared_in_tx,
    },
    defer_user_state_for_novel_in_tx,
    migration::{remap_unattempted_chapter_paths_in_tx, UserStateChapterPathBefore},
    types::random_uuid_v4,
};
use super::work_metadata::{
    flush_dirty_in_tx, mark_work_metadata_refreshed_in_tx, persist_work_chapter_directories_in_tx,
    ChaptersMap, FetchedChapterCatalog,
};
use super::{decode_sqlite_f64, DbMutationEnvelope, ReadMode};

const MAX_ROUTE_QUERY_ROWS: i64 = 500;
const MAX_BACKFILL_ROWS: i64 = 200;
const MAX_CHAPTER_BULK_INPUT_ROWS: usize = 50_000;
const MAX_CHAPTER_TITLE_BYTES: usize = 8 * 1024;
const MAX_CHAPTER_URL_BYTES: usize = 32 * 1024;
const SQLITE_BIND_PARAMETER_BUDGET: usize = 900;
const SOURCE_CHAPTER_CHUNK_SIZE: usize = 112;
const CHAPTER_ID_CHUNK_SIZE: usize = 500;
const FINISHED_PROGRESS: f64 = 100.0;
const CONTINUE_READING_LIMIT: i64 = 6;
const DEFAULT_UPDATES_LIMIT: i64 = 100;
const DEFAULT_HISTORY_LIMIT: i64 = 100;
const HISTORY_PAGE_SIZE: i64 = 50;
const MAX_SAFE_INT_I64: i64 = 9_007_199_254_740_991;

pub const SOURCE_CHAPTER_RENUMBER_PREFIX: &str = "norea-source-chapter-renumber:";
pub const SERVER_CHAPTER_RENUMBER_PREFIX: &str = "norea-content-chapter-number-reconciliation:";

const CHAPTER_SELECT_FIELDS: &str = "\
  id, \
  novel_id, \
  path, \
  name, \
  chapter_number, \
  position, \
  page, \
  bookmark, \
  unread, \
  progress, \
  is_downloaded, \
  content_type, \
  stored_content_type, \
  content_bytes, \
  media_bytes, \
  media_repair_needed, \
  release_time, \
  read_at, \
  created_at, \
  found_at, \
  updated_at";

const RELEASE_OR_FOUND_AT_SQL: &str = "MIN(COALESCE(CASE \
    WHEN c.release_time GLOB '[0-9][0-9][0-9][0-9][-.][0-9][0-9][-.][0-9][0-9]' \
      THEN unixepoch(replace(c.release_time, '.', '-'), 'utc') \
    WHEN c.release_time GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][ T][0-9][0-9]:[0-9][0-9]*' \
      THEN unixepoch(c.release_time) \
  END, c.found_at), c.found_at)";

const SELECT_CHAPTER_STORAGE_ROW_SQL: &str = "\
  SELECT \
    c.id AS chapter_id, \
    c.novel_id, \
    c.name AS chapter_name, \
    c.chapter_number, \
    c.position, \
    c.is_downloaded, \
    c.content_type AS source_content_type, \
    c.stored_content_type, \
    c.content_bytes, \
    c.media_bytes, \
    c.media_repair_needed, \
    n.plugin_id, \
    n.path AS novel_path, \
    n.source_novel_id, \
    n.name AS novel_name \
  FROM chapter c \
  JOIN novel n ON n.id = c.novel_id";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImportedChapterRefDto {
    pub id: i64,
    pub novel_id: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRowDto {
    pub id: i64,
    pub novel_id: i64,
    pub path: String,
    pub name: String,
    pub chapter_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_chapter_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition_source: Option<ChapterSourceSnapshotDto>,
    pub position: i64,
    pub page: String,
    pub bookmark: bool,
    pub unread: bool,
    pub progress: f64,
    pub is_downloaded: bool,
    pub source_content_type: String,
    pub content_type: String,
    pub content_bytes: i64,
    pub media_bytes: i64,
    pub media_repair_needed: bool,
    pub release_time: Option<String>,
    pub read_at: Option<i64>,
    pub created_at: Option<i64>,
    pub found_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDownloadChapterDto {
    #[serde(flatten)]
    pub chapter: ChapterRowDto,
    pub is_download_queued: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertChapterInputDto {
    pub novel_id: i64,
    pub path: String,
    pub name: String,
    pub position: i64,
    #[serde(default)]
    pub chapter_number: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub release_time: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestSourceChapterAnchorDto {
    pub novel_id: i64,
    pub chapter_number: f64,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSinceAnchorResponseDto {
    pub existing_novel_id: i64,
    pub anchor: Option<LatestSourceChapterAnchorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterMutationResultDto {
    pub rows_affected: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterReadStateDto {
    pub id: i64,
    pub progress: f64,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkReadStateMutationResultDto {
    pub rows_affected: u64,
    pub chunks: usize,
    pub previous: Vec<ChapterReadStateDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelativeReadStateMutationResultDto {
    pub rows_affected: u64,
    pub previous: Vec<ChapterReadStateDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChapterProgressInputDto {
    pub chapter_id: i64,
    pub progress: f64,
    #[serde(default)]
    pub record_history: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetChaptersReadStateInputDto {
    pub chapter_ids: Vec<i64>,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNovelsReadStateInputDto {
    pub novel_ids: Vec<i64>,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRelativeChaptersReadStateInputDto {
    pub anchor_chapter_id: i64,
    pub direction: String,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChapterContentMetadataInputDto {
    pub chapter_id: i64,
    pub content_bytes: i64,
    pub content_type: String,
    #[serde(default)]
    pub media_bytes: Option<i64>,
    pub media_repair_needed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveChapterPartialContentMetadataInputDto {
    pub chapter_id: i64,
    pub content_bytes: i64,
    pub content_type: String,
    pub media_repair_needed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptStoredChapterContentInputDto {
    pub chapter_id: i64,
    pub content_bytes: i64,
    pub media_bytes: i64,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub media_repair_needed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdatesCursorDto {
    pub chapter_id: i64,
    pub sort_at: i64,
    pub position: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListLibraryUpdatesInputDto {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub cursor: Option<LibraryUpdatesCursorDto>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryUpdateEntryDto {
    pub chapter_id: i64,
    pub chapter_path: String,
    pub novel_id: i64,
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub novel_source_novel_id: Option<String>,
    pub novel_path: String,
    pub chapter_name: String,
    pub content_type: String,
    pub position: i64,
    pub sort_at: i64,
    pub is_downloaded: bool,
    pub novel_name: String,
    pub novel_cover: Option<String>,
    #[serde(default)]
    pub novel_cover_override: Option<String>,
    pub novel_is_local: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentlyReadEntryDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_chapter_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition_source: Option<ChapterSourceSnapshotDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_path: Option<String>,
    pub chapter_id: i64,
    pub novel_id: i64,
    pub chapter_name: String,
    pub chapter_number: Option<String>,
    pub position: i64,
    pub read_at: i64,
    pub progress: f64,
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub novel_source_novel_id: Option<String>,
    pub novel_name: String,
    pub novel_cover: Option<String>,
    #[serde(default)]
    pub novel_cover_override: Option<String>,
    pub novel_in_library: bool,
    pub novel_is_local: bool,
    pub novel_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueReadingEntryDto {
    pub novel_id: i64,
    pub novel_name: String,
    pub novel_cover: Option<String>,
    #[serde(default)]
    pub novel_cover_override: Option<String>,
    pub novel_is_local: bool,
    pub novel_path: String,
    pub plugin_id: String,
    pub novel_source_novel_id: Option<String>,
    pub chapter_id: i64,
    pub chapter_name: String,
    pub chapter_number: Option<String>,
    pub position: i64,
    pub progress: f64,
    pub read_at: i64,
    pub next_chapter_id: Option<i64>,
    pub next_chapter_name: Option<String>,
    pub next_chapter_number: Option<String>,
    pub next_chapter_position: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCursorDto {
    pub chapter_id: i64,
    pub position: i64,
    pub read_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListReadingHistoryPageInputDto {
    #[serde(default)]
    pub cursor: Option<HistoryCursorDto>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub progress: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageDto {
    pub entries: Vec<RecentlyReadEntryDto>,
    pub next_cursor: Option<HistoryCursorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum CleanupCategoriesSelectionDto {
    All,
    Selected { ids: Vec<i64> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFinishedSelectionDto {
    pub keep_last: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCleanupSelectionDto {
    pub reading: String,
    pub categories: CleanupCategoriesSelectionDto,
    #[serde(default)]
    pub finished: Option<CleanupFinishedSelectionDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListChapterCleanupCandidatesInputDto {
    pub selection: ChapterCleanupSelectionDto,
    #[serde(default)]
    pub after_id: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub chapter_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupNovelIdentityDto {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupChapterIdentityDto {
    pub id: i64,
    pub name: String,
    pub position: i64,
    pub chapter_number: Option<String>,
    pub content_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterContentStorageIdentityDto {
    pub novel: CleanupNovelIdentityDto,
    pub chapter: CleanupChapterIdentityDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCleanupCandidateDto {
    pub identity: ChapterContentStorageIdentityDto,
    pub novel_path: String,
    pub chapter_path: String,
    pub novel_name: String,
    pub chapter_name: String,
    pub server_source: Option<String>,
    pub storage_ambiguous: bool,
    pub local_server_fingerprint: Option<String>,
    pub unread: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCleanedChapterSnapshotDto {
    pub content_bytes: i64,
    pub media_bytes: i64,
    pub media_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCleanedChapterInputDto {
    pub candidate: ChapterCleanupCandidateDto,
    pub snapshot: ReconcileCleanedChapterSnapshotDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageRowDto {
    pub chapter_id: i64,
    pub chapter_name: String,
    pub chapter_number: Option<String>,
    pub content_bytes: i64,
    pub source_content_type: String,
    pub stored_content_type: Option<String>,
    pub is_downloaded: bool,
    pub media_bytes: i64,
    pub media_repair_needed: bool,
    pub novel_id: i64,
    pub novel_name: String,
    pub novel_path: String,
    pub source_novel_id: Option<String>,
    pub plugin_id: String,
    pub position: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListChapterStorageRowsInputDto {
    #[serde(default)]
    pub downloaded_by_novel_id: Option<i64>,
    #[serde(default)]
    pub all_downloaded: bool,
    #[serde(default)]
    pub chapter_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub after_chapter_id: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenumberWorkDto {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRenumberChapterDto {
    pub id: i64,
    pub path: String,
    pub chapter_number: Option<String>,
    pub position: i64,
    pub directory: Option<String>,
    pub is_downloaded: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceChapterNumberChangeDto {
    pub id: i64,
    pub path: String,
    pub chapter_number: String,
    pub next_path: String,
    pub next_chapter_number: String,
    pub source_relative_dir: String,
    pub target_relative_dir: String,
    pub is_downloaded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSourceChapterItemDto {
    pub path: String,
    pub name: String,
    pub chapter_number: f64,
    #[serde(default)]
    pub source_chapter_id: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub release_time: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNovelFromSourceInputDto {
    pub plugin_id: String,
    pub novel_path: String,
    pub item_name: String,
    pub novel_name: String,
    pub source_novel_id: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub genres: Option<String>,
    #[serde(default)]
    pub rating: Option<f64>,
    pub preserve_missing_metadata: bool,
    #[serde(default)]
    pub mark_found_by_check: bool,
    pub start_position: i64,
    #[serde(default)]
    pub expected_novel_id: Option<i64>,
    pub chapters: Vec<SyncSourceChapterItemDto>,
    #[serde(default)]
    pub renumber: Option<JsonValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncNovelPublishResultDto {
    pub republish: bool,
    pub changed_chapters: u64,
    pub new_chapters: u64,
    pub cover: Option<String>,
    pub cover_changed: bool,
    pub cover_fetched_at: Option<i64>,
    pub novel_changed: bool,
    pub in_library: bool,
    pub novel_id: i64,
}

fn now_unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clamp_route_query_limit(limit: Option<i64>, default_limit: i64) -> i64 {
    let raw = limit.unwrap_or(default_limit);
    if raw <= 0 {
        return default_limit.min(MAX_ROUTE_QUERY_ROWS).max(1);
    }
    raw.min(MAX_ROUTE_QUERY_ROWS).max(1)
}

fn clamp_backfill_limit(limit: i64) -> i64 {
    if limit <= 0 {
        return 50;
    }
    limit.min(MAX_BACKFILL_ROWS).max(1)
}

fn optional_trimmed_text(value: Option<&str>) -> Option<String> {
    value
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn js_math_round_clamped(progress: f64) -> i64 {
    if !progress.is_finite() || progress <= 0.0 {
        return 0;
    }
    let rounded = (progress + 0.5).floor();
    if rounded >= 100.0 {
        100
    } else {
        rounded as i64
    }
}

fn js_encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(ch);
        } else {
            let mut buf = [0u8; 4];
            for byte in ch.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

fn format_f64_js(value: f64) -> String {
    if value == 0.0 {
        "0".to_string()
    } else if value.fract() == 0.0 && value.abs() <= (MAX_SAFE_INT_I64 as f64) {
        (value as i64).to_string()
    } else {
        value.to_string()
    }
}

fn assert_chapter_bulk_count(count: usize, label: &str) -> Result<(), String> {
    if count > MAX_CHAPTER_BULK_INPUT_ROWS {
        return Err(format!(
            "{label} has {count} chapters, which exceeds the {MAX_CHAPTER_BULK_INPUT_ROWS} chapter limit."
        ));
    }
    Ok(())
}

pub fn validate_source_chapter_inputs(inputs: &[InsertChapterInputDto]) -> Result<(), String> {
    assert_chapter_bulk_count(inputs.len(), "Chapter upsert")?;
    for input in inputs {
        assert_byte_budget(
            input.name.len() as i64,
            MAX_CHAPTER_TITLE_BYTES,
            "Chapter title",
        )?;
        assert_byte_budget(
            input.path.len() as i64,
            MAX_CHAPTER_URL_BYTES,
            "Chapter URL",
        )?;
    }
    Ok(())
}

fn map_chapter_row(row: &sqlx::sqlite::SqliteRow) -> ChapterRowDto {
    let source_raw: Option<String> = row.get("content_type");
    let stored_raw: Option<String> = row.get("stored_content_type");
    let source_content_type = normalize_chapter_content_type(source_raw.as_deref()).to_string();
    let content_type = match stored_raw.as_deref() {
        Some(raw) if !raw.is_empty() => normalize_chapter_content_type(Some(raw)).to_string(),
        _ => source_content_type.clone(),
    };
    ChapterRowDto {
        id: row.get("id"),
        novel_id: row.get("novel_id"),
        path: row.get("path"),
        name: row.get("name"),
        chapter_number: row.get("chapter_number"),
        display_chapter_number: None,
        composition_source: None,
        position: row.get("position"),
        page: row.get("page"),
        bookmark: row.get::<i64, _>("bookmark") != 0,
        unread: row.get::<i64, _>("unread") != 0,
        progress: decode_sqlite_f64(row, "progress"),
        is_downloaded: row.get::<i64, _>("is_downloaded") != 0,
        source_content_type,
        content_type,
        content_bytes: row.get("content_bytes"),
        media_bytes: row.get("media_bytes"),
        media_repair_needed: row.get::<i64, _>("media_repair_needed") != 0,
        release_time: row.get("release_time"),
        read_at: row.get("read_at"),
        created_at: row.get("created_at"),
        found_at: row.get("found_at"),
        updated_at: row.get("updated_at"),
    }
}

fn map_storage_row(row: &sqlx::sqlite::SqliteRow) -> ChapterStorageRowDto {
    ChapterStorageRowDto {
        chapter_id: row.get("chapter_id"),
        chapter_name: row.get("chapter_name"),
        chapter_number: row.get("chapter_number"),
        content_bytes: row.get("content_bytes"),
        source_content_type: row.get("source_content_type"),
        stored_content_type: row.get("stored_content_type"),
        is_downloaded: row.get::<i64, _>("is_downloaded") != 0,
        media_bytes: row.get("media_bytes"),
        media_repair_needed: row.get::<i64, _>("media_repair_needed") != 0,
        novel_id: row.get("novel_id"),
        novel_name: row.get("novel_name"),
        novel_path: row.get("novel_path"),
        source_novel_id: row.get("source_novel_id"),
        plugin_id: row.get("plugin_id"),
        position: row.get("position"),
    }
}

async fn load_composition_displays_in_conn(
    conn: &mut SqliteConnection,
    novel_ids: &[i64],
) -> Result<HashMap<i64, HashMap<String, (String, ChapterSourceSnapshotDto)>>, String> {
    let mut unique_ids = Vec::new();
    let mut seen = HashSet::new();
    for id in novel_ids {
        if seen.insert(*id) {
            unique_ids.push(*id);
        }
    }
    if unique_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut displays: HashMap<i64, HashMap<String, (String, ChapterSourceSnapshotDto)>> =
        HashMap::new();
    for chunk in unique_ids.chunks(SQLITE_BIND_PARAMETER_BUDGET) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT novel_id, payload FROM novel_chapter_composition WHERE novel_id IN ({})",
            placeholders.join(",")
        );
        let mut query = sqlx::query(&sql);
        for id in chunk {
            query = query.bind(*id);
        }
        let rows = query
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: load composition displays: {err}"))?;

        for record in rows {
            let novel_id: i64 = record.get("novel_id");
            let payload: String = record.get("payload");
            let raw: JsonValue = serde_json::from_str(&payload)
                .map_err(|err| format!("db chapter: parse composition JSON: {err}"))?;
            let composition = parse_chapter_composition(&raw)?;
            let mut by_path = HashMap::new();
            for entry in composition.entries {
                if !entry.user.included {
                    continue;
                }
                let display_num = entry
                    .user
                    .chapter_number
                    .unwrap_or_else(|| entry.user.order.to_string());
                if let Some(source) = entry.sources.get(entry.primary_source).cloned() {
                    by_path.insert(entry.path, (display_num, source));
                }
            }
            displays.insert(novel_id, by_path);
        }
    }
    Ok(displays)
}

async fn apply_composition_displays_to_chapters_in_conn(
    conn: &mut SqliteConnection,
    rows: &mut [ChapterRowDto],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let novel_ids: Vec<i64> = rows.iter().map(|r| r.novel_id).collect();
    let displays = load_composition_displays_in_conn(conn, &novel_ids).await?;
    for row in rows {
        if let Some((display_num, source)) = displays
            .get(&row.novel_id)
            .and_then(|by_path| by_path.get(&row.path))
        {
            row.display_chapter_number = Some(display_num.clone());
            row.composition_source = Some(source.clone());
        }
    }
    Ok(())
}

pub async fn find_local_imported_chapter_in_conn(
    conn: &mut SqliteConnection,
    path_key: &str,
) -> Result<Option<LocalImportedChapterRefDto>, String> {
    let chapter_path = format!("{path_key}/chapter-0001");
    let row = sqlx::query(
        "SELECT c.id, c.novel_id \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         WHERE n.plugin_id = ?1 AND n.path = ?2 AND n.is_local = 1 AND c.path = ?3",
    )
    .bind(LOCAL_PLUGIN_ID)
    .bind(LOCAL_NOVEL_PATH)
    .bind(chapter_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: find local imported chapter: {err}"))?;

    Ok(row.map(|r| LocalImportedChapterRefDto {
        id: r.get("id"),
        novel_id: r.get("novel_id"),
    }))
}

pub async fn list_chapters_by_novel_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Vec<ChapterRowDto>, String> {
    let sql = format!(
        "SELECT {CHAPTER_SELECT_FIELDS} FROM chapter WHERE novel_id = ?1 ORDER BY position, id"
    );
    let mut rows: Vec<ChapterRowDto> = sqlx::query(&sql)
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list chapters by novel: {err}"))?
        .iter()
        .map(map_chapter_row)
        .collect();
    apply_composition_displays_to_chapters_in_conn(conn, &mut rows).await?;
    Ok(rows)
}

pub async fn list_library_download_chapters_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Vec<LibraryDownloadChapterDto>, String> {
    let sql = format!(
        "SELECT {CHAPTER_SELECT_FIELDS}, \
           EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = chapter.id) AS is_download_queued \
         FROM chapter \
         WHERE novel_id = ?1 \
         ORDER BY position, id"
    );
    let raw_rows = sqlx::query(&sql)
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list library download chapters: {err}"))?;

    let mut chapters: Vec<ChapterRowDto> = raw_rows.iter().map(map_chapter_row).collect();
    apply_composition_displays_to_chapters_in_conn(conn, &mut chapters).await?;

    Ok(raw_rows
        .iter()
        .zip(chapters)
        .map(|(raw, chapter)| LibraryDownloadChapterDto {
            chapter,
            is_download_queued: raw.get::<i64, _>("is_download_queued") != 0,
        })
        .collect())
}

pub async fn list_unqueued_chapter_downloads_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
    after_chapter_id: i64,
) -> Result<Vec<ChapterRowDto>, String> {
    let sql = format!(
        "SELECT {CHAPTER_SELECT_FIELDS} FROM chapter \
         WHERE novel_id = ?1 AND id > ?2 \
           AND EXISTS(SELECT 1 FROM novel n WHERE n.id = chapter.novel_id AND n.is_local = 0) \
           AND is_downloaded = 0 AND content_bytes <= 0 \
           AND NOT EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = chapter.id) \
         ORDER BY id LIMIT ?3"
    );
    let mut rows: Vec<ChapterRowDto> = sqlx::query(&sql)
        .bind(novel_id)
        .bind(after_chapter_id)
        .bind(MAX_ROUTE_QUERY_ROWS)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list unqueued chapter downloads: {err}"))?
        .iter()
        .map(map_chapter_row)
        .collect();
    apply_composition_displays_to_chapters_in_conn(conn, &mut rows).await?;
    Ok(rows)
}

pub async fn get_chapter_by_id_in_conn(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<Option<ChapterRowDto>, String> {
    let sql = format!("SELECT {CHAPTER_SELECT_FIELDS} FROM chapter WHERE id = ?1");
    let Some(raw) = sqlx::query(&sql)
        .bind(chapter_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: get chapter by id: {err}"))?
    else {
        return Ok(None);
    };
    let mut rows = vec![map_chapter_row(&raw)];
    apply_composition_displays_to_chapters_in_conn(conn, &mut rows).await?;
    Ok(rows.pop())
}

pub async fn list_existing_chapter_ids_in_conn(
    conn: &mut SqliteConnection,
    chapter_ids: &[i64],
) -> Result<Vec<i64>, String> {
    let mut unique_ids = Vec::new();
    let mut seen = HashSet::new();
    for id in chapter_ids {
        if seen.insert(*id) {
            unique_ids.push(*id);
        }
    }
    if unique_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut existing = Vec::new();
    for chunk in unique_ids.chunks(CHAPTER_ID_CHUNK_SIZE) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT id FROM chapter WHERE id IN ({})",
            placeholders.join(", ")
        );
        let mut query = sqlx::query_scalar::<_, i64>(&sql);
        for id in chunk {
            query = query.bind(*id);
        }
        let rows = query
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: list existing chapter ids: {err}"))?;
        existing.extend(rows);
    }
    Ok(existing)
}

pub async fn get_latest_source_chapter_anchor_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<LatestSourceChapterAnchorDto>, String> {
    let rows = sqlx::query(
        "SELECT chapter_number, position, path FROM chapter WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: get latest source chapter anchor: {err}"))?;

    if rows.is_empty() {
        return Ok(None);
    }

    let mut latest: Option<LatestSourceChapterAnchorDto> = None;
    for row in rows {
        let path: String = row.get("path");
        if path.starts_with("norea-folder:") {
            continue;
        }
        let Some(raw_num): Option<String> = row.get("chapter_number") else {
            return Ok(None);
        };
        let trimmed = raw_num.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let Ok(chapter_number) = trimmed.parse::<f64>() else {
            return Ok(None);
        };
        if !chapter_number.is_finite() {
            return Ok(None);
        }
        let position: i64 = row.get("position");
        if latest
            .as_ref()
            .is_none_or(|prev| chapter_number > prev.chapter_number)
        {
            latest = Some(LatestSourceChapterAnchorDto {
                novel_id,
                chapter_number,
                position,
            });
        }
    }
    Ok(latest)
}

pub async fn get_sync_since_anchor_in_conn(
    conn: &mut SqliteConnection,
    plugin_id: &str,
    path: &str,
    novel_id: Option<i64>,
) -> Result<Option<SyncSinceAnchorResponseDto>, String> {
    let existing_novel_id = match novel_id {
        Some(id) => Some(id),
        None => sqlx::query_scalar::<_, i64>(
            "SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(plugin_id)
        .bind(path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: resolve existing novel id: {err}"))?,
    };
    let Some(existing_novel_id) = existing_novel_id else {
        return Ok(None);
    };

    if let Some(composition) = get_chapter_composition_in_tx(conn, existing_novel_id).await? {
        let source_novel_id: Option<String> = sqlx::query_scalar(
            "SELECT source_novel_id FROM novel WHERE id = ?1",
        )
        .bind(existing_novel_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: load novel source_novel_id: {err}"))?
        .flatten();
        let anchor = source_novel_id.and_then(|source_id| {
            let mut best: Option<(f64, i64)> = None;
            for entry in &composition.entries {
                for source in &entry.sources {
                    if source.plugin_id != plugin_id || source.novel_id != source_id {
                        continue;
                    }
                    let Some(ref num_str) = source.chapter_number else {
                        continue;
                    };
                    let Ok(num) = num_str.trim().parse::<f64>() else {
                        continue;
                    };
                    if !num.is_finite() {
                        continue;
                    }
                    if best.is_none_or(|(prev_num, _)| num > prev_num) {
                        best = Some((num, source.position));
                    }
                }
            }
            best.map(|(chapter_number, position)| LatestSourceChapterAnchorDto {
                novel_id: existing_novel_id,
                chapter_number,
                position,
            })
        });
        return Ok(Some(SyncSinceAnchorResponseDto {
            existing_novel_id,
            anchor,
        }));
    }

    let anchor = get_latest_source_chapter_anchor_in_conn(conn, existing_novel_id).await?;
    Ok(Some(SyncSinceAnchorResponseDto {
        existing_novel_id,
        anchor,
    }))
}

pub async fn get_adjacent_chapter_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
    position: i64,
    direction: i64,
) -> Result<Option<ChapterRowDto>, String> {
    let sql = if direction >= 0 {
        format!(
            "SELECT {CHAPTER_SELECT_FIELDS} FROM chapter \
             WHERE novel_id = ?1 AND position > ?2 \
             ORDER BY position ASC LIMIT 1"
        )
    } else {
        format!(
            "SELECT {CHAPTER_SELECT_FIELDS} FROM chapter \
             WHERE novel_id = ?1 AND position < ?2 \
             ORDER BY position DESC LIMIT 1"
        )
    };
    let Some(raw) = sqlx::query(&sql)
        .bind(novel_id)
        .bind(position)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: get adjacent chapter: {err}"))?
    else {
        return Ok(None);
    };
    let mut rows = vec![map_chapter_row(&raw)];
    apply_composition_displays_to_chapters_in_conn(conn, &mut rows).await?;
    Ok(rows.pop())
}

async fn migrate_source_chapter_paths_in_tx(
    conn: &mut SqliteConnection,
    chunk: &[InsertChapterInputDto],
) -> Result<u64, String> {
    let values_sql: Vec<String> = (0..chunk.len())
        .map(|index| {
            let p = index * 4 + 1;
            format!("(?{}, ?{}, ?{}, ?{})", p, p + 1, p + 2, p + 3)
        })
        .collect();
    let values_clause = values_sql.join(", ");

    let before: Vec<UserStateChapterPathBefore> = if has_user_state_schema_in_tx(conn).await? {
        let select_sql = format!(
            "WITH incoming(novel_id, path, chapter_number, page) AS (VALUES {values_clause}) \
             SELECT target.id, target.novel_id, target.path \
             FROM chapter target \
             JOIN incoming \
               ON incoming.novel_id = target.novel_id \
              AND incoming.chapter_number IS target.chapter_number \
              AND incoming.page IS target.page \
             WHERE incoming.path IS NOT target.path"
        );
        let mut q = sqlx::query(&select_sql);
        for input in chunk {
            q = q
                .bind(input.novel_id)
                .bind(&input.path)
                .bind(&input.chapter_number)
                .bind(input.page.as_deref().unwrap_or("1"));
        }
        q.fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: select path migration candidates: {err}"))?
            .into_iter()
            .map(|r| UserStateChapterPathBefore {
                id: r.get("id"),
                novel_id: r.get("novel_id"),
                path: r.get("path"),
            })
            .collect()
    } else {
        Vec::new()
    };

    let update_sql = format!(
        "WITH incoming(novel_id, path, chapter_number, page) AS (VALUES {values_clause}) \
         UPDATE chapter AS target \
            SET path = ( \
              SELECT incoming.path \
                FROM incoming \
               WHERE incoming.novel_id IS target.novel_id \
                 AND incoming.chapter_number IS target.chapter_number \
                 AND incoming.page IS target.page \
            ), \
                updated_at = unixepoch() \
          WHERE target.novel_id IN (SELECT novel_id FROM incoming) \
            AND EXISTS ( \
              SELECT 1 \
                FROM incoming \
               WHERE incoming.novel_id IS target.novel_id \
                 AND incoming.chapter_number IS target.chapter_number \
                 AND incoming.page IS target.page \
                 AND incoming.path IS NOT target.path \
            ) \
            AND target.id = ( \
                  SELECT MIN(existing.id) \
                    FROM chapter AS existing \
                   WHERE existing.novel_id IS target.novel_id \
                     AND existing.chapter_number IS target.chapter_number \
                     AND existing.page IS target.page \
                ) \
            AND NOT EXISTS ( \
              SELECT 1 \
                FROM chapter AS existing \
                JOIN incoming \
                  ON incoming.novel_id IS existing.novel_id \
                 AND incoming.path IS existing.path \
               WHERE existing.id IS NOT target.id \
                 AND incoming.novel_id IS target.novel_id \
                 AND incoming.chapter_number IS target.chapter_number \
                 AND incoming.page IS target.page \
            )"
    );
    let mut update_query = sqlx::query(&update_sql);
    for input in chunk {
        update_query = update_query
            .bind(input.novel_id)
            .bind(&input.path)
            .bind(&input.chapter_number)
            .bind(input.page.as_deref().unwrap_or("1"));
    }
    let result = update_query
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: migrate source chapter paths: {err}"))?;

    remap_unattempted_chapter_paths_in_tx(conn, &before).await?;
    Ok(result.rows_affected())
}

async fn execute_source_chapter_chunk_in_tx(
    conn: &mut SqliteConnection,
    chunk: &[InsertChapterInputDto],
) -> Result<u64, String> {
    let values_sql: Vec<String> = (0..chunk.len())
        .map(|index| {
            let p = index * 8 + 1;
            format!(
                "(?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, unixepoch(), unixepoch())",
                p,
                p + 1,
                p + 2,
                p + 3,
                p + 4,
                p + 5,
                p + 6,
                p + 7
            )
        })
        .collect();
    let sql = format!(
        "INSERT INTO chapter \
           (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at) \
         VALUES {} \
         ON CONFLICT(novel_id, path) DO UPDATE SET \
           name           = excluded.name, \
           position       = excluded.position, \
           chapter_number = excluded.chapter_number, \
           page           = excluded.page, \
           release_time   = excluded.release_time, \
           content_type   = excluded.content_type, \
           updated_at     = unixepoch() \
          WHERE \
            name IS NOT excluded.name \
            OR position IS NOT excluded.position \
            OR chapter_number IS NOT excluded.chapter_number \
            OR page IS NOT excluded.page \
            OR release_time IS NOT excluded.release_time \
            OR content_type IS NOT excluded.content_type",
        values_sql.join(", ")
    );
    let mut query = sqlx::query(&sql);
    for input in chunk {
        let content_type = normalize_chapter_content_type(input.content_type.as_deref());
        query = query
            .bind(input.novel_id)
            .bind(&input.path)
            .bind(&input.name)
            .bind(input.position)
            .bind(&input.chapter_number)
            .bind(input.page.as_deref().unwrap_or("1"))
            .bind(&input.release_time)
            .bind(content_type);
    }
    let result = query
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: upsert source chapter chunk: {err}"))?;
    Ok(result.rows_affected())
}

pub async fn upsert_source_chapters_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    inputs: &[InsertChapterInputDto],
) -> Result<BulkChapterMutationResultDto, String> {
    if inputs.is_empty() {
        return Ok(BulkChapterMutationResultDto {
            rows_affected: 0,
            chunks: 0,
        });
    }
    validate_source_chapter_inputs(inputs)?;

    let mut rows_affected = 0u64;
    let mut chunks = 0usize;
    for chunk in inputs.chunks(SOURCE_CHAPTER_CHUNK_SIZE) {
        rows_affected += migrate_source_chapter_paths_in_tx(conn, chunk).await?;
        rows_affected += execute_source_chapter_chunk_in_tx(conn, chunk).await?;
        chunks += 1;
    }

    let mut seen_novels = HashSet::new();
    for input in inputs {
        if seen_novels.insert(input.novel_id) {
            defer_user_state_for_novel_in_tx(conn, ctx, input.novel_id).await?;
        }
    }

    Ok(BulkChapterMutationResultDto {
        rows_affected,
        chunks,
    })
}

pub async fn insert_chapter_if_absent_in_tx(
    conn: &mut SqliteConnection,
    input: &InsertChapterInputDto,
) -> Result<(), String> {
    let content_type = normalize_chapter_content_type(input.content_type.as_deref());
    sqlx::query(
        "INSERT OR IGNORE INTO chapter \
           (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch(), unixepoch())",
    )
    .bind(input.novel_id)
    .bind(&input.path)
    .bind(&input.name)
    .bind(input.position)
    .bind(&input.chapter_number)
    .bind(input.page.as_deref().unwrap_or("1"))
    .bind(&input.release_time)
    .bind(content_type)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: insert chapter if absent: {err}"))?;
    Ok(())
}

pub async fn upsert_chapter_in_tx(
    conn: &mut SqliteConnection,
    input: &InsertChapterInputDto,
) -> Result<ChapterMutationResultDto, String> {
    let content_type = normalize_chapter_content_type(input.content_type.as_deref());
    let result = sqlx::query(
        "INSERT INTO chapter \
           (novel_id, path, name, position, chapter_number, page, release_time, content_type, created_at, found_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch(), unixepoch()) \
         ON CONFLICT(novel_id, path) DO UPDATE SET \
           name           = excluded.name, \
           position       = excluded.position, \
           chapter_number = excluded.chapter_number, \
           page           = excluded.page, \
           release_time   = excluded.release_time, \
           content_type   = excluded.content_type, \
           updated_at     = unixepoch() \
          WHERE \
            name IS NOT excluded.name \
            OR position IS NOT excluded.position \
            OR chapter_number IS NOT excluded.chapter_number \
            OR page IS NOT excluded.page \
            OR release_time IS NOT excluded.release_time \
            OR content_type IS NOT excluded.content_type",
    )
    .bind(input.novel_id)
    .bind(&input.path)
    .bind(&input.name)
    .bind(input.position)
    .bind(&input.chapter_number)
    .bind(input.page.as_deref().unwrap_or("1"))
    .bind(&input.release_time)
    .bind(content_type)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: upsert chapter: {err}"))?;

    Ok(ChapterMutationResultDto {
        rows_affected: result.rows_affected(),
    })
}

pub async fn update_chapter_progress_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &UpdateChapterProgressInputDto,
) -> Result<(), String> {
    let clamped = js_math_round_clamped(input.progress);
    let record_history = input.record_history.unwrap_or(true);
    if record_history {
        sqlx::query(
            "UPDATE chapter \
             SET \
               progress   = CASE WHEN progress >= 100 THEN progress ELSE ?2 END, \
               unread     = CASE WHEN ?2 >= 100 THEN 0 ELSE unread END, \
               read_at    = CASE WHEN ?2 > 0 THEN unixepoch() ELSE read_at END, \
               updated_at = unixepoch() \
             WHERE id = ?1",
        )
        .bind(input.chapter_id)
        .bind(clamped)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: update progress: {err}"))?;

        sqlx::query(
            "UPDATE novel \
             SET last_read_at = unixepoch(), updated_at = unixepoch() \
             WHERE id = (SELECT novel_id FROM chapter WHERE id = ?1)",
        )
        .bind(input.chapter_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: update novel last_read_at: {err}"))?;

        record_chapters_in_tx(conn, ctx, &[input.chapter_id], "reading").await?;
        return Ok(());
    }

    mark_private_chapter_progress_in_tx(conn, input.chapter_id).await?;
    sqlx::query(
        "UPDATE chapter \
         SET \
           progress   = CASE WHEN progress >= 100 THEN progress ELSE ?2 END, \
           unread     = CASE WHEN ?2 >= 100 THEN 0 ELSE unread END, \
           updated_at = unixepoch() \
         WHERE id = ?1",
    )
    .bind(input.chapter_id)
    .bind(clamped)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: update private progress: {err}"))?;
    Ok(())
}

pub async fn set_chapters_read_state_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    chapter_ids: &[i64],
    unread: bool,
) -> Result<BulkReadStateMutationResultDto, String> {
    let mut unique_ids = Vec::new();
    let mut seen = HashSet::new();
    for &id in chapter_ids {
        if id > 0 && seen.insert(id) {
            unique_ids.push(id);
        }
    }
    if unique_ids.is_empty() {
        return Ok(BulkReadStateMutationResultDto {
            rows_affected: 0,
            chunks: 0,
            previous: Vec::new(),
        });
    }
    assert_chapter_bulk_count(unique_ids.len(), "Chapter read state update")?;

    let unread_flag: i64 = if unread { 1 } else { 0 };
    let progress: f64 = if unread { 0.0 } else { FINISHED_PROGRESS };
    let mut rows_affected = 0u64;
    let mut chunks = 0usize;
    let mut previous = Vec::new();

    for chunk in unique_ids.chunks(CHAPTER_ID_CHUNK_SIZE) {
        let sel_placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let select_sql = format!(
            "SELECT id, unread, progress FROM chapter WHERE id IN ({})",
            sel_placeholders.join(", ")
        );
        let mut sel_q = sqlx::query(&select_sql);
        for id in chunk {
            sel_q = sel_q.bind(*id);
        }
        let rows = sel_q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: select previous read states: {err}"))?;
        for r in rows {
            previous.push(ChapterReadStateDto {
                id: r.get("id"),
                progress: decode_sqlite_f64(&r, "progress"),
                unread: r.get::<i64, _>("unread") != 0,
            });
        }

        let upd_placeholders: Vec<String> =
            (1..=chunk.len()).map(|i| format!("?{}", i + 2)).collect();
        let update_sql = format!(
            "UPDATE chapter \
             SET progress = ?1, unread = ?2, updated_at = unixepoch() \
             WHERE id IN ({})",
            upd_placeholders.join(", ")
        );
        let mut upd_q = sqlx::query(&update_sql).bind(progress).bind(unread_flag);
        for id in chunk {
            upd_q = upd_q.bind(*id);
        }
        let res = upd_q
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: update read state: {err}"))?;
        rows_affected += res.rows_affected();
        chunks += 1;
    }

    record_chapters_in_tx(conn, ctx, &unique_ids, "reading").await?;
    Ok(BulkReadStateMutationResultDto {
        rows_affected,
        chunks,
        previous,
    })
}

pub async fn set_novels_read_state_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: &[i64],
    unread: bool,
) -> Result<BulkReadStateMutationResultDto, String> {
    let mut unique_ids = Vec::new();
    let mut seen = HashSet::new();
    for &id in novel_ids {
        if id > 0 && seen.insert(id) {
            unique_ids.push(id);
        }
    }
    if unique_ids.is_empty() {
        return Ok(BulkReadStateMutationResultDto {
            rows_affected: 0,
            chunks: 0,
            previous: Vec::new(),
        });
    }

    let progress: f64 = if unread { 0.0 } else { FINISHED_PROGRESS };
    let unread_flag: i64 = if unread { 1 } else { 0 };
    let mut rows_affected = 0u64;
    let mut chunks = 0usize;
    let mut previous = Vec::new();

    for chunk in unique_ids.chunks(CHAPTER_ID_CHUNK_SIZE) {
        let novel_placeholders: Vec<String> =
            (1..=chunk.len()).map(|i| format!("?{}", i + 2)).collect();
        let in_clause = novel_placeholders.join(", ");
        let select_sql = format!(
            "SELECT id, unread, progress FROM chapter \
             WHERE novel_id IN ({in_clause}) AND (progress <> ?1 OR unread <> ?2)"
        );
        let mut sel_q = sqlx::query(&select_sql).bind(progress).bind(unread_flag);
        for id in chunk {
            sel_q = sel_q.bind(*id);
        }
        let rows = sel_q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: select novel previous read states: {err}"))?;
        for r in rows {
            previous.push(ChapterReadStateDto {
                id: r.get("id"),
                progress: decode_sqlite_f64(&r, "progress"),
                unread: r.get::<i64, _>("unread") != 0,
            });
        }

        let update_sql = format!(
            "UPDATE chapter \
             SET progress = ?1, unread = ?2, updated_at = unixepoch() \
             WHERE novel_id IN ({in_clause}) AND (progress <> ?1 OR unread <> ?2)"
        );
        let mut upd_q = sqlx::query(&update_sql).bind(progress).bind(unread_flag);
        for id in chunk {
            upd_q = upd_q.bind(*id);
        }
        let res = upd_q
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: update novel read states: {err}"))?;
        rows_affected += res.rows_affected();
        chunks += 1;
    }

    record_novel_chapters_in_tx(conn, ctx, Some(&unique_ids)).await?;
    Ok(BulkReadStateMutationResultDto {
        rows_affected,
        chunks,
        previous,
    })
}

pub async fn restore_chapter_read_states_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    states: &[ChapterReadStateDto],
) -> Result<BulkChapterMutationResultDto, String> {
    let mut group_order: Vec<(i64, u64)> = Vec::new();
    let mut groups: HashMap<(i64, u64), (f64, Vec<i64>)> = HashMap::new();
    for state in states {
        if state.id <= 0 {
            continue;
        }
        let unread_flag: i64 = if state.unread { 1 } else { 0 };
        let key = (unread_flag, state.progress.to_bits());
        let entry = groups.entry(key).or_insert_with(|| {
            group_order.push(key);
            (state.progress, Vec::new())
        });
        entry.1.push(state.id);
    }
    if groups.is_empty() {
        return Ok(BulkChapterMutationResultDto {
            rows_affected: 0,
            chunks: 0,
        });
    }
    assert_chapter_bulk_count(states.len(), "Chapter read state restore")?;

    let mut rows_affected = 0u64;
    let mut chunks = 0usize;
    for key in &group_order {
        let (unread_flag, _) = *key;
        let (progress, ref ids) = groups[key];
        for chunk in ids.chunks(CHAPTER_ID_CHUNK_SIZE) {
            let placeholders: Vec<String> =
                (1..=chunk.len()).map(|i| format!("?{}", i + 2)).collect();
            let sql = format!(
                "UPDATE chapter \
                 SET progress = ?1, unread = ?2, updated_at = unixepoch() \
                 WHERE id IN ({})",
                placeholders.join(", ")
            );
            let mut q = sqlx::query(&sql).bind(progress).bind(unread_flag);
            for id in chunk {
                q = q.bind(*id);
            }
            let res = q
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db chapter: restore read states: {err}"))?;
            rows_affected += res.rows_affected();
            chunks += 1;
        }
    }

    let all_ids: Vec<i64> = states.iter().map(|s| s.id).filter(|&id| id > 0).collect();
    record_chapters_in_tx(conn, ctx, &all_ids, "reading").await?;
    Ok(BulkChapterMutationResultDto {
        rows_affected,
        chunks,
    })
}

pub async fn set_relative_chapters_read_state_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &SetRelativeChaptersReadStateInputDto,
) -> Result<RelativeReadStateMutationResultDto, String> {
    if input.anchor_chapter_id <= 0 {
        return Ok(RelativeReadStateMutationResultDto {
            rows_affected: 0,
            previous: Vec::new(),
        });
    }
    let range_predicate = match input.direction.as_str() {
        "before" => {
            "(candidate.position < reference.position \
               OR (candidate.position = reference.position AND candidate.id < reference.id))"
        }
        "after" => {
            "(candidate.position > reference.position \
               OR (candidate.position = reference.position AND candidate.id > reference.id))"
        }
        other => {
            return Err(format!(
                "db chapter: unsupported relative read direction '{other}'"
            ))
        }
    };
    let progress: f64 = if input.unread { 0.0 } else { FINISHED_PROGRESS };
    let unread_flag: i64 = if input.unread { 1 } else { 0 };

    let select_sql = format!(
        "WITH reference AS (SELECT id, novel_id, position FROM chapter WHERE id = ?1) \
         SELECT candidate.id, candidate.unread, candidate.progress \
         FROM chapter AS candidate \
         CROSS JOIN reference \
         WHERE candidate.novel_id = reference.novel_id \
           AND candidate.id <> reference.id \
           AND {range_predicate} \
           AND (candidate.progress <> ?2 OR candidate.unread <> ?3)"
    );
    let prev_rows = sqlx::query(&select_sql)
        .bind(input.anchor_chapter_id)
        .bind(progress)
        .bind(unread_flag)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: select relative previous read states: {err}"))?;
    let previous: Vec<ChapterReadStateDto> = prev_rows
        .iter()
        .map(|r| ChapterReadStateDto {
            id: r.get("id"),
            progress: decode_sqlite_f64(r, "progress"),
            unread: r.get::<i64, _>("unread") != 0,
        })
        .collect();

    let update_sql = format!(
        "WITH reference AS (SELECT id, novel_id, position FROM chapter WHERE id = ?1) \
         UPDATE chapter \
         SET progress = ?2, unread = ?3, updated_at = unixepoch() \
         WHERE id IN ( \
           SELECT candidate.id \
           FROM chapter AS candidate \
           CROSS JOIN reference \
           WHERE candidate.novel_id = reference.novel_id \
             AND candidate.id <> reference.id \
             AND {range_predicate} \
         ) \
           AND (progress <> ?2 OR unread <> ?3)"
    );
    let result = sqlx::query(&update_sql)
        .bind(input.anchor_chapter_id)
        .bind(progress)
        .bind(unread_flag)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: update relative read states: {err}"))?;

    if has_user_state_schema_in_tx(conn).await? {
        let targets_sql = format!(
            "WITH reference AS (SELECT id, novel_id, position FROM chapter WHERE id = ?1) \
             SELECT candidate.id \
             FROM chapter candidate \
             CROSS JOIN reference \
             WHERE candidate.novel_id = reference.novel_id \
               AND candidate.id <> reference.id \
               AND {range_predicate}"
        );
        let target_ids: Vec<i64> = sqlx::query_scalar(&targets_sql)
            .bind(input.anchor_chapter_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: select relative target ids: {err}"))?;
        record_chapters_in_tx(conn, ctx, &target_ids, "reading").await?;
    }

    Ok(RelativeReadStateMutationResultDto {
        rows_affected: result.rows_affected(),
        previous,
    })
}

pub async fn mark_chapter_opened_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    chapter_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE chapter SET read_at = unixepoch(), updated_at = unixepoch() WHERE id = ?1",
    )
    .bind(chapter_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: mark chapter opened: {err}"))?;

    sqlx::query(
        "UPDATE novel SET last_read_at = unixepoch(), updated_at = unixepoch() \
         WHERE id = (SELECT novel_id FROM chapter WHERE id = ?1)",
    )
    .bind(chapter_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: update novel opened last_read_at: {err}"))?;

    record_chapters_in_tx(conn, ctx, &[chapter_id], "reading").await
}

pub async fn clear_novel_history_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE chapter SET read_at = NULL, updated_at = unixepoch() \
         WHERE novel_id = ?1 AND read_at IS NOT NULL",
    )
    .bind(novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: clear novel chapter history: {err}"))?;

    sqlx::query("UPDATE novel SET last_read_at = NULL, updated_at = unixepoch() WHERE id = ?1")
        .bind(novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: clear novel last_read_at: {err}"))?;

    record_public_novel_reading_in_tx(conn, ctx, &[novel_id], true).await?;
    record_resume_cleared_in_tx(conn, ctx, Some(&[novel_id])).await
}

pub async fn set_chapter_bookmark_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    chapter_id: i64,
    bookmarked: bool,
) -> Result<(), String> {
    let flag: i64 = if bookmarked { 1 } else { 0 };
    sqlx::query("UPDATE chapter SET bookmark = ?2, updated_at = unixepoch() WHERE id = ?1")
        .bind(chapter_id)
        .bind(flag)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: set bookmark: {err}"))?;

    record_chapters_in_tx(conn, ctx, &[chapter_id], "bookmark").await
}

pub async fn save_chapter_content_metadata_in_tx(
    conn: &mut SqliteConnection,
    input: &SaveChapterContentMetadataInputDto,
) -> Result<ChapterMutationResultDto, String> {
    let normalized = stored_chapter_content_type(normalize_chapter_content_type(Some(
        &input.content_type,
    )));
    let has_media_bytes: i64 = if input.media_bytes.is_some() { 1 } else { 0 };
    let media_bytes = input.media_bytes.unwrap_or(0);
    let repair_flag: i64 = if input.media_repair_needed { 1 } else { 0 };
    let res = sqlx::query(
        "UPDATE chapter \
         SET \
           stored_content_type = ?2, \
           content_bytes = ?3, \
           media_bytes = ?4, \
           media_repair_needed = ?5, \
           media_bytes_checked_at = CASE WHEN ?6 = 1 THEN unixepoch() ELSE NULL END, \
           is_downloaded = 1, \
           updated_at = unixepoch() \
         WHERE id = ?1",
    )
    .bind(input.chapter_id)
    .bind(normalized)
    .bind(input.content_bytes)
    .bind(media_bytes)
    .bind(repair_flag)
    .bind(has_media_bytes)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: save content metadata: {err}"))?;
    Ok(ChapterMutationResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn save_chapter_partial_content_metadata_in_tx(
    conn: &mut SqliteConnection,
    input: &SaveChapterPartialContentMetadataInputDto,
) -> Result<ChapterMutationResultDto, String> {
    let normalized = stored_chapter_content_type(normalize_chapter_content_type(Some(
        &input.content_type,
    )));
    let repair_flag: i64 = if input.media_repair_needed { 1 } else { 0 };
    let res = sqlx::query(
        "UPDATE chapter \
         SET \
           stored_content_type = ?2, \
           content_bytes = ?3, \
           media_repair_needed = MAX(media_repair_needed, ?4), \
           media_bytes_checked_at = NULL, \
           updated_at = unixepoch() \
         WHERE id = ?1",
    )
    .bind(input.chapter_id)
    .bind(normalized)
    .bind(input.content_bytes)
    .bind(repair_flag)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: save partial content metadata: {err}"))?;
    Ok(ChapterMutationResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn mark_chapter_media_repair_pending_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<ChapterMutationResultDto, String> {
    let res = sqlx::query(
        "UPDATE chapter SET media_repair_needed = 1, is_downloaded = 0, \
           media_bytes_checked_at = NULL WHERE id = ?1",
    )
    .bind(chapter_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: mark media repair pending: {err}"))?;
    Ok(ChapterMutationResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn adopt_stored_chapter_content_metadata_in_tx(
    conn: &mut SqliteConnection,
    input: &AdoptStoredChapterContentInputDto,
) -> Result<ChapterMutationResultDto, String> {
    let normalized = input
        .content_type
        .as_deref()
        .map(|ct| stored_chapter_content_type(normalize_chapter_content_type(Some(ct))));
    let repair_flag: i64 = if input.media_repair_needed { 1 } else { 0 };
    let res = sqlx::query(
        "UPDATE chapter \
         SET \
           content_bytes = ?2, \
           media_bytes = ?3, \
           media_repair_needed = ?5, \
           media_bytes_checked_at = unixepoch(), \
           stored_content_type = COALESCE(?4, stored_content_type), \
           is_downloaded = 1 - ?5 \
         WHERE id = ?1 \
           AND (content_bytes IS NOT ?2 \
             OR media_bytes IS NOT ?3 \
             OR media_repair_needed IS NOT ?5 \
             OR (?4 IS NOT NULL AND stored_content_type IS NOT ?4) \
             OR is_downloaded IS NOT (1 - ?5))",
    )
    .bind(input.chapter_id)
    .bind(input.content_bytes)
    .bind(input.media_bytes)
    .bind(normalized)
    .bind(repair_flag)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: adopt stored content metadata: {err}"))?;

    if res.rows_affected() == 0 {
        let checked =
            sqlx::query("UPDATE chapter SET media_bytes_checked_at = unixepoch() WHERE id = ?1")
                .bind(input.chapter_id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db chapter: touch media_bytes_checked_at: {err}"))?;
        return Ok(ChapterMutationResultDto {
            rows_affected: checked.rows_affected(),
        });
    }
    Ok(ChapterMutationResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn mark_stored_chapter_content_missing_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<ChapterMutationResultDto, String> {
    let res = sqlx::query(
        "UPDATE chapter \
         SET \
           content_bytes = 0, \
           media_bytes = 0, \
           media_repair_needed = 0, \
           media_bytes_checked_at = NULL, \
           stored_content_type = NULL, \
           is_downloaded = 0 \
         WHERE id = ?1 \
           AND novel_id IN (SELECT id FROM novel WHERE is_local = 0)",
    )
    .bind(chapter_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: mark stored content missing: {err}"))?;
    Ok(ChapterMutationResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn clear_chapter_content_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE chapter \
         SET \
           content_bytes = 0, \
           media_bytes = 0, \
           media_repair_needed = 0, \
           media_bytes_checked_at = NULL, \
           stored_content_type = NULL, \
           is_downloaded = 0, \
           updated_at = unixepoch() \
         WHERE id = ?1 \
           AND novel_id IN (SELECT id FROM novel WHERE is_local = 0)",
    )
    .bind(chapter_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: clear chapter content: {err}"))?;
    Ok(())
}

pub async fn list_library_updates_in_conn(
    conn: &mut SqliteConnection,
    input: &ListLibraryUpdatesInputDto,
) -> Result<Vec<LibraryUpdateEntryDto>, String> {
    let normalized_limit = clamp_route_query_limit(input.limit, DEFAULT_UPDATES_LIMIT);
    let is_new = input.scope.as_deref().unwrap_or("new") != "backlog";
    let sort_at = if is_new {
        RELEASE_OR_FOUND_AT_SQL
    } else {
        "c.found_at"
    };
    let found_clause = if is_new { "AND c.found_by_check = 1" } else { "" };
    let cursor_clause = if input.cursor.is_some() {
        format!(
            "AND ({sort_at} < ?1 \
               OR ({sort_at} = ?1 AND c.position < ?2) \
               OR ({sort_at} = ?1 AND c.position = ?2 AND c.id < ?3))"
        )
    } else {
        String::new()
    };
    let limit_param = if input.cursor.is_some() { "?4" } else { "?1" };
    let sql = format!(
        "SELECT \
           c.id AS chapter_id, \
           c.path AS chapter_path, \
           c.novel_id, \
           n.plugin_id, \
           ip.name AS plugin_name, \
           n.source_novel_id AS novel_source_novel_id, \
           n.path AS novel_path, \
           c.name AS chapter_name, \
           COALESCE(c.stored_content_type, c.content_type) AS content_type, \
           c.position, \
           {sort_at} AS sort_at, \
           c.is_downloaded, \
           {effective_name} AS novel_name, \
           n.cover AS novel_cover, \
           {override_cover} AS novel_cover_override, \
           n.is_local AS novel_is_local \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         LEFT JOIN novel_override o ON o.novel_id = n.id \
         LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id \
         WHERE n.in_library = 1 AND c.unread = 1 \
           {found_clause} \
           {cursor_clause} \
         ORDER BY sort_at DESC, c.position DESC, c.id DESC \
         LIMIT {limit_param}",
        effective_name = super::novel::EFFECTIVE_NOVEL_NAME_SQL,
        override_cover = super::novel::OVERRIDE_COVER_SQL,
    );
    let mut query = sqlx::query(&sql);
    if let Some(ref cursor) = input.cursor {
        query = query
            .bind(cursor.sort_at)
            .bind(cursor.position)
            .bind(cursor.chapter_id)
            .bind(normalized_limit);
    } else {
        query = query.bind(normalized_limit);
    }
    let rows = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list library updates: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let ct_raw: Option<String> = r.get("content_type");
            LibraryUpdateEntryDto {
                chapter_id: r.get("chapter_id"),
                chapter_path: r.get("chapter_path"),
                novel_id: r.get("novel_id"),
                plugin_id: r.get("plugin_id"),
                plugin_name: r.get("plugin_name"),
                novel_source_novel_id: r.get("novel_source_novel_id"),
                novel_path: r.get("novel_path"),
                chapter_name: r.get("chapter_name"),
                content_type: normalize_chapter_content_type(ct_raw.as_deref()).to_string(),
                position: r.get("position"),
                sort_at: r.get("sort_at"),
                is_downloaded: r.get::<i64, _>("is_downloaded") != 0,
                novel_name: r.get("novel_name"),
                novel_cover: r.get("novel_cover"),
                novel_cover_override: r.get("novel_cover_override"),
                novel_is_local: r.get::<i64, _>("novel_is_local") != 0,
            }
        })
        .collect())
}

pub async fn count_new_library_chapters_since_in_conn(
    conn: &mut SqliteConnection,
    seen_at: i64,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM chapter c JOIN novel n ON n.id = c.novel_id \
         WHERE n.in_library = 1 AND c.unread = 1 AND c.found_by_check = 1 AND c.found_at > ?1",
    )
    .bind(seen_at)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: count new library chapters since: {err}"))
}

pub async fn list_recently_read_in_conn(
    conn: &mut SqliteConnection,
    limit: Option<i64>,
) -> Result<Vec<RecentlyReadEntryDto>, String> {
    let normalized_limit = clamp_route_query_limit(limit, DEFAULT_HISTORY_LIMIT);
    let sql = format!(
        "SELECT \
           c.id AS chapter_id, \
           c.novel_id, \
           c.name AS chapter_name, \
           c.chapter_number, \
           c.path AS chapter_path, \
           c.position, \
           c.read_at, \
           c.progress, \
           n.plugin_id, \
           n.source_novel_id AS novel_source_novel_id, \
           {effective_name} AS novel_name, \
           n.cover AS novel_cover, \
           {override_cover} AS novel_cover_override, \
           n.in_library AS novel_in_library, \
           n.is_local AS novel_is_local, \
           n.path AS novel_path \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         LEFT JOIN novel_override o ON o.novel_id = n.id \
         WHERE c.id = ( \
           SELECT c2.id FROM chapter c2 \
           WHERE c2.novel_id = c.novel_id AND c2.read_at IS NOT NULL \
           ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC \
           LIMIT 1 \
         ) \
         ORDER BY c.read_at DESC, c.position DESC, c.id DESC \
         LIMIT ?1",
        effective_name = super::novel::EFFECTIVE_NOVEL_NAME_SQL,
        override_cover = super::novel::OVERRIDE_COVER_SQL,
    );
    let rows = sqlx::query(&sql)
        .bind(normalized_limit)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list recently read: {err}"))?;

    let mut entries: Vec<RecentlyReadEntryDto> = rows
        .iter()
        .map(|r| RecentlyReadEntryDto {
            display_chapter_number: None,
            composition_source: None,
            chapter_path: Some(r.get("chapter_path")),
            chapter_id: r.get("chapter_id"),
            novel_id: r.get("novel_id"),
            chapter_name: r.get("chapter_name"),
            chapter_number: r.get("chapter_number"),
            position: r.get("position"),
            read_at: r.get("read_at"),
            progress: decode_sqlite_f64(r, "progress"),
            plugin_id: r.get("plugin_id"),
            novel_source_novel_id: r.get("novel_source_novel_id"),
            novel_name: r.get("novel_name"),
            novel_cover: r.get("novel_cover"),
            novel_cover_override: r.get("novel_cover_override"),
            novel_in_library: r.get::<i64, _>("novel_in_library") != 0,
            novel_is_local: r.get::<i64, _>("novel_is_local") != 0,
            novel_path: r.get("novel_path"),
        })
        .collect();

    if !entries.is_empty() {
        let novel_ids: Vec<i64> = entries.iter().map(|e| e.novel_id).collect();
        let displays = load_composition_displays_in_conn(conn, &novel_ids).await?;
        for entry in &mut entries {
            let path = entry.chapter_path.as_deref().unwrap_or("");
            if let Some((display_num, source)) = displays
                .get(&entry.novel_id)
                .and_then(|by_path| by_path.get(path))
            {
                entry.display_chapter_number = Some(display_num.clone());
                entry.composition_source = Some(source.clone());
            }
        }
    }

    Ok(entries)
}

pub async fn list_continue_reading_in_conn(
    conn: &mut SqliteConnection,
    limit: Option<i64>,
) -> Result<Vec<ContinueReadingEntryDto>, String> {
    let normalized_limit = limit
        .unwrap_or(CONTINUE_READING_LIMIT)
        .clamp(1, CONTINUE_READING_LIMIT);
    let sql = format!(
        "WITH latest AS ( \
           SELECT \
             n.id AS novel_id, \
             {effective_name} AS novel_name, \
             n.cover AS novel_cover, \
             {override_cover} AS novel_cover_override, \
             n.is_local AS novel_is_local, \
             n.path AS novel_path, \
             n.plugin_id, \
             n.source_novel_id AS novel_source_novel_id, \
             c.id AS chapter_id, \
             c.name AS chapter_name, \
             c.chapter_number, \
             c.position, \
             CASE WHEN c.unread = 0 THEN 100.0 ELSE c.progress END AS progress, \
             c.read_at, \
             CASE WHEN nc.id IS NOT NULL AND (nc.is_downloaded = 1 OR nc.content_bytes > 0) THEN nc.id ELSE NULL END AS next_chapter_id, \
             CASE WHEN nc.id IS NOT NULL AND (nc.is_downloaded = 1 OR nc.content_bytes > 0) THEN nc.name ELSE NULL END AS next_chapter_name, \
             CASE WHEN nc.id IS NOT NULL AND (nc.is_downloaded = 1 OR nc.content_bytes > 0) THEN nc.chapter_number ELSE NULL END AS next_chapter_number, \
             CASE WHEN nc.id IS NOT NULL AND (nc.is_downloaded = 1 OR nc.content_bytes > 0) THEN nc.position ELSE NULL END AS next_chapter_position \
           FROM novel n \
           LEFT JOIN novel_override o ON o.novel_id = n.id \
           JOIN chapter c ON c.id = ( \
             SELECT c2.id FROM chapter c2 \
             WHERE c2.novel_id = n.id AND c2.read_at IS NOT NULL \
             ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC \
             LIMIT 1 \
           ) \
           LEFT JOIN chapter nc ON nc.id = ( \
             SELECT nc2.id FROM chapter nc2 \
             WHERE nc2.novel_id = n.id AND nc2.position > c.position \
             ORDER BY nc2.position ASC, nc2.id ASC \
             LIMIT 1 \
           ) \
           WHERE n.in_library = 1 \
         ) \
         SELECT * FROM latest \
         WHERE progress < 100 OR next_chapter_id IS NOT NULL \
         ORDER BY read_at DESC, position DESC, chapter_id DESC \
         LIMIT ?1",
        effective_name = super::novel::EFFECTIVE_NOVEL_NAME_SQL,
        override_cover = super::novel::OVERRIDE_COVER_SQL,
    );
    let rows = sqlx::query(&sql)
        .bind(normalized_limit)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list continue reading: {err}"))?;

    Ok(rows
        .iter()
        .map(|r| ContinueReadingEntryDto {
            novel_id: r.get("novel_id"),
            novel_name: r.get("novel_name"),
            novel_cover: r.get("novel_cover"),
            novel_cover_override: r.get("novel_cover_override"),
            novel_is_local: r.get::<i64, _>("novel_is_local") != 0,
            novel_path: r.get("novel_path"),
            plugin_id: r.get("plugin_id"),
            novel_source_novel_id: r.get("novel_source_novel_id"),
            chapter_id: r.get("chapter_id"),
            chapter_name: r.get("chapter_name"),
            chapter_number: r.get("chapter_number"),
            position: r.get("position"),
            progress: decode_sqlite_f64(r, "progress"),
            read_at: r.get("read_at"),
            next_chapter_id: r.get("next_chapter_id"),
            next_chapter_name: r.get("next_chapter_name"),
            next_chapter_number: r.get("next_chapter_number"),
            next_chapter_position: r.get("next_chapter_position"),
        })
        .collect())
}

pub async fn list_reading_history_page_in_conn(
    conn: &mut SqliteConnection,
    input: &ListReadingHistoryPageInputDto,
) -> Result<HistoryPageDto, String> {
    let page_size = clamp_route_query_limit(input.limit, HISTORY_PAGE_SIZE);
    let term = input
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let progress_clause = match input.progress.as_deref().unwrap_or("all") {
        "finished" => "AND progress >= 100",
        "inProgress" => "AND progress < 100",
        _ => "",
    };

    let mut next_param = 2usize;
    let search_clause = if term.is_some() {
        let p = next_param;
        next_param += 1;
        format!(
            "AND (instr(lower(novel_name), lower(?{p})) > 0 \
              OR instr(lower(chapter_name), lower(?{p})) > 0 \
              OR instr(CAST(position AS TEXT), ?{p}) > 0 \
              OR instr(COALESCE(chapter_number, ''), ?{p}) > 0)"
        )
    } else {
        String::new()
    };

    let cursor_clause = if input.cursor.is_some() {
        let p1 = next_param;
        let p2 = next_param + 1;
        let p3 = next_param + 2;
        format!(
            "AND (read_at < ?{p1} \
              OR (read_at = ?{p1} AND position < ?{p2}) \
              OR (read_at = ?{p1} AND position = ?{p2} AND chapter_id < ?{p3}))"
        )
    } else {
        String::new()
    };

    let sql = format!(
        "WITH latest AS ( \
           SELECT \
             c.id AS chapter_id, \
             c.novel_id, \
             c.name AS chapter_name, \
             c.chapter_number, \
             c.position, \
             c.read_at, \
             c.progress, \
             n.plugin_id, \
             n.source_novel_id AS novel_source_novel_id, \
             {effective_name} AS novel_name, \
             n.cover AS novel_cover, \
             {override_cover} AS novel_cover_override, \
             n.in_library AS novel_in_library, \
             n.is_local AS novel_is_local, \
             n.path AS novel_path \
           FROM novel n \
           LEFT JOIN novel_override o ON o.novel_id = n.id \
           JOIN chapter c ON c.id = ( \
             SELECT c2.id FROM chapter c2 \
             WHERE c2.novel_id = n.id AND c2.read_at IS NOT NULL \
             ORDER BY c2.read_at DESC, c2.position DESC, c2.id DESC \
             LIMIT 1 \
           ) \
         ) \
         SELECT * FROM latest \
         WHERE 1 = 1 \
           {search_clause} \
           {progress_clause} \
           {cursor_clause} \
         ORDER BY read_at DESC, position DESC, chapter_id DESC \
         LIMIT ?1",
        effective_name = super::novel::EFFECTIVE_NOVEL_NAME_SQL,
        override_cover = super::novel::OVERRIDE_COVER_SQL,
    );

    let mut query = sqlx::query(&sql).bind(page_size + 1);
    if let Some(term) = term {
        query = query.bind(term);
    }
    if let Some(ref cursor) = input.cursor {
        query = query
            .bind(cursor.read_at)
            .bind(cursor.position)
            .bind(cursor.chapter_id);
    }

    let rows = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list reading history page: {err}"))?;

    let has_more = (rows.len() as i64) > page_size;
    let entries: Vec<RecentlyReadEntryDto> = rows
        .iter()
        .take(page_size as usize)
        .map(|r| RecentlyReadEntryDto {
            display_chapter_number: None,
            composition_source: None,
            chapter_path: None,
            chapter_id: r.get("chapter_id"),
            novel_id: r.get("novel_id"),
            chapter_name: r.get("chapter_name"),
            chapter_number: r.get("chapter_number"),
            position: r.get("position"),
            read_at: r.get("read_at"),
            progress: decode_sqlite_f64(r, "progress"),
            plugin_id: r.get("plugin_id"),
            novel_source_novel_id: r.get("novel_source_novel_id"),
            novel_name: r.get("novel_name"),
            novel_cover: r.get("novel_cover"),
            novel_cover_override: r.get("novel_cover_override"),
            novel_in_library: r.get::<i64, _>("novel_in_library") != 0,
            novel_is_local: r.get::<i64, _>("novel_is_local") != 0,
            novel_path: r.get("novel_path"),
        })
        .collect();

    let next_cursor = if has_more {
        entries.last().map(|last| HistoryCursorDto {
            chapter_id: last.chapter_id,
            position: last.position,
            read_at: last.read_at,
        })
    } else {
        None
    };

    Ok(HistoryPageDto {
        entries,
        next_cursor,
    })
}

pub async fn list_chapter_cleanup_candidates_in_conn(
    conn: &mut SqliteConnection,
    input: &ListChapterCleanupCandidatesInputDto,
) -> Result<Vec<ChapterCleanupCandidateDto>, String> {
    let mut binds: Vec<i64> = Vec::new();
    let mut next_bind = |val: i64| -> String {
        binds.push(val);
        format!("?{}", binds.len())
    };

    let mut predicates: Vec<String> = vec![
        "(n.is_local = 0 OR CASE WHEN json_valid(proof.payload) THEN \
           json_extract(proof.payload, '$.chapterId') = c.id \
           AND json_extract(proof.payload, '$.novelId') = n.id \
           AND json_extract(proof.payload, '$.pluginId') = n.plugin_id \
           AND json_extract(proof.payload, '$.sourceNovelId') IS n.source_novel_id \
           AND json_extract(proof.payload, '$.novelPath') = n.path \
           AND json_extract(proof.payload, '$.chapterPath') = c.path \
           AND json_extract(proof.payload, '$.chapterNumber') IS c.chapter_number \
           AND json_extract(proof.payload, '$.position') = c.position \
           AND json_type(proof.payload, '$.serverUrl') = 'text' \
           AND length(json_extract(proof.payload, '$.serverUrl')) > 0 \
           AND json_type(proof.payload, '$.fingerprint') = 'text' \
           AND length(json_extract(proof.payload, '$.fingerprint')) = 64 \
         ELSE 0 END)"
            .to_string(),
    ];

    if input.selection.reading == "read" {
        predicates.push("c.unread = 0".to_string());
    }

    if let CleanupCategoriesSelectionDto::Selected { ref ids } = input.selection.categories {
        let mut unique_ids = Vec::new();
        let mut seen = HashSet::new();
        for &id in ids {
            if seen.insert(id) {
                unique_ids.push(id);
            }
        }
        if unique_ids.is_empty() {
            return Ok(Vec::new());
        }
        let categorized: Vec<i64> = unique_ids
            .iter()
            .copied()
            .filter(|&id| id != UNCATEGORIZED_CATEGORY_ID)
            .collect();
        let mut cat_conditions = Vec::new();
        if !categorized.is_empty() {
            let params: Vec<String> = categorized.into_iter().map(&mut next_bind).collect();
            cat_conditions.push(format!(
                "EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id AND nc.category_id IN ({}))",
                params.join(", ")
            ));
        }
        if unique_ids.contains(&UNCATEGORIZED_CATEGORY_ID) {
            cat_conditions.push(
                "NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)".to_string(),
            );
        }
        predicates.push(format!(
            "n.in_library = 1 AND ({})",
            cat_conditions.join(" OR ")
        ));
    }

    if let Some(ref finished) = input.selection.finished {
        let keep_last = next_bind(finished.keep_last.max(1));
        let reading_position = "(SELECT r.position FROM chapter r \
            WHERE r.novel_id = c.novel_id AND r.read_at IS NOT NULL \
            ORDER BY r.read_at DESC, r.id DESC LIMIT 1)";
        predicates.push(format!(
            "c.unread = 0 AND c.bookmark = 0 AND n.is_local = 0 \
               AND (c.is_downloaded = 1 OR c.media_repair_needed = 1) \
               AND EXISTS (SELECT 1 FROM installed_plugin p WHERE p.id = n.plugin_id) \
               AND NOT EXISTS (SELECT 1 FROM novel_download_goal g WHERE g.novel_id = n.id AND g.kind = 'entire') \
               AND c.position < {reading_position} \
               AND (SELECT COUNT(*) FROM chapter f WHERE f.novel_id = c.novel_id AND f.unread = 0 \
                 AND f.position > c.position AND f.position <= {reading_position}) >= {keep_last}"
        ));
    }

    if let Some(chapter_id) = input.chapter_id {
        let p = next_bind(chapter_id);
        predicates.push(format!("c.id = {p}"));
    } else {
        let p = next_bind(input.after_id.unwrap_or(0));
        predicates.push(format!("c.id > {p}"));
    }

    let limit = input.limit.unwrap_or(100).clamp(1, 100);
    let limit_param = next_bind(limit);
    let sql = format!(
        "SELECT \
           c.id, \
           c.novel_id, \
           n.plugin_id, \
           n.source_novel_id, \
           n.path AS novel_path, \
           c.path AS chapter_path, \
           n.name AS novel_name, \
           c.name AS chapter_name, \
           c.chapter_number, \
           c.position, \
           c.unread, \
           COALESCE(c.stored_content_type, c.content_type) AS content_type, \
           source.payload AS server_source, \
           CASE WHEN n.is_local = 1 THEN json_extract(proof.payload, '$.fingerprint') ELSE NULL END AS local_server_fingerprint, \
           EXISTS (SELECT 1 FROM chapter other INDEXED BY chapter_novel_position_idx \
             WHERE other.novel_id = c.novel_id AND other.id <> c.id \
               AND CAST(COALESCE(other.chapter_number, CASE WHEN other.position > 0 THEN other.position END) AS REAL) \
                 = CAST(COALESCE(c.chapter_number, CASE WHEN c.position > 0 THEN c.position END) AS REAL)) AS storage_ambiguous \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         LEFT JOIN content_sync_cache source ON source.cache_key = 'norea-content-source:' || n.id \
         LEFT JOIN content_sync_cache proof ON proof.cache_key = 'norea-content-chapter-source:' || c.id \
         WHERE {} \
         ORDER BY c.id \
         LIMIT {limit_param}",
        predicates.join(" AND ")
    );

    let mut query = sqlx::query(&sql);
    for val in binds {
        query = query.bind(val);
    }
    let rows = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list cleanup candidates: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let novel_id: i64 = r.get("novel_id");
            let plugin_id: String = r.get("plugin_id");
            let source_novel_id: Option<String> = r.get("source_novel_id");
            let novel_path: String = r.get("novel_path");
            let novel_name: String = r.get("novel_name");
            let chapter_id: i64 = r.get("id");
            let chapter_name: String = r.get("chapter_name");
            let chapter_path: String = r.get("chapter_path");
            let position: i64 = r.get("position");
            let chapter_number: Option<String> = r.get("chapter_number");
            let ct_raw: Option<String> = r.get("content_type");
            ChapterCleanupCandidateDto {
                identity: ChapterContentStorageIdentityDto {
                    novel: CleanupNovelIdentityDto {
                        id: novel_id,
                        plugin_id,
                        source_novel_id,
                        path: novel_path.clone(),
                        name: novel_name.clone(),
                    },
                    chapter: CleanupChapterIdentityDto {
                        id: chapter_id,
                        name: chapter_name.clone(),
                        position,
                        chapter_number,
                        content_type: normalize_chapter_content_type(ct_raw.as_deref()).to_string(),
                    },
                },
                novel_path,
                chapter_path,
                novel_name,
                chapter_name,
                server_source: r.get("server_source"),
                storage_ambiguous: r.get::<i64, _>("storage_ambiguous") != 0,
                local_server_fingerprint: r.get("local_server_fingerprint"),
                unread: r.get::<i64, _>("unread") != 0,
            }
        })
        .collect())
}

pub async fn reconcile_cleaned_chapter_in_tx(
    conn: &mut SqliteConnection,
    input: &ReconcileCleanedChapterInputDto,
) -> Result<u64, String> {
    let identity = &input.candidate.identity;
    let has_body = input.snapshot.content_bytes > 0;
    let is_downloaded: i64 = if has_body && input.snapshot.media_complete {
        1
    } else {
        0
    };
    let media_repair_needed: i64 = if has_body && !input.snapshot.media_complete {
        1
    } else {
        0
    };
    let res = sqlx::query(
        "UPDATE chapter \
         SET content_bytes = ?1, \
             media_bytes = ?2, \
             is_downloaded = ?3, \
             media_repair_needed = ?4, \
             media_bytes_checked_at = unixepoch() \
         WHERE id = ?5 AND novel_id = ?6 AND path = ?7 \
           AND EXISTS ( \
             SELECT 1 FROM novel n \
             WHERE n.id = chapter.novel_id \
               AND n.plugin_id = ?8 \
               AND n.path = ?9 \
               AND n.source_novel_id IS ?10 \
           )",
    )
    .bind(input.snapshot.content_bytes)
    .bind(input.snapshot.media_bytes)
    .bind(is_downloaded)
    .bind(media_repair_needed)
    .bind(identity.chapter.id)
    .bind(identity.novel.id)
    .bind(&input.candidate.chapter_path)
    .bind(&identity.novel.plugin_id)
    .bind(&input.candidate.novel_path)
    .bind(&identity.novel.source_novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: reconcile cleaned chapter: {err}"))?;
    Ok(res.rows_affected())
}

pub async fn get_chapter_storage_row_in_conn(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<Option<ChapterStorageRowDto>, String> {
    let sql = format!("{SELECT_CHAPTER_STORAGE_ROW_SQL} WHERE c.id = ?1");
    let row = sqlx::query(&sql)
        .bind(chapter_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: get storage row: {err}"))?;
    Ok(row.as_ref().map(map_storage_row))
}

pub async fn list_chapter_storage_rows_in_conn(
    conn: &mut SqliteConnection,
    input: &ListChapterStorageRowsInputDto,
) -> Result<Vec<ChapterStorageRowDto>, String> {
    if let Some(novel_id) = input.downloaded_by_novel_id {
        let sql = format!(
            "{SELECT_CHAPTER_STORAGE_ROW_SQL} \
             WHERE c.novel_id = ?1 AND c.is_downloaded = 1 \
             ORDER BY c.position, c.id"
        );
        return Ok(sqlx::query(&sql)
            .bind(novel_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: list downloaded storage rows by novel: {err}"))?
            .iter()
            .map(map_storage_row)
            .collect());
    }

    if input.all_downloaded {
        let sql = format!(
            "{SELECT_CHAPTER_STORAGE_ROW_SQL} \
             WHERE c.is_downloaded = 1 \
             ORDER BY c.novel_id, c.position, c.id"
        );
        return Ok(sqlx::query(&sql)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: list all downloaded storage rows: {err}"))?
            .iter()
            .map(map_storage_row)
            .collect());
    }

    if let Some(ref ids) = input.chapter_ids {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut unique_ids = Vec::new();
        let mut seen = HashSet::new();
        for &id in ids {
            if seen.insert(id) {
                unique_ids.push(id);
            }
        }
        let limit = input.limit.map(clamp_backfill_limit);
        let mut out = Vec::new();
        for chunk in unique_ids.chunks(CHAPTER_ID_CHUNK_SIZE) {
            let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
            let sql = format!(
                "{SELECT_CHAPTER_STORAGE_ROW_SQL} \
                 WHERE n.is_local = 0 AND c.id IN ({}) \
                 ORDER BY c.id",
                placeholders.join(", ")
            );
            let mut q = sqlx::query(&sql);
            for id in chunk {
                q = q.bind(*id);
            }
            let rows = q
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db chapter: list storage rows by ids: {err}"))?;
            out.extend(rows.iter().map(map_storage_row));
        }
        out.sort_by_key(|r| r.chapter_id);
        if let Some(limit) = limit {
            out.truncate(limit as usize);
        }
        return Ok(out);
    }

    let mut binds: Vec<i64> = Vec::new();
    let mut clauses = vec!["n.is_local = 0".to_string()];
    if let Some(after_id) = input.after_chapter_id.filter(|&id| id > 0) {
        binds.push(after_id);
        clauses.push(format!("c.id > ?{}", binds.len()));
    }
    let limit_clause = if let Some(raw_limit) = input.limit {
        let clamped = clamp_backfill_limit(raw_limit);
        binds.push(clamped);
        format!(" LIMIT ?{}", binds.len())
    } else {
        String::new()
    };
    let sql = format!(
        "{SELECT_CHAPTER_STORAGE_ROW_SQL} WHERE {} ORDER BY c.id{limit_clause}",
        clauses.join(" AND ")
    );
    let mut query = sqlx::query(&sql);
    for val in binds {
        query = query.bind(val);
    }
    Ok(query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: list storage rows for restore: {err}"))?
        .iter()
        .map(map_storage_row)
        .collect())
}

fn canonical_renumber_chapter_number(value: &str) -> Option<String> {
    canonical_chapter_number_str(value)
}

fn is_valid_plugin_dir_id(plugin_id: &str) -> bool {
    is_storage_id(plugin_id)
        && !plugin_id.is_empty()
        && plugin_id.split('-').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn chapter_storage_relative_dir_for_work(
    plugin_id: &str,
    source_novel_id: &str,
    chapter_number: Option<&str>,
    position: i64,
) -> Result<String, String> {
    if !is_valid_plugin_dir_id(plugin_id) {
        return Err("Plugin ID is required for storage.".to_string());
    }
    if !is_storage_id(source_novel_id) {
        return Err("Plugin-owned novel ID is required for storage.".to_string());
    }
    let seq = match chapter_number {
        Some(num) => canonical_renumber_chapter_number(num)
            .ok_or_else(|| "Chapter storage sequence must be a decimal number.".to_string())?,
        None if position > 0 => position.to_string(),
        None => return Err("Chapter storage sequence must be a nonnegative number.".to_string()),
    };
    Ok(format!("contents/{plugin_id}/{source_novel_id}/{seq}"))
}

pub fn assert_source_chapter_number_changes_supported(
    changes: &[SourceChapterNumberChangeDto],
) -> Result<(), String> {
    if changes.len() > 10_000 {
        return Err("Chapter number reconciliation supports at most 10000 mappings.".to_string());
    }
    for change in changes {
        for value in [&change.chapter_number, &change.next_chapter_number] {
            let ok = canonical_renumber_chapter_number(value).as_deref() == Some(value.as_str())
                && value
                    .parse::<i64>()
                    .is_ok_and(|n| n > 0 && n <= MAX_SAFE_INT_I64);
            if !ok {
                return Err(
                    "Chapter number reconciliation requires positive safe integer numbers."
                        .to_string(),
                );
            }
        }
        if change.next_path.trim().is_empty()
            || change.next_path.len() > 4096
            || change.next_path.starts_with("norea-folder:")
        {
            return Err(
                "Chapter number reconciliation requires an actual source path of at most 4096 characters."
                    .to_string(),
            );
        }
    }
    Ok(())
}

pub fn plan_source_chapter_number_changes(
    work: &RenumberWorkDto,
    stored: &[StoredRenumberChapterDto],
    incoming: &[SyncSourceChapterItemDto],
) -> Result<Vec<SourceChapterNumberChangeDto>, String> {
    if incoming.is_empty() {
        return Ok(Vec::new());
    }

    let mut stored_by_path: HashMap<&str, Vec<&StoredRenumberChapterDto>> = HashMap::new();
    for ch in stored {
        stored_by_path.entry(ch.path.as_str()).or_default().push(ch);
    }

    let mut incoming_path_counts: HashMap<&str, usize> = HashMap::new();
    for ch in incoming {
        *incoming_path_counts.entry(ch.path.as_str()).or_default() += 1;
    }

    let mut source_id_counts: HashMap<String, usize> = HashMap::new();
    for ch in incoming {
        if let Some(ref sid) = ch.source_chapter_id {
            if let Some(canon) = canonical_renumber_chapter_number(sid) {
                *source_id_counts.entry(canon).or_default() += 1;
            }
        }
    }

    let minimum = incoming
        .iter()
        .map(|c| c.chapter_number)
        .fold(f64::INFINITY, f64::min);
    let maximum = incoming
        .iter()
        .map(|c| c.chapter_number)
        .fold(f64::NEG_INFINITY, f64::max);

    fn only<'a>(
        rows: Option<&Vec<&'a StoredRenumberChapterDto>>,
    ) -> Result<Option<&'a StoredRenumberChapterDto>, String> {
        match rows {
            Some(list) if list.len() > 1 => Err(
                "Source chapter identity is ambiguous; no chapter numbers were changed."
                    .to_string(),
            ),
            Some(list) => Ok(list.first().copied()),
            None => Ok(None),
        }
    }

    let mut matched_ids = HashSet::new();
    let mut changes = Vec::new();

    for ch in incoming {
        if incoming_path_counts.get(ch.path.as_str()).copied().unwrap_or(0) != 1 {
            return Err(
                "Source chapter paths are not unique; no chapter numbers were changed.".to_string(),
            );
        }
        let next_num_raw = format_f64_js(ch.chapter_number);
        let next_number = canonical_renumber_chapter_number(&next_num_raw)
            .ok_or_else(|| "Source chapter number is invalid.".to_string())?;

        let mut matched = only(stored_by_path.get(ch.path.as_str()))?;
        if matched.is_none() {
            let folder_key = format!("norea-folder:{next_number}");
            if let Some(current) = only(stored_by_path.get(folder_key.as_str()))? {
                if current
                    .chapter_number
                    .as_deref()
                    .and_then(canonical_renumber_chapter_number)
                    .as_deref()
                    == Some(next_number.as_str())
                {
                    matched = Some(current);
                }
            }
        }
        if matched.is_none() {
            if let Some(source_id) = ch
                .source_chapter_id
                .as_deref()
                .and_then(canonical_renumber_chapter_number)
            {
                if let Ok(sid_num) = source_id.parse::<f64>() {
                    if sid_num < minimum || sid_num > maximum {
                        if source_id_counts.get(&source_id).copied().unwrap_or(0) != 1 {
                            return Err(
                                "Source chapter IDs are ambiguous; no chapter numbers were changed."
                                    .to_string(),
                            );
                        }
                        let legacy_key = format!("norea-folder:{source_id}");
                        if let Some(legacy) = only(stored_by_path.get(legacy_key.as_str()))? {
                            if legacy
                                .chapter_number
                                .as_deref()
                                .and_then(canonical_renumber_chapter_number)
                                .as_deref()
                                == Some(source_id.as_str())
                            {
                                matched = Some(legacy);
                            }
                        }
                    }
                }
            }
        }

        let Some(matched) = matched else {
            continue;
        };
        if !matched_ids.insert(matched.id) {
            return Err("Several source chapters match one stored chapter.".to_string());
        }
        let Some(previous_number) = matched
            .chapter_number
            .as_deref()
            .and_then(canonical_renumber_chapter_number)
        else {
            continue;
        };
        if previous_number == next_number {
            continue;
        }
        let prev_count = stored
            .iter()
            .filter(|row| {
                row.chapter_number
                    .as_deref()
                    .and_then(canonical_renumber_chapter_number)
                    .as_deref()
                    == Some(previous_number.as_str())
            })
            .count();
        if prev_count != 1 {
            return Err(
                "A previous chapter number is ambiguous; no chapter numbers were changed."
                    .to_string(),
            );
        }

        let source_relative_dir = chapter_storage_relative_dir_for_work(
            &work.plugin_id,
            &work.source_novel_id,
            Some(&previous_number),
            matched.position,
        )?;
        if let Some(ref dir) = matched.directory {
            if dir != &source_relative_dir {
                return Err(
                    "A stored chapter directory does not match its number; no chapter numbers were changed."
                        .to_string(),
                );
            }
        }
        let target_relative_dir = chapter_storage_relative_dir_for_work(
            &work.plugin_id,
            &work.source_novel_id,
            Some(&next_number),
            1,
        )?;

        changes.push(SourceChapterNumberChangeDto {
            id: matched.id,
            path: matched.path.clone(),
            chapter_number: previous_number,
            next_path: ch.path.clone(),
            next_chapter_number: next_number,
            source_relative_dir,
            target_relative_dir,
            is_downloaded: matched.is_downloaded != 0,
        });
    }

    assert_source_chapter_number_changes_supported(&changes)?;

    let old_numbers: HashSet<&str> = changes.iter().map(|c| c.chapter_number.as_str()).collect();
    let old_paths: HashSet<&str> = changes
        .iter()
        .map(|c| c.source_relative_dir.as_str())
        .collect();
    let mut targets: HashSet<&str> = HashSet::new();
    for change in &changes {
        if old_numbers.contains(change.next_chapter_number.as_str())
            || old_paths.contains(change.target_relative_dir.as_str())
            || !targets.insert(change.next_chapter_number.as_str())
        {
            return Err(
                "Chapter number changes overlap or form a cycle; no chapter numbers were changed."
                    .to_string(),
            );
        }
        if stored.iter().any(|ch| {
            ch.id != change.id
                && (ch
                    .chapter_number
                    .as_deref()
                    .and_then(canonical_renumber_chapter_number)
                    .as_deref()
                    == Some(change.next_chapter_number.as_str())
                    || ch.path == change.next_path)
        }) {
            return Err(
                "A chapter number or path is already assigned; no chapter numbers were changed."
                    .to_string(),
            );
        }
    }

    Ok(changes)
}

pub async fn read_renumber_chapters_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Vec<StoredRenumberChapterDto>, String> {
    let rows = sqlx::query(
        "SELECT c.id, c.path, c.chapter_number, c.position, c.is_downloaded, d.directory \
         FROM chapter c \
         LEFT JOIN work_metadata_directory_cache d ON d.chapter_id = c.id \
         WHERE c.novel_id = ?1 \
         ORDER BY c.id",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: read renumber chapters: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| StoredRenumberChapterDto {
            id: r.get("id"),
            path: r.get("path"),
            chapter_number: r.get("chapter_number"),
            position: r.get("position"),
            directory: r.get("directory"),
            is_downloaded: r.get("is_downloaded"),
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedRenumberJournalHeader {
    operation_id: String,
    phase: String,
    work: RenumberWorkDto,
    changes: Vec<SourceChapterNumberChangeDto>,
    server_url: Option<String>,
}

pub async fn apply_source_chapter_number_changes_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    raw_journal: &JsonValue,
) -> Result<Vec<String>, String> {
    let job: ParsedRenumberJournalHeader = serde_json::from_value(raw_journal.clone())
        .map_err(|err| format!("Stored chapter number reconciliation is invalid: {err}"))?;
    if job.work.id != novel_id || job.phase != "preparing" {
        return Err("Chapter number reconciliation no longer matches this work.".to_string());
    }
    let current = read_renumber_chapters_in_conn(conn, novel_id).await?;
    for change in &job.changes {
        let matched = current.iter().find(|r| r.id == change.id);
        let conflict = current.iter().any(|r| {
            r.id != change.id
                && (r.path == change.next_path
                    || r.chapter_number
                        .as_deref()
                        .and_then(canonical_renumber_chapter_number)
                        .as_deref()
                        == Some(change.next_chapter_number.as_str()))
        });
        let valid = matched.is_some_and(|ch| {
            ch.path == change.path
                && ch
                    .chapter_number
                    .as_deref()
                    .and_then(canonical_renumber_chapter_number)
                    .as_deref()
                    == Some(change.chapter_number.as_str())
        });
        if !valid || conflict {
            return Err(
                "A chapter changed while its number was being reconciled; existing files were retained."
                    .to_string(),
            );
        }
    }

    for change in &job.changes {
        sqlx::query(
            "UPDATE chapter \
             SET path = ?1, chapter_number = ?2, updated_at = unixepoch() \
             WHERE id = ?3 AND novel_id = ?4",
        )
        .bind(&change.next_path)
        .bind(&change.next_chapter_number)
        .bind(change.id)
        .bind(novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter: apply renumber chapter update: {err}"))?;
    }

    let changed_dirs: HashMap<i64, String> = job
        .changes
        .iter()
        .map(|c| (c.id, c.target_relative_dir.clone()))
        .collect();
    let directories: Vec<(i64, String)> = current
        .iter()
        .filter_map(|ch| {
            let dir = changed_dirs
                .get(&ch.id)
                .cloned()
                .or_else(|| ch.directory.clone())?;
            Some((ch.id, dir))
        })
        .collect();
    persist_work_chapter_directories_in_tx(root, conn, ctx, novel_id, &directories, root.is_some())
        .await?;

    let deletion_rows = sqlx::query(
        "SELECT cache_key, payload FROM content_sync_cache \
         WHERE cache_key LIKE 'norea-content-deletions:%'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: load content deletion exclusions: {err}"))?;

    let replacements: HashMap<&str, &str> = job
        .changes
        .iter()
        .map(|c| (c.chapter_number.as_str(), c.next_chapter_number.as_str()))
        .collect();

    for row in deletion_rows {
        let cache_key: String = row.get("cache_key");
        let payload: String = row.get("payload");
        let exclusions: Vec<String> = serde_json::from_str(&payload)
            .map_err(|_| "Stored chapter deletion exclusions are invalid.".to_string())?;
        let mut changed_exclusions = false;
        let mut next = Vec::with_capacity(exclusions.len());
        let mut seen = HashSet::new();
        for value in exclusions {
            let parsed_key: JsonValue = serde_json::from_str(&value)
                .map_err(|_| "Stored chapter deletion exclusions are invalid.".to_string())?;
            let mapped = if let Some(arr) = parsed_key.as_array() {
                if arr.len() == 3
                    && arr[0].as_str() == Some(job.work.plugin_id.as_str())
                    && arr[1].as_str() == Some(job.work.source_novel_id.as_str())
                    && arr[2]
                        .as_array()
                        .is_some_and(|inner| inner.len() == 2 && inner[0].as_str() == Some("number"))
                {
                    let inner_val = &arr[2].as_array().unwrap()[1];
                    let num_str = match inner_val {
                        JsonValue::Number(n) => n.to_string(),
                        JsonValue::String(s) => s.clone(),
                        _ => String::new(),
                    };
                    if let Some(canon) = canonical_renumber_chapter_number(&num_str) {
                        if let Some(&replacement) = replacements.get(canon.as_str()) {
                            let rep_num: i64 = replacement.parse().map_err(|_| {
                                "Stored chapter number mapping is invalid.".to_string()
                            })?;
                            changed_exclusions = true;
                            serde_json::to_string(&json!([
                                job.work.plugin_id,
                                job.work.source_novel_id,
                                ["number", rep_num]
                            ]))
                            .unwrap()
                        } else {
                            value
                        }
                    } else {
                        value
                    }
                } else {
                    value
                }
            } else {
                value
            };
            if seen.insert(mapped.clone()) {
                next.push(mapped);
            }
        }
        if changed_exclusions {
            let encoded = serde_json::to_string(&next).unwrap();
            sqlx::query("UPDATE content_sync_cache SET payload = ?1 WHERE cache_key = ?2")
                .bind(encoded)
                .bind(cache_key)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db chapter: update deletion exclusions: {err}"))?;
        }
    }

    Ok(job
        .changes
        .into_iter()
        .map(|c| c.chapter_number)
        .collect())
}

pub async fn commit_source_chapter_renumber_in_tx(
    conn: &mut SqliteConnection,
    raw_journal: &JsonValue,
) -> Result<(), String> {
    let job: ParsedRenumberJournalHeader = serde_json::from_value(raw_journal.clone())
        .map_err(|err| format!("Stored chapter number reconciliation is invalid: {err}"))?;
    let mut committed = raw_journal.clone();
    if let Some(obj) = committed.as_object_mut() {
        obj.insert("phase".to_string(), json!("committed"));
    } else {
        return Err("Stored chapter number reconciliation is invalid.".to_string());
    }
    let cache_key = format!("{SOURCE_CHAPTER_RENUMBER_PREFIX}{}", job.operation_id);
    let payload = serde_json::to_string(&committed)
        .map_err(|err| format!("db chapter: encode committed renumber journal: {err}"))?;
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(cache_key)
    .bind(payload)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db chapter: save committed renumber journal: {err}"))?;

    if let Some(server_url) = job.server_url {
        let mappings: Vec<JsonValue> = job
            .changes
            .iter()
            .map(|c| {
                json!({
                    "chapterPath": c.next_path,
                    "from": c.chapter_number,
                    "to": c.next_chapter_number,
                })
            })
            .collect();
        let remote = json!({
            "version": 1,
            "operationId": job.operation_id,
            "serverUrl": server_url,
            "identity": {
                "pluginId": job.work.plugin_id,
                "novelId": job.work.source_novel_id,
                "novelPath": job.work.path,
            },
            "mappings": mappings,
            "status": "pending",
            "createdAt": now_unix_millis(),
        });
        let remote_key = format!("{SERVER_CHAPTER_RENUMBER_PREFIX}{}", job.operation_id);
        let remote_payload = serde_json::to_string(&remote)
            .map_err(|err| format!("db chapter: encode server renumber job: {err}"))?;
        sqlx::query("INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)")
            .bind(remote_key)
            .bind(remote_payload)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: insert server renumber job: {err}"))?;
    }
    Ok(())
}

pub fn refresh_chapter_composition(
    previous: &ChapterCompositionV1Dto,
    plugin_id: &str,
    novel_id: &str,
    novel_path: &str,
    chapters: &[SyncSourceChapterItemDto],
    start_position: i64,
) -> Result<ChapterCompositionV1Dto, String> {
    let mut composition = previous.clone();
    let by_path: HashMap<&str, &SyncSourceChapterItemDto> =
        chapters.iter().map(|c| (c.path.as_str(), c)).collect();
    let positions: HashMap<&str, i64> = chapters
        .iter()
        .enumerate()
        .map(|(idx, c)| (c.path.as_str(), start_position + idx as i64))
        .collect();
    let mut by_stable_id: HashMap<&str, &SyncSourceChapterItemDto> = HashMap::new();
    let mut duplicate_stable_ids: HashSet<&str> = HashSet::new();
    for ch in chapters {
        if let Some(ref sid) = ch.source_chapter_id {
            if !sid.is_empty() {
                if by_stable_id.contains_key(sid.as_str()) {
                    duplicate_stable_ids.insert(sid.as_str());
                }
                by_stable_id.insert(sid.as_str(), ch);
            }
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let build_updated_source =
        |old_sid: Option<String>, ch: &SyncSourceChapterItemDto| -> ChapterSourceSnapshotDto {
            ChapterSourceSnapshotDto {
                plugin_id: plugin_id.to_string(),
                novel_id: novel_id.to_string(),
                novel_path: novel_path.to_string(),
                chapter_path: ch.path.clone(),
                source_chapter_id: ch.source_chapter_id.clone().or(old_sid),
                chapter_number: Some(format_f64_js(ch.chapter_number)),
                name: ch.name.clone(),
                position: *positions.get(ch.path.as_str()).unwrap_or(&1),
                page: ch.page.clone().unwrap_or_else(|| "1".to_string()),
                content_type: normalize_chapter_content_type(ch.content_type.as_deref())
                    .to_string(),
                release_time: ch.release_time.clone(),
            }
        };

    for entry in &mut composition.entries {
        for source in &mut entry.sources {
            if source.plugin_id != plugin_id || source.novel_id != novel_id {
                continue;
            }
            let exact = by_path.get(source.chapter_path.as_str()).copied();
            let stable = source
                .source_chapter_id
                .as_deref()
                .filter(|sid| !sid.is_empty() && !duplicate_stable_ids.contains(sid))
                .and_then(|sid| by_stable_id.get(sid).copied());
            let matched = stable.or_else(|| {
                exact.filter(|ex| {
                    source.source_chapter_id.is_none()
                        || ex.source_chapter_id.is_none()
                        || ex.source_chapter_id == source.source_chapter_id
                })
            });
            let Some(chapter) = matched else {
                continue;
            };
            seen.insert(chapter.path.clone());
            *source = build_updated_source(source.source_chapter_id.clone(), chapter);
        }
    }

    let mut storage_number: i64 = composition
        .entries
        .iter()
        .filter_map(|e| e.storage_chapter_number.parse::<f64>().ok())
        .map(|n| n.ceil() as i64)
        .max()
        .unwrap_or(0);
    let mut order: i64 = composition
        .entries
        .iter()
        .filter(|e| e.user.included)
        .count() as i64;
    let mut paths: HashSet<String> = composition.entries.iter().map(|e| e.path.clone()).collect();

    for ch in chapters {
        if seen.contains(&ch.path) {
            continue;
        }
        let id = random_uuid_v4()?;
        let source = build_updated_source(None, ch);
        order += 1;
        storage_number += 1;
        let path = if paths.contains(&ch.path) {
            format!(
                "norea-source:{}:{}:{}",
                js_encode_uri_component(plugin_id),
                js_encode_uri_component(novel_id),
                js_encode_uri_component(&ch.path)
            )
        } else {
            ch.path.clone()
        };
        paths.insert(path.clone());
        composition.entries.push(ChapterCompositionEntryDto {
            id,
            path,
            storage_chapter_number: storage_number.to_string(),
            sources: vec![source],
            primary_source: 0,
            user: ChapterCompositionUserDto {
                included: true,
                order,
                name: None,
                chapter_number: Some(order.to_string()),
            },
        });
    }

    if composition.entries != previous.entries {
        composition.updated_at = (previous.updated_at + 1).max(now_unix_millis());
    }
    let encoded = serde_json::to_value(&composition)
        .map_err(|err| format!("Chapter composition: encode refreshed: {err}"))?;
    parse_chapter_composition(&encoded)
}

pub async fn sync_novel_from_source_in_tx(
    metadata_root: &MetadataRoot,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &SyncNovelFromSourceInputDto,
) -> Result<SyncNovelPublishResultDto, String> {
    if optional_trimmed_text(Some(&input.novel_name)).is_none() {
        return Err(format!(
            "Plugin '{}' returned an empty novel name.",
            input.plugin_id
        ));
    }
    if let Some(expected_id) = input.expected_novel_id {
        let current: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM novel WHERE id = ?1 AND plugin_id = ?2 AND path = ?3",
        )
        .bind(expected_id)
        .bind(&input.plugin_id)
        .bind(&input.novel_path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db sync novel: verify expected novel id: {err}"))?;
        if current.is_none() {
            return Err(
                "Work no longer matches the source refresh; open it again before refreshing."
                    .to_string(),
            );
        }
    }

    let imported_identities: Vec<ImportedChapterIdentityDto> = input
        .chapters
        .iter()
        .map(|ch| ImportedChapterIdentityDto {
            path: ch.path.clone(),
            chapter_number: Some(format_f64_js(ch.chapter_number)),
        })
        .collect();
    let reconciled = reconcile_imported_novel_identity_in_tx(
        conn,
        &input.plugin_id,
        &input.novel_path,
        &imported_identities,
    )
    .await?;

    let stored_identity_row = sqlx::query(
        "SELECT n.source_novel_id, n.cover AS previous_cover, f.cover_fetched_at \
         FROM novel n \
         LEFT JOIN novel_freshness f ON f.novel_id = n.id \
         WHERE n.plugin_id = ?1 AND n.path = ?2",
    )
    .bind(&input.plugin_id)
    .bind(&input.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db sync novel: load stored identity: {err}"))?;

    let mut previous_cover: Option<String> = None;
    let mut cover_fetched_at: Option<i64> = None;
    if let Some(ref row) = stored_identity_row {
        let existing_source_id: Option<String> = row.get("source_novel_id");
        if let Some(ref prev_sid) = existing_source_id {
            if prev_sid != &input.source_novel_id {
                return Err(format!(
                    "Plugin '{}' changed a stored novel ID.",
                    input.plugin_id
                ));
            }
        }
        previous_cover = row.get("previous_cover");
        cover_fetched_at = row.get("cover_fetched_at");
    }

    let assign = |col: &str| -> String {
        if input.preserve_missing_metadata {
            format!("{col} = COALESCE(excluded.{col}, {col})")
        } else {
            format!("{col} = excluded.{col}")
        }
    };
    let changed = |col: &str| -> String {
        if input.preserve_missing_metadata {
            format!("{col} IS NOT COALESCE(excluded.{col}, {col})")
        } else {
            format!("{col} IS NOT excluded.{col}")
        }
    };

    let novel_upsert_sql = format!(
        "INSERT INTO novel \
           (plugin_id, path, name, cover, summary, author, artist, status, genres, rating, source_novel_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         ON CONFLICT(plugin_id, path) DO UPDATE SET \
           name = excluded.name, \
           source_novel_id = excluded.source_novel_id, \
           {}, {}, {}, {}, {}, {}, {}, \
           updated_at = unixepoch() \
          WHERE \
            source_novel_id IS NOT excluded.source_novel_id \
            OR name IS NOT excluded.name \
            OR {} OR {} OR {} OR {} OR {} OR {} OR {}",
        assign("cover"),
        assign("summary"),
        assign("author"),
        assign("artist"),
        assign("status"),
        assign("genres"),
        assign("rating"),
        changed("cover"),
        changed("summary"),
        changed("author"),
        changed("artist"),
        changed("status"),
        changed("genres"),
        changed("rating"),
    );

    let cover_in = optional_trimmed_text(input.cover.as_deref());
    let novel_result = sqlx::query(&novel_upsert_sql)
        .bind(&input.plugin_id)
        .bind(&input.novel_path)
        .bind(&input.novel_name)
        .bind(&cover_in)
        .bind(optional_trimmed_text(input.summary.as_deref()))
        .bind(optional_trimmed_text(input.author.as_deref()))
        .bind(optional_trimmed_text(input.artist.as_deref()))
        .bind(optional_trimmed_text(input.status.as_deref()))
        .bind(optional_trimmed_text(input.genres.as_deref()))
        .bind(input.rating)
        .bind(&input.source_novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db sync novel: upsert novel: {err}"))?;

    let novel_row = sqlx::query(
        "SELECT id, cover, in_library FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&input.plugin_id)
    .bind(&input.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db sync novel: resolve novel row: {err}"))?
    .ok_or_else(|| "sync-novel: failed to resolve local novel id".to_string())?;

    let novel_id: i64 = novel_row.get("id");
    let current_cover: Option<String> = novel_row.get("cover");
    let in_library: bool = novel_row.get::<i64, _>("in_library") != 0;

    let before_counts: Option<(i64, i64)> = if input.mark_found_by_check {
        Some(
            sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM chapter WHERE novel_id = ?1), \
                        (SELECT COALESCE(MAX(id), 0) FROM chapter)",
            )
            .bind(novel_id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db sync novel: query before chapter counts: {err}"))?,
        )
    } else {
        None
    };

    let resolved_root = metadata_root.resolve()?;
    let composition = get_chapter_composition_in_tx(conn, novel_id).await?;
    let mut replaced_chapter_numbers: Vec<String> = Vec::new();

    let changed_chapters: u64 = if let Some(ref comp) = composition {
        if input.renumber.is_some() {
            return Err(
                "A composed chapter list cannot be renumbered by a provider refresh.".to_string(),
            );
        }
        let updated = refresh_chapter_composition(
            comp,
            &input.plugin_id,
            &input.source_novel_id,
            &input.novel_path,
            &input.chapters,
            input.start_position,
        )?;
        let changed_entries = updated
            .entries
            .iter()
            .enumerate()
            .filter(|(idx, entry)| comp.entries.get(*idx) != Some(*entry))
            .count() as u64;
        materialize_chapter_composition_in_tx(
            resolved_root.as_deref(),
            conn,
            novel_id,
            &updated,
            &[],
        )
        .await?;
        set_chapter_composition_in_tx(conn, novel_id, Some(&updated)).await?;
        changed_entries
    } else {
        if let Some(ref raw_renumber) = input.renumber {
            replaced_chapter_numbers = apply_source_chapter_number_changes_in_tx(
                resolved_root.as_deref(),
                conn,
                ctx,
                novel_id,
                raw_renumber,
            )
            .await?;
        } else {
            let stored_renumber = read_renumber_chapters_in_conn(conn, novel_id).await?;
            let planned = plan_source_chapter_number_changes(
                &RenumberWorkDto {
                    id: novel_id,
                    plugin_id: input.plugin_id.clone(),
                    source_novel_id: input.source_novel_id.clone(),
                    path: input.novel_path.clone(),
                },
                &stored_renumber,
                &input.chapters,
            )?;
            if !planned.is_empty() {
                return Err(
                    "Chapter numbers changed during refresh. Refresh the complete chapter list again."
                        .to_string(),
                );
            }
        }

        let chapter_inputs: Vec<InsertChapterInputDto> = input
            .chapters
            .iter()
            .enumerate()
            .map(|(idx, ch)| InsertChapterInputDto {
                novel_id,
                path: ch.path.clone(),
                name: ch.name.clone(),
                position: input.start_position + idx as i64,
                chapter_number: Some(format_f64_js(ch.chapter_number)),
                page: Some(ch.page.clone().unwrap_or_else(|| "1".to_string())),
                release_time: ch.release_time.clone(),
                content_type: Some(
                    normalize_chapter_content_type(ch.content_type.as_deref()).to_string(),
                ),
            })
            .collect();
        upsert_source_chapters_in_tx(conn, ctx, &chapter_inputs)
            .await?
            .rows_affected
    };

    let new_chapters: u64 = match before_counts {
        Some((before_count, max_id)) if before_count > 0 => sqlx::query(
            "UPDATE chapter SET found_by_check = 1 WHERE novel_id = ?1 AND id > ?2",
        )
        .bind(novel_id)
        .bind(max_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db sync novel: mark found_by_check: {err}"))?
        .rows_affected(),
        _ => 0,
    };

    if !matches!(metadata_root, MetadataRoot::None) {
        if composition.is_some() {
            flush_dirty_in_tx(metadata_root, conn, ctx, None).await?;
        } else {
            let mut chapters_map = ChaptersMap::default();
            for ch in &input.chapters {
                chapters_map.insert(format_f64_js(ch.chapter_number), ch.name.clone());
            }
            let fetched = FetchedChapterCatalog {
                novel_id,
                chapters: chapters_map,
                replaced_chapter_numbers,
            };
            flush_dirty_in_tx(metadata_root, conn, ctx, Some(&fetched)).await?;
        }
    }

    let reconciled_changed = reconciled.as_ref().is_some_and(|r| r.changed);
    let novel_changed = novel_result.rows_affected() > 0 || reconciled_changed;
    let stored = novel_changed || changed_chapters > 0;
    let republish = stored || !input.mark_found_by_check;
    if republish {
        mark_work_metadata_refreshed_in_tx(conn, &input.plugin_id, &input.novel_path).await?;
    }
    if let Some(ref raw_renumber) = input.renumber {
        commit_source_chapter_renumber_in_tx(conn, raw_renumber).await?;
    }
    defer_user_state_for_novel_in_tx(conn, ctx, novel_id).await?;

    let effective_cover = if input.preserve_missing_metadata {
        optional_trimmed_text(current_cover.as_deref()).or(cover_in)
    } else {
        cover_in
    };
    let prev_trimmed = optional_trimmed_text(previous_cover.as_deref());
    let curr_trimmed = optional_trimmed_text(current_cover.as_deref());
    let cover_changed = prev_trimmed.is_some() && prev_trimmed != curr_trimmed;

    Ok(SyncNovelPublishResultDto {
        republish,
        changed_chapters,
        new_chapters,
        cover: effective_cover,
        cover_changed,
        cover_fetched_at,
        novel_changed,
        in_library,
        novel_id,
    })
}

#[tauri::command]
pub async fn db_chapter_find_local_imported(
    db: State<'_, AppDatabase>,
    path_key: String,
) -> Result<Option<LocalImportedChapterRefDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    find_local_imported_chapter_in_conn(&mut conn, &path_key).await
}

#[tauri::command]
pub async fn db_chapter_list_by_novel(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Vec<ChapterRowDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_chapters_by_novel_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_chapter_list_library_download(
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<Vec<LibraryDownloadChapterDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_library_download_chapters_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_chapter_list_unqueued_downloads(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    after_chapter_id: Option<i64>,
) -> Result<Vec<ChapterRowDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_unqueued_chapter_downloads_in_conn(&mut conn, novel_id, after_chapter_id.unwrap_or(0))
        .await
}

#[tauri::command]
pub async fn db_chapter_get_by_id(
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Option<ChapterRowDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    get_chapter_by_id_in_conn(&mut conn, chapter_id).await
}

#[tauri::command]
pub async fn db_chapter_list_existing_ids(
    db: State<'_, AppDatabase>,
    chapter_ids: Vec<i64>,
) -> Result<Vec<i64>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_existing_chapter_ids_in_conn(&mut conn, &chapter_ids).await
}

#[tauri::command]
pub async fn db_chapter_get_latest_source_anchor(
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<Option<LatestSourceChapterAnchorDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    get_latest_source_chapter_anchor_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_chapter_get_sync_since_anchor(
    db: State<'_, AppDatabase>,
    plugin_id: String,
    path: String,
    novel_id: Option<i64>,
) -> Result<Option<SyncSinceAnchorResponseDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    get_sync_since_anchor_in_conn(&mut conn, &plugin_id, &path, novel_id).await
}

#[tauri::command]
pub async fn db_chapter_get_adjacent(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    position: i64,
    direction: i64,
) -> Result<Option<ChapterRowDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    get_adjacent_chapter_in_conn(&mut conn, novel_id, position, direction).await
}

#[tauri::command]
pub async fn db_chapter_upsert_source(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    inputs: Vec<InsertChapterInputDto>,
    remote_content_sync: Option<bool>,
) -> Result<DbMutationEnvelope<BulkChapterMutationResultDto>, String> {
    validate_source_chapter_inputs(&inputs)?;
    let options = TxOptions {
        remote_content_sync: remote_content_sync.unwrap_or(false),
        ..TxOptions::with_app_metadata(app)
    };
    with_write_tx(db.writer(), options, move |conn, ctx| {
        Box::pin(async move { upsert_source_chapters_in_tx(conn, ctx, &inputs).await })
    })
    .await
}

#[tauri::command]
pub async fn db_chapter_upsert_downloaded(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    inputs: Vec<DownloadedChapterUpsertInputDto>,
) -> Result<DbMutationEnvelope<BulkChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { upsert_downloaded_chapters_in_tx(conn, &inputs).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_insert_if_absent(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: InsertChapterInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| Box::pin(async move { insert_chapter_if_absent_in_tx(conn, &input).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_upsert(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: InsertChapterInputDto,
) -> Result<DbMutationEnvelope<ChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| Box::pin(async move { upsert_chapter_in_tx(conn, &input).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_update_progress(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: UpdateChapterProgressInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move { update_chapter_progress_in_tx(conn, ctx, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_set_read_state(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: SetChaptersReadStateInputDto,
) -> Result<DbMutationEnvelope<BulkReadStateMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move {
                set_chapters_read_state_in_tx(conn, ctx, &input.chapter_ids, input.unread).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_set_novels_read_state(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: SetNovelsReadStateInputDto,
) -> Result<DbMutationEnvelope<BulkReadStateMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move {
                set_novels_read_state_in_tx(conn, ctx, &input.novel_ids, input.unread).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_restore_read_states(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    states: Vec<ChapterReadStateDto>,
) -> Result<DbMutationEnvelope<BulkChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move { restore_chapter_read_states_in_tx(conn, ctx, &states).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_set_relative_read_state(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: SetRelativeChaptersReadStateInputDto,
) -> Result<DbMutationEnvelope<RelativeReadStateMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move { set_relative_chapters_read_state_in_tx(conn, ctx, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_mark_opened(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { mark_chapter_opened_in_tx(conn, ctx, chapter_id).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_clear_novel_history(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { clear_novel_history_in_tx(conn, ctx, novel_id).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_set_bookmark(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    bookmarked: bool,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move { set_chapter_bookmark_in_tx(conn, ctx, chapter_id, bookmarked).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_save_content_metadata(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: SaveChapterContentMetadataInputDto,
) -> Result<DbMutationEnvelope<ChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { save_chapter_content_metadata_in_tx(conn, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_save_partial_content_metadata(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: SaveChapterPartialContentMetadataInputDto,
) -> Result<DbMutationEnvelope<ChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { save_chapter_partial_content_metadata_in_tx(conn, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_mark_media_repair_pending(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<DbMutationEnvelope<ChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { mark_chapter_media_repair_pending_in_tx(conn, chapter_id).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_adopt_stored_content_metadata(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: AdoptStoredChapterContentInputDto,
) -> Result<DbMutationEnvelope<ChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { adopt_stored_chapter_content_metadata_in_tx(conn, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_mark_stored_content_missing(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<DbMutationEnvelope<ChapterMutationResultDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { mark_stored_chapter_content_missing_in_tx(conn, chapter_id).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_clear_content(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| Box::pin(async move { clear_chapter_content_in_tx(conn, chapter_id).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_list_library_updates(
    db: State<'_, AppDatabase>,
    input: Option<ListLibraryUpdatesInputDto>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<LibraryUpdateEntryDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_library_updates_in_conn(&mut conn, &input.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_chapter_count_new_since(
    db: State<'_, AppDatabase>,
    seen_at: i64,
    read_mode: Option<ReadMode>,
) -> Result<i64, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    count_new_library_chapters_since_in_conn(&mut conn, seen_at).await
}

#[tauri::command]
pub async fn db_chapter_list_recently_read(
    db: State<'_, AppDatabase>,
    limit: Option<i64>,
) -> Result<Vec<RecentlyReadEntryDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_recently_read_in_conn(&mut conn, limit).await
}

#[tauri::command]
pub async fn db_chapter_list_continue_reading(
    db: State<'_, AppDatabase>,
    limit: Option<i64>,
) -> Result<Vec<ContinueReadingEntryDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_continue_reading_in_conn(&mut conn, limit).await
}

#[tauri::command]
pub async fn db_chapter_list_reading_history_page(
    db: State<'_, AppDatabase>,
    input: Option<ListReadingHistoryPageInputDto>,
    read_mode: Option<ReadMode>,
) -> Result<HistoryPageDto, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_reading_history_page_in_conn(&mut conn, &input.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_chapter_list_cleanup_candidates(
    db: State<'_, AppDatabase>,
    input: ListChapterCleanupCandidatesInputDto,
    read_mode: Option<ReadMode>,
) -> Result<Vec<ChapterCleanupCandidateDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or(ReadMode::Committed))
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_chapter_cleanup_candidates_in_conn(&mut conn, &input).await
}

#[tauri::command]
pub async fn db_chapter_reconcile_cleaned(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: ReconcileCleanedChapterInputDto,
) -> Result<DbMutationEnvelope<u64>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| Box::pin(async move { reconcile_cleaned_chapter_in_tx(conn, &input).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_chapter_get_storage_row(
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Option<ChapterStorageRowDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    get_chapter_storage_row_in_conn(&mut conn, chapter_id).await
}

#[tauri::command]
pub async fn db_chapter_list_storage_rows(
    db: State<'_, AppDatabase>,
    input: Option<ListChapterStorageRowsInputDto>,
) -> Result<Vec<ChapterStorageRowDto>, String> {
    let mut conn = db
        .writer()
        .acquire()
        .await
        .map_err(|err| format!("db chapter: acquire connection: {err}"))?;
    list_chapter_storage_rows_in_conn(&mut conn, &input.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_novel_sync_from_source(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: SyncNovelFromSourceInputDto,
) -> Result<DbMutationEnvelope<SyncNovelPublishResultDto>, String> {
    let metadata_root = MetadataRoot::App(app.clone());
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move {
                sync_novel_from_source_in_tx(&metadata_root, conn, ctx, &input).await
            })
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;
    use std::time::Duration;

    #[tokio::test]
    async fn upsert_source_chapters_migrates_paths_and_projects_composition_display() {
        let test_db = open_test_db().await;
        with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library) \
                     VALUES (1, 'demo-plugin', 'book-1', '/book-1', 'Book 1', 1)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();

                let initial = vec![
                    InsertChapterInputDto {
                        novel_id: 1,
                        path: "/old/1".to_string(),
                        name: "Episode 1".to_string(),
                        position: 1,
                        chapter_number: Some("1".to_string()),
                        page: Some("1".to_string()),
                        release_time: None,
                        content_type: None,
                    },
                    InsertChapterInputDto {
                        novel_id: 1,
                        path: "/old/2".to_string(),
                        name: "Episode 2".to_string(),
                        position: 2,
                        chapter_number: Some("2".to_string()),
                        page: Some("1".to_string()),
                        release_time: None,
                        content_type: None,
                    },
                ];
                let res = upsert_source_chapters_in_tx(conn, ctx, &initial).await?;
                assert_eq!(res.rows_affected, 2);

                let migrated = vec![InsertChapterInputDto {
                    novel_id: 1,
                    path: "/new/1".to_string(),
                    name: "Episode 1 Renamed".to_string(),
                    position: 1,
                    chapter_number: Some("1".to_string()),
                    page: Some("1".to_string()),
                    release_time: None,
                    content_type: None,
                }];
                upsert_source_chapters_in_tx(conn, ctx, &migrated).await?;
                Ok(())
            })
        })
        .await
        .unwrap();

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        let chapters = list_chapters_by_novel_in_conn(&mut conn, 1).await.unwrap();
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].path, "/new/1");
        assert_eq!(chapters[0].name, "Episode 1 Renamed");

        let composition = ChapterCompositionV1Dto {
            version: 1,
            updated_at: 1000,
            entries: vec![ChapterCompositionEntryDto {
                id: "entry-1".to_string(),
                path: "/new/1".to_string(),
                storage_chapter_number: "1".to_string(),
                sources: vec![ChapterSourceSnapshotDto {
                    plugin_id: "demo-plugin".to_string(),
                    novel_id: "book-1".to_string(),
                    novel_path: "/book-1".to_string(),
                    chapter_path: "/new/1".to_string(),
                    source_chapter_id: None,
                    chapter_number: Some("1".to_string()),
                    name: "Episode 1 Renamed".to_string(),
                    position: 1,
                    page: "1".to_string(),
                    content_type: "html".to_string(),
                    release_time: None,
                }],
                primary_source: 0,
                user: ChapterCompositionUserDto {
                    included: true,
                    order: 1,
                    name: None,
                    chapter_number: Some("101".to_string()),
                },
            }],
        };
        drop(conn);

        with_write_tx(test_db.db.writer(), TxOptions::default(), move |conn, _ctx| {
            Box::pin(async move {
                set_chapter_composition_in_tx(conn, 1, Some(&composition)).await
            })
        })
        .await
        .unwrap();

        let mut reader_conn = test_db.db.reader().acquire().await.unwrap();
        let composed_chapters = list_chapters_by_novel_in_conn(&mut reader_conn, 1)
            .await
            .unwrap();
        assert_eq!(
            composed_chapters[0].display_chapter_number.as_deref(),
            Some("101")
        );
        assert!(composed_chapters[0].composition_source.is_some());
        drop(reader_conn);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn progress_read_state_continue_reading_and_history_work_atomically() {
        let test_db = open_test_db().await;
        with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library) \
                     VALUES (1, 'demo-plugin', 'book-1', '/book-1', 'Dragon Tales', 1)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO chapter (id, novel_id, path, name, chapter_number, position, unread, progress) VALUES \
                     (11, 1, '/c1', 'Prologue', '1', 1, 1, 0), \
                     (12, 1, '/c2', 'Chapter Two', '2', 2, 1, 0), \
                     (13, 1, '/c3', 'Chapter Three', '3', 3, 1, 0)",
                )
                .execute(&mut *conn)
                .await
                .unwrap();

                update_chapter_progress_in_tx(
                    conn,
                    ctx,
                    &UpdateChapterProgressInputDto {
                        chapter_id: 11,
                        progress: 100.0,
                        record_history: Some(true),
                    },
                )
                .await?;
                // Reopening a finished chapter at 35% must keep progress at 100%.
                update_chapter_progress_in_tx(
                    conn,
                    ctx,
                    &UpdateChapterProgressInputDto {
                        chapter_id: 11,
                        progress: 35.0,
                        record_history: Some(true),
                    },
                )
                .await?;

                // Private progress update must not set read_at.
                update_chapter_progress_in_tx(
                    conn,
                    ctx,
                    &UpdateChapterProgressInputDto {
                        chapter_id: 12,
                        progress: 45.0,
                        record_history: Some(false),
                    },
                )
                .await?;

                let rel = set_relative_chapters_read_state_in_tx(
                    conn,
                    ctx,
                    &SetRelativeChaptersReadStateInputDto {
                        anchor_chapter_id: 12,
                        direction: "after".to_string(),
                        unread: false,
                    },
                )
                .await?;
                assert_eq!(rel.rows_affected, 1);
                assert_eq!(rel.previous.len(), 1);
                assert_eq!(rel.previous[0].id, 13);

                restore_chapter_read_states_in_tx(conn, ctx, &rel.previous).await?;
                set_chapter_bookmark_in_tx(conn, ctx, 13, true).await?;
                Ok(())
            })
        })
        .await
        .unwrap();

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        let ch11 = get_chapter_by_id_in_conn(&mut conn, 11)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ch11.progress, 100.0);
        assert!(!ch11.unread);
        assert!(ch11.read_at.is_some());

        let ch12 = get_chapter_by_id_in_conn(&mut conn, 12)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ch12.progress, 45.0);
        assert!(ch12.read_at.is_none());

        let ch13 = get_chapter_by_id_in_conn(&mut conn, 13)
            .await
            .unwrap()
            .unwrap();
        assert!(ch13.unread);
        assert!(ch13.bookmark);

        let cont_undownloaded = list_continue_reading_in_conn(&mut conn, None).await.unwrap();
        assert!(cont_undownloaded.is_empty());

        sqlx::query("UPDATE chapter SET is_downloaded = 1, content_bytes = 64 WHERE id = 12")
            .execute(&mut *conn)
            .await
            .unwrap();

        let cont = list_continue_reading_in_conn(&mut conn, None).await.unwrap();
        assert_eq!(cont.len(), 1);
        assert_eq!(cont[0].chapter_id, 11);
        assert_eq!(cont[0].next_chapter_id, Some(12));
        assert_eq!(cont[0].progress, 100.0);

        // Even if a read chapter (unread = 0) had stored progress < 100, continue reading
        // reports it as finished (100.0) so callers advance to the downloaded next chapter.
        sqlx::query("UPDATE chapter SET unread = 0, progress = 50.0 WHERE id = 11")
            .execute(&mut *conn)
            .await
            .unwrap();
        let cont_read_low_progress = list_continue_reading_in_conn(&mut conn, None).await.unwrap();
        assert_eq!(cont_read_low_progress.len(), 1);
        assert_eq!(cont_read_low_progress[0].chapter_id, 11);
        assert_eq!(cont_read_low_progress[0].progress, 100.0);
        assert_eq!(cont_read_low_progress[0].next_chapter_id, Some(12));
        sqlx::query("UPDATE chapter SET progress = 100.0 WHERE id = 11")
            .execute(&mut *conn)
            .await
            .unwrap();

        let hist = list_reading_history_page_in_conn(
            &mut conn,
            &ListReadingHistoryPageInputDto {
                search: Some("dragon".to_string()),
                progress: Some("finished".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(hist.entries.len(), 1);
        assert_eq!(hist.entries[0].chapter_id, 11);
        drop(conn);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn sync_novel_from_source_publishes_metadata_and_handles_renumber_journal() {
        let test_db = open_test_db().await;
        let media_dir = test_db.dir.path().join("media");
        std::fs::create_dir_all(&media_dir).unwrap();
        let meta_root = MetadataRoot::Path(media_dir.clone());
        let tx_opts = TxOptions {
            metadata_root: meta_root.clone(),
            ..TxOptions::default()
        };

        let meta_clone = meta_root.clone();
        let initial_res = with_write_tx(test_db.db.writer(), tx_opts.clone(), move |conn, ctx| {
            Box::pin(async move {
                sync_novel_from_source_in_tx(
                    &meta_clone,
                    conn,
                    ctx,
                    &SyncNovelFromSourceInputDto {
                        plugin_id: "demo-plugin".to_string(),
                        novel_path: "/works/alpha".to_string(),
                        item_name: "Alpha".to_string(),
                        novel_name: "Alpha Novel".to_string(),
                        source_novel_id: "alpha-1".to_string(),
                        cover: Some("https://example.com/cover.jpg".to_string()),
                        summary: Some("Summary".to_string()),
                        author: Some("Author".to_string()),
                        artist: None,
                        status: Some("Ongoing".to_string()),
                        genres: None,
                        rating: Some(4.5),
                        preserve_missing_metadata: true,
                        mark_found_by_check: false,
                        start_position: 1,
                        expected_novel_id: None,
                        chapters: vec![
                            SyncSourceChapterItemDto {
                                path: "/works/alpha/1".to_string(),
                                name: "Ch 1".to_string(),
                                chapter_number: 1.0,
                                source_chapter_id: None,
                                page: None,
                                release_time: None,
                                content_type: None,
                            },
                            SyncSourceChapterItemDto {
                                path: "/works/alpha/2".to_string(),
                                name: "Ch 2".to_string(),
                                chapter_number: 2.0,
                                source_chapter_id: None,
                                page: None,
                                release_time: None,
                                content_type: None,
                            },
                        ],
                        renumber: None,
                    },
                )
                .await
            })
        })
        .await
        .unwrap()
        .value;

        assert_eq!(initial_res.changed_chapters, 2);
        assert!(media_dir
            .join("contents/demo-plugin/alpha-1/novel.json")
            .exists());

        // Check for new chapters flags newly inserted rows with found_by_check = 1.
        let meta_clone2 = meta_root.clone();
        let check_res = with_write_tx(test_db.db.writer(), tx_opts, move |conn, ctx| {
            Box::pin(async move {
                sqlx::query("UPDATE novel SET in_library = 1 WHERE id = ?1")
                    .bind(initial_res.novel_id)
                    .execute(&mut *conn)
                    .await
                    .unwrap();
                sync_novel_from_source_in_tx(
                    &meta_clone2,
                    conn,
                    ctx,
                    &SyncNovelFromSourceInputDto {
                        plugin_id: "demo-plugin".to_string(),
                        novel_path: "/works/alpha".to_string(),
                        item_name: "Alpha".to_string(),
                        novel_name: "Alpha Novel".to_string(),
                        source_novel_id: "alpha-1".to_string(),
                        cover: None,
                        summary: None,
                        author: None,
                        artist: None,
                        status: None,
                        genres: None,
                        rating: None,
                        preserve_missing_metadata: true,
                        mark_found_by_check: true,
                        start_position: 2,
                        expected_novel_id: Some(initial_res.novel_id),
                        chapters: vec![
                            SyncSourceChapterItemDto {
                                path: "/works/alpha/2".to_string(),
                                name: "Ch 2".to_string(),
                                chapter_number: 2.0,
                                source_chapter_id: None,
                                page: None,
                                release_time: None,
                                content_type: None,
                            },
                            SyncSourceChapterItemDto {
                                path: "/works/alpha/3".to_string(),
                                name: "Ch 3".to_string(),
                                chapter_number: 3.0,
                                source_chapter_id: None,
                                page: None,
                                release_time: Some("2026-11-01".to_string()),
                                content_type: None,
                            },
                        ],
                        renumber: None,
                    },
                )
                .await
            })
        })
        .await
        .unwrap()
        .value;

        assert_eq!(check_res.new_chapters, 1);
        let mut conn = test_db.db.reader().acquire().await.unwrap();
        let updates = list_library_updates_in_conn(&mut conn, &ListLibraryUpdatesInputDto::default())
            .await
            .unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].chapter_name, "Ch 3");
        drop(conn);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn committed_reader_queries_do_not_block_while_writer_transaction_is_open() {
        let test_db = open_test_db().await;
        sqlx::query(
            "INSERT INTO novel (id, plugin_id, path, name, in_library) VALUES (1, 'demo', '/n1', 'Novel 1', 1)",
        )
        .execute(test_db.db.writer())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter (id, novel_id, path, name, position, progress, read_at) \
             VALUES (10, 1, '/c1', 'Ch 1', 1, 50, 1000)",
        )
        .execute(test_db.db.writer())
        .await
        .unwrap();

        // Hold an uncommitted BEGIN IMMEDIATE write transaction open on the single-connection writer pool.
        let mut write_tx = test_db
            .db
            .writer()
            .begin_with("BEGIN IMMEDIATE")
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO chapter (id, novel_id, path, name, position) VALUES (11, 1, '/c2', 'Uncommitted Ch 2', 2)",
        )
        .execute(&mut *write_tx)
        .await
        .unwrap();

        // Concurrent ReadMode::Committed reads on the reader pool must complete immediately and see committed snapshot.
        let reader_result = tokio::time::timeout(Duration::from_millis(500), async {
            let mut reader_conn = test_db
                .db
                .pool_for(ReadMode::Committed)
                .acquire()
                .await
                .unwrap();
            let chapters = list_chapters_by_novel_in_conn(&mut reader_conn, 1)
                .await
                .unwrap();
            let history = list_reading_history_page_in_conn(
                &mut reader_conn,
                &ListReadingHistoryPageInputDto::default(),
            )
            .await
            .unwrap();
            (chapters, history)
        })
        .await
        .expect("reader pool must not block on uncommitted writer tx");

        assert_eq!(reader_result.0.len(), 1);
        assert_eq!(reader_result.0[0].id, 10);
        assert_eq!(reader_result.1.entries.len(), 1);

        write_tx.commit().await.unwrap();
        test_db.db.close().await;
    }
}
