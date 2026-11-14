use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;

use super::chapter_composition::get_chapter_composition_in_tx;
use super::novel::{
    get_novel_by_id_in_conn, reconcile_imported_novel_identity_in_tx, ImportedChapterIdentityDto,
    NovelDetailRecordDto,
};
use super::novel_merge::{
    immutable_lineage_proof, normalize_content_server_url_strict, record_pending_novel_merge_in_tx,
    RecordPendingNovelMergeInputDto, INCOMING_MIGRATION_CACHE_PREFIX, NOVEL_MIGRATION_CACHE_PREFIX,
};
use super::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use super::user_state::{
    core::{
        chapter_reference_json, chapter_work_json, has_user_state_schema_in_tx,
        map_user_chapter_row, record_chapter_rows_in_tx, record_library_in_tx,
        record_membership_in_tx, record_resume_cleared_in_tx, USER_CHAPTER_SELECT,
    },
    types::user_state_entity_key,
};
use super::work_metadata::canonical_json_value;
use super::{
    ChapterDirectoryUpdateDto, DbMutationEnvelope, ReadMode, WorkDirectoryUpdateDto,
};

const LOCAL_PLUGIN_ID: &str = "local";
const INCOMING_MIGRATION_CURSOR_PREFIX: &str = "norea-content-incoming-migration-cursor:";
pub const SERVER_CHAPTER_RENUMBER_PREFIX: &str = "norea-content-chapter-number-reconciliation:";

fn canonical_finite_number_str(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed: f64 = trimmed.parse().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    if parsed == 0.0 {
        return Some("0".to_string());
    }
    Some(format!("{parsed}"))
}

