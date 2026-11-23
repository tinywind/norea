use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{AssertSqlSafe, FromRow, QueryBuilder, Sqlite, SqliteConnection, SqlitePool};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;
use crate::db::tx::{with_write_tx, TxOptions};
use crate::db::vpn::{parse_job_value, parse_stored_chapter_download_job, ChapterDownloadJobDto};
use crate::db::DbMutationEnvelope;

const BYTES_PER_MIB: usize = 1024 * 1024;
const MAX_INLINE_IPC_BYTES: usize = 128 * BYTES_PER_MIB;
const MAX_ROUTE_QUERY_ROWS: usize = 500;
const MAX_BACKFILL_PER_RUN: i64 = 100;
const FAILURE_ID_CHUNK_SIZE: usize = 500;
const TARGET_ID_CHUNK_SIZE: usize = 500;

const STORED_CHAPTER_SQL: &str = "(c.is_downloaded = 1 OR c.content_bytes > 0)";
const STORED_CHAPTER_UNALIASED_SQL: &str = "(is_downloaded = 1 OR content_bytes > 0)";
const DELETE_CANDIDATE_CHAPTER_SQL: &str =
    "(c.is_downloaded = 1 OR c.content_bytes > 0 OR c.media_repair_needed = 1)";

fn now_ms() -> Result<i64, String> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("system clock before unix epoch: {err}"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| "timestamp overflow".to_string())
}

fn queue_tx_options() -> TxOptions {
    TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: 3,
        publish_metadata: false,
        ..TxOptions::default()
    }
}

fn require_batch_id(batch_id: &str) -> Result<(), String> {
    if batch_id.trim().is_empty() {
        return Err("A pending VPN download requires a batch identity.".to_string());
    }
    Ok(())
}

fn assert_inline_budget(payload: &str, label: &str) -> Result<(), String> {
    if payload.len() > MAX_INLINE_IPC_BYTES {
        return Err(format!(
            "{label} is {} bytes, which exceeds the {MAX_INLINE_IPC_BYTES} byte limit.",
            payload.len()
        ));
    }
    Ok(())
}

fn normalize_content_type(raw: Option<&str>) -> &'static str {
    match raw {
        Some("text") => "text",
        Some("markdown") => "markdown",
        Some("pdf") => "pdf",
        Some("epub") => "epub",
        _ => "html",
    }
}

