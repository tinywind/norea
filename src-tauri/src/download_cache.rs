use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::chapter_media::{clear_downloaded_chapter_artifacts, ChapterMediaClearContext};

const DB_URL: &str = "sqlite:norea.db";
const DOWNLOAD_CACHE_DELETE_PROGRESS_EVENT: &str = "download-cache-delete-progress";
const DELETE_BATCH_SIZE: usize = 50;

const CREATE_DOWNLOAD_CACHE_WORK_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS download_cache_work (
  id text PRIMARY KEY NOT NULL,
  scope text NOT NULL,
  target_ids_json text NOT NULL,
  title text,
  status text DEFAULT 'queued' NOT NULL,
  total integer DEFAULT 0 NOT NULL,
  completed integer DEFAULT 0 NOT NULL,
  failed integer DEFAULT 0 NOT NULL,
  error text,
  cancel_requested integer DEFAULT 0 NOT NULL,
  created_at_ms integer NOT NULL,
  updated_at_ms integer NOT NULL,
  started_at_ms integer,
  finished_at_ms integer
)"#;

const CREATE_DOWNLOAD_CACHE_WORK_STATUS_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS download_cache_work_status_idx
ON download_cache_work (status, updated_at_ms)"#;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheDeleteWorkRequest {
    id: String,
    scope: String,
    target_ids: Vec<i64>,
    title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheDeleteWork {
    id: String,
    scope: String,
    target_ids: Vec<i64>,
    title: Option<String>,
    status: String,
    total: i64,
    completed: i64,
    failed: i64,
    error: Option<String>,
    cancel_requested: bool,
    created_at_ms: i64,
    updated_at_ms: i64,
    started_at_ms: Option<i64>,
    finished_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCacheDeleteResult {
    work_id: String,
    total: i64,
    deleted: i64,
    failed: i64,
    cancelled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadCacheDeleteProgressEvent {
    work_id: String,
    status: String,
    total: i64,
    completed: i64,
    failed: i64,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct DownloadCacheChapterRow {
    chapter_id: i64,
    novel_id: i64,
    source_id: String,
    novel_path: String,
    novel_name: String,
    chapter_number: Option<String>,
    chapter_name: String,
    chapter_position: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn is_supported_scope(scope: &str) -> bool {
    matches!(scope, "chapter" | "novel" | "all")
}

fn normalize_target_ids(scope: &str, target_ids: Vec<i64>) -> Result<Vec<i64>, String> {
    if !is_supported_scope(scope) {
        return Err(format!(
            "download cache: unsupported delete scope '{scope}'"
        ));
    }
    if scope == "all" {
        return Ok(Vec::new());
    }
    let mut ids: Vec<i64> = target_ids.into_iter().filter(|id| *id > 0).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Err("download cache: delete target ids are empty".to_string());
    }
    Ok(ids)
}

fn parse_target_ids(raw: &str) -> Result<Vec<i64>, String> {
    serde_json::from_str(raw).map_err(|err| format!("download cache: parse target ids: {err}"))
}

async fn app_db_pool(db_instances: &DbInstances) -> Result<SqlitePool, String> {
    let instances = db_instances.0.read().await;
    match instances.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        None => Err("download cache: norea.db is not loaded".to_string()),
    }
}

async fn ensure_work_schema(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(CREATE_DOWNLOAD_CACHE_WORK_TABLE_SQL)
        .execute(pool)
        .await
        .map_err(|err| format!("download cache: create work table: {err}"))?;
    sqlx::query(CREATE_DOWNLOAD_CACHE_WORK_STATUS_INDEX_SQL)
        .execute(pool)
        .await
        .map_err(|err| format!("download cache: create work status index: {err}"))?;
    Ok(())
}

fn work_from_row(row: sqlx::sqlite::SqliteRow) -> Result<DownloadCacheDeleteWork, String> {
    let target_ids_json: String = row
        .try_get("target_ids_json")
        .map_err(|err| format!("download cache: read work targets: {err}"))?;
    Ok(DownloadCacheDeleteWork {
        id: row
            .try_get("id")
            .map_err(|err| format!("download cache: read work id: {err}"))?,
        scope: row
            .try_get("scope")
            .map_err(|err| format!("download cache: read work scope: {err}"))?,
        target_ids: parse_target_ids(&target_ids_json)?,
        title: row
            .try_get("title")
            .map_err(|err| format!("download cache: read work title: {err}"))?,
        status: row
            .try_get("status")
            .map_err(|err| format!("download cache: read work status: {err}"))?,
        total: row
            .try_get("total")
            .map_err(|err| format!("download cache: read work total: {err}"))?,
        completed: row
            .try_get("completed")
            .map_err(|err| format!("download cache: read work completed: {err}"))?,
        failed: row
            .try_get("failed")
            .map_err(|err| format!("download cache: read work failed: {err}"))?,
        error: row
            .try_get("error")
            .map_err(|err| format!("download cache: read work error: {err}"))?,
        cancel_requested: row
            .try_get::<i64, _>("cancel_requested")
            .map_err(|err| format!("download cache: read work cancel flag: {err}"))?
            == 1,
        created_at_ms: row
            .try_get("created_at_ms")
            .map_err(|err| format!("download cache: read work created time: {err}"))?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|err| format!("download cache: read work updated time: {err}"))?,
        started_at_ms: row
            .try_get("started_at_ms")
            .map_err(|err| format!("download cache: read work started time: {err}"))?,
        finished_at_ms: row
            .try_get("finished_at_ms")
            .map_err(|err| format!("download cache: read work finished time: {err}"))?,
    })
}

async fn get_work(pool: &SqlitePool, work_id: &str) -> Result<DownloadCacheDeleteWork, String> {
    let row = sqlx::query(
        r#"
        SELECT
          id,
          scope,
          target_ids_json,
          title,
          status,
          total,
          completed,
          failed,
          error,
          cancel_requested,
          created_at_ms,
          updated_at_ms,
          started_at_ms,
          finished_at_ms
        FROM download_cache_work
        WHERE id = ?1
        "#,
    )
    .bind(work_id)
    .fetch_optional(pool)
    .await
    .map_err(|err| format!("download cache: load work: {err}"))?;
    match row {
        Some(row) => work_from_row(row),
        None => Err("download cache: delete work not found".to_string()),
    }
}

fn push_target_filter(
    query: &mut QueryBuilder<'_, Sqlite>,
    scope: &str,
    target_ids: &[i64],
) -> Result<(), String> {
    match scope {
        "all" => Ok(()),
        "chapter" => {
            if target_ids.is_empty() {
                return Err("download cache: chapter delete target ids are empty".to_string());
            }
            query.push(" AND c.id IN (");
            let mut separated = query.separated(", ");
            for id in target_ids {
                separated.push_bind(*id);
            }
            separated.push_unseparated(")");
            Ok(())
        }
        "novel" => {
            if target_ids.is_empty() {
                return Err("download cache: novel delete target ids are empty".to_string());
            }
            query.push(" AND c.novel_id IN (");
            let mut separated = query.separated(", ");
            for id in target_ids {
                separated.push_bind(*id);
            }
            separated.push_unseparated(")");
            Ok(())
        }
        _ => Err(format!(
            "download cache: unsupported delete scope '{scope}'"
        )),
    }
}

async fn select_target_chapters(
    pool: &SqlitePool,
    work: &DownloadCacheDeleteWork,
) -> Result<Vec<DownloadCacheChapterRow>, String> {
    let mut query = QueryBuilder::<Sqlite>::new(
        r#"
        SELECT
          c.id             AS chapter_id,
          c.novel_id       AS novel_id,
          n.plugin_id      AS source_id,
          n.path           AS novel_path,
          n.name           AS novel_name,
          c.chapter_number AS chapter_number,
          c.name           AS chapter_name,
          c.position       AS chapter_position
        FROM chapter c
        JOIN novel n ON n.id = c.novel_id
        WHERE n.is_local = 0
        "#,
    );
    push_target_filter(&mut query, &work.scope, &work.target_ids)?;
    query.push(" ORDER BY c.novel_id, c.position, c.id");

    let rows = query
        .build()
        .fetch_all(pool)
        .await
        .map_err(|err| format!("download cache: select target chapters: {err}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(DownloadCacheChapterRow {
                chapter_id: row
                    .try_get("chapter_id")
                    .map_err(|err| format!("download cache: read chapter id: {err}"))?,
                novel_id: row
                    .try_get("novel_id")
                    .map_err(|err| format!("download cache: read novel id: {err}"))?,
                source_id: row
                    .try_get("source_id")
                    .map_err(|err| format!("download cache: read source id: {err}"))?,
                novel_path: row
                    .try_get("novel_path")
                    .map_err(|err| format!("download cache: read novel path: {err}"))?,
                novel_name: row
                    .try_get("novel_name")
                    .map_err(|err| format!("download cache: read novel name: {err}"))?,
                chapter_number: row
                    .try_get("chapter_number")
                    .map_err(|err| format!("download cache: read chapter number: {err}"))?,
                chapter_name: row
                    .try_get("chapter_name")
                    .map_err(|err| format!("download cache: read chapter name: {err}"))?,
                chapter_position: row
                    .try_get("chapter_position")
                    .map_err(|err| format!("download cache: read chapter position: {err}"))?,
            })
        })
        .collect()
}

