use std::{
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sqlx::{
    QueryBuilder, Row, Sqlite, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

const DB_FILE: &str = "norea.db";
const DB_BUSY_TIMEOUT_MS: u64 = 5000;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vpn_batch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vpn_work_paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vpn_plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    vpn_range_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retry_at: Option<i64>,
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
        .app_config_dir()
        .map_err(|err| format!("download queue: app config dir: {err}"))?
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
        WHERE json_extract(chapter_download_queue.job_json, '$.vpnPlanId') IS NULL
          AND json_extract(chapter_download_queue.job_json, '$.vpnRangeId') IS NULL
          AND json_extract(chapter_download_queue.job_json, '$.vpnBatchId') IS NULL
          AND json_extract(excluded.job_json, '$.vpnPlanId') IS NULL
          AND json_extract(excluded.job_json, '$.vpnRangeId') IS NULL
          AND json_extract(excluded.job_json, '$.vpnBatchId') IS NULL
        "#,
    )
    .bind(job.id)
    .bind(job_json)
    .bind(i64::try_from(created_at_ms).unwrap_or(i64::MAX))
    .bind(i64::try_from(updated_at_ms).unwrap_or(i64::MAX))
    .execute(executor)
    .await
    .and_then(|result| {
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(sqlx::Error::Protocol("ordinary enqueue cannot overwrite VPN download ownership".into()))
        }
    })
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
    remove_queue_jobs(&pool, &chapter_ids).await
}

async fn remove_queue_jobs(pool: &SqlitePool, chapter_ids: &[i64]) -> Result<(), String> {
    let mut query =
        QueryBuilder::<Sqlite>::new("DELETE FROM chapter_download_queue WHERE chapter_id IN (");
    let mut separated = query.separated(", ");
    for chapter_id in chapter_ids {
        separated.push_bind(chapter_id);
    }
    separated.push_unseparated(")");
    query.push(" AND json_extract(job_json, '$.vpnPlanId') IS NULL AND json_extract(job_json, '$.vpnRangeId') IS NULL AND json_extract(job_json, '$.vpnBatchId') IS NULL");
    query
        .build()
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|err| format!("download queue: remove jobs: {err}"))
}

#[tauri::command]
pub async fn chapter_download_queue_lease(
    app: AppHandle,
    state: State<'_, DownloadQueueState>,
    limit: Option<usize>,
) -> Result<Vec<ChapterDownloadQueueJob>, String> {
    let pool = queue_pool(&app, state.inner()).await?;
    lease_queue_jobs(&pool, limit).await
}