fn clamp_backfill_limit(limit: Option<i64>) -> i64 {
    match limit {
        Some(value) if value > 0 => value.min(MAX_BACKFILL_PER_RUN),
        _ => MAX_BACKFILL_PER_RUN,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StoredQueueRowDto {
    pub chapter_id: i64,
    pub job_json: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptOrdinaryQueueRowInput {
    pub chapter_id: i64,
    pub job_json: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredQueuedChapterDownloadDto {
    pub job: ChapterDownloadJobDto,
    pub job_json: String,
    pub updated_at_ms: i64,
}

fn to_stored_queued_download(
    row: StoredQueueRowDto,
) -> Result<StoredQueuedChapterDownloadDto, String> {
    let job = parse_stored_chapter_download_job(row.chapter_id, &row.job_json)?;
    Ok(StoredQueuedChapterDownloadDto {
        job,
        job_json: row.job_json,
        updated_at_ms: row.updated_at_ms,
    })
}

pub async fn list_ordinary_queue_jobs_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<StoredQueuedChapterDownloadDto>, String> {
    let rows: Vec<StoredQueueRowDto> = sqlx::query_as(
        r#"
        SELECT
          q.chapter_id AS chapter_id,
          q.job_json AS job_json,
          q.updated_at_ms AS updated_at_ms
        FROM chapter_download_queue q
        JOIN chapter c ON c.id = q.chapter_id
        JOIN novel n ON n.id = c.novel_id
        WHERE n.is_local = 0
          AND n.id = json_extract(q.job_json, '$.novelId')
          AND n.plugin_id = json_extract(q.job_json, '$.pluginId')
          AND json_extract(q.job_json, '$.vpnBatchId') IS NULL
          AND json_extract(q.job_json, '$.vpnPlanId') IS NULL
          AND json_extract(q.job_json, '$.vpnRangeId') IS NULL
        ORDER BY q.created_at_ms, q.chapter_id
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("list ordinary chapter download jobs: {err}"))?;

    rows.into_iter().map(to_stored_queued_download).collect()
}

pub async fn list_pending_vpn_queue_jobs_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<StoredQueuedChapterDownloadDto>, String> {
    let rows: Vec<StoredQueueRowDto> = sqlx::query_as(
        r#"
        SELECT
          chapter_id,
          job_json,
          updated_at_ms
        FROM chapter_download_queue
        WHERE json_extract(job_json, '$.vpnBatchId') IS NOT NULL
          AND json_extract(job_json, '$.vpnPlanId') IS NULL
          AND json_extract(job_json, '$.vpnRangeId') IS NULL
        ORDER BY created_at_ms, chapter_id
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("list pending VPN download jobs: {err}"))?;

    rows.into_iter().map(to_stored_queued_download).collect()
}

pub async fn enqueue_pending_vpn_jobs_in_tx(
    conn: &mut SqliteConnection,
    batch_id: &str,
    jobs: &[Value],
    now: i64,
) -> Result<(), String> {
    require_batch_id(batch_id)?;
    let mut captured: Vec<(ChapterDownloadJobDto, String)> = Vec::with_capacity(jobs.len());
    for raw_job in jobs {
        let mut obj = raw_job
            .as_object()
            .cloned()
            .ok_or_else(|| "Invalid VPN download queue payload.".to_string())?;
        let job_id = obj.get("id").and_then(Value::as_i64).unwrap_or_default();
        let has_plan = obj.get("vpnPlanId").is_some_and(|v| !v.is_null());
        let has_range = obj.get("vpnRangeId").is_some_and(|v| !v.is_null());
        let conflicting_batch = match obj.get("vpnBatchId") {
            None | Some(Value::Null) => false,
            Some(Value::String(existing)) => existing != batch_id,
            Some(_) => true,
        };
        if has_plan || has_range || conflicting_batch {
            return Err(format!("Chapter {job_id} already has another VPN owner."));
        }
        obj.insert(
            "vpnBatchId".to_string(),
            Value::String(batch_id.to_string()),
        );
        let value = Value::Object(obj);
        let job_json = serde_json::to_string(&value)
            .map_err(|err| format!("serialize pending VPN download job: {err}"))?;
        assert_inline_budget(&job_json, "Pending VPN download job")?;
        let parsed = parse_job_value(&value)?;
        let validated = parse_stored_chapter_download_job(parsed.id(), &job_json)?;
        captured.push((validated, job_json));
    }

    for (job, job_json) in captured {
        let existing: Option<StoredQueueRowDto> = sqlx::query_as(
            r#"
            SELECT chapter_id, job_json, updated_at_ms
            FROM chapter_download_queue
            WHERE chapter_id = ?1
            "#,
        )
        .bind(job.id())
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("read existing download queue row: {err}"))?;

        if let Some(existing_row) = existing {
            let owner =
                parse_stored_chapter_download_job(existing_row.chapter_id, &existing_row.job_json)?;
            if owner.vpn_batch_id() != Some(batch_id)
                || owner.vpn_plan_id().is_some()
                || owner.vpn_range_id().is_some()
                || owner != job
            {
                return Err(format!(
                    "Chapter {} conflicts with an existing download owner.",
                    job.id()
                ));
            }
            continue;
        }

        sqlx::query(
            r#"
            INSERT INTO chapter_download_queue (
              chapter_id,
              job_json,
              created_at_ms,
              updated_at_ms,
              leased_at_ms,
              attempt_count
            )
            VALUES (?1, ?2, ?3, ?3, NULL, 0)
            "#,
        )
        .bind(job.id())
        .bind(&job_json)
        .bind(now)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("insert pending VPN download job: {err}"))?;
    }

    Ok(())
}

pub async fn adopt_ordinary_queue_jobs_in_tx(
    conn: &mut SqliteConnection,
    batch_id: &str,
    expected: &[AdoptOrdinaryQueueRowInput],
    now: i64,
) -> Result<Vec<ChapterDownloadJobDto>, String> {
    require_batch_id(batch_id)?;
    let mut captured: Vec<(AdoptOrdinaryQueueRowInput, ChapterDownloadJobDto, String)> =
        Vec::with_capacity(expected.len());

    for row in expected {
        let parsed = parse_stored_chapter_download_job(row.chapter_id, &row.job_json)?;
        if parsed.vpn_batch_id().is_some()
            || parsed.vpn_plan_id().is_some()
            || parsed.vpn_range_id().is_some()
        {
            return Err(format!(
                "Chapter {} no longer has ordinary ownership.",
                parsed.id()
            ));
        }
        let mut adopted_val = serde_json::to_value(&parsed)
            .map_err(|err| format!("serialize ordinary queue job: {err}"))?;
        adopted_val
            .as_object_mut()
            .expect("validated job object")
            .insert(
                "vpnBatchId".to_string(),
                Value::String(batch_id.to_string()),
            );
        let adopted_json = serde_json::to_string(&adopted_val)
            .map_err(|err| format!("serialize adopted VPN download job: {err}"))?;
        assert_inline_budget(&adopted_json, "Pending VPN download job")?;
        let adopted_job = parse_job_value(&adopted_val)?;
        captured.push((row.clone(), adopted_job, adopted_json));
    }

    let mut adopted_jobs = Vec::with_capacity(captured.len());
    for (row, adopted_job, adopted_json) in captured {
        let result = sqlx::query(
            r#"
            UPDATE chapter_download_queue
            SET job_json = ?1,
                updated_at_ms = ?2,
                leased_at_ms = NULL
            WHERE chapter_id = ?3
              AND job_json = ?4
              AND updated_at_ms = ?5
              AND json_extract(job_json, '$.vpnBatchId') IS NULL
              AND json_extract(job_json, '$.vpnPlanId') IS NULL
              AND json_extract(job_json, '$.vpnRangeId') IS NULL
              AND EXISTS(
                SELECT 1
                FROM chapter c
                JOIN novel n ON n.id = c.novel_id
                WHERE c.id = chapter_download_queue.chapter_id
                  AND n.is_local = 0
                  AND n.id = json_extract(job_json, '$.novelId')
                  AND n.plugin_id = json_extract(job_json, '$.pluginId')
              )
            "#,
        )
        .bind(&adopted_json)
        .bind(now)
        .bind(adopted_job.id())
        .bind(&row.job_json)
        .bind(row.updated_at_ms)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("adopt ordinary chapter download job: {err}"))?;

        if result.rows_affected() != 1 {
            return Err(format!(
                "Queued chapter {} is missing, stale or changed owners.",
                adopted_job.id()
            ));
        }
        adopted_jobs.push(adopted_job);
    }

    Ok(adopted_jobs)
}

pub async fn cancel_pending_vpn_batch_in_tx(
    conn: &mut SqliteConnection,
    batch_id: &str,
) -> Result<i64, String> {
    require_batch_id(batch_id)?;
    let result = sqlx::query(
        r#"
        DELETE FROM chapter_download_queue
        WHERE json_extract(job_json, '$.vpnBatchId') = ?1
          AND json_extract(job_json, '$.vpnPlanId') IS NULL
          AND json_extract(job_json, '$.vpnRangeId') IS NULL
        "#,
    )
    .bind(batch_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("cancel pending VPN download batch: {err}"))?;
    Ok(result.rows_affected() as i64)
}

pub async fn cancel_pending_vpn_jobs_in_tx(
    conn: &mut SqliteConnection,
    batch_id: &str,
    chapter_ids: &[i64],
) -> Result<i64, String> {
    require_batch_id(batch_id)?;
    let mut seen = HashSet::with_capacity(chapter_ids.len());
    let unique_ids: Vec<i64> = chapter_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    if unique_ids.is_empty() {
        return Ok(0);
    }

    let chunk_size = MAX_ROUTE_QUERY_ROWS - 1;
    let mut cancelled: i64 = 0;
    for chunk in unique_ids.chunks(chunk_size) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "DELETE FROM chapter_download_queue WHERE json_extract(job_json, '$.vpnBatchId') = ",
        );
        qb.push_bind(batch_id);
        qb.push(
            " AND json_extract(job_json, '$.vpnPlanId') IS NULL AND json_extract(job_json, '$.vpnRangeId') IS NULL AND chapter_id IN (",
        );
        let mut separated = qb.separated(", ");
        for id in chunk {
            separated.push_bind(*id);
        }
        separated.push_unseparated(")");
        let result = qb
            .build()
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("cancel pending VPN download jobs: {err}"))?;
        cancelled += result.rows_affected() as i64;
    }
    Ok(cancelled)
}