async fn mark_work_running(pool: &SqlitePool, work_id: &str, total: i64) -> Result<bool, String> {
    let now = now_ms();
    sqlx::query(
        r#"
        UPDATE download_cache_work
        SET
          status = 'running',
          total = ?2,
          completed = 0,
          failed = 0,
          error = NULL,
          cancel_requested = 0,
          started_at_ms = COALESCE(started_at_ms, ?3),
          finished_at_ms = NULL,
          updated_at_ms = ?3
        WHERE id = ?1
          AND status IN ('queued', 'running')
          AND cancel_requested = 0
        "#,
    )
    .bind(work_id)
    .bind(total)
    .bind(now)
    .execute(pool)
    .await
    .map(|result| result.rows_affected() > 0)
    .map_err(|err| format!("download cache: mark work running: {err}"))
}

async fn update_work_progress(
    pool: &SqlitePool,
    work_id: &str,
    completed: i64,
    failed: i64,
) -> Result<(), String> {
    sqlx::query(
        r#"
        UPDATE download_cache_work
        SET completed = ?2,
            failed = ?3,
            updated_at_ms = ?4
        WHERE id = ?1
        "#,
    )
    .bind(work_id)
    .bind(completed)
    .bind(failed)
    .bind(now_ms())
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|err| format!("download cache: update work progress: {err}"))
}