async fn lease_queue_jobs(
    pool: &SqlitePool,
    limit: Option<usize>,
) -> Result<Vec<ChapterDownloadQueueJob>, String> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|err| format!("download queue: begin lease: {err}"))?;
    let rows = match limit.filter(|value| *value > 0) {
        Some(limit) => {
            sqlx::query(
                r#"
                SELECT chapter_id, job_json
                FROM chapter_download_queue
                WHERE json_extract(job_json, '$.vpnPlanId') IS NULL
                  AND json_extract(job_json, '$.vpnRangeId') IS NULL
                  AND json_extract(job_json, '$.vpnBatchId') IS NULL
                ORDER BY created_at_ms, chapter_id
                LIMIT ?1
                "#,
            )
            .bind(i64::try_from(limit).unwrap_or(i64::MAX))
            .fetch_all(&mut *tx)
            .await
        }
        None => {
            sqlx::query(
                r#"
                SELECT chapter_id, job_json
                FROM chapter_download_queue
                WHERE json_extract(job_json, '$.vpnPlanId') IS NULL
                  AND json_extract(job_json, '$.vpnRangeId') IS NULL
                  AND json_extract(job_json, '$.vpnBatchId') IS NULL
                ORDER BY created_at_ms, chapter_id
                "#,
            )
            .fetch_all(&mut *tx)
            .await
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: i64, plan: Option<&str>, range: Option<&str>) -> ChapterDownloadQueueJob {
        serde_json::from_value(serde_json::json!({
            "id": id, "pluginId": "source", "chapterPath": format!("/{id}"), "title": "Chapter",
            "vpnPlanId": plan, "vpnRangeId": range,
        })).unwrap()
    }

    #[test]
    fn vpn_membership_survives_json_roundtrip() {
        let stored = serde_json::to_value(job(1, Some("plan"), Some("range"))).unwrap();
        assert_eq!(stored["vpnPlanId"], "plan");
        assert_eq!(stored["vpnRangeId"], "range");
        let restored: ChapterDownloadQueueJob = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), stored);
        let ordinary = serde_json::to_value(job(2, None, None)).unwrap();
        assert!(ordinary.get("vpnPlanId").is_none());
        assert!(ordinary.get("vpnRangeId").is_none());
    }

    fn pending_job(id: i64, batch: &str) -> ChapterDownloadQueueJob {
        let mut value = serde_json::to_value(job(id, None, None)).unwrap();
        value["vpnBatchId"] = batch.into();
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn pending_vpn_ownership_survives_json_roundtrip() {
        let stored = serde_json::to_value(pending_job(5, "pending-batch")).unwrap();
        assert_eq!(stored["vpnBatchId"], "pending-batch");
        let restored: ChapterDownloadQueueJob = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), stored);
        assert!(serde_json::to_value(job(6, None, None)).unwrap().get("vpnBatchId").is_none());
    }

    #[test]
    fn automatic_retry_time_survives_json_roundtrip() {
        let mut value = serde_json::to_value(job(7, None, None)).unwrap();
        assert!(value.get("retryAt").is_none());
        value["retryAt"] = 1_700_000_030_000_i64.into();
        let restored: ChapterDownloadQueueJob = serde_json::from_value(value).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap()["retryAt"], 1_700_000_030_000_i64);
    }

    #[test]
    fn pending_work_pause_survives_json_roundtrip() {
        let mut value = serde_json::to_value(pending_job(5, "pending-batch")).unwrap();
        value["vpnWorkPaused"] = true.into();
        let restored: ChapterDownloadQueueJob = serde_json::from_value(value).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap()["vpnWorkPaused"], true);
        assert!(serde_json::to_value(job(6, None, None)).unwrap().get("vpnWorkPaused").is_none());
    }

    #[tokio::test]
    async fn pending_vpn_jobs_are_not_leased_or_removed_as_ordinary_work() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_queue_schema(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_queue VALUES(5,?1,1,2,NULL,0)")
            .bind(r#"{"id":5,"pluginId":"source","chapterPath":"/5","title":"Pending","vpnBatchId":"pending-batch"}"#)
            .execute(&pool).await.unwrap();
        insert_queue_job(&pool, &job(6, None, None), 3, 4).await.unwrap();
        assert_eq!(lease_queue_jobs(&pool, Some(1)).await.unwrap().iter().map(|job| job.id).collect::<Vec<_>>(), vec![6]);
        assert_eq!(lease_queue_jobs(&pool, None).await.unwrap().iter().map(|job| job.id).collect::<Vec<_>>(), vec![6]);
        remove_queue_jobs(&pool, &[5, 6]).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, i64, i64, Option<i64>, i64)>(
            "SELECT chapter_id,created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue")
            .fetch_all(&pool).await.unwrap(), vec![(5,1,2,None,0)]);
        pool.close().await;
    }

    #[tokio::test]
    async fn ordinary_enqueue_cannot_overwrite_pending_vpn_ownership() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_queue_schema(&pool).await.unwrap();
        let payload = r#"{"id":5,"pluginId":"source","chapterPath":"/5","title":"Pending","vpnBatchId":"pending-batch"}"#;
        sqlx::query("INSERT INTO chapter_download_queue VALUES(5,?1,1,2,NULL,0)")
            .bind(payload).execute(&pool).await.unwrap();
        assert!(insert_queue_job(&pool, &job(5, None, None), 3, 4).await.is_err());
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT job_json FROM chapter_download_queue WHERE chapter_id=5")
            .fetch_one(&pool).await.unwrap(), payload);
        insert_queue_job(&pool, &job(6, None, None), 3, 4).await.unwrap();
        assert!(insert_queue_job(&pool, &pending_job(6, "another-batch"), 5, 6).await.is_err());
        pool.close().await;
    }

    #[tokio::test]
    async fn native_lease_leaves_enrolled_jobs_unleased() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_queue_schema(&pool).await.unwrap();
        insert_queue_job(&pool, &job(1, Some("plan"), Some("range")), 1, 1).await.unwrap();
        insert_queue_job(&pool, &job(2, None, None), 2, 2).await.unwrap();
        insert_queue_job(&pool, &job(3, Some("plan"), None), 0, 0).await.unwrap();
        insert_queue_job(&pool, &job(4, None, Some("range")), 0, 0).await.unwrap();
        let limited = lease_queue_jobs(&pool, Some(1)).await.unwrap();
        assert_eq!(limited.iter().map(|job| job.id).collect::<Vec<_>>(), vec![2]);
        let all = lease_queue_jobs(&pool, None).await.unwrap();
        assert_eq!(all.iter().map(|job| job.id).collect::<Vec<_>>(), vec![2]);
        assert_eq!(sqlx::query_as::<_, (i64, Option<i64>, i64)>(
            "SELECT chapter_id,leased_at_ms,attempt_count FROM chapter_download_queue WHERE chapter_id<>2 ORDER BY chapter_id")
            .fetch_all(&pool).await.unwrap(), vec![(1,None,0), (3,None,0), (4,None,0)]);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT attempt_count FROM chapter_download_queue WHERE chapter_id=2")
            .fetch_one(&pool).await.unwrap(), 2);
        pool.close().await;
    }

    #[tokio::test]
    async fn enqueue_cannot_steal_enrolled_queue_ownership() {
        let pool = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        ensure_queue_schema(&pool).await.unwrap();
        insert_queue_job(&pool, &job(1, Some("plan"), Some("range")), 1, 1).await.unwrap();
        assert!(insert_queue_job(&pool, &job(1, None, None), 2, 2).await.is_err());
        remove_queue_jobs(&pool, &[1]).await.unwrap();
        assert!(insert_queue_job(&pool, &job(1, Some("other"), Some("other")), 2, 2).await.is_err());
        let stored: String = sqlx::query_scalar("SELECT job_json FROM chapter_download_queue WHERE chapter_id=1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&stored).unwrap()["vpnPlanId"], "plan");
        insert_queue_job(&pool, &job(2, None, None), 1, 1).await.unwrap();
        assert!(insert_queue_job(&pool, &job(2, Some("plan"), Some("range")), 2, 2).await.is_err());
        lease_queue_jobs(&pool, None).await.unwrap();
        insert_queue_job(&pool, &job(2, None, None), 2, 2).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, i64, Option<i64>, i64)>(
            "SELECT created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue WHERE chapter_id=2")
            .fetch_one(&pool).await.unwrap(), (1,2,None,0));
        pool.close().await;
    }
}