pub async fn set_pending_vpn_jobs_paused_in_tx(
    conn: &mut SqliteConnection,
    batch_id: &str,
    chapter_ids: &[i64],
    paused: bool,
    now: i64,
) -> Result<i64, String> {
    require_batch_id(batch_id)?;
    let mut seen = HashSet::with_capacity(chapter_ids.len());
    let unique_ids: Vec<i64> = chapter_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    if unique_ids.is_empty() {
        return Ok(0);
    }

    let chunk_size = MAX_ROUTE_QUERY_ROWS - 2;
    let mut changed: i64 = 0;
    let payload_expr = if paused {
        "json_set(job_json, '$.vpnWorkPaused', json('true'))"
    } else {
        "json_remove(job_json, '$.vpnWorkPaused')"
    };

    for chunk in unique_ids.chunks(chunk_size) {
        let mut qb = QueryBuilder::<Sqlite>::new(format!(
            "UPDATE chapter_download_queue SET job_json = {payload_expr}, updated_at_ms = "
        ));
        qb.push_bind(now);
        qb.push(" WHERE json_extract(job_json, '$.vpnBatchId') = ");
        qb.push_bind(batch_id);
        qb.push(
            " AND json_extract(job_json, '$.vpnPlanId') IS NULL AND json_extract(job_json, '$.vpnRangeId') IS NULL AND chapter_id IN (",
        );
        let mut separated = qb.separated(", ");
        for id in chunk {
            separated.push_bind(*id);
        }
        separated.push_unseparated(")");
        let result = qb
            .build()
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("set pending VPN download jobs paused: {err}"))?;
        changed += result.rows_affected() as i64;
    }
    Ok(changed)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StoredChapterDownloadFailureDto {
    pub chapter_id: i64,
    pub plugin_id: String,
    pub failure_class: String,
    pub message_summary: String,
    pub challenge_url: Option<String>,
    pub attempts: i64,
    pub next_retry_at: Option<i64>,
    pub job_json: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordChapterDownloadFailureInput {
    pub chapter_id: i64,
    pub plugin_id: String,
    pub failure_class: String,
    pub message_summary: String,
    pub challenge_url: Option<String>,
    pub job_json: String,
    pub now: i64,
    pub retry_delays_ms: Vec<Option<i64>>,
    pub fallback_retry_delay_ms: Option<i64>,
}

pub async fn record_chapter_download_failure_in_tx(
    conn: &mut SqliteConnection,
    input: &RecordChapterDownloadFailureInput,
) -> Result<Option<StoredChapterDownloadFailureDto>, String> {
    let previous_attempts: Option<i64> = sqlx::query_scalar(
        "SELECT attempts FROM chapter_download_failure WHERE chapter_id = ?1",
    )
    .bind(input.chapter_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("read previous chapter download failure attempts: {err}"))?;

    let attempts = previous_attempts.unwrap_or(0) + 1;
    let delay = usize::try_from(attempts - 1)
        .ok()
        .and_then(|idx| input.retry_delays_ms.get(idx).copied())
        .unwrap_or(input.fallback_retry_delay_ms);
    let next_retry_at = delay.map(|ms| input.now + ms);

    let result = sqlx::query(
        r#"
        INSERT INTO chapter_download_failure (
          chapter_id,
          plugin_id,
          failure_class,
          message_summary,
          challenge_url,
          attempts,
          next_retry_at,
          job_json,
          updated_at
        )
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE EXISTS (SELECT 1 FROM chapter WHERE id = ?1)
        ON CONFLICT(chapter_id) DO UPDATE SET
          plugin_id = excluded.plugin_id,
          failure_class = excluded.failure_class,
          message_summary = excluded.message_summary,
          challenge_url = excluded.challenge_url,
          attempts = excluded.attempts,
          next_retry_at = excluded.next_retry_at,
          job_json = excluded.job_json,
          updated_at = excluded.updated_at
        "#,
    )
    .bind(input.chapter_id)
    .bind(&input.plugin_id)
    .bind(&input.failure_class)
    .bind(&input.message_summary)
    .bind(&input.challenge_url)
    .bind(attempts)
    .bind(next_retry_at)
    .bind(&input.job_json)
    .bind(input.now)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("record chapter download failure: {err}"))?;

    if result.rows_affected() != 1 {
        return Ok(None);
    }

    Ok(Some(StoredChapterDownloadFailureDto {
        chapter_id: input.chapter_id,
        plugin_id: input.plugin_id.clone(),
        failure_class: input.failure_class.clone(),
        message_summary: input.message_summary.clone(),
        challenge_url: input.challenge_url.clone(),
        attempts,
        next_retry_at,
        job_json: input.job_json.clone(),
        updated_at: input.now,
    }))
}

pub async fn clear_chapter_download_failures_in_tx(
    conn: &mut SqliteConnection,
    chapter_ids: &[i64],
) -> Result<i64, String> {
    let mut seen = HashSet::with_capacity(chapter_ids.len());
    let ids: Vec<i64> = chapter_ids
        .iter()
        .copied()
        .filter(|id| seen.insert(*id))
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }

    let mut removed: i64 = 0;
    for chunk in ids.chunks(FAILURE_ID_CHUNK_SIZE) {
        let mut qb =
            QueryBuilder::<Sqlite>::new("DELETE FROM chapter_download_failure WHERE chapter_id IN (");
        let mut separated = qb.separated(", ");
        for id in chunk {
            separated.push_bind(*id);
        }
        separated.push_unseparated(")");
        let result = qb
            .build()
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("clear chapter download failures: {err}"))?;
        removed += result.rows_affected() as i64;
    }
    Ok(removed)
}

