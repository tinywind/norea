use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    QueryBuilder, Row, Sqlite, SqlitePool,
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const DB_FILE: &str = "norea.db";
const DB_BUSY_TIMEOUT_MS: u64 = 5000;
const MAX_LEASE_LIMIT: usize = 100;

const CREATE_DOWNLOAD_QUEUE_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS chapter_download_queue (
  chapter_id integer PRIMARY KEY NOT NULL,
  job_json text NOT NULL,
  created_at_ms integer NOT NULL,
  updated_at_ms integer NOT NULL,
  leased_at_ms integer,
  attempt_count integer DEFAULT 0 NOT NULL
)"#;

const CREATE_DOWNLOAD_QUEUE_CREATED_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS chapter_download_queue_created_idx
ON chapter_download_queue (created_at_ms, chapter_id)"#;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDownloadQueueJob {
    id: i64,
    batch_id: Option<String>,
    batch_title: Option<String>,
    plugin_id: String,
    plugin_name: Option<String>,
    chapter_path: String,
    chapter_name: Option<String>,
    chapter_number: Option<String>,
    content_type: Option<String>,
    novel_id: Option<i64>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    priority: Option<String>,
    title: String,
}

#[derive(Debug, Default)]
pub struct DownloadQueueState {
    pool: Mutex<Option<SqlitePool>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|err| format!("download queue: app data dir: {err}"))?
        .join(DB_FILE))
}

async fn ensure_queue_schema(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(CREATE_DOWNLOAD_QUEUE_TABLE_SQL)
        .execute(pool)
        .await
        .map_err(|err| format!("download queue: create table: {err}"))?;
    sqlx::query(CREATE_DOWNLOAD_QUEUE_CREATED_INDEX_SQL)
        .execute(pool)
        .await
        .map_err(|err| format!("download queue: create created index: {err}"))?;
    Ok(())
}

async fn insert_queue_job(
    executor: impl sqlx::Executor<'_, Database = Sqlite>,
    job: &ChapterDownloadQueueJob,
    created_at_ms: u64,
    updated_at_ms: u64,
) -> Result<(), String> {
    let job_json = serde_json::to_string(job)
        .map_err(|err| format!("download queue: serialize job: {err}"))?;
    sqlx::query(
        r#"
        INSERT INTO chapter_download_queue (
          chapter_id,
          job_json,
          created_at_ms,
          updated_at_ms
        )
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(chapter_id) DO UPDATE SET
          job_json = excluded.job_json,
          updated_at_ms = excluded.updated_at_ms,
          leased_at_ms = NULL,
          attempt_count = 0
        "#,
    )
    .bind(job.id)
    .bind(job_json)
    .bind(i64::try_from(created_at_ms).unwrap_or(i64::MAX))
    .bind(i64::try_from(updated_at_ms).unwrap_or(i64::MAX))
    .execute(executor)
    .await
    .map(|_| ())
    .map_err(|err| format!("download queue: insert job: {err}"))
}

async fn queue_pool(app: &AppHandle, state: &DownloadQueueState) -> Result<SqlitePool, String> {
    let mut guard = state.pool.lock().await;
    if let Some(pool) = guard.as_ref() {
        return Ok(pool.clone());
    }

    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("download queue: create db dir: {err}"))?;
    }
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|err| format!("download queue: open sqlite queue db: {err}"))?;
    ensure_queue_schema(&pool).await?;
    *guard = Some(pool.clone());
    Ok(pool)
}

#[tauri::command]
pub async fn chapter_download_queue_enqueue(
    app: AppHandle,
    state: State<'_, DownloadQueueState>,
    jobs: Vec<ChapterDownloadQueueJob>,
) -> Result<(), String> {
    if jobs.is_empty() {
        return Ok(());
    }

    let pool = queue_pool(&app, state.inner()).await?;
    let now = now_ms();
    let mut tx = pool
        .begin()
        .await
        .map_err(|err| format!("download queue: begin enqueue: {err}"))?;
    for job in &jobs {
        insert_queue_job(&mut *tx, job, now, now).await?;
    }
    tx.commit()
        .await
        .map_err(|err| format!("download queue: commit enqueue: {err}"))?;
    Ok(())
}

#[tauri::command]
pub async fn chapter_download_queue_remove(
    app: AppHandle,
    state: State<'_, DownloadQueueState>,
    chapter_ids: Vec<i64>,
) -> Result<(), String> {
    if chapter_ids.is_empty() {
        return Ok(());
    }

    let pool = queue_pool(&app, state.inner()).await?;
    let mut query =
        QueryBuilder::<Sqlite>::new("DELETE FROM chapter_download_queue WHERE chapter_id IN (");
    let mut separated = query.separated(", ");
    for chapter_id in chapter_ids {
        separated.push_bind(chapter_id);
    }
    separated.push_unseparated(")");
    query
        .build()
        .execute(&pool)
        .await
        .map(|_| ())
        .map_err(|err| format!("download queue: remove jobs: {err}"))
}

#[tauri::command]
pub async fn chapter_download_queue_lease(
    app: AppHandle,
    state: State<'_, DownloadQueueState>,
    limit: usize,
) -> Result<Vec<ChapterDownloadQueueJob>, String> {
    let pool = queue_pool(&app, state.inner()).await?;
    let limit = limit.clamp(1, MAX_LEASE_LIMIT);
    let mut tx = pool
        .begin()
        .await
        .map_err(|err| format!("download queue: begin lease: {err}"))?;
    let rows = sqlx::query(
        r#"
        SELECT chapter_id, job_json
        FROM chapter_download_queue
        ORDER BY created_at_ms, chapter_id
        LIMIT ?1
        "#,
    )
    .bind(i64::try_from(limit).unwrap_or(i64::MAX))
    .fetch_all(&mut *tx)
    .await
    .map_err(|err| format!("download queue: lease jobs: {err}"))?;

    let mut jobs = Vec::with_capacity(rows.len());
    let mut chapter_ids = Vec::with_capacity(rows.len());
    for row in rows {
        let chapter_id: i64 = row
            .try_get("chapter_id")
            .map_err(|err| format!("download queue: read leased chapter id: {err}"))?;
        let job_json: String = row
            .try_get("job_json")
            .map_err(|err| format!("download queue: read leased job: {err}"))?;
        let job = serde_json::from_str(&job_json)
            .map_err(|err| format!("download queue: parse leased job: {err}"))?;
        chapter_ids.push(chapter_id);
        jobs.push(job);
    }

    if !chapter_ids.is_empty() {
        let leased_at_ms = now_ms();
        let mut query =
            QueryBuilder::<Sqlite>::new("UPDATE chapter_download_queue SET leased_at_ms = ");
        query
            .push_bind(i64::try_from(leased_at_ms).unwrap_or(i64::MAX))
            .push(", attempt_count = attempt_count + 1 WHERE chapter_id IN (");
        let mut separated = query.separated(", ");
        for chapter_id in chapter_ids {
            separated.push_bind(chapter_id);
        }
        separated.push_unseparated(")");
        query
            .build()
            .execute(&mut *tx)
            .await
            .map_err(|err| format!("download queue: mark leased jobs: {err}"))?;
    }

    tx.commit()
        .await
        .map_err(|err| format!("download queue: commit lease: {err}"))?;
    Ok(jobs)
}
