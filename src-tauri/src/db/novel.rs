use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;

use super::category::UNCATEGORIZED_CATEGORY_ID;
use super::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use super::user_state::{
    core::{has_user_state_schema_in_tx, record_library_in_tx},
    defer_user_state_for_novel_in_tx,
};
use super::work_metadata::persist_work_chapter_directories_in_tx;
use super::{decode_sqlite_f64, decode_sqlite_opt_f64, DbMutationEnvelope, ReadMode};

pub const LOCAL_PLUGIN_ID: &str = "local";
pub const LOCAL_NOVEL_PATH: &str = "local";

const MAX_ROUTE_QUERY_ROWS: i64 = 500;
const DEFAULT_LIBRARY_PAGE_LIMIT: i64 = 100;
const MAX_INLINE_IPC_BYTES: i64 = 128 * 1024 * 1024;
const MAX_CHAPTER_BULK_INPUT_ROWS: usize = 50_000;
const MAX_CHAPTER_TITLE_BYTES: usize = 8 * 1024;
const MAX_CHAPTER_URL_BYTES: usize = 32 * 1024;
const DOWNLOADED_CHAPTER_CHUNK_SIZE: usize = 90;
const MAX_SAFE_INT_I64: i64 = 9_007_199_254_740_991;
const FOLDER_PREFIX: &str = "norea-folder:";