pub async fn get_chapter_download_failure_in_conn(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<Option<StoredChapterDownloadFailureDto>, String> {
    sqlx::query_as(
        r#"
        SELECT
          chapter_id,
          plugin_id,
          failure_class,
          message_summary,
          challenge_url,
          attempts,
          next_retry_at,
          job_json,
          updated_at
        FROM chapter_download_failure
        WHERE chapter_id = ?1
        "#,
    )
    .bind(chapter_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("get chapter download failure: {err}"))
}

pub async fn clear_scheduled_chapter_download_retries_in_tx(
    conn: &mut SqliteConnection,
) -> Result<i64, String> {
    let result = sqlx::query(
        "UPDATE chapter_download_failure SET next_retry_at = NULL WHERE next_retry_at IS NOT NULL",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("clear scheduled chapter download retries: {err}"))?;
    Ok(result.rows_affected() as i64)
}

pub async fn list_chapter_download_failures_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<StoredChapterDownloadFailureDto>, String> {
    sqlx::query_as(
        r#"
        SELECT
          chapter_id,
          plugin_id,
          failure_class,
          message_summary,
          challenge_url,
          attempts,
          next_retry_at,
          job_json,
          updated_at
        FROM chapter_download_failure
        ORDER BY plugin_id, failure_class, updated_at, chapter_id
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("list chapter download failures: {err}"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheResultDto {
    pub rows_affected: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheNovelDto {
    pub novel_id: i64,
    pub novel_name: String,
    pub novel_cover: Option<String>,
    pub novel_path: String,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub plugin_name: Option<String>,
    pub in_library: bool,
    pub chapters_downloaded: i64,
    pub total_chapters: i64,
    pub unread_downloaded: i64,
    pub read_downloaded: i64,
    pub media_repair_needed_chapters: i64,
    pub total_bytes: i64,
    pub last_downloaded_at: Option<i64>,
}

#[derive(Debug, FromRow)]
struct RawDownloadCacheNovelRow {
    novel_id: i64,
    novel_name: String,
    novel_cover: Option<String>,
    novel_path: String,
    plugin_id: String,
    source_novel_id: Option<String>,
    plugin_name: Option<String>,
    in_library: i64,
    chapters_downloaded: i64,
    total_chapters: i64,
    unread_downloaded: i64,
    read_downloaded: i64,
    media_repair_needed_chapters: i64,
    total_bytes: i64,
    last_downloaded_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheChapterDto {
    pub id: i64,
    pub novel_id: i64,
    pub name: String,
    pub position: i64,
    pub progress: i64,
    pub read_at: Option<i64>,
    pub downloaded_at: Option<i64>,
    pub content_bytes: i64,
    pub media_bytes: i64,
    pub media_repair_needed: bool,
    pub total_bytes: i64,
}

#[derive(Debug, FromRow)]
struct RawDownloadCacheChapterRow {
    id: i64,
    novel_id: i64,
    name: String,
    position: i64,
    progress: i64,
    read_at: Option<i64>,
    downloaded_at: Option<i64>,
    content_bytes: i64,
    media_bytes: i64,
    media_repair_needed: i64,
    total_bytes: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheTargetFilterInput {
    pub chapter_ids: Option<Vec<i64>>,
    pub novel_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheDeleteChapterCandidateDto {
    pub content_bytes: i64,
    pub id: i64,
    pub is_downloaded: bool,
    pub path: String,
    pub plugin_id: String,
    pub source_content_type: String,
}

#[derive(Debug, FromRow)]
struct RawDownloadCacheDeleteCandidateRow {
    content_bytes: i64,
    id: i64,
    is_downloaded: i64,
    path: String,
    source_content_type: Option<String>,
    plugin_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheMediaBackfillCandidateDto {
    pub id: i64,
    pub source_novel_id: Option<String>,
    pub chapter_name: String,
    pub chapter_number: Option<String>,
    pub novel_id: i64,
    pub novel_name: String,
    pub novel_path: String,
    pub plugin_id: String,
    pub position: i64,
    pub updated_at: i64,
}

enum TargetScope {
    All,
    Empty,
    Column(&'static str, Vec<i64>),
}

fn resolve_target_scope(
    filter: &DownloadCacheTargetFilterInput,
    chapter_col: &'static str,
    novel_col: &'static str,
) -> TargetScope {
    let (column, raw_ids) = if let Some(ids) = &filter.chapter_ids {
        (chapter_col, ids)
    } else if let Some(ids) = &filter.novel_ids {
        (novel_col, ids)
    } else {
        return TargetScope::All;
    };

    let mut normalized: Vec<i64> = raw_ids.iter().copied().filter(|id| *id > 0).collect();
    normalized.sort_unstable();
    normalized.dedup();
    if normalized.is_empty() {
        TargetScope::Empty
    } else {
        TargetScope::Column(column, normalized)
    }
}

pub async fn list_download_cache_novels_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<DownloadCacheNovelDto>, String> {
    let sql = format!(
        r#"
        SELECT
          n.id AS novel_id,
          n.name AS novel_name,
          n.cover AS novel_cover,
          n.path AS novel_path,
          n.plugin_id AS plugin_id,
          n.source_novel_id AS source_novel_id,
          ip.name AS plugin_name,
          n.in_library AS in_library,
          COUNT(c.id) AS chapters_downloaded,
          (
            SELECT COUNT(*)
            FROM chapter all_chapters
            WHERE all_chapters.novel_id = n.id
          ) AS total_chapters,
          COALESCE(SUM(CASE WHEN c.progress < 100 THEN 1 ELSE 0 END), 0) AS unread_downloaded,
          COALESCE(SUM(CASE WHEN c.progress >= 100 THEN 1 ELSE 0 END), 0) AS read_downloaded,
          COALESCE(SUM(CASE WHEN c.media_repair_needed = 1 THEN 1 ELSE 0 END), 0) AS media_repair_needed_chapters,
          COALESCE(SUM(c.content_bytes + c.media_bytes), 0) AS total_bytes,
          MAX(c.updated_at) AS last_downloaded_at
        FROM novel n
        JOIN chapter c ON c.novel_id = n.id
        LEFT JOIN installed_plugin ip ON ip.id = n.plugin_id
        WHERE {STORED_CHAPTER_SQL}
          AND n.is_local = 0
        GROUP BY n.id
        ORDER BY last_downloaded_at DESC, n.name COLLATE NOCASE ASC
        "#
    );
    let rows: Vec<RawDownloadCacheNovelRow> = sqlx::query_as(AssertSqlSafe(sql))
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("list download cache novels: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|row| DownloadCacheNovelDto {
            novel_id: row.novel_id,
            novel_name: row.novel_name,
            novel_cover: row.novel_cover,
            novel_path: row.novel_path,
            plugin_id: row.plugin_id,
            source_novel_id: row.source_novel_id,
            plugin_name: row.plugin_name,
            in_library: row.in_library != 0,
            chapters_downloaded: row.chapters_downloaded,
            total_chapters: row.total_chapters,
            unread_downloaded: row.unread_downloaded,
            read_downloaded: row.read_downloaded,
            media_repair_needed_chapters: row.media_repair_needed_chapters,
            total_bytes: row.total_bytes,
            last_downloaded_at: row.last_downloaded_at,
        })
        .collect())
}

pub async fn list_download_cache_chapters_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Vec<DownloadCacheChapterDto>, String> {
    let sql = format!(
        r#"
        SELECT
          c.id,
          c.novel_id,
          c.name,
          c.position,
          c.progress,
          c.read_at,
          c.updated_at AS downloaded_at,
          c.content_bytes,
          c.media_bytes,
          c.media_repair_needed,
          c.content_bytes + c.media_bytes AS total_bytes
        FROM chapter c
        JOIN novel n ON n.id = c.novel_id
        WHERE c.novel_id = ?1
          AND {STORED_CHAPTER_SQL}
          AND n.is_local = 0
        ORDER BY c.position ASC, c.id ASC
        "#
    );
    let rows: Vec<RawDownloadCacheChapterRow> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("list download cache chapters: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|row| DownloadCacheChapterDto {
            id: row.id,
            novel_id: row.novel_id,
            name: row.name,
            position: row.position,
            progress: row.progress,
            read_at: row.read_at,
            downloaded_at: row.downloaded_at,
            content_bytes: row.content_bytes,
            media_bytes: row.media_bytes,
            media_repair_needed: row.media_repair_needed != 0,
            total_bytes: row.total_bytes,
        })
        .collect())
}

pub async fn list_delete_candidates_in_conn(
    conn: &mut SqliteConnection,
    filter: &DownloadCacheTargetFilterInput,
) -> Result<Vec<DownloadCacheDeleteChapterCandidateDto>, String> {
    let map_row = |row: RawDownloadCacheDeleteCandidateRow| DownloadCacheDeleteChapterCandidateDto {
        content_bytes: row.content_bytes,
        id: row.id,
        is_downloaded: row.is_downloaded != 0,
        path: row.path,
        plugin_id: row.plugin_id,
        source_content_type: normalize_content_type(row.source_content_type.as_deref()).to_string(),
    };

    let base_select = format!(
        r#"
        SELECT
          c.content_bytes,
          c.id,
          c.is_downloaded,
          c.path,
          c.content_type AS source_content_type,
          n.plugin_id
        FROM chapter c
        JOIN novel n ON n.id = c.novel_id
        WHERE n.is_local = 0
          AND {DELETE_CANDIDATE_CHAPTER_SQL}
        "#
    );

    match resolve_target_scope(filter, "c.id", "c.novel_id") {
        TargetScope::Empty => Ok(Vec::new()),
        TargetScope::All => {
            let sql = format!("{base_select} ORDER BY c.novel_id, c.position, c.id");
            let rows: Vec<RawDownloadCacheDeleteCandidateRow> = sqlx::query_as(AssertSqlSafe(sql))
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("list download cache delete candidates: {err}"))?;
            Ok(rows.into_iter().map(map_row).collect())
        }
        TargetScope::Column(col, ids) => {
            let mut combined: Vec<(i64, i64, DownloadCacheDeleteChapterCandidateDto)> = Vec::new();
            for chunk in ids.chunks(TARGET_ID_CHUNK_SIZE) {
                let mut qb = QueryBuilder::<Sqlite>::new(format!(
                    r#"
                    SELECT
                      c.novel_id,
                      c.position,
                      c.content_bytes,
                      c.id,
                      c.is_downloaded,
                      c.path,
                      c.content_type AS source_content_type,
                      n.plugin_id
                    FROM chapter c
                    JOIN novel n ON n.id = c.novel_id
                    WHERE n.is_local = 0
                      AND {DELETE_CANDIDATE_CHAPTER_SQL}
                      AND {col} IN (
                    "#
                ));
                let mut separated = qb.separated(", ");
                for id in chunk {
                    separated.push_bind(*id);
                }
                separated.push_unseparated(") ORDER BY c.novel_id, c.position, c.id");
                #[derive(FromRow)]
                struct OrderedRow {
                    novel_id: i64,
                    position: i64,
                    content_bytes: i64,
                    id: i64,
                    is_downloaded: i64,
                    path: String,
                    source_content_type: Option<String>,
                    plugin_id: String,
                }
                let rows: Vec<OrderedRow> = qb
                    .build_query_as()
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("list download cache delete candidates: {err}"))?;
                for row in rows {
                    combined.push((
                        row.novel_id,
                        row.position,
                        map_row(RawDownloadCacheDeleteCandidateRow {
                            content_bytes: row.content_bytes,
                            id: row.id,
                            is_downloaded: row.is_downloaded,
                            path: row.path,
                            source_content_type: row.source_content_type,
                            plugin_id: row.plugin_id,
                        }),
                    ));
                }
            }
            combined.sort_by(|a, b| (a.0, a.1, a.2.id).cmp(&(b.0, b.1, b.2.id)));
            Ok(combined.into_iter().map(|(_, _, dto)| dto).collect())
        }
    }
}

pub async fn list_ordinary_queued_chapter_ids_in_conn(
    conn: &mut SqliteConnection,
    filter: &DownloadCacheTargetFilterInput,
) -> Result<Vec<i64>, String> {
    let base_select = r#"
        SELECT c.novel_id, c.position, q.chapter_id AS id
        FROM chapter_download_queue q
        JOIN chapter c ON c.id = q.chapter_id
        JOIN novel n ON n.id = c.novel_id
        WHERE n.is_local = 0
          AND json_extract(q.job_json, '$.vpnPlanId') IS NULL
          AND json_extract(q.job_json, '$.vpnRangeId') IS NULL
          AND json_extract(q.job_json, '$.vpnBatchId') IS NULL
    "#;

    match resolve_target_scope(filter, "q.chapter_id", "c.novel_id") {
        TargetScope::Empty => Ok(Vec::new()),
        TargetScope::All => {
            let sql = format!("{base_select} ORDER BY c.novel_id, c.position, c.id");
            let rows: Vec<(i64, i64, i64)> = sqlx::query_as(AssertSqlSafe(sql))
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("list ordinary queued download chapter ids: {err}"))?;
            Ok(rows.into_iter().map(|(_, _, id)| id).collect())
        }
        TargetScope::Column(col, ids) => {
            let mut combined: Vec<(i64, i64, i64)> = Vec::new();
            for chunk in ids.chunks(TARGET_ID_CHUNK_SIZE) {
                let mut qb =
                    QueryBuilder::<Sqlite>::new(format!("{base_select} AND {col} IN ("));
                let mut separated = qb.separated(", ");
                for id in chunk {
                    separated.push_bind(*id);
                }
                separated.push_unseparated(") ORDER BY c.novel_id, c.position, c.id");
                let rows: Vec<(i64, i64, i64)> = qb
                    .build_query_as()
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("list ordinary queued download chapter ids: {err}"))?;
                combined.extend(rows);
            }
            combined.sort_unstable();
            Ok(combined.into_iter().map(|(_, _, id)| id).collect())
        }
    }
}

pub async fn delete_download_cache_chapter_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<DownloadCacheResultDto, String> {
    let sql = format!(
        r#"
        UPDATE chapter
        SET
          content_bytes = 0,
          media_bytes = 0,
          media_repair_needed = 0,
          media_bytes_checked_at = NULL,
          is_downloaded = 0,
          updated_at = unixepoch()
        WHERE id = ?1
          AND {STORED_CHAPTER_UNALIASED_SQL}
          AND EXISTS (
            SELECT 1 FROM novel n
            WHERE n.id = chapter.novel_id
              AND n.is_local = 0
          )
        "#
    );
    let result = sqlx::query(AssertSqlSafe(sql))
        .bind(chapter_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("delete download cache chapter: {err}"))?;
    Ok(DownloadCacheResultDto {
        rows_affected: result.rows_affected() as i64,
    })
}

pub async fn delete_download_cache_novel_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<DownloadCacheResultDto, String> {
    let sql = format!(
        r#"
        UPDATE chapter
        SET
          content_bytes = 0,
          media_bytes = 0,
          media_repair_needed = 0,
          media_bytes_checked_at = NULL,
          is_downloaded = 0,
          updated_at = unixepoch()
        WHERE novel_id = ?1
          AND {STORED_CHAPTER_UNALIASED_SQL}
          AND EXISTS (
            SELECT 1 FROM novel n
            WHERE n.id = chapter.novel_id
              AND n.is_local = 0
          )
        "#
    );
    let result = sqlx::query(AssertSqlSafe(sql))
        .bind(novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("delete download cache novel: {err}"))?;
    Ok(DownloadCacheResultDto {
        rows_affected: result.rows_affected() as i64,
    })
}

pub async fn delete_all_download_cache_in_tx(
    conn: &mut SqliteConnection,
) -> Result<DownloadCacheResultDto, String> {
    let sql = format!(
        r#"
        UPDATE chapter
        SET
          content_bytes = 0,
          media_bytes = 0,
          media_repair_needed = 0,
          media_bytes_checked_at = NULL,
          is_downloaded = 0,
          updated_at = unixepoch()
        WHERE {STORED_CHAPTER_UNALIASED_SQL}
          AND EXISTS (
            SELECT 1 FROM novel n
            WHERE n.id = chapter.novel_id
              AND n.is_local = 0
          )
        "#
    );
    let result = sqlx::query(AssertSqlSafe(sql))
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("delete all download cache: {err}"))?;
    Ok(DownloadCacheResultDto {
        rows_affected: result.rows_affected() as i64,
    })
}

pub async fn list_media_backfill_candidates_in_conn(
    conn: &mut SqliteConnection,
    novel_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DownloadCacheMediaBackfillCandidateDto>, String> {
    let normalized_limit = clamp_backfill_limit(limit);
    let mut qb = QueryBuilder::<Sqlite>::new(
        r#"
        SELECT
          c.id,
          c.name AS chapter_name,
          n.source_novel_id,
          c.chapter_number,
          c.novel_id,
          c.position,
          c.updated_at,
          n.name AS novel_name,
          n.path AS novel_path,
          n.plugin_id
        FROM chapter c
        JOIN novel n ON n.id = c.novel_id
        WHERE c.is_downloaded = 1
          AND c.media_bytes = 0
          AND c.media_bytes_checked_at IS NULL
          AND n.is_local = 0
        "#,
    );
    if let Some(target_novel_id) = novel_id {
        qb.push(" AND c.novel_id = ");
        qb.push_bind(target_novel_id);
    }
    qb.push(" ORDER BY c.updated_at ASC, c.id ASC LIMIT ");
    qb.push_bind(normalized_limit);

    qb.build_query_as()
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("list download cache media backfill candidates: {err}"))
}

pub async fn update_chapter_media_bytes_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
    media_bytes: i64,
) -> Result<DownloadCacheResultDto, String> {
    let clamped_bytes = media_bytes.max(0);
    let result = sqlx::query(
        r#"
        UPDATE chapter
        SET
          media_bytes = ?2,
          media_bytes_checked_at = unixepoch()
        WHERE id = ?1
          AND (
            media_bytes IS NOT ?2
            OR media_bytes_checked_at IS NULL
          )
        "#,
    )
    .bind(chapter_id)
    .bind(clamped_bytes)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("update download cache chapter media bytes: {err}"))?;
    Ok(DownloadCacheResultDto {
        rows_affected: result.rows_affected() as i64,
    })
}