fn assert_server_chapter_number_matches(
    current: Option<&str>,
    incoming: Option<&str>,
) -> Result<(), String> {
    let from = canonical_finite_number_str(current);
    let to = canonical_finite_number_str(incoming);
    if let (Some(f), Some(t)) = (from, to) {
        if f != t {
            return Err(
                "Synchronize the corrected work metadata before importing its chapters. Existing files were retained."
                    .to_string(),
            );
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChapterSummaryInputDto {
    pub chapter_path: String,
    pub name: String,
    pub position: i64,
    #[serde(default)]
    pub chapter_number: Option<String>,
    pub content_type: String,
    pub page: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSyncChapterDto {
    pub chapter_id: i64,
    pub novel_id: i64,
    pub plugin_id: String,
    pub novel_path: String,
    pub source_novel_id: Option<String>,
    pub chapter_path: String,
    pub novel_name: String,
    pub author: Option<String>,
    pub summary: Option<String>,
    pub is_local: bool,
    pub chapter_name: String,
    pub chapter_number: Option<String>,
    pub position: i64,
    pub page: String,
    pub content_type: String,
    pub is_downloaded: bool,
    pub media_repair_needed: bool,
    pub is_download_queued: bool,
    pub content_bytes: i64,
    pub media_bytes: i64,
}

fn map_content_sync_chapter_row(row: &sqlx::sqlite::SqliteRow) -> ContentSyncChapterDto {
    ContentSyncChapterDto {
        chapter_id: row.get("chapterId"),
        novel_id: row.get("novelId"),
        plugin_id: row.get("pluginId"),
        novel_path: row.get("novelPath"),
        source_novel_id: row.get("sourceNovelId"),
        chapter_path: row.get("chapterPath"),
        novel_name: row.get("novelName"),
        author: row.get("author"),
        summary: row.get("summary"),
        is_local: row.get::<i64, _>("isLocal") != 0,
        chapter_name: row.get("chapterName"),
        chapter_number: row.get("chapterNumber"),
        position: row.get("position"),
        page: row.get("page"),
        content_type: row.get("contentType"),
        is_downloaded: row.get::<i64, _>("isDownloaded") != 0,
        media_repair_needed: row.get::<i64, _>("mediaRepairNeeded") != 0,
        is_download_queued: row.get::<i64, _>("isDownloadQueued") != 0,
        content_bytes: row.get("contentBytes"),
        media_bytes: row.get("mediaBytes"),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationWorkIdentityDto {
    pub plugin_id: String,
    pub novel_id: String,
    pub novel_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifestIdentityDto {
    pub plugin_id: String,
    pub novel_id: String,
    pub novel_path: String,
    pub chapter_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifestChapterDto {
    pub name: String,
    pub position: i64,
    #[serde(default)]
    pub chapter_number: Option<String>,
    pub content_type: String,
    pub page: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifestInputDto {
    pub identity: PackageManifestIdentityDto,
    pub chapter: PackageManifestChapterDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedContentMetadataDto {
    pub novel_id: i64,
    pub chapter_id: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentJournalEntryDto {
    pub sequence: i64,
    pub key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSyncCacheEntryDto {
    pub cache_key: String,
    pub payload: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLocalNovelRecordsInputDto {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub path: String,
    #[serde(default)]
    pub record_user_state_removal: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelIdentityGuardInputDto {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub path: String,
}

pub async fn is_novel_migration_source_held_in_conn(
    conn: &mut SqliteConnection,
    server_url: &str,
    plugin_id: &str,
    novel_path: &str,
    novel_id: &str,
) -> Result<bool, String> {
    let trimmed = server_url.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let normalized = normalize_content_server_url_strict(trimmed, true)?;
    let raw_trimmed = trimmed.trim_end_matches('/').to_string();
    let migration_like = format!("{NOVEL_MIGRATION_CACHE_PREFIX}%");

    let held: i64 = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM content_sync_cache WHERE cache_key LIKE ?1 \
           AND rtrim(json_extract(payload, '$.serverUrl'), '/') IN (?2, ?6) \
           AND json_extract(payload, '$.source.pluginId') = ?3 \
           AND (json_extract(payload, '$.source.novelPath') = ?4 OR json_extract(payload, '$.source.novelId') = ?5) \
           UNION ALL \
           SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-content-incoming-migration:%' \
           AND rtrim(json_extract(payload, '$.serverUrl'), '/') IN (?2, ?6) \
           AND json_extract(payload, '$.status') <> 'inactive' \
           AND json_extract(payload, '$.source.pluginId') = ?3 \
           AND (json_extract(payload, '$.source.novelPath') = ?4 OR json_extract(payload, '$.source.novelId') = ?5) \
           UNION ALL \
           SELECT 1 FROM content_sync_cache WHERE cache_key LIKE 'norea-content-chapter-number-reconciliation:%' \
           AND rtrim(json_extract(payload, '$.serverUrl'), '/') IN (?2, ?6) \
           AND json_extract(payload, '$.status') = 'pending' \
           AND json_extract(payload, '$.identity.pluginId') = ?3 \
           AND (json_extract(payload, '$.identity.novelPath') = ?4 OR json_extract(payload, '$.identity.novelId') = ?5) \
         ) AS held",
    )
    .bind(migration_like)
    .bind(&normalized)
    .bind(plugin_id)
    .bind(novel_path)
    .bind(novel_id)
    .bind(&raw_trimmed)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: check migration source hold: {err}"))?;

    Ok(held != 0)
}

pub async fn cache_server_chapters_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    chapters: &[ServerChapterSummaryInputDto],
) -> Result<bool, String> {
    let novel_plugin_id: Option<String> =
        sqlx::query_scalar("SELECT plugin_id FROM novel WHERE id = ?1")
            .bind(novel_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db content sync: load novel plugin id: {err}"))?;

    let existing_rows =
        sqlx::query("SELECT path, chapter_number FROM chapter WHERE novel_id = ?1")
            .bind(novel_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db content sync: list existing chapters: {err}"))?;

    let mut paths: HashSet<String> = HashSet::with_capacity(existing_rows.len());
    let mut by_path: HashMap<String, Option<String>> = HashMap::with_capacity(existing_rows.len());
    let mut numbers: HashMap<String, Vec<String>> = HashMap::new();

    for row in existing_rows {
        let path: String = row.get("path");
        let chapter_number: Option<String> = row.get("chapter_number");
        if let Some(canon) = canonical_finite_number_str(chapter_number.as_deref()) {
            numbers.entry(canon).or_default().push(path.clone());
        }
        paths.insert(path.clone());
        by_path.insert(path, chapter_number);
    }

    let composition = get_chapter_composition_in_tx(conn, novel_id).await?;
    let included = composition.as_ref().map(|comp| {
        comp.entries
            .iter()
            .filter(|entry| entry.user.included)
            .map(|entry| (entry.path.clone(), entry))
            .collect::<HashMap<_, _>>()
    });

    struct IncomingRow {
        chapter_path: String,
        name: String,
        chapter_number: Option<String>,
        position: i64,
        page: String,
        content_type: String,
    }

    let mut incoming: Vec<IncomingRow> = Vec::new();
    let is_local_plugin = novel_plugin_id.as_deref() == Some(LOCAL_PLUGIN_ID);

    for chapter in chapters {
        if let Some(ref inc) = included {
            if !inc.contains_key(&chapter.chapter_path) {
                continue;
            }
        }
        if paths.contains(&chapter.chapter_path) {
            let existing_num = by_path
                .get(&chapter.chapter_path)
                .and_then(|v| v.as_deref());
            assert_server_chapter_number_matches(existing_num, chapter.chapter_number.as_deref())?;
            continue;
        }
        let number = if !is_local_plugin {
            canonical_finite_number_str(chapter.chapter_number.as_deref())
        } else {
            None
        };
        if let Some(ref num) = number {
            if let Some(matches) = numbers.get(num) {
                if !matches.is_empty() {
                    if matches.len() > 1 {
                        return Err(
                            "Server chapter number matches multiple local chapters.".to_string()
                        );
                    }
                    continue;
                }
            }
        }

        if let Some(entry) = included
            .as_ref()
            .and_then(|inc| inc.get(&chapter.chapter_path))
        {
            assert_server_chapter_number_matches(
                Some(entry.storage_chapter_number.as_str()),
                chapter.chapter_number.as_deref(),
            )?;
            let source = entry
                .sources
                .get(entry.primary_source)
                .ok_or_else(|| "Chapter composition primary source is missing.".to_string())?;
            incoming.push(IncomingRow {
                chapter_path: chapter.chapter_path.clone(),
                name: entry
                    .user
                    .name
                    .clone()
                    .unwrap_or_else(|| source.name.clone()),
                chapter_number: chapter.chapter_number.clone(),
                position: entry.user.order,
                page: source.page.clone(),
                content_type: source.content_type.clone(),
            });
        } else {
            incoming.push(IncomingRow {
                chapter_path: chapter.chapter_path.clone(),
                name: chapter.name.clone(),
                chapter_number: chapter.chapter_number.clone(),
                position: chapter.position,
                page: chapter.page.clone(),
                content_type: chapter.content_type.clone(),
            });
        }
        paths.insert(chapter.chapter_path.clone());
        if let Some(num) = number {
            numbers.insert(num, vec![chapter.chapter_path.clone()]);
        }
    }

    let mut inserted = false;
    for batch in incoming.chunks(100) {
        let values_sql: Vec<String> = (0..batch.len())
            .map(|idx| {
                let p = idx * 7 + 1;
                format!(
                    "(?{}, ?{}, ?{}, ?{}, ?{}, ?{}, ?{})",
                    p,
                    p + 1,
                    p + 2,
                    p + 3,
                    p + 4,
                    p + 5,
                    p + 6
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO chapter(novel_id, path, name, chapter_number, position, page, content_type) \
             VALUES {} ON CONFLICT(novel_id, path) DO NOTHING",
            values_sql.join(",")
        );
        let mut query = sqlx::query(&sql);
        for item in batch {
            query = query
                .bind(novel_id)
                .bind(&item.chapter_path)
                .bind(&item.name)
                .bind(&item.chapter_number)
                .bind(item.position)
                .bind(&item.page)
                .bind(&item.content_type);
        }
        let res = query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db content sync: insert cached server chapters: {err}"))?;
        inserted |= res.rows_affected() > 0;
    }

    Ok(inserted)
}

pub async fn select_content_sync_chapters_in_conn(
    conn: &mut SqliteConnection,
    identities: Option<&[String]>,
    downloaded_only: bool,
    match_works: bool,
) -> Result<Vec<ContentSyncChapterDto>, String> {
    if let Some(ids) = identities {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        if ids.len() > 100 {
            let mut out = Vec::new();
            for chunk in ids.chunks(100) {
                out.extend(
                    select_content_sync_chapters_block_in_conn(
                        conn,
                        Some(chunk),
                        downloaded_only,
                        match_works,
                    )
                    .await?,
                );
            }
            return Ok(out);
        }
    }
    select_content_sync_chapters_block_in_conn(conn, identities, downloaded_only, match_works).await
}

async fn select_content_sync_chapters_block_in_conn(
    conn: &mut SqliteConnection,
    identities: Option<&[String]>,
    downloaded_only: bool,
    match_works: bool,
) -> Result<Vec<ContentSyncChapterDto>, String> {
    let columns: &[&str] = if match_works {
        &["plugin_id", "novel_path"]
    } else {
        &["plugin_id", "novel_path", "chapter_path"]
    };

    let mut targets: Vec<String> = Vec::new();
    let prefix = if let Some(ids) = identities {
        for raw in ids {
            let parsed: Vec<String> = serde_json::from_str(raw)
                .map_err(|err| format!("db content sync: invalid content identity JSON: {err}"))?;
            if parsed.len() < columns.len() {
                return Err("db content sync: content identity has too few segments".to_string());
            }
            targets.extend(parsed.into_iter().take(columns.len()));
        }
        let tuples: Vec<String> = (0..ids.len())
            .map(|i| {
                let slots: Vec<String> = (0..columns.len())
                    .map(|col| format!("?{}", i * columns.len() + col + 1))
                    .collect();
                format!("({})", slots.join(","))
            })
            .collect();
        format!(
            "WITH targets({}) AS (VALUES {}) ",
            columns.join(","),
            tuples.join(",")
        )
    } else {
        String::new()
    };

    let from = if identities.is_some() {
        if match_works {
            "targets t JOIN novel n ON n.plugin_id = t.plugin_id AND n.path = t.novel_path \
             JOIN chapter c ON c.novel_id = n.id"
        } else {
            "targets t JOIN novel n ON n.plugin_id = t.plugin_id AND n.path = t.novel_path \
             JOIN chapter c ON c.novel_id = n.id AND c.path = t.chapter_path"
        }
    } else {
        "chapter c JOIN novel n ON n.id = c.novel_id"
    };

    let where_clause = if downloaded_only {
        "WHERE (c.is_downloaded = 1 OR c.content_bytes > 0) "
    } else {
        ""
    };

    let sql = format!(
        "{prefix}SELECT \
           c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath, \
           n.source_novel_id AS sourceNovelId, c.path AS chapterPath, n.name AS novelName, \
           n.author, n.summary, n.is_local AS isLocal, c.name AS chapterName, \
           c.chapter_number AS chapterNumber, c.position, c.page, \
           COALESCE(c.stored_content_type, c.content_type) AS contentType, \
           c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded, \
           c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes, \
           EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = c.id) AS isDownloadQueued \
         FROM {from} {where_clause}\
         ORDER BY n.id, c.position, c.id"
    );

    let mut query = sqlx::query(&sql);
    for t in &targets {
        query = query.bind(t);
    }
    let rows = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db content sync: select chapters: {err}"))?;

    Ok(rows.iter().map(map_content_sync_chapter_row).collect())
}

pub async fn import_content_metadata_in_tx(
    conn: &mut SqliteConnection,
    manifest: &PackageManifestInputDto,
    server_url: Option<&str>,
) -> Result<ImportedContentMetadataDto, String> {
    let identity = &manifest.identity;
    let chapter = &manifest.chapter;

    if let Some(url) = server_url {
        if is_novel_migration_source_held_in_conn(
            conn,
            url,
            &identity.plugin_id,
            &identity.novel_path,
            &identity.novel_id,
        )
        .await?
        {
            return Err(
                "The original work is held while its server migration completes.".to_string(),
            );
        }
    }

    let novel_row = sqlx::query(
        "SELECT id, source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&identity.plugin_id)
    .bind(&identity.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: load target novel for import: {err}"))?;

    let Some(novel_row) = novel_row else {
        return Err("Install the work metadata before downloading its chapters.".to_string());
    };
    let novel_id: i64 = novel_row.get("id");
    let source_novel_id: Option<String> = novel_row.get("source_novel_id");
    if source_novel_id.as_deref() != Some(identity.novel_id.as_str()) {
        return Err("Server chapter novel ID does not match the installed work.".to_string());
    }

    let composition = get_chapter_composition_in_tx(conn, novel_id).await?;
    if let Some(ref comp) = composition {
        let comp_entry = comp
            .entries
            .iter()
            .find(|entry| entry.path == identity.chapter_path);
        let valid = comp_entry.is_some_and(|entry| {
            entry.user.included
                && Some(entry.storage_chapter_number.as_str()) == chapter.chapter_number.as_deref()
        });
        if !valid {
            return Err(
                "The server chapter is excluded from the final chapter list or has a different storage identity."
                    .to_string(),
            );
        }
    }

    let current_chapter = sqlx::query(
        "SELECT chapter_number FROM chapter WHERE novel_id = ?1 AND path = ?2",
    )
    .bind(novel_id)
    .bind(&identity.chapter_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: load current chapter for import: {err}"))?;

    if let Some(cur) = current_chapter {
        let cur_num: Option<String> = cur.get("chapter_number");
        assert_server_chapter_number_matches(
            cur_num.as_deref(),
            chapter.chapter_number.as_deref(),
        )?;
    }

    let trimmed_num = chapter
        .chapter_number
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if composition.is_none()
        && identity.plugin_id != LOCAL_PLUGIN_ID
        && !identity.chapter_path.starts_with("norea-folder:")
    {
        if let Some(num) = trimmed_num {
            if num.parse::<f64>().is_ok_and(f64::is_finite) {
                let anchors = vec![ImportedChapterIdentityDto {
                    path: identity.chapter_path.clone(),
                    chapter_number: Some(num.to_string()),
                }];
                reconcile_imported_novel_identity_in_tx(
                    conn,
                    &identity.plugin_id,
                    &identity.novel_path,
                    &anchors,
                )
                .await?;
            }
        }
    }

    sqlx::query(
        "INSERT INTO chapter(novel_id, path, name, chapter_number, position, page, content_type) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(novel_id, path) DO NOTHING",
    )
    .bind(novel_id)
    .bind(&identity.chapter_path)
    .bind(&chapter.name)
    .bind(&chapter.chapter_number)
    .bind(chapter.position)
    .bind(&chapter.page)
    .bind(&chapter.content_type)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: insert imported chapter metadata: {err}"))?;

    let chapter_id: i64 =
        sqlx::query_scalar("SELECT id FROM chapter WHERE novel_id = ?1 AND path = ?2")
            .bind(novel_id)
            .bind(&identity.chapter_path)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db content sync: read imported chapter id: {err}"))?;

    Ok(ImportedContentMetadataDto {
        novel_id,
        chapter_id,
    })
}

fn incoming_receipt_key(server_url: &str, operation_id: &str) -> String {
    format!(
        "{INCOMING_MIGRATION_CACHE_PREFIX}{}",
        serde_json::to_string(&(server_url, operation_id)).unwrap()
    )
}

fn server_receipt_prefix(server_url: &str) -> String {
    let encoded = serde_json::to_string(&[server_url]).unwrap();
    format!(
        "{INCOMING_MIGRATION_CACHE_PREFIX}{},",
        &encoded[..encoded.len() - 1]
    )
}

fn validate_incoming_record_shape(raw: &JsonValue) -> Result<(String, String, i64, String), String> {
    let Some(obj) = raw.as_object() else {
        return Err(
            "Incoming work migration is invalid: expected an object. Synchronization was held."
                .to_string(),
        );
    };
    if obj.get("version").and_then(JsonValue::as_i64) != Some(1) {
        return Err(
            "Incoming work migration is invalid: stored receipt. Synchronization was held."
                .to_string(),
        );
    }
    let raw_server = obj
        .get("serverUrl")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| {
            "Incoming work migration is invalid: server URL. Synchronization was held.".to_string()
        })?;
    let server_url = normalize_content_server_url_strict(raw_server, true)?;
    let operation_id = obj
        .get("operationId")
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Incoming work migration is invalid: operation ID. Synchronization was held."
                .to_string()
        })?
        .to_string();
    let sequence = obj
        .get("sequence")
        .and_then(JsonValue::as_i64)
        .filter(|&n| n > 0)
        .ok_or_else(|| {
            "Incoming work migration is invalid: sequence. Synchronization was held.".to_string()
        })?;
    let status = obj
        .get("status")
        .and_then(JsonValue::as_str)
        .filter(|s| {
            matches!(
                *s,
                "pending" | "failed" | "blocked" | "completed" | "inactive"
            )
        })
        .ok_or_else(|| {
            "Incoming work migration is invalid: stored receipt. Synchronization was held."
                .to_string()
        })?
        .to_string();
    let lineage = obj.get("lineage").ok_or_else(|| {
        "Incoming work migration is invalid: stored receipt. Synchronization was held.".to_string()
    })?;
    let lineage_active = lineage.get("active").and_then(JsonValue::as_bool);
    let lineage_seq = lineage.get("sequence").and_then(JsonValue::as_i64);
    let lineage_op = lineage.get("operationId").and_then(JsonValue::as_str);
    if lineage_op != Some(operation_id.as_str())
        || lineage_seq != Some(sequence)
        || (status == "inactive") != (lineage_active == Some(false))
    {
        return Err(
            "Incoming work migration is invalid: stored receipt. Synchronization was held."
                .to_string(),
        );
    }
    let _ = immutable_lineage_proof(lineage)?;
    Ok((server_url, operation_id, sequence, status))
}

fn merge_lineage_into_previous(
    server_url: &str,
    lineage: &JsonValue,
    previous: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    let operation_id = lineage
        .get("operationId")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| {
            "Incoming work migration is invalid: operation ID. Synchronization was held."
                .to_string()
        })?;
    let sequence = lineage
        .get("sequence")
        .and_then(JsonValue::as_i64)
        .filter(|&n| n > 0)
        .ok_or_else(|| {
            "Incoming work migration is invalid: sequence. Synchronization was held.".to_string()
        })?;
    let active = lineage
        .get("active")
        .and_then(JsonValue::as_bool)
        .ok_or_else(|| {
            "Incoming work migration is invalid: active. Synchronization was held.".to_string()
        })?;
    let next_proof = immutable_lineage_proof(lineage)?;

    if let Some(prev) = previous {
        let (prev_server, prev_op, prev_seq, prev_status) = validate_incoming_record_shape(prev)?;
        let prev_lineage = prev.get("lineage").unwrap_or(&JsonValue::Null);
        let prev_legacy = prev_lineage
            .get("legacyOperationId")
            .and_then(JsonValue::as_str);
        let next_legacy = lineage.get("legacyOperationId").and_then(JsonValue::as_str);
        if prev_server != server_url
            || prev_op != operation_id
            || immutable_lineage_proof(prev_lineage)? != next_proof
            || (prev_legacy.is_some() && prev_legacy != next_legacy)
        {
            return Err(
                "Incoming work migration is invalid: immutable lineage changed. Synchronization was held."
                    .to_string(),
            );
        }
        if sequence < prev_seq {
            return Ok(prev.clone());
        }
        let prev_active = prev_lineage.get("active").and_then(JsonValue::as_bool);
        if sequence == prev_seq && Some(active) != prev_active {
            return Err(
                "Incoming work migration is invalid: event state changed without a new sequence. Synchronization was held."
                    .to_string(),
            );
        }
        let status = if !active {
            "inactive"
        } else if prev_status != "inactive" {
            prev_status.as_str()
        } else {
            "pending"
        };
        let source = lineage
            .get("sourceWork")
            .and_then(|w| w.get("identity"))
            .cloned()
            .unwrap_or(JsonValue::Null);
        let target = lineage
            .get("targetWork")
            .and_then(|w| w.get("identity"))
            .cloned()
            .unwrap_or(JsonValue::Null);
        let mut out = json!({
            "version": 1,
            "serverUrl": server_url,
            "operationId": operation_id,
            "sequence": sequence,
            "source": source,
            "target": target,
            "status": status,
            "lineage": lineage,
        });
        if active && prev_status != "inactive" {
            if let Some(err_val) = prev.get("error").and_then(JsonValue::as_str) {
                out.as_object_mut()
                    .unwrap()
                    .insert("error".to_string(), json!(err_val));
            }
        }
        return Ok(out);
    }

    let source = lineage
        .get("sourceWork")
        .and_then(|w| w.get("identity"))
        .cloned()
        .unwrap_or(JsonValue::Null);
    let target = lineage
        .get("targetWork")
        .and_then(|w| w.get("identity"))
        .cloned()
        .unwrap_or(JsonValue::Null);
    Ok(json!({
        "version": 1,
        "serverUrl": server_url,
        "operationId": operation_id,
        "sequence": sequence,
        "source": source,
        "target": target,
        "status": if active { "pending" } else { "inactive" },
        "lineage": lineage,
    }))
}

pub async fn save_incoming_migration_in_tx(
    conn: &mut SqliteConnection,
    proposed_raw: &JsonValue,
) -> Result<JsonValue, String> {
    let (server_url, operation_id, proposed_seq, proposed_status) =
        validate_incoming_record_shape(proposed_raw)?;
    let mut proposed = proposed_raw.clone();
    if let Some(obj) = proposed.as_object_mut() {
        obj.insert("serverUrl".to_string(), json!(server_url));
    }
    let key = incoming_receipt_key(&server_url, &operation_id);

    let existing_row =
        sqlx::query("SELECT cache_key, payload FROM content_sync_cache WHERE cache_key = ?1")
            .bind(&key)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db content sync: read existing incoming migration: {err}"))?;

    let previous = match existing_row {
        Some(row) => {
            let row_key: String = row.get("cache_key");
            let payload: String = row.get("payload");
            let parsed: JsonValue = serde_json::from_str(&payload).map_err(|_| {
                "Incoming work migration is invalid: stored receipt. Synchronization was held."
                    .to_string()
            })?;
            let (p_srv, p_op, _, _) = validate_incoming_record_shape(&parsed)?;
            if row_key != incoming_receipt_key(&p_srv, &p_op) {
                return Err(
                    "Incoming work migration is invalid: receipt cache identity. Synchronization was held."
                        .to_string(),
                );
            }
            Some(parsed)
        }
        None => None,
    };

    let proposed_lineage = proposed.get("lineage").unwrap_or(&JsonValue::Null);
    let checked = merge_lineage_into_previous(&server_url, proposed_lineage, previous.as_ref())?;
    let checked_seq = checked
        .get("sequence")
        .and_then(JsonValue::as_i64)
        .unwrap_or(0);
    let checked_status = checked
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or("");

    let selected = if checked_seq > proposed_seq
        || (checked_status == "completed" && proposed_status != "inactive")
    {
        checked
    } else {
        proposed
    };

    let encoded = serde_json::to_string(&selected)
        .map_err(|err| format!("db content sync: encode incoming migration: {err}"))?;
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(&key)
    .bind(encoded)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: write incoming migration: {err}"))?;

    Ok(selected)
}

fn parse_incoming_cursor_payload(payload: &str, server_url: &str) -> Result<i64, String> {
    let parsed: JsonValue = serde_json::from_str(payload).map_err(|_| {
        "Incoming work migration is invalid: stored cursor. Synchronization was held.".to_string()
    })?;
    let Some(obj) = parsed.as_object() else {
        return Err(
            "Incoming work migration is invalid: stored cursor. Synchronization was held."
                .to_string(),
        );
    };
    if obj.get("version").and_then(JsonValue::as_i64) != Some(1)
        || obj.get("serverUrl").and_then(JsonValue::as_str) != Some(server_url)
    {
        return Err(
            "Incoming work migration is invalid: stored cursor. Synchronization was held."
                .to_string(),
        );
    }
    let cursor = obj
        .get("cursor")
        .and_then(JsonValue::as_i64)
        .filter(|&c| c >= 0)
        .ok_or_else(|| {
            "Incoming work migration is invalid: cursor. Synchronization was held.".to_string()
        })?;
    Ok(cursor)
}

pub async fn get_incoming_migration_cursor_in_conn(
    conn: &mut SqliteConnection,
    server: &str,
) -> Result<i64, String> {
    let server_url = normalize_content_server_url_strict(server, true)?;
    let key = format!("{INCOMING_MIGRATION_CURSOR_PREFIX}{server_url}");
    let payload: Option<String> =
        sqlx::query_scalar("SELECT payload FROM content_sync_cache WHERE cache_key = ?1")
            .bind(&key)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db content sync: read incoming migration cursor: {err}"))?;
    match payload {
        Some(raw) => parse_incoming_cursor_payload(&raw, &server_url),
        None => Ok(0),
    }
}

pub async fn save_incoming_migration_cursor_in_tx(
    conn: &mut SqliteConnection,
    server: &str,
    cursor: i64,
) -> Result<(), String> {
    if cursor < 0 {
        return Err(
            "Incoming work migration is invalid: cursor. Synchronization was held.".to_string(),
        );
    }
    let server_url = normalize_content_server_url_strict(server, true)?;
    let previous = get_incoming_migration_cursor_in_conn(conn, &server_url).await?;
    let key = format!("{INCOMING_MIGRATION_CURSOR_PREFIX}{server_url}");
    let payload = serde_json::to_string(&json!({
        "version": 1,
        "serverUrl": server_url,
        "cursor": previous.max(cursor),
    }))
    .unwrap();
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(&key)
    .bind(payload)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: save incoming migration cursor: {err}"))?;
    Ok(())
}

pub async fn remember_incoming_migration_page_in_tx(
    conn: &mut SqliteConnection,
    server: &str,
    items: &[JsonValue],
    cursor: i64,
) -> Result<(), String> {
    let server_url = normalize_content_server_url_strict(server, true)?;
    let prefix = server_receipt_prefix(&server_url);
    let rows = sqlx::query(
        "SELECT cache_key, payload FROM content_sync_cache \
         WHERE substr(cache_key, 1, length(?1)) = ?1 ORDER BY cache_key",
    )
    .bind(&prefix)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db content sync: load incoming migrations for page: {err}"))?;

    let mut previous: HashMap<String, JsonValue> = HashMap::with_capacity(rows.len());
    for row in rows {
        let row_key: String = row.get("cache_key");
        let payload: String = row.get("payload");
        let parsed: JsonValue = serde_json::from_str(&payload).map_err(|_| {
            "Incoming work migration is invalid: stored receipt. Synchronization was held."
                .to_string()
        })?;
        let (p_srv, p_op, _, _) = validate_incoming_record_shape(&parsed)?;
        if row_key != incoming_receipt_key(&p_srv, &p_op) {
            return Err(
                "Incoming work migration is invalid: receipt cache identity. Synchronization was held."
                    .to_string(),
            );
        }
        previous.insert(p_op, parsed);
    }

    let mut changed_sources: HashSet<String> = HashSet::new();
    for entry in items {
        let op_id = entry
            .get("operationId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| {
                "Incoming work migration is invalid: operation ID. Synchronization was held."
                    .to_string()
            })?;
        let entry_seq = entry
            .get("sequence")
            .and_then(JsonValue::as_i64)
            .unwrap_or(0);
        let old = previous.get(op_id);
        let old_seq = old
            .and_then(|v| v.get("sequence"))
            .and_then(JsonValue::as_i64)
            .unwrap_or(0);
        if old.is_none() || entry_seq > old_seq {
            if let Some(src_id) = entry
                .get("sourceWork")
                .and_then(|w| w.get("id"))
                .and_then(JsonValue::as_str)
            {
                changed_sources.insert(src_id.to_string());
            }
        }
        let proposed = merge_lineage_into_previous(&server_url, entry, old)?;
        let saved = save_incoming_migration_in_tx(conn, &proposed).await?;
        previous.insert(op_id.to_string(), saved);
    }

    let mut successors: HashMap<String, Vec<String>> = HashMap::new();
    for value in previous.values() {
        let Some(lineage) = value.get("lineage") else {
            continue;
        };
        if lineage.get("active").and_then(JsonValue::as_bool) != Some(true) {
            continue;
        }
        if let (Some(src_id), Some(dst_id)) = (
            lineage
                .get("sourceWork")
                .and_then(|w| w.get("id"))
                .and_then(JsonValue::as_str),
            lineage
                .get("targetWork")
                .and_then(|w| w.get("id"))
                .and_then(JsonValue::as_str),
        ) {
            successors
                .entry(src_id.to_string())
                .or_default()
                .push(dst_id.to_string());
        }
    }

    let snapshot_records: Vec<JsonValue> = previous.values().cloned().collect();
    for record in snapshot_records {
        if record.get("status").and_then(JsonValue::as_str) != Some("blocked") {
            continue;
        }
        let Some(target_id) = record
            .get("lineage")
            .and_then(|l| l.get("targetWork"))
            .and_then(|w| w.get("id"))
            .and_then(JsonValue::as_str)
        else {
            continue;
        };
        let mut remaining = vec![target_id.to_string()];
        let mut visited: HashSet<String> = HashSet::new();
        let mut affected = false;
        while let Some(id) = remaining.pop() {
            if affected {
                break;
            }
            if !visited.insert(id.clone()) {
                continue;
            }
            if changed_sources.contains(&id) {
                affected = true;
            }
            if let Some(edges) = successors.get(&id) {
                remaining.extend(edges.iter().cloned());
            }
        }
        if affected {
            let mut reopened = record.clone();
            if let Some(obj) = reopened.as_object_mut() {
                obj.insert("status".to_string(), json!("pending"));
                obj.remove("error");
            }
            save_incoming_migration_in_tx(conn, &reopened).await?;
        }
    }

    save_incoming_migration_cursor_in_tx(conn, &server_url, cursor).await?;
    Ok(())
}

pub async fn delete_local_novel_records_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &DeleteLocalNovelRecordsInputDto,
) -> Result<(), String> {
    let current = sqlx::query(
        "SELECT plugin_id, source_novel_id, path, name, in_library, last_read_at \
         FROM novel WHERE id = ?1",
    )
    .bind(input.id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db content deletion: load novel for deletion: {err}"))?;

    let Some(current) = current else {
        return Ok(());
    };
    let cur_plugin: String = current.get("plugin_id");
    let cur_source_id: Option<String> = current.get("source_novel_id");
    let cur_path: String = current.get("path");
    let cur_name: String = current.get("name");
    let cur_in_library: i64 = current.get("in_library");
    let cur_last_read_at: Option<i64> = current.get("last_read_at");

    if cur_plugin != input.plugin_id
        || cur_source_id != input.source_novel_id
        || cur_path != input.path
    {
        return Err("Local work identity changed before deletion.".to_string());
    }

    if input.record_user_state_removal && has_user_state_schema_in_tx(conn).await? {
        let work_json = json!({
            "pluginId": cur_plugin,
            "sourceNovelId": cur_source_id,
            "novelPath": cur_path,
            "name": cur_name,
        });
        let category_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT category_id FROM novel_category WHERE novel_id = ?1",
        )
        .bind(input.id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db content deletion: list novel categories: {err}"))?;

        for cat_id in category_ids {
            record_membership_in_tx(conn, ctx, &[input.id], cat_id, false, false).await?;
        }

        let library_key = user_state_entity_key(&json!({
            "kind": "library",
            "work": work_json,
        }))?;
        let has_library_state = if cur_in_library != 0 {
            true
        } else {
            let exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM user_state_intent WHERE entity_key = ?1) \
                 OR EXISTS(SELECT 1 FROM user_state_record WHERE entity_key = ?1)",
            )
            .bind(&library_key)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db content deletion: check library user state: {err}"))?;
            exists != 0
        };
        if has_library_state {
            record_library_in_tx(conn, ctx, Some(&[input.id]), true).await?;
        }

        let resume_key = user_state_entity_key(&json!({
            "kind": "resume",
            "work": work_json,
        }))?;
        let has_resume_state = if cur_last_read_at.is_some() {
            true
        } else {
            let exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM user_state_intent WHERE entity_key = ?1) \
                 OR EXISTS(SELECT 1 FROM user_state_record WHERE entity_key = ?1) \
                 OR EXISTS(SELECT 1 FROM work_metadata_reading_state WHERE plugin_id = ?2 AND novel_path = ?3)",
            )
            .bind(&resume_key)
            .bind(&cur_plugin)
            .bind(&cur_path)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db content deletion: check resume user state: {err}"))?;
            exists != 0
        };
        if has_resume_state {
            record_resume_cleared_in_tx(conn, ctx, Some(&[input.id])).await?;
        }

        let chapter_sql = format!(
            "{USER_CHAPTER_SELECT} WHERE c.novel_id = ?1 \
             AND (c.progress > 0 OR c.unread = 0 OR c.read_at IS NOT NULL OR c.bookmark = 1)"
        );
        let raw_chapters = sqlx::query(&chapter_sql)
            .bind(input.id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db content deletion: list user state chapters: {err}"))?;
        let chapters: Vec<_> = raw_chapters.iter().map(map_user_chapter_row).collect();

        if !chapters.is_empty() {
            let private_keys: HashSet<String> =
                sqlx::query_scalar("SELECT entity_key FROM user_state_private")
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db content deletion: list private user keys: {err}"))?
                    .into_iter()
                    .collect();

            let mut reading_resets = Vec::new();
            for row in &chapters {
                if row.progress > 0.0 || row.unread == 0 || row.read_at.is_some() {
                    let key = user_state_entity_key(&json!({
                        "kind": "reading",
                        "work": chapter_work_json(row),
                        "chapter": chapter_reference_json(row),
                    }))?;
                    if !private_keys.contains(&key) {
                        let mut reset = row.clone();
                        reset.progress = 0.0;
                        reset.unread = 1;
                        reset.read_at = None;
                        reading_resets.push(reset);
                    }
                }
            }
            if !reading_resets.is_empty() {
                record_chapter_rows_in_tx(conn, ctx, &reading_resets, "reading", false).await?;
            }

            let mut bookmark_resets = Vec::new();
            for row in &chapters {
                if row.bookmark != 0 {
                    let mut reset = row.clone();
                    reset.bookmark = 0;
                    bookmark_resets.push(reset);
                }
            }
            if !bookmark_resets.is_empty() {
                record_chapter_rows_in_tx(conn, ctx, &bookmark_resets, "bookmark", false).await?;
            }
        }
    }

    let chapter_ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM chapter WHERE novel_id = ?1")
            .bind(input.id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db content deletion: list chapter ids for cleanup: {err}"))?;

    sqlx::query(
        "DELETE FROM content_sync_cache \
         WHERE cache_key IN (SELECT 'norea-content-chapter-source:' || id FROM chapter WHERE novel_id = ?1)",
    )
    .bind(input.id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db content deletion: delete chapter download proofs: {err}"))?;

    sqlx::query("DELETE FROM novel WHERE id = ?1")
        .bind(input.id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db content deletion: delete novel: {err}"))?;

    sqlx::query(
        "DELETE FROM work_metadata_reading_state WHERE plugin_id = ?1 AND novel_path = ?2",
    )
    .bind(&input.plugin_id)
    .bind(&input.path)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db content deletion: delete reading state: {err}"))?;

    sqlx::query("DELETE FROM content_sync_cache WHERE cache_key = ?1")
        .bind(format!("norea-content-source:{}", input.id))
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db content deletion: delete novel source cache: {err}"))?;

    ctx.record_work_directory(WorkDirectoryUpdateDto {
        novel_id: input.id,
        plugin_id: input.plugin_id.clone(),
        novel_path: input.path.clone(),
        directory: None,
        fingerprint: None,
    });
    for chapter_id in chapter_ids {
        ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
            chapter_id,
            directory: None,
        });
    }

    Ok(())
}

// --- Tauri Commands ---

#[tauri::command]
pub async fn db_content_sync_cache_server_chapters(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    chapters: Vec<ServerChapterSummaryInputDto>,
) -> Result<DbMutationEnvelope<bool>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            remote_content_sync: true,
            metadata_root: MetadataRoot::App(app),
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { cache_server_chapters_in_tx(conn, novel_id, &chapters).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_read_cache(
    db: State<'_, AppDatabase>,
    key: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT payload FROM content_sync_cache WHERE cache_key = ?1")
        .bind(key)
        .fetch_optional(db.pool_for(read_mode.unwrap_or_default()))
        .await
        .map_err(|err| format!("db content sync: read cache: {err}"))
}

#[tauri::command]
pub async fn db_content_sync_write_cache(
    db: State<'_, AppDatabase>,
    key: String,
    payload: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
                     ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
                )
                .bind(key)
                .bind(payload)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db content sync: write cache: {err}"))?;
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_clear_download_proof(
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                sqlx::query("DELETE FROM content_sync_cache WHERE cache_key = ?1")
                    .bind(format!("norea-content-chapter-source:{chapter_id}"))
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db content sync: clear download proof: {err}"))?;
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_list_cache_entries(
    db: State<'_, AppDatabase>,
    prefix: String,
    exact_substr: Option<bool>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<ContentSyncCacheEntryDto>, String> {
    let pool = db.pool_for(read_mode.unwrap_or_default());
    let rows = if exact_substr.unwrap_or(true) {
        sqlx::query(
            "SELECT cache_key, payload FROM content_sync_cache \
             WHERE substr(cache_key, 1, length(?1)) = ?1 ORDER BY cache_key",
        )
        .bind(prefix)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query(
            "SELECT cache_key, payload FROM content_sync_cache \
             WHERE cache_key LIKE ?1 ORDER BY cache_key",
        )
        .bind(format!("{prefix}%"))
        .fetch_all(pool)
        .await
    }
    .map_err(|err| format!("db content sync: list cache entries: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|row| ContentSyncCacheEntryDto {
            cache_key: row.get("cache_key"),
            payload: row.get("payload"),
        })
        .collect())
}

#[tauri::command]
pub async fn db_content_sync_list_pending_renumber_reconciliations(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<String>, String> {
    sqlx::query_scalar(
        "SELECT payload FROM content_sync_cache \
         WHERE cache_key LIKE ?1 AND json_extract(payload, '$.status') = 'pending' \
         ORDER BY json_extract(payload, '$.createdAt'), cache_key",
    )
    .bind(format!("{SERVER_CHAPTER_RENUMBER_PREFIX}%"))
    .fetch_all(db.pool_for(read_mode.unwrap_or_default()))
    .await
    .map_err(|err| format!("db content sync: list pending renumber reconciliations: {err}"))
}

#[tauri::command]
pub async fn db_content_sync_list_chapters(
    db: State<'_, AppDatabase>,
    identities: Option<Vec<String>>,
    downloaded_only: Option<bool>,
    match_works: Option<bool>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<ContentSyncChapterDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db content sync: acquire connection: {err}"))?;
    select_content_sync_chapters_in_conn(
        &mut conn,
        identities.as_deref(),
        downloaded_only.unwrap_or(false),
        match_works.unwrap_or(false),
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_list_untracked_chapters(
    db: State<'_, AppDatabase>,
    server_url: String,
) -> Result<Vec<ContentSyncChapterDto>, String> {
    let rows = sqlx::query(
        "WITH known(key) AS MATERIALIZED ( \
           SELECT entry.key \
           FROM content_sync_cache cache, json_each(cache.payload, '$.downloads') entry \
           WHERE cache.cache_key = ?1 \
         ) \
         SELECT \
           c.id AS chapterId, n.id AS novelId, n.plugin_id AS pluginId, n.path AS novelPath, \
           n.source_novel_id AS sourceNovelId, c.path AS chapterPath, n.name AS novelName, \
           n.author, n.summary, n.is_local AS isLocal, c.name AS chapterName, \
           c.chapter_number AS chapterNumber, c.position, c.page, \
           COALESCE(c.stored_content_type, c.content_type) AS contentType, \
           c.is_downloaded AS isDownloaded, c.media_repair_needed AS mediaRepairNeeded, \
           c.content_bytes AS contentBytes, c.media_bytes AS mediaBytes, \
           EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = c.id) AS isDownloadQueued \
         FROM chapter c \
         JOIN novel n ON n.id = c.novel_id \
         LEFT JOIN known ON known.key = json_array(n.plugin_id, n.path, c.path) \
         WHERE n.source_novel_id IS NOT NULL \
           AND (c.is_downloaded = 1 OR c.content_bytes > 0) \
           AND known.key IS NULL \
         ORDER BY n.id, c.position, c.id",
    )
    .bind(format!("norea-content-catalog:{server_url}"))
    .fetch_all(db.reader())
    .await
    .map_err(|err| format!("db content sync: list untracked chapters: {err}"))?;

    Ok(rows.iter().map(map_content_sync_chapter_row).collect())
}

#[tauri::command]
pub async fn db_content_sync_can_upload_chapter(
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<bool, String> {
    let ready: i64 = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM chapter c \
           WHERE c.id = ?1 AND (c.is_downloaded = 1 OR c.content_bytes > 0) \
             AND NOT EXISTS(SELECT 1 FROM chapter_download_queue q WHERE q.chapter_id = c.id) \
         ) AS ready",
    )
    .bind(chapter_id)
    .fetch_one(db.pool_for(read_mode.unwrap_or_default()))
    .await
    .map_err(|err| format!("db content sync: check can upload chapter: {err}"))?;

    Ok(ready != 0)
}

#[tauri::command]
pub async fn db_content_sync_import_metadata(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    manifest: PackageManifestInputDto,
    server_url: Option<String>,
) -> Result<DbMutationEnvelope<ImportedContentMetadataDto>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            remote_content_sync: true,
            metadata_root: MetadataRoot::App(app),
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                import_content_metadata_in_tx(conn, &manifest, server_url.as_deref()).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_mark_installed(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    content_type: String,
    content_bytes: i64,
    media_bytes: i64,
    media_complete: bool,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            remote_content_sync: true,
            metadata_root: MetadataRoot::App(app),
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                let res = sqlx::query(
                    "UPDATE chapter \
                     SET is_downloaded = ?5, stored_content_type = ?2, content_bytes = ?3, \
                         media_bytes = ?4, media_repair_needed = ?6, \
                         media_bytes_checked_at = unixepoch(), updated_at = unixepoch() \
                     WHERE id = ?1",
                )
                .bind(chapter_id)
                .bind(content_type)
                .bind(content_bytes)
                .bind(media_bytes)
                .bind(i64::from(media_complete))
                .bind(i64::from(!media_complete))
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db content sync: mark chapter installed: {err}"))?;
                if res.rows_affected() != 1 {
                    return Err("Downloaded chapter no longer exists locally.".to_string());
                }
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_journal_head(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<i64, String> {
    sqlx::query_scalar("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM content_sync_journal")
        .fetch_one(db.pool_for(read_mode.unwrap_or_default()))
        .await
        .map_err(|err| format!("db content sync: read journal head: {err}"))
}

#[tauri::command]
pub async fn db_content_sync_read_journal(
    db: State<'_, AppDatabase>,
    after: i64,
    through: i64,
    read_mode: Option<ReadMode>,
) -> Result<Vec<ContentJournalEntryDto>, String> {
    let rows = sqlx::query(
        "SELECT j.sequence, j.state_key AS key \
         FROM content_sync_journal j \
         JOIN ( \
           SELECT MAX(sequence) AS sequence \
           FROM content_sync_journal \
           WHERE sequence > ?1 AND sequence <= ?2 \
           GROUP BY state_key \
         ) latest ON latest.sequence = j.sequence \
         ORDER BY j.sequence",
    )
    .bind(after)
    .bind(through)
    .fetch_all(db.pool_for(read_mode.unwrap_or_default()))
    .await
    .map_err(|err| format!("db content sync: read journal entries: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| ContentJournalEntryDto {
            sequence: r.get("sequence"),
            key: r.get("key"),
        })
        .collect())
}

#[tauri::command]
pub async fn db_content_sync_is_migration_source_held(
    db: State<'_, AppDatabase>,
    server_url: String,
    identity: MigrationWorkIdentityDto,
    read_mode: Option<ReadMode>,
) -> Result<bool, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db content sync: acquire connection: {err}"))?;
    is_novel_migration_source_held_in_conn(
        &mut conn,
        &server_url,
        &identity.plugin_id,
        &identity.novel_path,
        &identity.novel_id,
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_record_pending_novel_merge(
    db: State<'_, AppDatabase>,
    input: RecordPendingNovelMergeInputDto,
) -> Result<DbMutationEnvelope<String>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move { record_pending_novel_merge_in_tx(conn, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_save_incoming_migration(
    db: State<'_, AppDatabase>,
    record: JsonValue,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                save_incoming_migration_in_tx(conn, &record).await?;
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_get_incoming_migration_cursor(
    db: State<'_, AppDatabase>,
    server_url: String,
    read_mode: Option<ReadMode>,
) -> Result<i64, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db content sync: acquire connection: {err}"))?;
    get_incoming_migration_cursor_in_conn(&mut conn, &server_url).await
}

#[tauri::command]
pub async fn db_content_sync_save_incoming_migration_cursor(
    db: State<'_, AppDatabase>,
    server_url: String,
    cursor: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                save_incoming_migration_cursor_in_tx(conn, &server_url, cursor).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_sync_remember_incoming_migration_page(
    db: State<'_, AppDatabase>,
    server_url: String,
    items: Vec<JsonValue>,
    cursor: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            notify_content_sync: false,
            ..TxOptions::default()
        },
        move |conn, _ctx| {
            Box::pin(async move {
                remember_incoming_migration_page_in_tx(conn, &server_url, &items, cursor).await
            })
        },
    )
    .await
}

// --- Content Deletion Commands ---

#[tauri::command]
pub async fn db_content_deletion_list_stored_novel_ids(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    sqlx::query_scalar(
        "SELECT n.id FROM novel n \
         WHERE n.is_local = 0 \
           AND EXISTS( \
             SELECT 1 FROM chapter c \
             WHERE c.novel_id = n.id AND (c.is_downloaded = 1 OR c.media_repair_needed = 1) \
           )",
    )
    .fetch_all(db.pool_for(read_mode.unwrap_or_default()))
    .await
    .map_err(|err| format!("db content deletion: list stored novel ids: {err}"))
}

#[tauri::command]
pub async fn db_content_deletion_list_downloaded_chapter_ids(
    db: State<'_, AppDatabase>,
    novel_ids: Option<Vec<i64>>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    let pool = db.pool_for(read_mode.unwrap_or_default());
    let base = "SELECT c.id FROM chapter c JOIN novel n ON n.id = c.novel_id \
                WHERE n.is_local = 0 \
                  AND (c.is_downloaded = 1 OR c.content_bytes > 0 OR c.media_repair_needed = 1)";
    let Some(ids) = novel_ids else {
        return sqlx::query_scalar(&format!("{base} ORDER BY c.id"))
            .fetch_all(pool)
            .await
            .map_err(|err| format!("db content deletion: list downloaded chapter ids: {err}"));
    };
    let mut unique: Vec<i64> = ids.into_iter().collect::<HashSet<_>>().into_iter().collect();
    unique.sort_unstable();
    let mut out = Vec::new();
    for chunk in unique.chunks(500) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!("{base} AND c.novel_id IN ({})", placeholders.join(","));
        let mut query = sqlx::query_scalar(&sql);
        for &id in chunk {
            query = query.bind(id);
        }
        let rows: Vec<i64> = query
            .fetch_all(pool)
            .await
            .map_err(|err| format!("db content deletion: list downloaded chapter ids: {err}"))?;
        out.extend(rows);
    }
    out.sort_unstable();
    Ok(out)
}

#[tauri::command]
pub async fn db_content_deletion_find_local_novel(
    db: State<'_, AppDatabase>,
    plugin_id: String,
    source_novel_id: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<NovelDetailRecordDto>, String> {
    let mut conn = db
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db content deletion: acquire connection: {err}"))?;
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM novel WHERE plugin_id = ?1 AND source_novel_id = ?2",
    )
    .bind(plugin_id)
    .bind(source_novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db content deletion: find local novel: {err}"))?;
    match id {
        Some(novel_id) => get_novel_by_id_in_conn(&mut conn, novel_id).await,
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn db_content_deletion_delete_novel_records(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    input: DeleteLocalNovelRecordsInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| {
            Box::pin(async move { delete_local_novel_records_in_tx(conn, ctx, &input).await })
        },
    )
    .await
}

fn verify_download_clear_row(
    row: &sqlx::sqlite::SqliteRow,
    expected: &NovelIdentityGuardInputDto,
    stage_error: &str,
) -> Result<(), String> {
    let plugin_id: String = row.get("plugin_id");
    let source_novel_id: Option<String> = row.get("source_novel_id");
    let path: String = row.get("path");
    let is_local: i64 = row.get("is_local");
    if plugin_id != expected.plugin_id
        || source_novel_id != expected.source_novel_id
        || path != expected.path
        || is_local != 0
    {
        return Err(stage_error.to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn db_content_deletion_verify_download_clear(
    db: State<'_, AppDatabase>,
    input: NovelIdentityGuardInputDto,
    read_mode: Option<ReadMode>,
) -> Result<bool, String> {
    let row = sqlx::query(
        "SELECT plugin_id, source_novel_id, path, is_local FROM novel WHERE id = ?1",
    )
    .bind(input.id)
    .fetch_optional(db.pool_for(read_mode.unwrap_or_default()))
    .await
    .map_err(|err| format!("db content deletion: verify download clear: {err}"))?;
    let Some(row) = row else {
        return Ok(false);
    };
    verify_download_clear_row(
        &row,
        &input,
        "Local work identity changed before download deletion.",
    )?;
    Ok(true)
}

#[tauri::command]
pub async fn db_content_deletion_commit_download_clear(
    db: State<'_, AppDatabase>,
    input: NovelIdentityGuardInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.writer(),
        TxOptions {
            publish_metadata: false,
            ..TxOptions::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                let row = sqlx::query(
                    "SELECT plugin_id, source_novel_id, path, is_local FROM novel WHERE id = ?1",
                )
                .bind(input.id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| {
                    format!("db content deletion: re-verify download clear: {err}")
                })?;
                let Some(row) = row else {
                    return Ok(());
                };
                verify_download_clear_row(
                    &row,
                    &input,
                    "Local work identity changed during download deletion.",
                )?;

                let chapter_ids: Vec<i64> =
                    sqlx::query_scalar("SELECT id FROM chapter WHERE novel_id = ?1")
                        .bind(input.id)
                        .fetch_all(&mut *conn)
                        .await
                        .map_err(|err| {
                            format!("db content deletion: list cleared chapters: {err}")
                        })?;

                sqlx::query(
                    "UPDATE chapter \
                     SET is_downloaded = 0, content_bytes = 0, media_bytes = 0, \
                         media_repair_needed = 0, media_bytes_checked_at = NULL, \
                         updated_at = unixepoch() \
                     WHERE novel_id = ?1",
                )
                .bind(input.id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db content deletion: clear chapter downloads: {err}"))?;

                sqlx::query("DELETE FROM work_metadata_directory_cache WHERE novel_id = ?1")
                    .bind(input.id)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| {
                        format!("db content deletion: clear chapter directory cache: {err}")
                    })?;

                for table in [
                    "work_metadata_file_cache",
                    "work_metadata_sync_journal",
                    "work_metadata_dirty",
                ] {
                    sqlx::query(&format!(
                        "DELETE FROM {table} WHERE plugin_id = ?1 AND path = ?2"
                    ))
                    .bind(&input.plugin_id)
                    .bind(&input.path)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db content deletion: clear {table}: {err}"))?;
                }

                ctx.record_work_directory(WorkDirectoryUpdateDto {
                    novel_id: input.id,
                    plugin_id: input.plugin_id.clone(),
                    novel_path: input.path.clone(),
                    directory: None,
                    fingerprint: None,
                });
                for chapter_id in chapter_ids {
                    ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
                        chapter_id,
                        directory: None,
                    });
                }

                let _ = canonical_json_value;
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_content_deletion_list_novel_chapter_ids(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    sqlx::query_scalar("SELECT id FROM chapter WHERE novel_id = ?1")
        .bind(novel_id)
        .fetch_all(db.pool_for(read_mode.unwrap_or_default()))
        .await
        .map_err(|err| format!("db content deletion: list novel chapter ids: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;

    #[tokio::test]
    async fn cache_server_chapters_and_import_metadata_work() {
        let test = open_test_db().await;
        let db = &test.db;
        let mut conn = db.writer().acquire().await.unwrap();

        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, source_novel_id, name, in_library) \
             VALUES (1, 'src', '/book', 'book-1', 'Book', 1)",
        )
        .execute(&mut *conn)
        .await
        .unwrap();

        let changed = cache_server_chapters_in_tx(
            &mut conn,
            1,
            &[ServerChapterSummaryInputDto {
                chapter_path: "/ch-1".to_string(),
                name: "Chapter 1".to_string(),
                position: 0,
                chapter_number: Some("1".to_string()),
                content_type: "html".to_string(),
                page: "1".to_string(),
            }],
        )
        .await
        .unwrap();
        assert!(changed);

        let mismatch = cache_server_chapters_in_tx(
            &mut conn,
            1,
            &[ServerChapterSummaryInputDto {
                chapter_path: "/ch-1".to_string(),
                name: "Chapter 1".to_string(),
                position: 0,
                chapter_number: Some("99".to_string()),
                content_type: "html".to_string(),
                page: "1".to_string(),
            }],
        )
        .await;
        assert!(mismatch
            .unwrap_err()
            .contains("Synchronize the corrected work metadata"));

        let imported = import_content_metadata_in_tx(
            &mut conn,
            &PackageManifestInputDto {
                identity: PackageManifestIdentityDto {
                    plugin_id: "src".to_string(),
                    novel_id: "book-1".to_string(),
                    novel_path: "/book".to_string(),
                    chapter_path: "/ch-2".to_string(),
                },
                chapter: PackageManifestChapterDto {
                    name: "Chapter 2".to_string(),
                    position: 1,
                    chapter_number: Some("2".to_string()),
                    content_type: "html".to_string(),
                    page: "1".to_string(),
                },
            },
            None,
        )
        .await
        .unwrap();
        assert_eq!(imported.novel_id, 1);

        sqlx::query(
            "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2)",
        )
        .bind("norea-content-novel-migration:op-1")
        .bind(
            json!({
                "serverUrl": "https://sync.example",
                "source": { "pluginId": "src", "novelId": "book-1", "novelPath": "/book" }
            })
            .to_string(),
        )
        .execute(&mut *conn)
        .await
        .unwrap();

        assert!(is_novel_migration_source_held_in_conn(
            &mut conn,
            "https://sync.example/",
            "src",
            "/book",
            "book-1",
        )
        .await
        .unwrap());
    }

    #[tokio::test]
    async fn delete_local_novel_records_records_user_state_and_cleans_up() {
        let test = open_test_db().await;
        let db = &test.db;
        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, source_novel_id, name, in_library, last_read_at) \
             VALUES (5, 'src', '/del-book', 'del-1', 'Delete Me', 1, 1700000000)",
        )
        .execute(db.writer())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter(id, novel_id, path, name, position, progress, unread, bookmark, is_downloaded, content_bytes) \
             VALUES (50, 5, '/del-ch-1', 'Ch 1', 0, 75, 0, 1, 1, 128)",
        )
        .execute(db.writer())
        .await
        .unwrap();

        let res = with_write_tx(
            db.writer(),
            TxOptions {
                publish_metadata: false,
                ..TxOptions::default()
            },
            |conn, ctx| {
                Box::pin(async move {
                    delete_local_novel_records_in_tx(
                        conn,
                        ctx,
                        &DeleteLocalNovelRecordsInputDto {
                            id: 5,
                            plugin_id: "src".to_string(),
                            source_novel_id: Some("del-1".to_string()),
                            path: "/del-book".to_string(),
                            record_user_state_removal: true,
                        },
                    )
                    .await
                })
            },
        )
        .await
        .unwrap();

        assert!(res.effects.user_state_ledger_changed);
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel WHERE id = 5")
            .fetch_one(db.reader())
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }
}