async fn finish_work(
    pool: &SqlitePool,
    work_id: &str,
    status: &str,
    completed: i64,
    failed: i64,
    error: Option<&str>,
) -> Result<(), String> {
    let now = now_ms();
    sqlx::query(
        r#"
        UPDATE download_cache_work
        SET
          status = ?2,
          completed = ?3,
          failed = ?4,
          error = ?5,
          finished_at_ms = ?6,
          updated_at_ms = ?6
        WHERE id = ?1
        "#,
    )
    .bind(work_id)
    .bind(status)
    .bind(completed)
    .bind(failed)
    .bind(error)
    .bind(now)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|err| format!("download cache: finish work: {err}"))
}

async fn cancel_requested(pool: &SqlitePool, work_id: &str) -> Result<bool, String> {
    let row = sqlx::query("SELECT cancel_requested FROM download_cache_work WHERE id = ?1")
        .bind(work_id)
        .fetch_optional(pool)
        .await
        .map_err(|err| format!("download cache: read cancel flag: {err}"))?;
    Ok(row
        .and_then(|row| row.try_get::<i64, _>("cancel_requested").ok())
        .unwrap_or(0)
        == 1)
}

async fn mark_chapters_deleted(pool: &SqlitePool, chapter_ids: &[i64]) -> Result<i64, String> {
    if chapter_ids.is_empty() {
        return Ok(0);
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        r#"
        UPDATE chapter
        SET
          content_bytes = 0,
          media_bytes = 0,
          media_repair_needed = 0,
          media_bytes_checked_at = NULL,
          is_downloaded = 0,
          updated_at = unixepoch()
        WHERE id IN (
        "#,
    );
    let mut separated = query.separated(", ");
    for chapter_id in chapter_ids {
        separated.push_bind(*chapter_id);
    }
    separated.push_unseparated(")");

    query
        .build()
        .execute(pool)
        .await
        .map(|result| result.rows_affected().min(i64::MAX as u64) as i64)
        .map_err(|err| format!("download cache: mark chapters deleted: {err}"))
}

async fn clear_artifact_batch<R: Runtime>(
    app: AppHandle<R>,
    rows: Vec<DownloadCacheChapterRow>,
) -> Result<(Vec<i64>, Vec<String>), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut deleted = Vec::new();
        let mut errors = Vec::new();
        for row in rows {
            let context = ChapterMediaClearContext {
                chapter_id: row.chapter_id,
                novel_id: Some(row.novel_id),
                source_id: Some(row.source_id),
                novel_name: Some(row.novel_name),
                novel_path: Some(row.novel_path),
                chapter_number: row.chapter_number,
                chapter_name: Some(row.chapter_name),
                chapter_position: Some(row.chapter_position),
            };
            match clear_downloaded_chapter_artifacts(&app, &context) {
                Ok(()) => deleted.push(row.chapter_id),
                Err(error) => errors.push(format!("chapter {}: {error}", row.chapter_id)),
            }
        }
        (deleted, errors)
    })
    .await
    .map_err(|err| format!("download cache: artifact worker: {err}"))
}

fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    work_id: &str,
    status: &str,
    total: i64,
    completed: i64,
    failed: i64,
    error: Option<String>,
) {
    let event = DownloadCacheDeleteProgressEvent {
        work_id: work_id.to_string(),
        status: status.to_string(),
        total,
        completed,
        failed,
        error,
    };
    if let Err(err) = app.emit(DOWNLOAD_CACHE_DELETE_PROGRESS_EVENT, event) {
        log::warn!("[download-cache] failed to emit delete progress: {err}");
    }
}

#[tauri::command]
pub async fn download_cache_delete_work_enqueue(
    db_instances: State<'_, DbInstances>,
    request: DownloadCacheDeleteWorkRequest,
) -> Result<DownloadCacheDeleteWork, String> {
    let work_id = request.id.trim().to_string();
    if work_id.is_empty() {
        return Err("download cache: delete work id is empty".to_string());
    }
    let scope = request.scope.trim().to_string();
    let target_ids = normalize_target_ids(&scope, request.target_ids)?;
    let target_ids_json = serde_json::to_string(&target_ids)
        .map_err(|err| format!("download cache: serialize target ids: {err}"))?;
    let pool = app_db_pool(db_instances.inner()).await?;
    ensure_work_schema(&pool).await?;
    let now = now_ms();

    sqlx::query(
        r#"
        INSERT INTO download_cache_work (
          id,
          scope,
          target_ids_json,
          title,
          status,
          total,
          completed,
          failed,
          error,
          cancel_requested,
          created_at_ms,
          updated_at_ms,
          started_at_ms,
          finished_at_ms
        )
        VALUES (?1, ?2, ?3, ?4, 'queued', 0, 0, 0, NULL, 0, ?5, ?5, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          scope = excluded.scope,
          target_ids_json = excluded.target_ids_json,
          title = excluded.title,
          status = 'queued',
          total = 0,
          completed = 0,
          failed = 0,
          error = NULL,
          cancel_requested = 0,
          updated_at_ms = excluded.updated_at_ms,
          started_at_ms = NULL,
          finished_at_ms = NULL
        "#,
    )
    .bind(&work_id)
    .bind(&scope)
    .bind(target_ids_json)
    .bind(request.title)
    .bind(now)
    .execute(&pool)
    .await
    .map_err(|err| format!("download cache: enqueue delete work: {err}"))?;

    get_work(&pool, &work_id).await
}

#[tauri::command]
pub async fn download_cache_delete_work_list_resumable(
    db_instances: State<'_, DbInstances>,
) -> Result<Vec<DownloadCacheDeleteWork>, String> {
    let pool = app_db_pool(db_instances.inner()).await?;
    ensure_work_schema(&pool).await?;
    let rows = sqlx::query(
        r#"
        SELECT
          id,
          scope,
          target_ids_json,
          title,
          status,
          total,
          completed,
          failed,
          error,
          cancel_requested,
          created_at_ms,
          updated_at_ms,
          started_at_ms,
          finished_at_ms
        FROM download_cache_work
        WHERE status IN ('queued', 'running')
        ORDER BY created_at_ms, id
        "#,
    )
    .fetch_all(&pool)
    .await
    .map_err(|err| format!("download cache: list resumable work: {err}"))?;

    rows.into_iter().map(work_from_row).collect()
}

#[tauri::command]
pub async fn download_cache_delete_work_cancel(
    db_instances: State<'_, DbInstances>,
    work_id: String,
) -> Result<(), String> {
    let pool = app_db_pool(db_instances.inner()).await?;
    ensure_work_schema(&pool).await?;
    sqlx::query(
        r#"
        UPDATE download_cache_work
        SET
          cancel_requested = 1,
          status = 'cancelled',
          finished_at_ms = ?2,
          updated_at_ms = ?2
        WHERE id = ?1
          AND status IN ('queued', 'running')
        "#,
    )
    .bind(work_id.trim())
    .bind(now_ms())
    .execute(&pool)
    .await
    .map(|_| ())
    .map_err(|err| format!("download cache: cancel delete work: {err}"))
}

#[tauri::command]
pub async fn download_cache_delete_work_run(
    app: AppHandle,
    db_instances: State<'_, DbInstances>,
    work_id: String,
    clear_files: bool,
) -> Result<DownloadCacheDeleteResult, String> {
    run_download_cache_delete_work(app, db_instances, work_id, clear_files).await
}

async fn run_download_cache_delete_work<R: Runtime>(
    app: AppHandle<R>,
    db_instances: State<'_, DbInstances>,
    work_id: String,
    clear_files: bool,
) -> Result<DownloadCacheDeleteResult, String> {
    let pool = app_db_pool(db_instances.inner()).await?;
    ensure_work_schema(&pool).await?;
    let work = get_work(&pool, work_id.trim()).await?;
    if work.status == "cancelled" {
        return Ok(DownloadCacheDeleteResult {
            work_id: work.id,
            total: work.total,
            deleted: work.completed.saturating_sub(work.failed),
            failed: work.failed,
            cancelled: true,
        });
    }

    let rows = select_target_chapters(&pool, &work).await?;
    let total = rows.len().min(i64::MAX as usize) as i64;
    if !mark_work_running(&pool, &work.id, total).await? {
        let current = get_work(&pool, &work.id).await?;
        if current.status == "cancelled" || current.cancel_requested {
            return Ok(DownloadCacheDeleteResult {
                work_id: current.id,
                total: current.total,
                deleted: current.completed.saturating_sub(current.failed),
                failed: current.failed,
                cancelled: true,
            });
        }
        return Err("download cache: delete work is not runnable".to_string());
    }
    emit_progress(&app, &work.id, "running", total, 0, 0, None);

    let mut completed = 0_i64;
    let mut deleted = 0_i64;
    let mut failed = 0_i64;
    let mut failures: Vec<String> = Vec::new();

    for batch in rows.chunks(DELETE_BATCH_SIZE) {
        if cancel_requested(&pool, &work.id).await? {
            finish_work(&pool, &work.id, "cancelled", completed, failed, None).await?;
            emit_progress(&app, &work.id, "cancelled", total, completed, failed, None);
            return Ok(DownloadCacheDeleteResult {
                work_id: work.id,
                total,
                deleted,
                failed,
                cancelled: true,
            });
        }

        let successful_ids = if clear_files {
            match clear_artifact_batch(app.clone(), batch.to_vec()).await {
                Ok((ids, errors)) => {
                    failures.extend(errors);
                    ids
                }
                Err(error) => {
                    failures.push(error);
                    Vec::new()
                }
            }
        } else {
            batch.iter().map(|row| row.chapter_id).collect()
        };

        if !successful_ids.is_empty() {
            deleted += mark_chapters_deleted(&pool, &successful_ids).await?;
        }
        completed += batch.len().min(i64::MAX as usize) as i64;
        failed += (batch.len().saturating_sub(successful_ids.len())).min(i64::MAX as usize) as i64;
        update_work_progress(&pool, &work.id, completed, failed).await?;
        emit_progress(&app, &work.id, "running", total, completed, failed, None);
    }

    let status = if failed > 0 { "failed" } else { "succeeded" };
    let error = if failures.is_empty() {
        None
    } else {
        Some(failures.join("; "))
    };
    finish_work(&pool, &work.id, status, completed, failed, error.as_deref()).await?;
    emit_progress(&app, &work.id, status, total, completed, failed, error);

    if failed > 0 {
        return Err(format!(
            "download cache: failed to delete {failed} chapters"
        ));
    }

    Ok(DownloadCacheDeleteResult {
        work_id: work.id,
        total,
        deleted,
        failed,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::{
        collections::HashMap,
        env,
        ffi::OsString,
        fs,
        path::{Path, PathBuf},
    };

    use sqlx::sqlite::SqlitePoolOptions;
    use tauri::Manager;

    struct EnvGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvGuard {
        fn set_path(key: &'static str, value: &Path) -> Self {
            let previous = env::var_os(key);
            env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => env::set_var(self.key, value),
                None => env::remove_var(self.key),
            }
        }
    }

    async fn create_fixture_schema(pool: &SqlitePool) {
        sqlx::query(
            r#"
            CREATE TABLE novel (
              id integer PRIMARY KEY NOT NULL,
              plugin_id text NOT NULL,
              path text NOT NULL,
              name text NOT NULL,
              is_local integer DEFAULT 0 NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("create novel table");

        sqlx::query(
            r#"
            CREATE TABLE chapter (
              id integer PRIMARY KEY NOT NULL,
              novel_id integer NOT NULL,
              chapter_number text,
              name text NOT NULL,
              position integer NOT NULL,
              is_downloaded integer DEFAULT 0 NOT NULL,
              content_bytes integer DEFAULT 0 NOT NULL,
              media_bytes integer DEFAULT 0 NOT NULL,
              media_repair_needed integer DEFAULT 0 NOT NULL,
              media_bytes_checked_at integer,
              updated_at integer DEFAULT (unixepoch()) NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .expect("create chapter table");
    }

    async fn seed_downloaded_novel(pool: &SqlitePool, chapter_count: i64) {
        sqlx::query(
            r#"
            INSERT INTO novel (id, plugin_id, path, name, is_local)
            VALUES (7, 'fixture-source', 'fixture/novel', 'Fixture Novel', 0)
            "#,
        )
        .execute(pool)
        .await
        .expect("insert novel");

        for chapter_id in 1..=chapter_count {
            sqlx::query(
                r#"
                INSERT INTO chapter (
                  id,
                  novel_id,
                  chapter_number,
                  name,
                  position,
                  is_downloaded,
                  content_bytes,
                  media_bytes,
                  media_repair_needed,
                  media_bytes_checked_at
                )
                VALUES (?1, 7, ?2, ?3, ?1, 1, 100, 200, 1, 1234)
                "#,
            )
            .bind(chapter_id)
            .bind(chapter_id.to_string())
            .bind(format!("Chapter {chapter_id}"))
            .execute(pool)
            .await
            .expect("insert chapter");
        }
    }

    fn content_chapter_dir(media_root: &Path, chapter_id: i64) -> PathBuf {
        media_root
            .join("contents")
            .join("fixture-source")
            .join("Fixture-Novel-fixture-novel")
            .join(format!("{chapter_id}-Chapter-{chapter_id}"))
    }

    fn seed_cache_files(media_root: &Path, chapter_count: i64) -> (PathBuf, PathBuf) {
        let first_legacy_file = media_root.join("1").join("media").join("page.bin");
        let first_content_file = content_chapter_dir(media_root, 1).join("content.html");

        for chapter_id in 1..=chapter_count {
            let legacy_media_dir = media_root.join(chapter_id.to_string()).join("media");
            fs::create_dir_all(&legacy_media_dir).expect("create legacy media dir");
            fs::write(legacy_media_dir.join("page.bin"), [1, 2, 3]).expect("write legacy media");

            let content_dir = content_chapter_dir(media_root, chapter_id);
            fs::create_dir_all(content_dir.join("media")).expect("create content media dir");
            fs::write(content_dir.join("content.html"), "<p>cached</p>")
                .expect("write content mirror");
            fs::write(content_dir.join("media").join("page.bin"), [4, 5, 6])
                .expect("write content media");
        }

        (first_legacy_file, first_content_file)
    }

    #[test]
    fn delete_work_run_clears_bulk_novel_cache_end_to_end() {
        tauri::async_runtime::block_on(async {
            let temp = tempfile::tempdir().expect("tempdir");
            let _data_guard = EnvGuard::set_path("XDG_DATA_HOME", &temp.path().join("data"));
            let _config_guard = EnvGuard::set_path("XDG_CONFIG_HOME", &temp.path().join("config"));
            let _cache_guard = EnvGuard::set_path("XDG_CACHE_HOME", &temp.path().join("cache"));

            let app = tauri::test::mock_app();
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .expect("open in-memory db");
            create_fixture_schema(&pool).await;
            seed_downloaded_novel(&pool, 120).await;
            sqlx::query(
                r#"
                UPDATE chapter
                SET is_downloaded = 0
                WHERE id = 120
                "#,
            )
            .execute(&pool)
            .await
            .expect("mark chapter as not downloaded");

            let mut dbs = HashMap::new();
            dbs.insert(DB_URL.to_string(), DbPool::Sqlite(pool.clone()));
            app.manage(DbInstances(tokio::sync::RwLock::new(dbs)));

            let media_root = app
                .path()
                .app_data_dir()
                .expect("app data dir")
                .join("chapter-media");
            let (legacy_file, content_file) = seed_cache_files(&media_root, 120);
            assert!(legacy_file.exists(), "fixture legacy cache should exist");
            assert!(content_file.exists(), "fixture content mirror should exist");

            let work = download_cache_delete_work_enqueue(
                app.state::<DbInstances>(),
                DownloadCacheDeleteWorkRequest {
                    id: "e2e-delete-novel".to_string(),
                    scope: "novel".to_string(),
                    target_ids: vec![7],
                    title: Some("Fixture Novel".to_string()),
                },
            )
            .await
            .expect("enqueue delete work");

            let result = run_download_cache_delete_work(
                app.handle().clone(),
                app.state::<DbInstances>(),
                work.id.clone(),
                true,
            )
            .await
            .expect("run delete work");

            assert_eq!(result.total, 120);
            assert_eq!(result.deleted, 120);
            assert_eq!(result.failed, 0);
            assert!(!result.cancelled);
            assert!(!legacy_file.exists(), "legacy cache file should be removed");
            assert!(!content_file.exists(), "content mirror should be removed");

            let downloaded_count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM chapter WHERE is_downloaded = 1")
                    .fetch_one(&pool)
                    .await
                    .expect("count downloaded chapters");
            assert_eq!(downloaded_count, 0);

            let total_content_bytes: i64 =
                sqlx::query_scalar("SELECT sum(content_bytes) FROM chapter")
                    .fetch_one(&pool)
                    .await
                    .expect("sum content bytes");
            let total_media_bytes: i64 = sqlx::query_scalar("SELECT sum(media_bytes) FROM chapter")
                .fetch_one(&pool)
                .await
                .expect("sum media bytes");
            let repair_count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM chapter WHERE media_repair_needed = 1")
                    .fetch_one(&pool)
                    .await
                    .expect("count repair flags");
            assert_eq!(total_content_bytes, 0);
            assert_eq!(total_media_bytes, 0);
            assert_eq!(repair_count, 0);

            let completed_work = get_work(&pool, "e2e-delete-novel")
                .await
                .expect("load completed work");
            assert_eq!(completed_work.status, "succeeded");
            assert_eq!(completed_work.total, 120);
            assert_eq!(completed_work.completed, 120);
            assert_eq!(completed_work.failed, 0);
            assert!(completed_work.finished_at_ms.is_some());
        });
    }
}