const LIBRARY_STORED_CHAPTER_COUNT_SQL: &str = "(COALESCE(s.chapters_downloaded, 0) + ( \
  SELECT COUNT(*) FROM chapter stored \
  WHERE stored.novel_id = n.id AND stored.is_downloaded = 0 AND stored.content_bytes > 0 \
))";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelDto {
    pub id: i64,
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub source_novel_id: Option<String>,
    pub path: String,
    pub name: String,
    pub cover: Option<String>,
    pub author: Option<String>,
    pub in_library: bool,
    pub is_local: bool,
    pub total_chapters: i64,
    pub chapters_downloaded: i64,
    pub chapters_unread: i64,
    pub reading_progress: f64,
    pub last_read_at: Option<i64>,
    pub last_updated_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFilterDto {
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub category_id: Option<i64>,
    #[serde(default)]
    pub downloaded_only: Option<bool>,
    #[serde(default)]
    pub repair_needed_only: Option<bool>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub unread_only: Option<bool>,
    #[serde(default)]
    pub local_only: Option<bool>,
    #[serde(default)]
    pub completed_only: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelCursorDto {
    pub id: i64,
    pub name: String,
    pub sort_value: JsonValue,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelPageFilterDto {
    #[serde(flatten)]
    pub filter: LibraryFilterDto,
    #[serde(default)]
    pub cursor: Option<LibraryNovelCursorDto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelPageDto {
    pub has_more: bool,
    pub next_cursor: Option<LibraryNovelCursorDto>,
    pub novels: Vec<LibraryNovelDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelSummaryDto {
    pub complete_novels: i64,
    pub downloaded_chapters: i64,
    pub downloaded_novels: i64,
    pub last_updated_at: Option<i64>,
    pub local_novels: i64,
    pub repair_needed_novels: i64,
    pub total_chapters: i64,
    pub total_novels: i64,
    pub unread_chapters: i64,
    pub unread_novels: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySourceFilterDto {
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub total_novels: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelIdentityDto {
    pub plugin_id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryNovelRefreshTargetDto {
    pub id: i64,
    pub plugin_id: String,
    pub path: String,
    pub name: String,
    pub cover: Option<String>,
    pub is_local: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelForCheckDto {
    pub id: i64,
    pub plugin_id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelDetailRecordDto {
    pub id: i64,
    pub source_novel_id: Option<String>,
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub path: String,
    pub name: String,
    pub cover: Option<String>,
    pub summary: Option<String>,
    pub author: Option<String>,
    pub artist: Option<String>,
    pub status: Option<String>,
    pub genres: Option<String>,
    pub rating: Option<f64>,
    pub in_library: bool,
    pub is_local: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub library_added_at: Option<i64>,
    pub last_read_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertNovelInputDto {
    pub plugin_id: String,
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub in_library: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedChapterIdentityDto {
    pub path: String,
    #[serde(default)]
    pub chapter_number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledNovelIdentityDto {
    pub id: i64,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedChapterUpsertInputDto {
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
    #[serde(default)]
    pub content_bytes: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkChapterMutationResultDto {
    pub rows_affected: u64,
    pub chunks: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChapterOrderMutationResultDto {
    pub rows_affected: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNovelMetadataInputDto {
    pub name: String,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNovelImportChapterInputDto {
    pub path: String,
    pub name: String,
    pub position: i64,
    #[serde(default)]
    pub content_type: Option<String>,
    pub content_bytes: i64,
    #[serde(default)]
    pub chapter_number: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub release_time: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNovelImportInputDto {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default = "default_true")]
    pub has_cover: bool,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default = "default_true")]
    pub has_summary: bool,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default = "default_true")]
    pub has_author: bool,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default = "default_true")]
    pub has_artist: bool,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default = "default_true")]
    pub has_status: bool,
    #[serde(default)]
    pub genres: Option<String>,
    #[serde(default = "default_true")]
    pub has_genres: bool,
    pub chapters: Vec<LocalNovelImportChapterInputDto>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalNovelImportResultDto {
    pub changed: bool,
    pub changed_chapters: u64,
    pub novel_id: i64,
    pub chapter_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkChapterDirectoryInputDto {
    pub id: i64,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelFreshnessDto {
    pub novel_id: i64,
    pub last_checked_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub consecutive_failures: i64,
    pub last_new_chapter_at: Option<i64>,
    pub cover_fetched_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCandidateDto {
    pub novel_id: i64,
    pub plugin_id: String,
    pub status: Option<String>,
    pub last_read_at: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub consecutive_failures: i64,
    pub total_chapters: i64,
    pub unread_chapters: i64,
    pub has_goal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCheckCountDto {
    pub plugin_id: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NovelDownloadGoalDto {
    KeepAhead { count: i64 },
    AllRemaining,
    Entire,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNovelDownloadGoalDto {
    pub novel_id: i64,
    pub goal: NovelDownloadGoalDto,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadGoalNovelDto {
    pub id: i64,
    pub plugin_id: String,
    pub path: String,
    pub name: String,
    pub last_read_at: Option<i64>,
    pub goal: Option<NovelDownloadGoalDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelWithoutGoalDto {
    pub id: i64,
    pub plugin_id: String,
}

#[derive(Debug, Clone)]
enum SqlParam {
    Int(i64),
    Text(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LibraryCursorKind {
    Name,
    Unique,
    ValueName,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SortValueKind {
    Number,
    Text,
}

struct LibrarySortSpec {
    cursor_column: &'static str,
    cursor_kind: LibraryCursorKind,
    direction: SortDirection,
    order_by: &'static str,
    value_kind: SortValueKind,
}

fn library_sort_spec(sort_order: Option<&str>) -> (&'static str, LibrarySortSpec) {
    let key = sort_order.unwrap_or("dateAddedDesc");
    match key {
        "nameAsc" => (
            "nameAsc",
            LibrarySortSpec {
                cursor_column: "name",
                cursor_kind: LibraryCursorKind::Name,
                direction: SortDirection::Asc,
                order_by: "name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Text,
            },
        ),
        "nameDesc" => (
            "nameDesc",
            LibrarySortSpec {
                cursor_column: "name",
                cursor_kind: LibraryCursorKind::Name,
                direction: SortDirection::Desc,
                order_by: "name COLLATE NOCASE DESC, id ASC",
                value_kind: SortValueKind::Text,
            },
        ),
        "downloadedAsc" => (
            "downloadedAsc",
            LibrarySortSpec {
                cursor_column: "chaptersDownloaded",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Asc,
                order_by: "chaptersDownloaded ASC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "downloadedDesc" => (
            "downloadedDesc",
            LibrarySortSpec {
                cursor_column: "chaptersDownloaded",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Desc,
                order_by: "chaptersDownloaded DESC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "undownloadedAsc" => (
            "undownloadedAsc",
            LibrarySortSpec {
                cursor_column: "chaptersUndownloaded",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Asc,
                order_by: "chaptersUndownloaded ASC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "undownloadedDesc" => (
            "undownloadedDesc",
            LibrarySortSpec {
                cursor_column: "chaptersUndownloaded",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Desc,
                order_by: "chaptersUndownloaded DESC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "totalChaptersAsc" => (
            "totalChaptersAsc",
            LibrarySortSpec {
                cursor_column: "totalChapters",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Asc,
                order_by: "totalChapters ASC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "totalChaptersDesc" => (
            "totalChaptersDesc",
            LibrarySortSpec {
                cursor_column: "totalChapters",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Desc,
                order_by: "totalChapters DESC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "unreadChaptersAsc" => (
            "unreadChaptersAsc",
            LibrarySortSpec {
                cursor_column: "chaptersUnread",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Asc,
                order_by: "chaptersUnread ASC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "unreadChaptersDesc" => (
            "unreadChaptersDesc",
            LibrarySortSpec {
                cursor_column: "chaptersUnread",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Desc,
                order_by: "chaptersUnread DESC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "dateAddedAsc" => (
            "dateAddedAsc",
            LibrarySortSpec {
                cursor_column: "id",
                cursor_kind: LibraryCursorKind::Unique,
                direction: SortDirection::Asc,
                order_by: "id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "lastReadAsc" => (
            "lastReadAsc",
            LibrarySortSpec {
                cursor_column: "lastReadSort",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Asc,
                order_by: "lastReadSort ASC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "lastReadDesc" => (
            "lastReadDesc",
            LibrarySortSpec {
                cursor_column: "lastReadSort",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Desc,
                order_by: "lastReadSort DESC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "lastUpdatedAsc" => (
            "lastUpdatedAsc",
            LibrarySortSpec {
                cursor_column: "lastUpdatedAt",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Asc,
                order_by: "lastUpdatedAt ASC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        "lastUpdatedDesc" => (
            "lastUpdatedDesc",
            LibrarySortSpec {
                cursor_column: "lastUpdatedAt",
                cursor_kind: LibraryCursorKind::ValueName,
                direction: SortDirection::Desc,
                order_by: "lastUpdatedAt DESC, name COLLATE NOCASE ASC, id ASC",
                value_kind: SortValueKind::Number,
            },
        ),
        _ => (
            "dateAddedDesc",
            LibrarySortSpec {
                cursor_column: "id",
                cursor_kind: LibraryCursorKind::Unique,
                direction: SortDirection::Desc,
                order_by: "id DESC",
                value_kind: SortValueKind::Number,
            },
        ),
    }
}

fn novel_sort_value(sort_key: &str, novel: &LibraryNovelDto) -> JsonValue {
    match sort_key {
        "nameAsc" | "nameDesc" => JsonValue::String(novel.name.clone()),
        "downloadedAsc" | "downloadedDesc" => JsonValue::from(novel.chapters_downloaded),
        "undownloadedAsc" | "undownloadedDesc" => {
            JsonValue::from((novel.total_chapters - novel.chapters_downloaded).max(0))
        }
        "totalChaptersAsc" | "totalChaptersDesc" => JsonValue::from(novel.total_chapters),
        "unreadChaptersAsc" | "unreadChaptersDesc" => JsonValue::from(novel.chapters_unread),
        "dateAddedAsc" | "dateAddedDesc" => JsonValue::from(novel.id),
        "lastReadAsc" | "lastReadDesc" => JsonValue::from(novel.last_read_at.unwrap_or(0)),
        "lastUpdatedAsc" | "lastUpdatedDesc" => JsonValue::from(novel.last_updated_at),
        _ => JsonValue::from(novel.id),
    }
}

pub fn is_local_cover_source(value: Option<&str>) -> bool {
    let Some(trimmed) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let Some((prefix, payload)) = trimmed.split_once(';') else {
        return false;
    };
    if !matches!(
        prefix.to_ascii_lowercase().as_str(),
        "data:image/avif"
            | "data:image/gif"
            | "data:image/jpeg"
            | "data:image/jpg"
            | "data:image/png"
            | "data:image/webp"
    ) {
        return false;
    }
    if payload.len() <= 7 || !payload[..7].eq_ignore_ascii_case("base64,") {
        return false;
    }
    let b64 = &payload[7..];
    let trimmed_eq = b64.trim_end_matches('=');
    !trimmed_eq.is_empty()
        && trimmed_eq
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn display_local_cover(value: Option<String>) -> Option<String> {
    value.filter(|v| is_local_cover_source(Some(v.as_str())))
}

fn nullable_text(value: Option<&str>) -> Option<String> {
    let trimmed = value.unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn nullable_local_cover(value: Option<&str>) -> Option<String> {
    let trimmed = nullable_text(value)?;
    if is_local_cover_source(Some(&trimmed)) {
        Some(trimmed)
    } else {
        None
    }
}

fn is_local_novel(plugin_id: &str, raw_is_local: i64) -> bool {
    plugin_id == LOCAL_PLUGIN_ID && raw_is_local != 0
}

pub fn normalize_chapter_content_type(value: Option<&str>) -> &'static str {
    match value {
        Some("html") => "html",
        Some("text") => "text",
        Some("pdf") => "pdf",
        Some("markdown") => "markdown",
        Some("epub") => "epub",
        _ => "html",
    }
}

pub fn stored_chapter_content_type(content_type: &str) -> &'static str {
    match content_type {
        "text" | "markdown" => "html",
        "pdf" => "pdf",
        "epub" => "epub",
        _ => "html",
    }
}

fn clamp_route_query_limit(limit: i64, fallback: i64) -> i64 {
    let normalized = if limit > 0 { limit } else { fallback.max(1) };
    normalized.min(MAX_ROUTE_QUERY_ROWS)
}

fn format_bytes(bytes: usize) -> String {
    let mib = bytes as f64 / (1024.0 * 1024.0);
    if mib >= 1.0 {
        if (mib - mib.round()).abs() < f64::EPSILON {
            format!("{} MiB", mib as usize)
        } else {
            format!("{mib:.1} MiB")
        }
    } else {
        let kib = bytes as f64 / 1024.0;
        if (kib - kib.round()).abs() < f64::EPSILON {
            format!("{} KiB", kib as usize)
        } else {
            format!("{kib:.1} KiB")
        }
    }
}

pub fn assert_byte_budget(byte_len: i64, max_bytes: usize, label: &str) -> Result<(), String> {
    if byte_len < 0 {
        return Err(format!("{label} size is not available."));
    }
    let len = byte_len as usize;
    if len > max_bytes {
        return Err(format!(
            "{label} is {}, which exceeds the {} limit.",
            format_bytes(len),
            format_bytes(max_bytes)
        ));
    }
    Ok(())
}

fn add_param(params: &mut Vec<SqlParam>, value: SqlParam) -> String {
    params.push(value);
    format!("?{}", params.len())
}

fn bind_sql_params<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    params: &'q [SqlParam],
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for param in params {
        query = match param {
            SqlParam::Int(v) => query.bind(*v),
            SqlParam::Text(v) => query.bind(v.as_str()),
        };
    }
    query
}

fn build_library_filter_conditions(
    filter: &LibraryFilterDto,
    params: &mut Vec<SqlParam>,
) -> Vec<String> {
    let mut conditions = vec!["n.in_library = 1".to_string()];

    if let Some(search) = filter.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let p = add_param(params, SqlParam::Text(search.to_string()));
        conditions.push(format!("n.name LIKE '%' || {p} || '%' COLLATE NOCASE"));
    }
    if filter.category_id == Some(UNCATEGORIZED_CATEGORY_ID) {
        conditions.push(
            "NOT EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id)".to_string(),
        );
    } else if let Some(category_id) = filter.category_id {
        let p = add_param(params, SqlParam::Int(category_id));
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id AND nc.category_id = {p})"
        ));
    }
    if filter.downloaded_only.unwrap_or(false) {
        conditions.push(format!(
            "(n.is_local = 1 OR {LIBRARY_STORED_CHAPTER_COUNT_SQL} > 0)"
        ));
    }
    if filter.repair_needed_only.unwrap_or(false) {
        conditions.push(
            "EXISTS (SELECT 1 FROM chapter c WHERE c.novel_id = n.id AND c.media_repair_needed = 1)"
                .to_string(),
        );
    }
    if let Some(source_id) = filter
        .source_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let p = add_param(params, SqlParam::Text(source_id.to_string()));
        conditions.push(format!("n.plugin_id = {p}"));
    }
    if filter.unread_only.unwrap_or(false) {
        conditions.push("COALESCE(s.chapters_unread, 0) > 0".to_string());
    }
    if filter.local_only.unwrap_or(false) {
        let p = add_param(params, SqlParam::Text(LOCAL_PLUGIN_ID.to_string()));
        conditions.push(format!("n.plugin_id = {p} AND n.is_local = 1"));
    }
    if filter.completed_only.unwrap_or(false) {
        conditions.push(
            "COALESCE(s.total_chapters, 0) > 0 AND COALESCE(s.chapters_unread, 0) = 0".to_string(),
        );
    }

    conditions
}

fn library_rows_cte(conditions: &[String]) -> String {
    format!(
        "WITH library_rows AS ( \
           SELECT \
             n.id, \
             n.plugin_id AS pluginId, \
             ip.name AS pluginName, \
             n.source_novel_id AS sourceNovelId, \
             n.path, \
             n.name, \
             n.cover, \
             n.author, \
             n.in_library AS inLibrary, \
             n.is_local AS isLocal, \
             COALESCE(s.total_chapters, 0) AS totalChapters, \
             {LIBRARY_STORED_CHAPTER_COUNT_SQL} AS chaptersDownloaded, \
             MAX(COALESCE(s.total_chapters, 0) - {LIBRARY_STORED_CHAPTER_COUNT_SQL}, 0) AS chaptersUndownloaded, \
             COALESCE(s.chapters_unread, 0) AS chaptersUnread, \
             COALESCE(s.reading_progress, 0) AS readingProgress, \
             n.last_read_at AS lastReadAt, \
             COALESCE(n.last_read_at, 0) AS lastReadSort, \
             CASE \
               WHEN COALESCE(s.total_chapters, 0) > 0 \
                 THEN COALESCE(s.last_chapter_updated_at, n.updated_at) \
               ELSE n.updated_at \
             END AS lastUpdatedAt \
           FROM novel n \
           LEFT JOIN novel_stats s ON s.novel_id = n.id \
           LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id \
           WHERE {} \
         )",
        conditions.join(" AND ")
    )
}

fn normalize_cursor_param(cursor: &LibraryNovelCursorDto, spec: &LibrarySortSpec) -> SqlParam {
    match spec.value_kind {
        SortValueKind::Text => match &cursor.sort_value {
            JsonValue::String(s) => SqlParam::Text(s.clone()),
            other => SqlParam::Text(other.to_string()),
        },
        SortValueKind::Number => {
            let n = match &cursor.sort_value {
                JsonValue::Number(num) => num.as_i64().or_else(|| num.as_f64().map(|v| v as i64)),
                JsonValue::String(s) => s.parse::<i64>().ok(),
                _ => None,
            }
            .unwrap_or(0);
            SqlParam::Int(n)
        }
    }
}

fn build_library_cursor_clause(
    cursor: Option<&LibraryNovelCursorDto>,
    params: &mut Vec<SqlParam>,
    spec: &LibrarySortSpec,
) -> String {
    let Some(cursor) = cursor else {
        return String::new();
    };
    let op = match spec.direction {
        SortDirection::Asc => ">",
        SortDirection::Desc => "<",
    };
    let value_param = add_param(params, normalize_cursor_param(cursor, spec));
    let col = spec.cursor_column;

    match spec.cursor_kind {
        LibraryCursorKind::Unique => format!("WHERE {col} {op} {value_param}"),
        LibraryCursorKind::Name => {
            let id_param = add_param(params, SqlParam::Int(cursor.id));
            format!(
                "WHERE ( \
                   {col} COLLATE NOCASE {op} {value_param} COLLATE NOCASE \
                   OR ({col} COLLATE NOCASE = {value_param} COLLATE NOCASE AND id > {id_param}) \
                 )"
            )
        }
        LibraryCursorKind::ValueName => {
            let id_param = add_param(params, SqlParam::Int(cursor.id));
            let name_param = add_param(params, SqlParam::Text(cursor.name.clone()));
            format!(
                "WHERE ( \
                   {col} {op} {value_param} \
                   OR ({col} = {value_param} AND name COLLATE NOCASE > {name_param} COLLATE NOCASE) \
                   OR ({col} = {value_param} AND name COLLATE NOCASE = {name_param} COLLATE NOCASE AND id > {id_param}) \
                 )"
            )
        }
    }
}

pub async fn select_library_novels_in_conn(
    conn: &mut SqliteConnection,
    filter: &LibraryNovelPageFilterDto,
) -> Result<Vec<LibraryNovelDto>, String> {
    let mut params = Vec::new();
    let conditions = build_library_filter_conditions(&filter.filter, &mut params);
    let (_, spec) = library_sort_spec(filter.filter.sort_order.as_deref());
    let cursor_clause = build_library_cursor_clause(filter.cursor.as_ref(), &mut params, &spec);
    let limit_clause = match filter.filter.limit {
        Some(limit) => {
            let clamped = clamp_route_query_limit(limit, MAX_ROUTE_QUERY_ROWS);
            let p = add_param(&mut params, SqlParam::Int(clamped));
            format!("LIMIT {p}")
        }
        None => String::new(),
    };
    let sql = format!(
        "{} \
         SELECT id, pluginId, pluginName, sourceNovelId, path, name, cover, author, \
                inLibrary, isLocal, totalChapters, chaptersDownloaded, chaptersUnread, \
                readingProgress, lastReadAt, lastUpdatedAt \
         FROM library_rows \
         {cursor_clause} \
         ORDER BY {} \
         {limit_clause}",
        library_rows_cte(&conditions),
        spec.order_by
    );

    let rows = bind_sql_params(sqlx::query(&sql), &params)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel: select library novels: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let plugin_id: String = row.get("pluginId");
            let raw_is_local: i64 = row.get("isLocal");
            let is_local = is_local_novel(&plugin_id, raw_is_local);
            let raw_cover: Option<String> = row.get("cover");
            let in_library_raw: i64 = row.get("inLibrary");
            LibraryNovelDto {
                id: row.get("id"),
                plugin_name: row.get("pluginName"),
                source_novel_id: row.get("sourceNovelId"),
                path: row.get("path"),
                name: row.get("name"),
                cover: if is_local {
                    display_local_cover(raw_cover)
                } else {
                    raw_cover
                },
                author: row.get("author"),
                in_library: in_library_raw != 0,
                is_local,
                total_chapters: row.get("totalChapters"),
                chapters_downloaded: row.get("chaptersDownloaded"),
                chapters_unread: row.get("chaptersUnread"),
                reading_progress: decode_sqlite_f64(&row, "readingProgress"),
                last_read_at: row.get("lastReadAt"),
                last_updated_at: row.get("lastUpdatedAt"),
                plugin_id,
            }
        })
        .collect())
}

pub async fn list_library_novel_page_in_conn(
    conn: &mut SqliteConnection,
    filter: &LibraryNovelPageFilterDto,
) -> Result<LibraryNovelPageDto, String> {
    let (sort_key, _) = library_sort_spec(filter.filter.sort_order.as_deref());
    let normalized_limit = clamp_route_query_limit(
        filter.filter.limit.unwrap_or(DEFAULT_LIBRARY_PAGE_LIMIT),
        DEFAULT_LIBRARY_PAGE_LIMIT,
    );
    let mut query_filter = filter.clone();
    query_filter.filter.limit = Some(normalized_limit + 1);

    let mut rows = select_library_novels_in_conn(conn, &query_filter).await?;
    let has_more = rows.len() as i64 > normalized_limit;
    if has_more {
        rows.truncate(normalized_limit as usize);
    }
    let next_cursor = if has_more {
        rows.last().map(|last| LibraryNovelCursorDto {
            id: last.id,
            name: last.name.clone(),
            sort_value: novel_sort_value(sort_key, last),
        })
    } else {
        None
    };

    Ok(LibraryNovelPageDto {
        has_more,
        next_cursor,
        novels: rows,
    })
}

pub async fn list_library_novel_ids_in_conn(
    conn: &mut SqliteConnection,
    filter: &LibraryFilterDto,
) -> Result<Vec<i64>, String> {
    let mut params = Vec::new();
    let conditions = build_library_filter_conditions(filter, &mut params);
    let sql = format!(
        "SELECT n.id FROM novel n \
         LEFT JOIN novel_stats s ON s.novel_id = n.id \
         WHERE {} \
         ORDER BY n.id",
        conditions.join(" AND ")
    );
    let rows = bind_sql_params(sqlx::query(&sql), &params)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel: list library novel ids: {err}"))?;
    Ok(rows.into_iter().map(|r| r.get("id")).collect())
}

pub async fn list_library_novel_identities_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<LibraryNovelIdentityDto>, String> {
    let rows = sqlx::query(
        "SELECT plugin_id AS pluginId, path \
         FROM novel \
         WHERE in_library = 1 \
         ORDER BY plugin_id COLLATE NOCASE ASC, path COLLATE NOCASE ASC",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel: list library novel identities: {err}"))?;
    Ok(rows
        .into_iter()
        .map(|row| LibraryNovelIdentityDto {
            plugin_id: row.get("pluginId"),
            path: row.get("path"),
        })
        .collect())
}

pub async fn get_library_novel_summary_in_conn(
    conn: &mut SqliteConnection,
    filter: &LibraryFilterDto,
) -> Result<LibraryNovelSummaryDto, String> {
    let mut params = Vec::new();
    let conditions = build_library_filter_conditions(filter, &mut params);
    let sql = format!(
        "{} \
         SELECT \
           COUNT(*) AS totalNovels, \
           COALESCE(SUM(totalChapters), 0) AS totalChapters, \
           COALESCE(SUM(chaptersDownloaded), 0) AS downloadedChapters, \
           COALESCE(SUM(chaptersUnread), 0) AS unreadChapters, \
           MAX(lastUpdatedAt) AS lastUpdatedAt, \
           COALESCE(SUM(CASE WHEN chaptersUnread > 0 THEN 1 ELSE 0 END), 0) AS unreadNovels, \
           COALESCE(SUM(CASE WHEN isLocal = 1 OR chaptersDownloaded > 0 THEN 1 ELSE 0 END), 0) AS downloadedNovels, \
           COALESCE(SUM(CASE WHEN pluginId = '{LOCAL_PLUGIN_ID}' AND isLocal = 1 THEN 1 ELSE 0 END), 0) AS localNovels, \
           COALESCE(SUM(CASE WHEN totalChapters > 0 AND chaptersUnread = 0 THEN 1 ELSE 0 END), 0) AS completeNovels, \
           COALESCE(SUM(EXISTS (SELECT 1 FROM chapter c WHERE c.novel_id = library_rows.id AND c.media_repair_needed = 1)), 0) AS repairNeededNovels \
         FROM library_rows",
        library_rows_cte(&conditions)
    );
    let row = bind_sql_params(sqlx::query(&sql), &params)
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| format!("db novel: get library novel summary: {err}"))?;

    Ok(LibraryNovelSummaryDto {
        complete_novels: row.get::<Option<i64>, _>("completeNovels").unwrap_or(0),
        downloaded_chapters: row.get::<Option<i64>, _>("downloadedChapters").unwrap_or(0),
        downloaded_novels: row.get::<Option<i64>, _>("downloadedNovels").unwrap_or(0),
        last_updated_at: row.get("lastUpdatedAt"),
        local_novels: row.get::<Option<i64>, _>("localNovels").unwrap_or(0),
        repair_needed_novels: row.get::<Option<i64>, _>("repairNeededNovels").unwrap_or(0),
        total_chapters: row.get::<Option<i64>, _>("totalChapters").unwrap_or(0),
        total_novels: row.get::<Option<i64>, _>("totalNovels").unwrap_or(0),
        unread_chapters: row.get::<Option<i64>, _>("unreadChapters").unwrap_or(0),
        unread_novels: row.get::<Option<i64>, _>("unreadNovels").unwrap_or(0),
    })
}

pub async fn count_library_stored_chapters_in_conn(
    conn: &mut SqliteConnection,
    novel_ids: &[i64],
) -> Result<i64, String> {
    let mut seen = HashSet::new();
    let unique: Vec<i64> = novel_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    if unique.is_empty() {
        return Ok(0);
    }
    let mut total = 0i64;
    for chunk in unique.chunks(500) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT SUM({LIBRARY_STORED_CHAPTER_COUNT_SQL}) AS storedChapters \
             FROM novel n \
             LEFT JOIN novel_stats s ON s.novel_id = n.id \
             WHERE n.id IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query_scalar::<_, Option<i64>>(&sql);
        for &id in chunk {
            q = q.bind(id);
        }
        let sum = q
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db novel: count library stored chapters: {err}"))?
            .unwrap_or(0);
        total += sum;
    }
    Ok(total)
}

pub async fn list_library_source_filters_in_conn(
    conn: &mut SqliteConnection,
    filter: &LibraryFilterDto,
) -> Result<Vec<LibrarySourceFilterDto>, String> {
    let mut stripped = filter.clone();
    stripped.source_id = None;
    stripped.sort_order = None;
    stripped.limit = None;
    let mut params = Vec::new();
    let conditions = build_library_filter_conditions(&stripped, &mut params);
    let sql = format!(
        "{} \
         SELECT pluginId, pluginName, COUNT(*) AS totalNovels \
         FROM library_rows \
         GROUP BY pluginId, pluginName \
         ORDER BY \
           CASE WHEN pluginId = '{LOCAL_PLUGIN_ID}' THEN 1 ELSE 0 END ASC, \
           COALESCE(pluginName, pluginId) COLLATE NOCASE ASC",
        library_rows_cte(&conditions)
    );
    let rows = bind_sql_params(sqlx::query(&sql), &params)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel: list library source filters: {err}"))?;
    Ok(rows
        .into_iter()
        .map(|row| LibrarySourceFilterDto {
            plugin_id: row.get("pluginId"),
            plugin_name: row.get("pluginName"),
            total_novels: row.get::<Option<i64>, _>("totalNovels").unwrap_or(0),
        })
        .collect())
}

pub async fn list_library_novel_refresh_targets_in_conn(
    conn: &mut SqliteConnection,
    filter: &LibraryFilterDto,
) -> Result<Vec<LibraryNovelRefreshTargetDto>, String> {
    let mut params = Vec::new();
    let conditions = build_library_filter_conditions(filter, &mut params);
    let sql = format!(
        "SELECT n.id, n.plugin_id AS pluginId, n.path, n.name, n.cover, n.is_local AS isLocal \
         FROM novel n \
         LEFT JOIN novel_stats s ON s.novel_id = n.id \
         WHERE {} \
         ORDER BY n.name COLLATE NOCASE ASC",
        conditions.join(" AND ")
    );
    let rows = bind_sql_params(sqlx::query(&sql), &params)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel: list library refresh targets: {err}"))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let plugin_id: String = row.get("pluginId");
            let raw_is_local: i64 = row.get("isLocal");
            LibraryNovelRefreshTargetDto {
                id: row.get("id"),
                path: row.get("path"),
                name: row.get("name"),
                cover: row.get("cover"),
                is_local: is_local_novel(&plugin_id, raw_is_local),
                plugin_id,
            }
        })
        .collect())
}

pub async fn list_novels_for_update_check_in_conn(
    conn: &mut SqliteConnection,
    novel_ids: Option<&[i64]>,
) -> Result<Vec<NovelForCheckDto>, String> {
    let rows = sqlx::query(
        "SELECT id, plugin_id AS pluginId, path, name \
         FROM novel \
         WHERE in_library = 1 \
         ORDER BY last_read_at IS NULL, last_read_at DESC, name COLLATE NOCASE ASC",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel: list novels for update check: {err}"))?;

    let wanted: Option<HashSet<i64>> = novel_ids.map(|ids| ids.iter().copied().collect());
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let id: i64 = row.get("id");
            if let Some(ref set) = wanted {
                if !set.contains(&id) {
                    return None;
                }
            }
            Some(NovelForCheckDto {
                id,
                plugin_id: row.get("pluginId"),
                path: row.get("path"),
                name: row.get("name"),
            })
        })
        .collect())
}

const SELECT_NOVEL_DETAIL_FIELDS: &str = "\
  SELECT \
    n.id, \
    n.source_novel_id AS sourceNovelId, \
    n.plugin_id AS pluginId, \
    ip.name AS pluginName, \
    n.path, \
    n.name, \
    n.cover, \
    n.summary, \
    n.author, \
    n.artist, \
    n.status, \
    n.genres, \
    n.rating, \
    n.in_library AS inLibrary, \
    n.is_local AS isLocal, \
    n.created_at AS createdAt, \
    n.updated_at AS updatedAt, \
    n.library_added_at AS libraryAddedAt, \
    n.last_read_at AS lastReadAt \
  FROM novel n \
  LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id";

fn map_novel_detail_row(row: sqlx::sqlite::SqliteRow) -> NovelDetailRecordDto {
    let plugin_id: String = row.get("pluginId");
    let raw_is_local: i64 = row.get("isLocal");
    let is_local = is_local_novel(&plugin_id, raw_is_local);
    let raw_cover: Option<String> = row.get("cover");
    let in_library_raw: i64 = row.get("inLibrary");
    NovelDetailRecordDto {
        id: row.get("id"),
        source_novel_id: row.get("sourceNovelId"),
        plugin_name: row.get("pluginName"),
        path: row.get("path"),
        name: row.get("name"),
        cover: if is_local {
            display_local_cover(raw_cover)
        } else {
            raw_cover
        },
        summary: row.get("summary"),
        author: row.get("author"),
        artist: row.get("artist"),
        status: row.get("status"),
        genres: row.get("genres"),
        rating: decode_sqlite_opt_f64(&row, "rating"),
        in_library: in_library_raw != 0,
        is_local,
        created_at: row.get("createdAt"),
        updated_at: row.get("updatedAt"),
        library_added_at: row.get("libraryAddedAt"),
        last_read_at: row.get("lastReadAt"),
        plugin_id,
    }
}

pub async fn get_novel_by_id_in_conn(
    conn: &mut SqliteConnection,
    id: i64,
) -> Result<Option<NovelDetailRecordDto>, String> {
    let sql = format!("{SELECT_NOVEL_DETAIL_FIELDS} WHERE n.id = ?1");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db novel: get novel by id: {err}"))?;
    Ok(row.map(map_novel_detail_row))
}

pub async fn find_novel_by_source_in_conn(
    conn: &mut SqliteConnection,
    plugin_id: &str,
    path: &str,
) -> Result<Option<NovelDetailRecordDto>, String> {
    let sql = format!("{SELECT_NOVEL_DETAIL_FIELDS} WHERE n.plugin_id = ?1 AND n.path = ?2");
    let row = sqlx::query(&sql)
        .bind(plugin_id)
        .bind(path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db novel: find novel by source: {err}"))?;
    Ok(row.map(map_novel_detail_row))
}

pub async fn count_novels_in_conn(conn: &mut SqliteConnection) -> Result<i64, String> {
    sqlx::query_scalar("SELECT COUNT(*) FROM novel")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| format!("db novel: count novels: {err}"))
}

pub async fn set_novel_in_library_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    id: i64,
    in_library: bool,
) -> Result<(), String> {
    let flag: i64 = if in_library { 1 } else { 0 };
    sqlx::query(
        "UPDATE novel \
         SET in_library = ?2, \
             library_added_at = CASE WHEN ?2 = 1 THEN unixepoch() ELSE NULL END, \
             updated_at = unixepoch() \
         WHERE id = ?1",
    )
    .bind(id)
    .bind(flag)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel: update novel in_library: {err}"))?;

    if in_library {
        sqlx::query(
            "UPDATE chapter \
             SET found_at = MAX(COALESCE(found_at, 0), unixepoch()) \
             WHERE novel_id = ?1",
        )
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel: update chapter found_at: {err}"))?;
    } else {
        sqlx::query("DELETE FROM novel_download_goal WHERE novel_id = ?1")
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel: delete novel download goal: {err}"))?;
    }

    record_library_in_tx(conn, ctx, Some(&[id]), false).await
}

pub async fn reconcile_imported_novel_identity_in_tx(
    conn: &mut SqliteConnection,
    plugin_id: &str,
    path: &str,
    chapters: &[ImportedChapterIdentityDto],
) -> Result<Option<ReconciledNovelIdentityDto>, String> {
    let existing_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(plugin_id)
    .bind(path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel identity: find matching novel: {err}"))?;

    let Some(existing_id) = existing_id else {
        return Ok(None);
    };

    #[derive(Clone)]
    struct PrevChapter {
        id: i64,
        path: String,
        chapter_number: Option<String>,
    }

    let previous: Vec<PrevChapter> = sqlx::query(
        "SELECT id, path, chapter_number FROM chapter WHERE novel_id = ?1",
    )
    .bind(existing_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel identity: select chapters: {err}"))?
    .into_iter()
    .map(|row| PrevChapter {
        id: row.get("id"),
        path: row.get("path"),
        chapter_number: row.get("chapter_number"),
    })
    .collect();

    let paths: HashSet<&str> = previous.iter().map(|c| c.path.as_str()).collect();
    let mut chapter_path_map: HashMap<String, String> = HashMap::new();

    for chapter in &previous {
        if !chapter.path.starts_with(FOLDER_PREFIX) {
            continue;
        }
        let Some(ref raw_num) = chapter.chapter_number else {
            continue;
        };
        let trimmed = raw_num.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(number) = trimmed.parse::<f64>() else {
            continue;
        };
        if !number.is_finite() {
            continue;
        }
        let matches: Vec<&ImportedChapterIdentityDto> = chapters
            .iter()
            .filter(|item| {
                item.chapter_number
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .and_then(|s| s.parse::<f64>().ok())
                    .is_some_and(|n| n.is_finite() && n == number)
            })
            .collect();
        if matches.is_empty() {
            continue;
        }
        let prev_same_num_count = previous
            .iter()
            .filter(|item| {
                item.chapter_number
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .and_then(|s| s.parse::<f64>().ok())
                    .is_some_and(|n| n.is_finite() && n == number)
            })
            .count();
        if matches.len() != 1
            || prev_same_num_count != 1
            || paths.contains(matches[0].path.as_str())
        {
            return Err(
                "Imported chapter identity is ambiguous; chapter state has been preserved."
                    .to_string(),
            );
        }
        chapter_path_map.insert(chapter.path.clone(), matches[0].path.clone());
    }

    if chapter_path_map.is_empty() {
        return Ok(Some(ReconciledNovelIdentityDto {
            id: existing_id,
            changed: false,
        }));
    }

    for chapter in &previous {
        if let Some(new_path) = chapter_path_map.get(&chapter.path) {
            sqlx::query("UPDATE chapter SET path = ?2 WHERE id = ?1")
                .bind(chapter.id)
                .bind(new_path)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db novel identity: update chapter path: {err}"))?;
        }
    }

    Ok(Some(ReconciledNovelIdentityDto {
        id: existing_id,
        changed: true,
    }))
}

pub async fn insert_novel_if_absent_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &InsertNovelInputDto,
) -> Result<(), String> {
    if reconcile_imported_novel_identity_in_tx(conn, &input.plugin_id, &input.path, &[])
        .await?
        .is_some()
    {
        return Ok(());
    }
    let in_library: i64 = if input.in_library.unwrap_or(true) { 1 } else { 0 };
    sqlx::query(
        "INSERT OR IGNORE INTO novel \
           (plugin_id, path, name, cover, in_library, library_added_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 = 1 THEN unixepoch() ELSE NULL END)",
    )
    .bind(&input.plugin_id)
    .bind(&input.path)
    .bind(&input.name)
    .bind(&input.cover)
    .bind(in_library)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel: insert novel if absent: {err}"))?;

    if in_library == 1 && has_user_state_schema_in_tx(conn).await? {
        if let Some(created_id) = sqlx::query_scalar::<_, i64>(
            "SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(&input.plugin_id)
        .bind(&input.path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db novel: select inserted novel id: {err}"))?
        {
            record_library_in_tx(conn, ctx, Some(&[created_id]), false).await?;
        }
    }
    Ok(())
}

pub fn validate_downloaded_chapter_inputs(
    inputs: &[DownloadedChapterUpsertInputDto],
) -> Result<Vec<(DownloadedChapterUpsertInputDto, i64)>, String> {
    if inputs.len() > MAX_CHAPTER_BULK_INPUT_ROWS {
        return Err(format!(
            "Downloaded chapter upsert has {} chapters, which exceeds the {} chapter limit.",
            inputs.len(),
            MAX_CHAPTER_BULK_INPUT_ROWS
        ));
    }
    let mut out = Vec::with_capacity(inputs.len());
    for input in inputs {
        assert_byte_budget(
            input.name.len() as i64,
            MAX_CHAPTER_TITLE_BYTES,
            "Downloaded chapter title",
        )?;
        assert_byte_budget(
            input.path.len() as i64,
            MAX_CHAPTER_URL_BYTES,
            "Downloaded chapter URL",
        )?;
        let content_bytes = input.content_bytes.unwrap_or(0);
        if content_bytes < 0 || content_bytes > MAX_INLINE_IPC_BYTES {
            assert_byte_budget(
                content_bytes,
                MAX_INLINE_IPC_BYTES as usize,
                "Downloaded chapter content",
            )?;
        }
        out.push((input.clone(), content_bytes));
    }
    Ok(out)
}

pub async fn upsert_downloaded_chapters_in_tx(
    conn: &mut SqliteConnection,
    inputs: &[DownloadedChapterUpsertInputDto],
) -> Result<BulkChapterMutationResultDto, String> {
    if inputs.is_empty() {
        return Ok(BulkChapterMutationResultDto {
            rows_affected: 0,
            chunks: 0,
        });
    }
    let normalized = validate_downloaded_chapter_inputs(inputs)?;
    let mut rows_affected = 0u64;
    let mut chunks = 0usize;

    for chunk in normalized.chunks(DOWNLOADED_CHAPTER_CHUNK_SIZE) {
        let values_sql: Vec<String> = (0..chunk.len())
            .map(|index| {
                let p = index * 10 + 1;
                format!(
                    "(?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{}, 0, 1, unixepoch(), unixepoch())",
                    p,
                    p + 1,
                    p + 2,
                    p + 3,
                    p + 4,
                    p + 5,
                    p + 6,
                    p + 7,
                    p + 8,
                    p + 9
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO chapter \
               (novel_id, path, name, position, chapter_number, page, release_time, content_type, stored_content_type, content_bytes, media_repair_needed, is_downloaded, created_at, found_at) \
             VALUES {} \
             ON CONFLICT(novel_id, path) DO UPDATE SET \
               name = excluded.name, \
               position = excluded.position, \
               chapter_number = excluded.chapter_number, \
               page = excluded.page, \
               release_time = excluded.release_time, \
               content_type = excluded.content_type, \
               stored_content_type = excluded.stored_content_type, \
               content_bytes = excluded.content_bytes, \
               media_repair_needed = 0, \
               media_bytes_checked_at = NULL, \
               is_downloaded = 1, \
               updated_at = unixepoch() \
             WHERE \
               name IS NOT excluded.name \
               OR position IS NOT excluded.position \
               OR chapter_number IS NOT excluded.chapter_number \
               OR page IS NOT excluded.page \
               OR release_time IS NOT excluded.release_time \
               OR content_type IS NOT excluded.content_type \
               OR stored_content_type IS NOT excluded.stored_content_type \
               OR content_bytes IS NOT excluded.content_bytes \
               OR media_repair_needed IS NOT 0 \
               OR is_downloaded IS NOT 1",
            values_sql.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (input, content_bytes) in chunk {
            let ct = normalize_chapter_content_type(input.content_type.as_deref());
            let sct = stored_chapter_content_type(ct);
            q = q
                .bind(input.novel_id)
                .bind(&input.path)
                .bind(&input.name)
                .bind(input.position)
                .bind(&input.chapter_number)
                .bind(input.page.as_deref().unwrap_or("1"))
                .bind(&input.release_time)
                .bind(ct)
                .bind(sct)
                .bind(*content_bytes);
        }
        let res = q
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter: upsert downloaded chapters: {err}"))?;
        rows_affected += res.rows_affected();
        chunks += 1;
    }

    Ok(BulkChapterMutationResultDto {
        rows_affected,
        chunks,
    })
}

async fn ensure_local_novel_exists_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<(), String> {
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM novel WHERE id = ?1 AND plugin_id = ?2 AND is_local = 1",
    )
    .bind(novel_id)
    .bind(LOCAL_PLUGIN_ID)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel: check local novel exists: {err}"))?;

    if exists.is_none() {
        return Err("local novel: target novel is not local".to_string());
    }
    Ok(())
}

async fn apply_local_chapter_order_updates_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    changed_entries: &[(i64, i64, String)],
    error_message: &str,
) -> Result<u64, String> {
    if changed_entries.is_empty() {
        return Ok(0);
    }
    let mut updated_total = 0u64;
    for chunk in changed_entries.chunks(250) {
        let values_sql: Vec<String> = (0..chunk.len())
            .map(|idx| {
                let p = idx * 3 + 1;
                format!("(?{}, ?{}, ?{})", p, p + 1, p + 2)
            })
            .collect();
        let novel_id_param = chunk.len() * 3 + 1;
        let sql = format!(
            "WITH requested(id, position, chapter_number) AS (VALUES {}) \
             UPDATE chapter \
             SET \
               position = (SELECT requested.position FROM requested WHERE requested.id = chapter.id), \
               chapter_number = (SELECT requested.chapter_number FROM requested WHERE requested.id = chapter.id), \
               updated_at = unixepoch() \
             WHERE novel_id = ?{novel_id_param} \
               AND id IN (SELECT id FROM requested) \
               AND ( \
                 position IS NOT (SELECT requested.position FROM requested WHERE requested.id = chapter.id) \
                 OR chapter_number IS NOT (SELECT requested.chapter_number FROM requested WHERE requested.id = chapter.id) \
               )",
            values_sql.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (chapter_id, position, chapter_number) in chunk {
            q = q.bind(*chapter_id).bind(*position).bind(chapter_number);
        }
        q = q.bind(novel_id);
        let res = q
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel: update local chapter order: {err}"))?;
        updated_total += res.rows_affected();
    }

    if updated_total != changed_entries.len() as u64 {
        return Err(error_message.to_string());
    }
    Ok(updated_total)
}

pub async fn renumber_local_novel_chapters_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<LocalChapterOrderMutationResultDto, String> {
    ensure_local_novel_exists_in_tx(conn, novel_id).await?;
    renumber_local_novel_chapters_unchecked_in_tx(conn, novel_id).await
}

async fn renumber_local_novel_chapters_unchecked_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<LocalChapterOrderMutationResultDto, String> {
    let rows = sqlx::query(
        "SELECT id, position, chapter_number FROM chapter WHERE novel_id = ?1 ORDER BY position, id",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel: load local chapters for renumber: {err}"))?;

    let mut changed_entries = Vec::new();
    for (index, row) in rows.into_iter().enumerate() {
        let chapter_id: i64 = row.get("id");
        let prev_position: i64 = row.get("position");
        let prev_chapter_number: Option<String> = row.get("chapter_number");
        let position = (index + 1) as i64;
        let chapter_number = position.to_string();
        if prev_position != position || prev_chapter_number.as_deref() != Some(&chapter_number) {
            changed_entries.push((chapter_id, position, chapter_number));
        }
    }

    let rows_affected = apply_local_chapter_order_updates_in_tx(
        conn,
        novel_id,
        &changed_entries,
        "local novel: failed to renumber chapter order",
    )
    .await?;

    Ok(LocalChapterOrderMutationResultDto { rows_affected })
}

pub async fn update_local_novel_metadata_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    input: &LocalNovelMetadataInputDto,
) -> Result<(), String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("local novel: name is required".to_string());
    }
    ensure_local_novel_exists_in_tx(conn, novel_id).await?;

    sqlx::query(
        "UPDATE novel \
         SET name = ?2, \
             cover = ?3, \
             summary = ?4, \
             author = ?5, \
             artist = ?6, \
             status = ?7, \
             genres = ?8, \
             updated_at = unixepoch() \
         WHERE id = ?1 AND plugin_id = ?9 AND is_local = 1",
    )
    .bind(novel_id)
    .bind(name)
    .bind(nullable_local_cover(input.cover.as_deref()))
    .bind(nullable_text(input.summary.as_deref()))
    .bind(nullable_text(input.author.as_deref()))
    .bind(nullable_text(input.artist.as_deref()))
    .bind(nullable_text(input.status.as_deref()))
    .bind(nullable_text(input.genres.as_deref()))
    .bind(LOCAL_PLUGIN_ID)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel: update local novel metadata: {err}"))?;

    Ok(())
}

pub async fn reorder_local_novel_chapters_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    chapter_ids: &[i64],
) -> Result<(), String> {
    ensure_local_novel_exists_in_tx(conn, novel_id).await?;

    let rows = sqlx::query(
        "SELECT id, position, chapter_number FROM chapter WHERE novel_id = ?1 ORDER BY position",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel: load local chapters for reorder: {err}"))?;

    let mut existing_by_id: HashMap<i64, (i64, Option<String>)> = HashMap::with_capacity(rows.len());
    for row in rows {
        existing_by_id.insert(
            row.get("id"),
            (row.get("position"), row.get("chapter_number")),
        );
    }

    let requested_set: HashSet<i64> = chapter_ids.iter().copied().collect();
    if requested_set.len() != chapter_ids.len()
        || existing_by_id.len() != chapter_ids.len()
        || existing_by_id.keys().any(|id| !requested_set.contains(id))
    {
        return Err("local novel: reorder ids must match existing chapters".to_string());
    }

    let mut changed_entries = Vec::new();
    for (index, &chapter_id) in chapter_ids.iter().enumerate() {
        let position = (index + 1) as i64;
        let chapter_number = position.to_string();
        let Some((prev_pos, prev_num)) = existing_by_id.get(&chapter_id) else {
            continue;
        };
        if *prev_pos != position || prev_num.as_deref() != Some(&chapter_number) {
            changed_entries.push((chapter_id, position, chapter_number));
        }
    }

    apply_local_chapter_order_updates_in_tx(
        conn,
        novel_id,
        &changed_entries,
        "local novel: failed to update chapter order",
    )
    .await?;

    Ok(())
}

fn local_import_path_key_from_chapter_path(path: &str) -> Option<&str> {
    let marker = "/chapter-";
    let marker_idx = path.rfind(marker)?;
    let path_key = &path[..marker_idx];
    if !path_key.starts_with("local:") {
        return None;
    }
    let suffix = &path[marker_idx + marker.len()..];
    if suffix.len() == 4 && suffix.bytes().all(|b| b.is_ascii_digit()) {
        Some(path_key)
    } else {
        None
    }
}

async fn delete_stale_local_import_chapters_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    chapters: &[LocalNovelImportChapterInputDto],
) -> Result<u64, String> {
    let mut seen_keys = HashSet::new();
    let mut path_keys = Vec::new();
    for chapter in chapters {
        if let Some(key) = local_import_path_key_from_chapter_path(&chapter.path) {
            if seen_keys.insert(key.to_string()) {
                path_keys.push(key.to_string());
            }
        }
    }
    if path_keys.is_empty() {
        return Ok(0);
    }

    let mut seen_paths = HashSet::new();
    let mut keep_paths = Vec::new();
    for chapter in chapters {
        if seen_paths.insert(chapter.path.clone()) {
            keep_paths.push(chapter.path.clone());
        }
    }

    let mut deleted = 0u64;
    for path_key in path_keys {
        let like_pattern = format!("{path_key}/chapter-%");
        if keep_paths.is_empty() {
            let res = sqlx::query(
                "DELETE FROM chapter WHERE novel_id = ?1 AND path LIKE ?2",
            )
            .bind(novel_id)
            .bind(&like_pattern)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel: delete stale local chapters: {err}"))?;
            deleted += res.rows_affected();
        } else {
            let keep_json = serde_json::to_string(&keep_paths)
                .map_err(|err| format!("db novel: serialize keep chapter paths: {err}"))?;
            let res = sqlx::query(
                "DELETE FROM chapter \
                 WHERE novel_id = ?1 \
                   AND path LIKE ?2 \
                   AND path NOT IN (SELECT value FROM json_each(?3))",
            )
            .bind(novel_id)
            .bind(&like_pattern)
            .bind(&keep_json)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel: delete stale local chapters: {err}"))?;
            deleted += res.rows_affected();
        }
    }

    Ok(deleted)
}

pub async fn upsert_local_novel_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &LocalNovelImportInputDto,
) -> Result<LocalNovelImportResultDto, String> {
    let current = if input.path == LOCAL_NOVEL_PATH {
        sqlx::query(
            "SELECT cover, summary, author, artist, status, genres \
             FROM novel WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(LOCAL_PLUGIN_ID)
        .bind(LOCAL_NOVEL_PATH)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db novel: load current local novel metadata: {err}"))?
    } else {
        None
    };

    let raw_cover = if input.has_cover {
        input.cover.clone()
    } else {
        current.as_ref().and_then(|r| r.get("cover"))
    };
    let cover = nullable_local_cover(raw_cover.as_deref());
    let summary: Option<String> = if input.has_summary {
        input.summary.clone()
    } else {
        current.as_ref().and_then(|r| r.get("summary"))
    };
    let author: Option<String> = if input.has_author {
        input.author.clone()
    } else {
        current.as_ref().and_then(|r| r.get("author"))
    };
    let artist: Option<String> = if input.has_artist {
        input.artist.clone()
    } else {
        current.as_ref().and_then(|r| r.get("artist"))
    };
    let status: Option<String> = if input.has_status {
        input.status.clone()
    } else {
        current.as_ref().and_then(|r| r.get("status"))
    };
    let genres: Option<String> = if input.has_genres {
        input.genres.clone()
    } else {
        current.as_ref().and_then(|r| r.get("genres"))
    };

    let novel_res = sqlx::query(
        "INSERT INTO novel \
           (plugin_id, path, name, cover, summary, author, artist, status, genres, in_library, is_local, library_added_at, source_novel_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, 1, unixepoch(), ?2) \
         ON CONFLICT(plugin_id, path) DO UPDATE SET \
           name = excluded.name, \
           source_novel_id = excluded.source_novel_id, \
           cover = excluded.cover, \
           summary = excluded.summary, \
           author = excluded.author, \
           artist = excluded.artist, \
           status = excluded.status, \
           genres = excluded.genres, \
           in_library = 1, \
           is_local = 1, \
           library_added_at = COALESCE(library_added_at, unixepoch()), \
           updated_at = unixepoch() \
         WHERE \
           source_novel_id IS NOT excluded.source_novel_id \
           OR name IS NOT excluded.name \
           OR cover IS NOT excluded.cover \
           OR summary IS NOT excluded.summary \
           OR author IS NOT excluded.author \
           OR artist IS NOT excluded.artist \
           OR status IS NOT excluded.status \
           OR genres IS NOT excluded.genres \
           OR in_library IS NOT 1 \
           OR is_local IS NOT 1 \
           OR library_added_at IS NULL",
    )
    .bind(LOCAL_PLUGIN_ID)
    .bind(&input.path)
    .bind(&input.name)
    .bind(&cover)
    .bind(&summary)
    .bind(&author)
    .bind(&artist)
    .bind(&status)
    .bind(&genres)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel: upsert local novel: {err}"))?;

    let novel_id: i64 = sqlx::query_scalar(
        "SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(LOCAL_PLUGIN_ID)
    .bind(&input.path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel: select local novel id: {err}"))?
    .ok_or_else(|| "local import: failed to resolve local novel id".to_string())?;

    let mut chapters = input.chapters.clone();
    if input.path == LOCAL_NOVEL_PATH && !chapters.is_empty() {
        let existing_rows = sqlx::query(
            "SELECT path, position, chapter_number FROM chapter WHERE novel_id = ?1",
        )
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel: load existing local chapters: {err}"))?;

        let mut by_path: HashMap<String, (i64, Option<String>)> =
            HashMap::with_capacity(existing_rows.len());
        let mut last_position = 0i64;
        for row in existing_rows {
            let pos: i64 = row.get("position");
            if pos > last_position {
                last_position = pos;
            }
            by_path.insert(row.get("path"), (pos, row.get("chapter_number")));
        }

        for chapter in &mut chapters {
            if let Some((prev_pos, prev_num)) = by_path.get(&chapter.path) {
                chapter.position = *prev_pos;
                chapter.chapter_number = Some(
                    prev_num
                        .clone()
                        .unwrap_or_else(|| prev_pos.to_string()),
                );
            } else {
                last_position += 1;
                chapter.position = last_position;
                chapter.chapter_number = Some(last_position.to_string());
            }
        }
    }

    let upsert_inputs: Vec<DownloadedChapterUpsertInputDto> = chapters
        .iter()
        .map(|chapter| DownloadedChapterUpsertInputDto {
            novel_id,
            path: chapter.path.clone(),
            name: chapter.name.clone(),
            position: chapter.position,
            chapter_number: chapter.chapter_number.clone(),
            page: Some(chapter.page.clone().unwrap_or_else(|| "1".to_string())),
            release_time: chapter.release_time.clone(),
            content_type: Some(
                normalize_chapter_content_type(chapter.content_type.as_deref()).to_string(),
            ),
            content_bytes: Some(chapter.content_bytes),
        })
        .collect();

    let mut changed_chapters = upsert_downloaded_chapters_in_tx(conn, &upsert_inputs)
        .await?
        .rows_affected;

    let deleted_chapters = if input.path == LOCAL_NOVEL_PATH {
        0
    } else {
        delete_stale_local_import_chapters_in_tx(conn, novel_id, &input.chapters).await?
    };
    changed_chapters += deleted_chapters;
    if deleted_chapters > 0 {
        let renumbered = renumber_local_novel_chapters_unchecked_in_tx(conn, novel_id).await?;
        changed_chapters += renumbered.rows_affected;
    }

    record_library_in_tx(conn, ctx, Some(&[novel_id]), false).await?;
    defer_user_state_for_novel_in_tx(conn, ctx, novel_id).await?;

    Ok(LocalNovelImportResultDto {
        changed: novel_res.rows_affected() > 0 || changed_chapters > 0,
        changed_chapters,
        novel_id,
        chapter_count: input.chapters.len(),
    })
}

// --- Novel Freshness ---

pub async fn get_novel_freshness_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<NovelFreshnessDto>, String> {
    let row = sqlx::query(
        "SELECT novel_id, last_checked_at, last_success_at, consecutive_failures, \
                last_new_chapter_at, cover_fetched_at \
         FROM novel_freshness WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel freshness: get: {err}"))?;

    Ok(row.map(|r| NovelFreshnessDto {
        novel_id: r.get("novel_id"),
        last_checked_at: r.get("last_checked_at"),
        last_success_at: r.get("last_success_at"),
        consecutive_failures: r.get("consecutive_failures"),
        last_new_chapter_at: r.get("last_new_chapter_at"),
        cover_fetched_at: r.get("cover_fetched_at"),
    }))
}

pub async fn record_novel_check_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    ok: bool,
    new_chapters: i64,
    now_seconds: i64,
) -> Result<(), String> {
    if ok {
        sqlx::query(
            "INSERT INTO novel_freshness \
               (novel_id, last_checked_at, last_success_at, consecutive_failures, last_new_chapter_at) \
             SELECT ?1, ?2, ?2, 0, CASE WHEN ?3 > 0 THEN ?2 END \
             WHERE EXISTS (SELECT 1 FROM novel WHERE id = ?1) \
             ON CONFLICT(novel_id) DO UPDATE SET \
               last_checked_at = excluded.last_checked_at, \
               last_success_at = excluded.last_success_at, \
               consecutive_failures = 0, \
               last_new_chapter_at = COALESCE(excluded.last_new_chapter_at, last_new_chapter_at)",
        )
        .bind(novel_id)
        .bind(now_seconds)
        .bind(new_chapters)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel freshness: record success: {err}"))?;
    } else {
        sqlx::query(
            "INSERT INTO novel_freshness (novel_id, last_checked_at, consecutive_failures) \
             SELECT ?1, ?2, 1 WHERE EXISTS (SELECT 1 FROM novel WHERE id = ?1) \
             ON CONFLICT(novel_id) DO UPDATE SET \
               last_checked_at = excluded.last_checked_at, \
               consecutive_failures = consecutive_failures + 1",
        )
        .bind(novel_id)
        .bind(now_seconds)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel freshness: record failure: {err}"))?;
    }
    Ok(())
}

pub async fn record_novel_cover_fetched_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    now_seconds: i64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO novel_freshness (novel_id, cover_fetched_at) \
         SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM novel WHERE id = ?1) \
         ON CONFLICT(novel_id) DO UPDATE SET cover_fetched_at = excluded.cover_fetched_at",
    )
    .bind(novel_id)
    .bind(now_seconds)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel freshness: record cover fetched: {err}"))?;
    Ok(())
}

pub async fn list_check_candidates_in_conn(
    conn: &mut SqliteConnection,
    active_since: Option<i64>,
) -> Result<Vec<CheckCandidateDto>, String> {
    let rows = sqlx::query(
        "SELECT n.id AS novelId, n.plugin_id AS pluginId, n.status, n.last_read_at AS lastReadAt, \
                f.last_checked_at AS lastCheckedAt, \
                COALESCE(f.consecutive_failures, 0) AS consecutiveFailures, \
                COALESCE(s.total_chapters, 0) AS totalChapters, \
                COALESCE(s.chapters_unread, 0) AS unreadChapters, \
                (?1 IS NOT NULL AND n.last_read_at >= ?1 AND (g.novel_id IS NULL OR g.kind <> 'none')) AS hasGoal \
         FROM novel n \
         LEFT JOIN novel_freshness f ON f.novel_id = n.id \
         LEFT JOIN novel_stats s ON s.novel_id = n.id \
         LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
         WHERE n.in_library = 1 AND n.is_local = 0 \
         ORDER BY n.id",
    )
    .bind(active_since)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel freshness: list check candidates: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| CheckCandidateDto {
            novel_id: r.get("novelId"),
            plugin_id: r.get("pluginId"),
            status: r.get("status"),
            last_read_at: r.get("lastReadAt"),
            last_checked_at: r.get("lastCheckedAt"),
            consecutive_failures: r.get("consecutiveFailures"),
            total_chapters: r.get("totalChapters"),
            unread_chapters: r.get("unreadChapters"),
            has_goal: r.get::<i64, _>("hasGoal") != 0,
        })
        .collect())
}

pub async fn count_recent_checks_by_source_in_conn(
    conn: &mut SqliteConnection,
    since_seconds: i64,
) -> Result<Vec<SourceCheckCountDto>, String> {
    let rows = sqlx::query(
        "SELECT n.plugin_id AS pluginId, COUNT(*) AS count \
         FROM novel_freshness f \
         JOIN novel n ON n.id = f.novel_id \
         WHERE f.last_checked_at >= ?1 \
         GROUP BY n.plugin_id",
    )
    .bind(since_seconds)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel freshness: count recent checks by source: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| SourceCheckCountDto {
            plugin_id: r.get("pluginId"),
            count: r.get("count"),
        })
        .collect())
}

pub async fn get_latest_library_check_at_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Option<i64>, String> {
    let checked_at: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(f.last_checked_at) \
         FROM novel_freshness f \
         JOIN novel n ON n.id = f.novel_id \
         WHERE n.in_library = 1",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db novel freshness: get latest library check at: {err}"))?;
    Ok(checked_at)
}

// --- Novel Download Goals ---

fn parse_goal_row(kind: &str, count: Option<i64>) -> Option<NovelDownloadGoalDto> {
    match kind {
        "keep_ahead" => {
            let c = count?;
            if c > 0 && c <= MAX_SAFE_INT_I64 {
                Some(NovelDownloadGoalDto::KeepAhead { count: c })
            } else {
                None
            }
        }
        "all_remaining" => Some(NovelDownloadGoalDto::AllRemaining),
        "entire" => Some(NovelDownloadGoalDto::Entire),
        "none" => Some(NovelDownloadGoalDto::None),
        _ => None,
    }
}

fn goal_kind_and_count(goal: &NovelDownloadGoalDto) -> (&'static str, Option<i64>) {
    match goal {
        NovelDownloadGoalDto::KeepAhead { count } => ("keep_ahead", Some(*count)),
        NovelDownloadGoalDto::AllRemaining => ("all_remaining", None),
        NovelDownloadGoalDto::Entire => ("entire", None),
        NovelDownloadGoalDto::None => ("none", None),
    }
}

pub async fn get_novel_download_goal_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<StoredNovelDownloadGoalDto>, String> {
    let row = sqlx::query(
        "SELECT novel_id, kind, count, updated_at FROM novel_download_goal WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel goal: get: {err}"))?;

    Ok(row.and_then(|r| {
        let kind: String = r.get("kind");
        let count: Option<i64> = r.get("count");
        let goal = parse_goal_row(&kind, count)?;
        Some(StoredNovelDownloadGoalDto {
            novel_id: r.get("novel_id"),
            goal,
            updated_at: r.get("updated_at"),
        })
    }))
}

pub async fn list_novel_download_goals_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<StoredNovelDownloadGoalDto>, String> {
    let rows = sqlx::query(
        "SELECT novel_id, kind, count, updated_at FROM novel_download_goal ORDER BY novel_id",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel goal: list: {err}"))?;

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let kind: String = r.get("kind");
            let count: Option<i64> = r.get("count");
            let goal = parse_goal_row(&kind, count)?;
            Some(StoredNovelDownloadGoalDto {
                novel_id: r.get("novel_id"),
                goal,
                updated_at: r.get("updated_at"),
            })
        })
        .collect())
}

pub async fn set_novel_download_goal_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    goal: Option<&NovelDownloadGoalDto>,
    now: i64,
) -> Result<bool, String> {
    let Some(goal) = goal else {
        sqlx::query("DELETE FROM novel_download_goal WHERE novel_id = ?1")
            .bind(novel_id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel goal: delete: {err}"))?;
        return Ok(true);
    };

    let (kind, count) = goal_kind_and_count(goal);
    let res = sqlx::query(
        "INSERT INTO novel_download_goal (novel_id, kind, count, updated_at) \
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM novel WHERE id = ?1) \
         ON CONFLICT(novel_id) DO UPDATE SET \
           kind = excluded.kind, \
           count = excluded.count, \
           updated_at = excluded.updated_at",
    )
    .bind(novel_id)
    .bind(kind)
    .bind(count)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel goal: upsert: {err}"))?;

    Ok(res.rows_affected() == 1)
}

pub async fn list_download_goal_novels_in_conn(
    conn: &mut SqliteConnection,
    active_since: Option<i64>,
    novel_ids: Option<&[i64]>,
) -> Result<Vec<DownloadGoalNovelDto>, String> {
    let Some(active_since) = active_since else {
        return Ok(Vec::new());
    };
    let filtered_ids: Option<Vec<i64>> = novel_ids.map(|ids| {
        let mut seen = HashSet::new();
        ids.iter()
            .copied()
            .filter(|id| seen.insert(*id))
            .collect()
    });
    if filtered_ids.as_ref().is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }

    let rows = match filtered_ids {
        Some(ref ids) => {
            let ids_json = serde_json::to_string(ids)
                .map_err(|err| format!("db novel goal: serialize novel ids: {err}"))?;
            sqlx::query(
                "SELECT n.id, n.plugin_id AS pluginId, n.path, n.name, n.last_read_at AS lastReadAt, \
                        g.kind, g.count \
                 FROM novel n \
                 LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
                 WHERE n.is_local = 0 AND n.in_library = 1 \
                   AND n.last_read_at >= ?1 \
                   AND (g.novel_id IS NULL OR g.kind <> 'none') \
                   AND n.id IN (SELECT value FROM json_each(?2)) \
                 ORDER BY COALESCE(n.last_read_at, 0) DESC, n.id",
            )
            .bind(active_since)
            .bind(&ids_json)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db novel goal: list goal novels by ids: {err}"))?
        }
        None => sqlx::query(
            "SELECT n.id, n.plugin_id AS pluginId, n.path, n.name, n.last_read_at AS lastReadAt, \
                    g.kind, g.count \
             FROM novel n \
             LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
             WHERE n.is_local = 0 AND n.in_library = 1 \
               AND n.last_read_at >= ?1 \
               AND (g.novel_id IS NULL OR g.kind <> 'none') \
             ORDER BY COALESCE(n.last_read_at, 0) DESC, n.id",
        )
        .bind(active_since)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel goal: list goal novels: {err}"))?,
    };

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let kind: Option<String> = row.get("kind");
        let count: Option<i64> = row.get("count");
        let goal = kind.as_deref().and_then(|k| parse_goal_row(k, count));
        if matches!(goal, Some(NovelDownloadGoalDto::None)) {
            continue;
        }
        out.push(DownloadGoalNovelDto {
            id: row.get("id"),
            plugin_id: row.get("pluginId"),
            path: row.get("path"),
            name: row.get("name"),
            last_read_at: row.get("lastReadAt"),
            goal,
        });
    }
    Ok(out)
}

pub async fn list_goal_novel_ids_for_scope_in_conn(
    conn: &mut SqliteConnection,
    scope: &str,
    ids: &[i64],
    active_since: Option<i64>,
) -> Result<Vec<i64>, String> {
    let Some(active_since) = active_since else {
        return Ok(Vec::new());
    };
    if scope == "all" {
        return sqlx::query_scalar(
            "SELECT n.id FROM novel n \
             LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
             WHERE n.in_library = 1 AND n.is_local = 0 \
               AND n.last_read_at >= ?1 \
               AND (g.novel_id IS NULL OR g.kind <> 'none') \
             ORDER BY n.id",
        )
        .bind(active_since)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel goal: list scope all: {err}"));
    }

    let mut seen = HashSet::new();
    let unique: Vec<i64> = ids.iter().copied().filter(|id| seen.insert(*id)).collect();
    if unique.is_empty() {
        return Ok(Vec::new());
    }

    let mut found = HashSet::new();
    for chunk in unique.chunks(500) {
        let chunk_json = serde_json::to_string(chunk)
            .map_err(|err| format!("db novel goal: serialize scope chunk: {err}"))?;
        let sql = if scope == "novel" {
            "SELECT n.id FROM novel n \
             LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
             WHERE n.in_library = 1 AND n.is_local = 0 \
               AND n.last_read_at >= ?1 \
               AND (g.novel_id IS NULL OR g.kind <> 'none') \
               AND n.id IN (SELECT value FROM json_each(?2))"
        } else {
            "SELECT DISTINCT n.id FROM chapter c \
             JOIN novel n ON n.id = c.novel_id \
             LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
             WHERE n.in_library = 1 AND n.is_local = 0 \
               AND n.last_read_at >= ?1 \
               AND (g.novel_id IS NULL OR g.kind <> 'none') \
               AND c.id IN (SELECT value FROM json_each(?2))"
        };
        let rows: Vec<i64> = sqlx::query_scalar(sql)
            .bind(active_since)
            .bind(&chunk_json)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db novel goal: list scope {scope}: {err}"))?;
        found.extend(rows);
    }
    let mut sorted: Vec<i64> = found.into_iter().collect();
    sorted.sort_unstable();
    Ok(sorted)
}

pub async fn exclude_chapters_from_download_goals_in_tx(
    conn: &mut SqliteConnection,
    chapter_ids: &[i64],
    now: i64,
) -> Result<(), String> {
    let mut seen = HashSet::new();
    let unique: Vec<i64> = chapter_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    for chunk in unique.chunks(500) {
        let chunk_json = serde_json::to_string(chunk)
            .map_err(|err| format!("db novel goal: serialize excluded chapters: {err}"))?;
        sqlx::query(
            "INSERT INTO chapter_download_goal_exclusion (chapter_id, created_at) \
             SELECT id, ?1 FROM chapter WHERE id IN (SELECT value FROM json_each(?2)) \
             ON CONFLICT(chapter_id) DO NOTHING",
        )
        .bind(now)
        .bind(&chunk_json)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db novel goal: exclude chapters: {err}"))?;
    }
    Ok(())
}

pub async fn list_download_goal_excluded_chapter_ids_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Vec<i64>, String> {
    sqlx::query_scalar(
        "SELECT e.chapter_id \
         FROM chapter_download_goal_exclusion e \
         JOIN chapter c ON c.id = e.chapter_id \
         WHERE c.novel_id = ?1 \
         ORDER BY e.chapter_id",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel goal: list excluded chapters: {err}"))
}

pub async fn resume_stopped_novel_download_goal_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<bool, String> {
    let res = sqlx::query(
        "DELETE FROM novel_download_goal WHERE novel_id = ?1 AND kind = 'none'",
    )
    .bind(novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel goal: resume stopped goal: {err}"))?;
    Ok(res.rows_affected() > 0)
}

pub async fn list_library_novels_without_download_goal_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<NovelWithoutGoalDto>, String> {
    let rows = sqlx::query(
        "SELECT n.id, n.plugin_id AS pluginId \
         FROM novel n \
         LEFT JOIN novel_download_goal g ON g.novel_id = n.id \
         WHERE n.in_library = 1 AND n.is_local = 0 AND g.novel_id IS NULL \
         ORDER BY n.id",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db novel goal: list library novels without goal: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| NovelWithoutGoalDto {
            id: r.get("id"),
            plugin_id: r.get("pluginId"),
        })
        .collect())
}

fn non_content_tx_options() -> TxOptions {
    TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: 3,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    }
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn db_novel_list_library(
    db: State<'_, AppDatabase>,
    filter: Option<LibraryFilterDto>,
    mode: Option<ReadMode>,
) -> Result<Vec<LibraryNovelDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    select_library_novels_in_conn(
        &mut conn,
        &LibraryNovelPageFilterDto {
            filter: filter.unwrap_or_default(),
            cursor: None,
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_list_library_page(
    db: State<'_, AppDatabase>,
    filter: Option<LibraryNovelPageFilterDto>,
    mode: Option<ReadMode>,
) -> Result<LibraryNovelPageDto, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    list_library_novel_page_in_conn(&mut conn, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_novel_list_library_ids(
    db: State<'_, AppDatabase>,
    filter: Option<LibraryFilterDto>,
    mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    list_library_novel_ids_in_conn(&mut conn, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_novel_list_library_identities(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<Vec<LibraryNovelIdentityDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    list_library_novel_identities_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_novel_get_library_summary(
    db: State<'_, AppDatabase>,
    filter: Option<LibraryFilterDto>,
    mode: Option<ReadMode>,
) -> Result<LibraryNovelSummaryDto, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    get_library_novel_summary_in_conn(&mut conn, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_novel_count_library_stored_chapters(
    db: State<'_, AppDatabase>,
    novel_ids: Vec<i64>,
    mode: Option<ReadMode>,
) -> Result<i64, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    count_library_stored_chapters_in_conn(&mut conn, &novel_ids).await
}

#[tauri::command]
pub async fn db_novel_list_library_source_filters(
    db: State<'_, AppDatabase>,
    filter: Option<LibraryFilterDto>,
    mode: Option<ReadMode>,
) -> Result<Vec<LibrarySourceFilterDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    list_library_source_filters_in_conn(&mut conn, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_novel_list_library_refresh_targets(
    db: State<'_, AppDatabase>,
    filter: Option<LibraryFilterDto>,
    mode: Option<ReadMode>,
) -> Result<Vec<LibraryNovelRefreshTargetDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    list_library_novel_refresh_targets_in_conn(&mut conn, &filter.unwrap_or_default()).await
}

#[tauri::command]
pub async fn db_novel_list_for_update_check(
    db: State<'_, AppDatabase>,
    novel_ids: Option<Vec<i64>>,
    mode: Option<ReadMode>,
) -> Result<Vec<NovelForCheckDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    list_novels_for_update_check_in_conn(&mut conn, novel_ids.as_deref()).await
}

#[tauri::command]
pub async fn db_novel_get_by_id(
    db: State<'_, AppDatabase>,
    id: i64,
    mode: Option<ReadMode>,
) -> Result<Option<NovelDetailRecordDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    get_novel_by_id_in_conn(&mut conn, id).await
}

#[tauri::command]
pub async fn db_novel_find_by_source(
    db: State<'_, AppDatabase>,
    plugin_id: String,
    path: String,
    mode: Option<ReadMode>,
) -> Result<Option<NovelDetailRecordDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    find_novel_by_source_in_conn(&mut conn, &plugin_id, &path).await
}

#[tauri::command]
pub async fn db_novel_count(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<i64, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel: acquire connection: {err}"))?;
    count_novels_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_novel_set_in_library(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    id: i64,
    in_library: bool,
) -> Result<DbMutationEnvelope<()>, String> {
    let mut opts = TxOptions::with_app_metadata(app);
    opts.busy_begin_retries = 3;
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move { set_novel_in_library_in_tx(conn, ctx, id, in_library).await })
    })
    .await
}

#[tauri::command]
pub async fn db_novel_insert_if_absent(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: InsertNovelInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { insert_novel_if_absent_in_tx(conn, ctx, &input).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_novel_renumber_local_chapters(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<DbMutationEnvelope<LocalChapterOrderMutationResultDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| Box::pin(async move { renumber_local_novel_chapters_in_tx(conn, novel_id).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_novel_update_local_metadata(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    input: LocalNovelMetadataInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    if input.name.trim().is_empty() {
        return Err("local novel: name is required".to_string());
    }
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { update_local_novel_metadata_in_tx(conn, novel_id, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_reorder_local_chapters(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    chapter_ids: Vec<i64>,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move {
                reorder_local_novel_chapters_in_tx(conn, novel_id, &chapter_ids).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_upsert_local(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: LocalNovelImportInputDto,
) -> Result<DbMutationEnvelope<LocalNovelImportResultDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { upsert_local_novel_in_tx(conn, ctx, &input).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_novel_persist_chapter_directories(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    chapters: Vec<WorkChapterDirectoryInputDto>,
) -> Result<DbMutationEnvelope<()>, String> {
    let pairs: Vec<(i64, String)> = chapters.into_iter().map(|c| (c.id, c.directory)).collect();
    let root = crate::chapter_media::media_root(&app).ok();
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move {
                persist_work_chapter_directories_in_tx(
                    root.as_deref(),
                    conn,
                    ctx,
                    novel_id,
                    &pairs,
                    true,
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_freshness_get(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    mode: Option<ReadMode>,
) -> Result<Option<NovelFreshnessDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel freshness: acquire connection: {err}"))?;
    get_novel_freshness_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_novel_freshness_record_check(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    ok: bool,
    new_chapters: Option<i64>,
    now_seconds: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        non_content_tx_options(),
        move |conn, _ctx| {
            Box::pin(async move {
                record_novel_check_in_tx(conn, novel_id, ok, new_chapters.unwrap_or(0), now_seconds)
                    .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_freshness_record_cover_fetched(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    now_seconds: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        non_content_tx_options(),
        move |conn, _ctx| {
            Box::pin(async move {
                record_novel_cover_fetched_in_tx(conn, novel_id, now_seconds).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_freshness_list_candidates(
    db: State<'_, AppDatabase>,
    active_since: Option<i64>,
    mode: Option<ReadMode>,
) -> Result<Vec<CheckCandidateDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel freshness: acquire connection: {err}"))?;
    list_check_candidates_in_conn(&mut conn, active_since).await
}

#[tauri::command]
pub async fn db_novel_freshness_count_recent_by_source(
    db: State<'_, AppDatabase>,
    since_seconds: i64,
    mode: Option<ReadMode>,
) -> Result<Vec<SourceCheckCountDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel freshness: acquire connection: {err}"))?;
    count_recent_checks_by_source_in_conn(&mut conn, since_seconds).await
}

#[tauri::command]
pub async fn db_novel_freshness_get_latest_library_check_at(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<Option<i64>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel freshness: acquire connection: {err}"))?;
    get_latest_library_check_at_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_novel_goal_get(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    mode: Option<ReadMode>,
) -> Result<Option<StoredNovelDownloadGoalDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel goal: acquire connection: {err}"))?;
    get_novel_download_goal_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_novel_goal_list(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<Vec<StoredNovelDownloadGoalDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel goal: acquire connection: {err}"))?;
    list_novel_download_goals_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_novel_goal_set(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    goal: Option<NovelDownloadGoalDto>,
    now: i64,
) -> Result<DbMutationEnvelope<bool>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        non_content_tx_options(),
        move |conn, _ctx| {
            Box::pin(async move {
                set_novel_download_goal_in_tx(conn, novel_id, goal.as_ref(), now).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_goal_list_novels(
    db: State<'_, AppDatabase>,
    active_since: Option<i64>,
    novel_ids: Option<Vec<i64>>,
    mode: Option<ReadMode>,
) -> Result<Vec<DownloadGoalNovelDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel goal: acquire connection: {err}"))?;
    list_download_goal_novels_in_conn(&mut conn, active_since, novel_ids.as_deref()).await
}

#[tauri::command]
pub async fn db_novel_goal_list_ids_for_scope(
    db: State<'_, AppDatabase>,
    scope: String,
    ids: Vec<i64>,
    active_since: Option<i64>,
    mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel goal: acquire connection: {err}"))?;
    list_goal_novel_ids_for_scope_in_conn(&mut conn, &scope, &ids, active_since).await
}

#[tauri::command]
pub async fn db_novel_goal_exclude_chapters(
    db: State<'_, AppDatabase>,
    chapter_ids: Vec<i64>,
    now: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        non_content_tx_options(),
        move |conn, _ctx| {
            Box::pin(async move {
                exclude_chapters_from_download_goals_in_tx(conn, &chapter_ids, now).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_goal_list_excluded_chapter_ids(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel goal: acquire connection: {err}"))?;
    list_download_goal_excluded_chapter_ids_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_novel_goal_resume_stopped(
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<DbMutationEnvelope<bool>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        non_content_tx_options(),
        move |conn, _ctx| {
            Box::pin(async move { resume_stopped_novel_download_goal_in_tx(conn, novel_id).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_novel_goal_list_library_without_goal(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<Vec<NovelWithoutGoalDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel goal: acquire connection: {err}"))?;
    list_library_novels_without_download_goal_in_conn(&mut conn).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;

    #[tokio::test]
    async fn library_queries_cursor_pagination_and_summary_work() {
        let harness = open_test_db().await;
        let pool = harness.db.writer();
        let meta_dir = tempfile::tempdir().unwrap();
        let tx_opts = || TxOptions {
            metadata_root: MetadataRoot::Path(meta_dir.path().to_path_buf()),
            ..TxOptions::default()
        };

        sqlx::query("INSERT INTO installed_plugin (id, name, version, lang, icon_url, source_url, source_code) VALUES ('src', 'Source One', '1.0', 'en', '', 'https://example.com/plugin.js', 'code')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library, is_local, last_read_at, rating) \
             VALUES \
               (1, 'src', 'n1', '/n1', 'Alpha Work', 1, 0, 500, 4.5), \
               (2, 'src', 'n2', '/n2', 'Beta Work', 1, 0, 200, 5), \
               (3, 'local', 'local', 'local', 'Local Work', 1, 1, 800, NULL)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter (id, novel_id, path, name, position, chapter_number, is_downloaded, content_bytes, unread, progress) \
             VALUES \
               (10, 1, '/c1', 'Ch 1', 1, '1', 1, 120, 0, 100), \
               (11, 1, '/c2', 'Ch 2', 2, '2', 0, 80, 1, 0), \
               (20, 2, '/b1', 'Ch 1', 1, '1', 0, 0, 0, 100)",
        )
        .execute(pool)
        .await
        .unwrap();

        let mut conn = harness.db.pool_for(ReadMode::Committed).acquire().await.unwrap();
        let page1 = list_library_novel_page_in_conn(
            &mut conn,
            &LibraryNovelPageFilterDto {
                filter: LibraryFilterDto {
                    sort_order: Some("nameAsc".to_string()),
                    limit: Some(2),
                    ..Default::default()
                },
                cursor: None,
            },
        )
        .await
        .unwrap();
        assert!(page1.has_more);
        assert_eq!(page1.novels.len(), 2);
        assert_eq!(page1.novels[0].name, "Alpha Work");
        assert_eq!(page1.novels[0].chapters_downloaded, 2); // 1 downloaded + 1 stored content_bytes > 0
        assert_eq!(page1.novels[1].name, "Beta Work");

        let page2 = list_library_novel_page_in_conn(
            &mut conn,
            &LibraryNovelPageFilterDto {
                filter: LibraryFilterDto {
                    sort_order: Some("nameAsc".to_string()),
                    limit: Some(2),
                    ..Default::default()
                },
                cursor: page1.next_cursor.clone(),
            },
        )
        .await
        .unwrap();
        assert!(!page2.has_more);
        assert_eq!(page2.novels.len(), 1);
        assert_eq!(page2.novels[0].name, "Local Work");
        assert!(page2.novels[0].is_local);

        let summary = get_library_novel_summary_in_conn(&mut conn, &LibraryFilterDto::default())
            .await
            .unwrap();
        assert_eq!(summary.total_novels, 3);
        assert_eq!(summary.local_novels, 1);
        assert_eq!(summary.complete_novels, 1); // Beta Work has 1 chapter, 0 unread
        assert_eq!(summary.downloaded_chapters, 2);

        let stored = count_library_stored_chapters_in_conn(&mut conn, &[1, 2])
            .await
            .unwrap();
        assert_eq!(stored, 2);

        let sources = list_library_source_filters_in_conn(&mut conn, &LibraryFilterDto::default())
            .await
            .unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].plugin_id, "src");
        assert_eq!(sources[1].plugin_id, "local");

        let detail = get_novel_by_id_in_conn(&mut conn, 2).await.unwrap().unwrap();
        assert_eq!(detail.rating, Some(5.0));
        drop(conn);

        sqlx::query(
            "INSERT INTO novel_download_goal (novel_id, kind, count, updated_at) VALUES (2, 'entire', NULL, 10)",
        )
        .execute(pool)
        .await
        .unwrap();
        with_write_tx(pool, tx_opts(), |conn, ctx| {
            Box::pin(async move { set_novel_in_library_in_tx(conn, ctx, 2, false).await })
        })
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        assert!(get_novel_download_goal_in_conn(&mut conn, 2).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn local_novel_upsert_reorder_and_freshness_goals_work() {
        let harness = open_test_db().await;
        let pool = harness.db.writer();
        let meta_dir = tempfile::tempdir().unwrap();
        let tx_opts = || TxOptions {
            metadata_root: MetadataRoot::Path(meta_dir.path().to_path_buf()),
            ..TxOptions::default()
        };

        let imported = with_write_tx(pool, tx_opts(), |conn, ctx| {
            Box::pin(async move {
                upsert_local_novel_in_tx(
                    conn,
                    ctx,
                    &LocalNovelImportInputDto {
                        path: "local".to_string(),
                        name: "local".to_string(),
                        cover: Some("https://disallowed-remote.invalid/cover.png".to_string()),
                        has_cover: true,
                        summary: Some("Local shelf".to_string()),
                        has_summary: true,
                        author: None,
                        has_author: true,
                        artist: None,
                        has_artist: true,
                        status: None,
                        has_status: true,
                        genres: None,
                        has_genres: true,
                        chapters: vec![
                            LocalNovelImportChapterInputDto {
                                path: "local:book/chapter-0001".to_string(),
                                name: "One".to_string(),
                                position: 1,
                                content_type: Some("text".to_string()),
                                content_bytes: 50,
                                chapter_number: Some("1".to_string()),
                                page: Some("1".to_string()),
                                release_time: None,
                            },
                            LocalNovelImportChapterInputDto {
                                path: "local:book/chapter-0002".to_string(),
                                name: "Two".to_string(),
                                position: 2,
                                content_type: Some("html".to_string()),
                                content_bytes: 60,
                                chapter_number: Some("2".to_string()),
                                page: Some("1".to_string()),
                                release_time: None,
                            },
                        ],
                    },
                )
                .await
            })
        })
        .await
        .unwrap()
        .value;

        assert!(imported.changed);
        assert_eq!(imported.chapter_count, 2);

        let chapter_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM chapter WHERE novel_id = ?1 ORDER BY position",
        )
        .bind(imported.novel_id)
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(chapter_ids.len(), 2);

        let rev = vec![chapter_ids[1], chapter_ids[0]];
        let novel_id = imported.novel_id;
        with_write_tx(pool, tx_opts(), move |conn, _ctx| {
            Box::pin(async move { reorder_local_novel_chapters_in_tx(conn, novel_id, &rev).await })
        })
        .await
        .unwrap();

        let reordered: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM chapter WHERE novel_id = ?1 ORDER BY position",
        )
        .bind(novel_id)
        .fetch_all(pool)
        .await
        .unwrap();
        assert_eq!(reordered, vec![chapter_ids[1], chapter_ids[0]]);

        sqlx::query(
            "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library, is_local, last_read_at) \
             VALUES (50, 'src', 's50', '/s50', 'Source 50', 1, 0, 1000)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter (id, novel_id, path, name, position) VALUES (500, 50, '/c500', 'C500', 1)",
        )
        .execute(pool)
        .await
        .unwrap();

        with_write_tx(pool, non_content_tx_options(), |conn, _ctx| {
            Box::pin(async move {
                record_novel_check_in_tx(conn, 50, true, 3, 2000).await?;
                record_novel_cover_fetched_in_tx(conn, 50, 2100).await?;
                set_novel_download_goal_in_tx(
                    conn,
                    50,
                    Some(&NovelDownloadGoalDto::KeepAhead { count: 5 }),
                    3000,
                )
                .await?;
                exclude_chapters_from_download_goals_in_tx(conn, &[500], 3100).await?;
                Ok(())
            })
        })
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        let fresh = get_novel_freshness_in_conn(&mut conn, 50)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fresh.last_new_chapter_at, Some(2000));
        assert_eq!(fresh.cover_fetched_at, Some(2100));
        assert_eq!(
            get_latest_library_check_at_in_conn(&mut conn).await.unwrap(),
            Some(2000)
        );
        let candidates = list_check_candidates_in_conn(&mut conn, Some(900))
            .await
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].has_goal);

        let goal_novels = list_download_goal_novels_in_conn(&mut conn, Some(900), None)
            .await
            .unwrap();
        assert_eq!(goal_novels.len(), 1);
        assert_eq!(
            goal_novels[0].goal,
            Some(NovelDownloadGoalDto::KeepAhead { count: 5 })
        );
        assert_eq!(
            list_download_goal_excluded_chapter_ids_in_conn(&mut conn, 50)
                .await
                .unwrap(),
            vec![500]
        );
    }
}