async fn acquire_writer(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<Sqlite>, String> {
    pool.acquire()
        .await
        .map_err(|err| format!("acquire database connection: {err}"))
}

#[tauri::command]
pub async fn db_download_queue_list_ordinary(
    db: State<'_, AppDatabase>,
) -> Result<Vec<StoredQueuedChapterDownloadDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    list_ordinary_queue_jobs_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_download_queue_list_pending_vpn(
    db: State<'_, AppDatabase>,
) -> Result<Vec<StoredQueuedChapterDownloadDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    list_pending_vpn_queue_jobs_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_download_queue_enqueue_pending_vpn(
    db: State<'_, AppDatabase>,
    batch_id: String,
    jobs: Vec<Value>,
) -> Result<DbMutationEnvelope<()>, String> {
    let now = now_ms()?;
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(async move { enqueue_pending_vpn_jobs_in_tx(conn, &batch_id, &jobs, now).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_queue_adopt_ordinary(
    db: State<'_, AppDatabase>,
    batch_id: String,
    expected: Vec<AdoptOrdinaryQueueRowInput>,
) -> Result<DbMutationEnvelope<Vec<ChapterDownloadJobDto>>, String> {
    let now = now_ms()?;
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(
            async move { adopt_ordinary_queue_jobs_in_tx(conn, &batch_id, &expected, now).await },
        )
    })
    .await
}

#[tauri::command]
pub async fn db_download_queue_cancel_pending_vpn_batch(
    db: State<'_, AppDatabase>,
    batch_id: String,
) -> Result<DbMutationEnvelope<i64>, String> {
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(async move { cancel_pending_vpn_batch_in_tx(conn, &batch_id).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_queue_cancel_pending_vpn_jobs(
    db: State<'_, AppDatabase>,
    batch_id: String,
    chapter_ids: Vec<i64>,
) -> Result<DbMutationEnvelope<i64>, String> {
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(async move { cancel_pending_vpn_jobs_in_tx(conn, &batch_id, &chapter_ids).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_queue_set_pending_vpn_paused(
    db: State<'_, AppDatabase>,
    batch_id: String,
    chapter_ids: Vec<i64>,
    paused: bool,
) -> Result<DbMutationEnvelope<i64>, String> {
    let now = now_ms()?;
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(async move {
            set_pending_vpn_jobs_paused_in_tx(conn, &batch_id, &chapter_ids, paused, now).await
        })
    })
    .await
}

#[tauri::command]
pub async fn db_download_failure_record(
    db: State<'_, AppDatabase>,
    input: RecordChapterDownloadFailureInput,
) -> Result<DbMutationEnvelope<Option<StoredChapterDownloadFailureDto>>, String> {
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(async move { record_chapter_download_failure_in_tx(conn, &input).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_failure_clear(
    db: State<'_, AppDatabase>,
    chapter_ids: Vec<i64>,
) -> Result<DbMutationEnvelope<i64>, String> {
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(async move { clear_chapter_download_failures_in_tx(conn, &chapter_ids).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_failure_get(
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<Option<StoredChapterDownloadFailureDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    get_chapter_download_failure_in_conn(&mut conn, chapter_id).await
}

#[tauri::command]
pub async fn db_download_failure_clear_scheduled_retries(
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<i64>, String> {
    with_write_tx(db.writer(), queue_tx_options(), |conn, _ctx| {
        Box::pin(clear_scheduled_chapter_download_retries_in_tx(conn))
    })
    .await
}

#[tauri::command]
pub async fn db_download_failure_list(
    db: State<'_, AppDatabase>,
) -> Result<Vec<StoredChapterDownloadFailureDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    list_chapter_download_failures_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_download_cache_list_novels(
    db: State<'_, AppDatabase>,
) -> Result<Vec<DownloadCacheNovelDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    list_download_cache_novels_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_download_cache_list_chapters(
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<Vec<DownloadCacheChapterDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    list_download_cache_chapters_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_download_cache_list_delete_candidates(
    db: State<'_, AppDatabase>,
    filter: Option<DownloadCacheTargetFilterInput>,
) -> Result<Vec<DownloadCacheDeleteChapterCandidateDto>, String> {
    let resolved = filter.unwrap_or_default();
    let mut conn = acquire_writer(db.writer()).await?;
    list_delete_candidates_in_conn(&mut conn, &resolved).await
}

#[tauri::command]
pub async fn db_download_cache_list_ordinary_queued_ids(
    db: State<'_, AppDatabase>,
    filter: Option<DownloadCacheTargetFilterInput>,
) -> Result<Vec<i64>, String> {
    let resolved = filter.unwrap_or_default();
    let mut conn = acquire_writer(db.writer()).await?;
    list_ordinary_queued_chapter_ids_in_conn(&mut conn, &resolved).await
}

#[tauri::command]
pub async fn db_download_cache_delete_chapter(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
) -> Result<DbMutationEnvelope<DownloadCacheResultDto>, String> {
    with_write_tx(db.writer(), TxOptions::with_app_metadata(app), |conn, _ctx| {
        Box::pin(async move { delete_download_cache_chapter_in_tx(conn, chapter_id).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_cache_delete_novel(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<DbMutationEnvelope<DownloadCacheResultDto>, String> {
    with_write_tx(db.writer(), TxOptions::with_app_metadata(app), |conn, _ctx| {
        Box::pin(async move { delete_download_cache_novel_in_tx(conn, novel_id).await })
    })
    .await
}

#[tauri::command]
pub async fn db_download_cache_delete_all(
    app: AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<DownloadCacheResultDto>, String> {
    with_write_tx(db.writer(), TxOptions::with_app_metadata(app), |conn, _ctx| {
        Box::pin(delete_all_download_cache_in_tx(conn))
    })
    .await
}

#[tauri::command]
pub async fn db_download_cache_list_media_backfill_candidates(
    db: State<'_, AppDatabase>,
    novel_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<DownloadCacheMediaBackfillCandidateDto>, String> {
    let mut conn = acquire_writer(db.writer()).await?;
    list_media_backfill_candidates_in_conn(&mut conn, novel_id, limit).await
}

#[tauri::command]
pub async fn db_download_cache_update_media_bytes(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    media_bytes: i64,
) -> Result<DbMutationEnvelope<DownloadCacheResultDto>, String> {
    with_write_tx(db.writer(), TxOptions::with_app_metadata(app), |conn, _ctx| {
        Box::pin(async move { update_chapter_media_bytes_in_tx(conn, chapter_id, media_bytes).await })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;
    use serde_json::json;

    fn sample_job(id: i64) -> Value {
        json!({
            "id": id,
            "pluginId": "source",
            "novelId": 42,
            "novelPath": "/work",
            "chapterPath": format!("/{id}"),
            "title": format!("Chapter {id}"),
            "batchId": "ordinary-batch"
        })
    }

    #[tokio::test]
    async fn pending_vpn_queue_coalesces_adopts_pauses_and_cancels() {
        let test_db = open_test_db().await;
        let pool = test_db.db.writer();

        sqlx::query("INSERT INTO novel(id, plugin_id, path, name, in_library) VALUES (42, 'source', '/work', 'Work', 1)")
            .execute(pool)
            .await
            .unwrap();
        for id in 1..=4 {
            sqlx::query("INSERT INTO chapter(id, novel_id, path, name, position) VALUES (?1, 42, ?2, ?3, ?1)")
                .bind(id)
                .bind(format!("/{id}"))
                .bind(format!("Chapter {id}"))
                .execute(pool)
                .await
                .unwrap();
        }

        with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            Box::pin(async move {
                enqueue_pending_vpn_jobs_in_tx(conn, "run-a", &[sample_job(1), sample_job(2)], 100)
                    .await?;
                enqueue_pending_vpn_jobs_in_tx(conn, "run-a", &[sample_job(1)], 110).await
            })
        })
        .await
        .unwrap();

        let mut conn = acquire_writer(pool).await.unwrap();
        let pending = list_pending_vpn_queue_jobs_in_conn(&mut conn).await.unwrap();
        drop(conn);
        assert_eq!(pending.len(), 2);
        assert_eq!(pending[0].job.id(), 1);
        assert_eq!(pending[0].job.vpn_batch_id(), Some("run-a"));

        let ord_json = serde_json::to_string(&sample_job(3)).unwrap();
        sqlx::query(
            "INSERT INTO chapter_download_queue(chapter_id, job_json, created_at_ms, updated_at_ms, leased_at_ms, attempt_count) VALUES (3, ?1, 10, 20, 30, 2)",
        )
        .bind(&ord_json)
        .execute(pool)
        .await
        .unwrap();

        let mut conn = acquire_writer(pool).await.unwrap();
        let ordinary = list_ordinary_queue_jobs_in_conn(&mut conn).await.unwrap();
        drop(conn);
        assert_eq!(ordinary.len(), 1);
        assert_eq!(ordinary[0].job.id(), 3);

        let adopted = with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            let expected = vec![AdoptOrdinaryQueueRowInput {
                chapter_id: 3,
                job_json: ordinary[0].job_json.clone(),
                updated_at_ms: ordinary[0].updated_at_ms,
            }];
            Box::pin(async move { adopt_ordinary_queue_jobs_in_tx(conn, "run-a", &expected, 200).await })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(adopted.len(), 1);
        assert_eq!(adopted[0].vpn_batch_id(), Some("run-a"));

        let paused = with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            Box::pin(async move { set_pending_vpn_jobs_paused_in_tx(conn, "run-a", &[1, 3], true, 250).await })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(paused, 2);

        let cancelled_one = with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            Box::pin(async move { cancel_pending_vpn_jobs_in_tx(conn, "run-a", &[1]).await })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(cancelled_one, 1);

        let cancelled_rest = with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            Box::pin(async move { cancel_pending_vpn_batch_in_tx(conn, "run-a").await })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(cancelled_rest, 2);
    }

    #[tokio::test]
    async fn download_failures_and_cache_queries_roundtrip() {
        let test_db = open_test_db().await;
        let pool = test_db.db.writer();

        sqlx::query("INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library, is_local) VALUES (1, 'source', 'w1', '/work', 'Work', 1, 0)")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO chapter(id, novel_id, path, name, position, is_downloaded, content_bytes, media_bytes, progress) VALUES (1, 1, '/1', 'One', 1, 1, 512, 0, 0), (2, 1, '/2', 'Two', 2, 0, 0, 0, 0)")
            .execute(pool)
            .await
            .unwrap();

        let recorded = with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            let input = RecordChapterDownloadFailureInput {
                chapter_id: 2,
                plugin_id: "source".to_string(),
                failure_class: "transient".to_string(),
                message_summary: "Timed out".to_string(),
                challenge_url: None,
                job_json: "{\"id\":2}".to_string(),
                now: 1000,
                retry_delays_ms: vec![Some(50), None],
                fallback_retry_delay_ms: None,
            };
            Box::pin(async move { record_chapter_download_failure_in_tx(conn, &input).await })
        })
        .await
        .unwrap()
        .value
        .unwrap();
        assert_eq!(recorded.attempts, 1);
        assert_eq!(recorded.next_retry_at, Some(1050));

        let cleared_sched = with_write_tx(pool, queue_tx_options(), |conn, _ctx| {
            Box::pin(clear_scheduled_chapter_download_retries_in_tx(conn))
        })
        .await
        .unwrap()
        .value;
        assert_eq!(cleared_sched, 1);

        let mut conn = acquire_writer(pool).await.unwrap();
        let novels = list_download_cache_novels_in_conn(&mut conn).await.unwrap();
        assert_eq!(novels.len(), 1);
        assert_eq!(novels[0].chapters_downloaded, 1);
        assert_eq!(novels[0].total_bytes, 512);

        let backfill = list_media_backfill_candidates_in_conn(&mut conn, Some(1), Some(10))
            .await
            .unwrap();
        drop(conn);
        assert_eq!(backfill.len(), 1);
        assert_eq!(backfill[0].id, 1);

        let updated = with_write_tx(pool, TxOptions::default(), |conn, _ctx| {
            Box::pin(async move { update_chapter_media_bytes_in_tx(conn, 1, 256).await })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(updated.rows_affected, 1);

        let deleted = with_write_tx(pool, TxOptions::default(), |conn, _ctx| {
            Box::pin(async move { delete_download_cache_chapter_in_tx(conn, 1).await })
        })
        .await
        .unwrap()
        .value;
        assert_eq!(deleted.rows_affected, 1);
    }
}
