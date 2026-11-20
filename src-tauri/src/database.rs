use std::{
    borrow::Cow,
    ffi::OsString,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};

use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Manager};

const DB_FILE: &str = "norea.db";
const DB_BUSY_TIMEOUT_MS: u64 = 5000;

#[derive(Debug, Clone, Copy)]
pub struct SchemaMigration {
    pub version: i64,
    pub description: &'static str,
    pub sql: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqliteReclaimStats {
    pub auto_vacuum_mode: i64,
    pub freelist_before: i64,
    pub freelist_after: i64,
    pub wal_checkpoint_busy: i64,
    pub wal_log_frames: i64,
    pub wal_checkpointed_frames: i64,
}

#[derive(Clone)]
pub struct AppDatabase {
    writer: SqlitePool,
    reader: SqlitePool,
}

impl AppDatabase {
    pub fn from_pools(writer: SqlitePool, reader: SqlitePool) -> Self {
        Self { writer, reader }
    }

    #[cfg(test)]
    pub fn from_single_pool(pool: SqlitePool) -> Self {
        Self {
            writer: pool.clone(),
            reader: pool,
        }
    }

    pub fn writer(&self) -> &SqlitePool {
        &self.writer
    }

    pub fn reader(&self) -> &SqlitePool {
        &self.reader
    }

    pub fn pool_for(&self, read_mode: crate::db::ReadMode) -> &SqlitePool {
        match read_mode {
            crate::db::ReadMode::Queued => &self.writer,
            crate::db::ReadMode::Committed => &self.reader,
        }
    }

    pub async fn close(&self) {
        self.reader.close().await;
        self.writer.close().await;
    }

    /// Reclaims freed pages and truncates WAL frames using the writer pool; must be called outside any write transaction.
    pub async fn reclaim_space(&self, max_pages: Option<u32>) -> Result<SqliteReclaimStats, String> {
        let mut conn = self
            .writer
            .acquire()
            .await
            .map_err(|err| format!("database: acquire writer for space reclaim: {err}"))?;
        let auto_vacuum_mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("database: read auto_vacuum mode: {err}"))?;
        let freelist_before: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("database: read freelist_count before reclaim: {err}"))?;
        if auto_vacuum_mode == 2 && freelist_before > 0 {
            match max_pages {
                None => {
                    sqlx::query("PRAGMA incremental_vacuum")
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("database: run incremental_vacuum: {err}"))?;
                }
                Some(0) => {}
                Some(pages) => {
                    let pragma = format!("PRAGMA incremental_vacuum({pages})");
                    sqlx::query(&pragma)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("database: run incremental_vacuum({pages}): {err}"))?;
                }
            }
        }
        let freelist_after: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("database: read freelist_count after reclaim: {err}"))?;
        let row = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("database: run wal_checkpoint(TRUNCATE): {err}"))?;
        let wal_checkpoint_busy: i64 = row
            .try_get(0)
            .map_err(|err| format!("database: read wal_checkpoint busy column: {err}"))?;
        let wal_log_frames: i64 = row
            .try_get(1)
            .map_err(|err| format!("database: read wal_checkpoint log column: {err}"))?;
        let wal_checkpointed_frames: i64 = row
            .try_get(2)
            .map_err(|err| format!("database: read wal_checkpoint checkpointed column: {err}"))?;
        Ok(SqliteReclaimStats {
            auto_vacuum_mode,
            freelist_before,
            freelist_after,
            wal_checkpoint_busy,
            wal_log_frames,
            wal_checkpointed_frames,
        })
    }
}

fn sqlite_pool_options() -> SqlitePoolOptions {
    SqlitePoolOptions::new()
        .max_connections(1)
        .max_lifetime(None)
        .idle_timeout(None)
}

fn run_async_command<F: std::future::Future>(command: F) -> F::Output {
    if tokio::runtime::Handle::try_current().is_ok() {
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(command))
    } else {
        tauri::async_runtime::block_on(command)
    }
}

pub fn schema_migrations() -> Vec<SchemaMigration> {
    vec![
        SchemaMigration {
            version: 1,
            description: "create current application schema",
            sql: include_str!("schema.sql"),
        },
        SchemaMigration {
            version: 2,
            description: "persist immutable VPN download plans",
            sql: include_str!("migrations/0002_vpn_download_plans.sql"),
        },
        SchemaMigration {
            version: 3,
            description: "persist batch-wide VPN profile exclusions",
            sql: include_str!("migrations/0003_vpn_download_profile_issues.sql"),
        },
        SchemaMigration {
            version: 4,
            description: "persist chapter download failures and retry budgets",
            sql: include_str!("migrations/0004_chapter_download_failures.sql"),
        },
        SchemaMigration {
            version: 5,
            description: "persist novel download goals",
            sql: include_str!("migrations/0005_novel_download_goals.sql"),
        },
        SchemaMigration {
            version: 6,
            description: "allow an explicit no-download goal and persist goal exclusions",
            sql: include_str!("migrations/0006_download_goal_opt_out.sql"),
        },
        SchemaMigration {
            version: 7,
            description: "record novel freshness and chapters found by checks",
            sql: include_str!("migrations/0007_novel_freshness.sql"),
        },
        SchemaMigration {
            version: 8,
            description: "allow several plugin repositories and record plugin publishers",
            sql: include_str!("migrations/0008_plugin_repositories.sql"),
        },
        SchemaMigration {
            version: 9,
            description: "record VPN download page timeouts and site refusals as profile problems",
            sql: include_str!("migrations/0009_vpn_profile_issue_page_causes.sql"),
        },
        SchemaMigration {
            version: 10,
            description: "preserve source chapter provenance and user composition",
            sql: include_str!("migrations/0010_novel_chapter_composition.sql"),
        },
        SchemaMigration {
            version: 11,
            description: "persist cross-device personal state intents and receipts",
            sql: include_str!("migrations/0011_user_state_journal.sql"),
        },
        SchemaMigration {
            version: 12,
            description: "journal chapter path rewrites and incomplete media bodies for content sync",
            sql: include_str!("migrations/0012_content_sync_journal_triggers.sql"),
        },
        SchemaMigration {
            version: 13,
            description: "keep user-set work metadata apart from source metadata",
            sql: include_str!("migrations/0013_novel_override.sql"),
        },
        SchemaMigration {
            version: 14,
            description: "upgrade legacy completed work overrides to canonical status",
            sql: include_str!("migrations/0014_novel_override_status.sql"),
        },
        SchemaMigration {
            version: 15,
            description: "track acknowledged user-state operation timestamps for retention",
            sql: include_str!("migrations/0015_user_state_retention.sql"),
        },
        SchemaMigration {
            version: 16,
            description: "track workspace seed suppression and retention cutoff",
            sql: include_str!("migrations/0016_user_state_epoch_retention.sql"),
        },
        SchemaMigration {
            version: 17,
            description: "unify chapter reading state on progress and remove unread columns",
            sql: include_str!("migrations/0017_single_progress_model.sql"),
        },
        SchemaMigration {
            version: 18,
            description: "index user-state operations by namespace, status, and entity key",
            sql: include_str!("migrations/0018_user_state_operation_pending_entity_index.sql"),
        },
    ]
}

pub fn sqlx_migrations() -> Vec<SqlxMigration> {
    schema_migrations()
        .into_iter()
        .map(|migration| {
            SqlxMigration::new(
                migration.version,
                migration.description.into(),
                MigrationType::ReversibleUp,
                migration.sql.into(),
                false,
            )
        })
        .collect()
}

#[cfg(test)]
async fn open_sqlite_pools(path: &Path) -> Result<(SqlitePool, SqlitePool), sqlx::Error> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS));
    let writer = sqlite_pool_options().connect_with(options.clone()).await?;
    let reader = SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(options.read_only(true))
        .await?;
    Ok((writer, reader))
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut os = OsString::from(path.as_os_str());
    os.push(suffix);
    PathBuf::from(os)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("database: remove {}: {err}", path.display())),
    }
}

fn remove_sqlite_files_if_exists(path: &Path) -> Result<(), String> {
    remove_file_if_exists(path)?;
    remove_file_if_exists(&sqlite_sidecar_path(path, "-wal"))?;
    remove_file_if_exists(&sqlite_sidecar_path(path, "-shm"))?;
    Ok(())
}

fn recover_interrupted_auto_vacuum_swap(path: &Path) -> Result<(), String> {
    let tmp_path = sqlite_sidecar_path(path, ".auto-vacuum.tmp");
    let bak_path = sqlite_sidecar_path(path, ".auto-vacuum.bak");
    remove_sqlite_files_if_exists(&tmp_path)?;
    if !path.exists() && bak_path.exists() {
        let _ = remove_file_if_exists(&sqlite_sidecar_path(path, "-wal"));
        let _ = remove_file_if_exists(&sqlite_sidecar_path(path, "-shm"));
        fs::rename(&bak_path, path)
            .map_err(|err| format!("database: restore interrupted auto_vacuum backup: {err}"))?;
    } else if path.exists() && bak_path.exists() {
        remove_sqlite_files_if_exists(&bak_path)?;
    }
    Ok(())
}

fn writer_connect_options(path: &Path, create_if_missing: bool) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(create_if_missing)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS))
}

async fn verify_vacuumed_incremental_database(path: &Path) -> Result<(), String> {
    let verify_pool = sqlite_pool_options()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false)
                .read_only(true),
        )
        .await
        .map_err(|err| format!("database: open vacuumed copy for verification: {err}"))?;
    let verify_result = async {
        let mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&verify_pool)
            .await
            .map_err(|err| format!("database: read vacuumed auto_vacuum mode: {err}"))?;
        if mode != 2 {
            return Err(format!(
                "database: vacuumed copy has auto_vacuum mode {mode}, expected 2"
            ));
        }
        let check: String = sqlx::query_scalar("PRAGMA quick_check")
            .fetch_one(&verify_pool)
            .await
            .map_err(|err| format!("database: quick_check vacuumed copy: {err}"))?;
        if check != "ok" {
            return Err(format!(
                "database: vacuumed copy failed quick_check: {check}"
            ));
        }
        Ok(())
    }
    .await;
    verify_pool.close().await;
    verify_result
}

async fn ensure_incremental_auto_vacuum(
    path: &Path,
    writer: SqlitePool,
    allow_rebuild: bool,
) -> Result<SqlitePool, String> {
    let mut conn = match writer.acquire().await {
        Ok(conn) => conn,
        Err(err) => {
            writer.close().await;
            return Err(format!("database: acquire writer for auto_vacuum: {err}"));
        }
    };
    let mode: i64 = match sqlx::query_scalar("PRAGMA auto_vacuum")
        .fetch_one(&mut *conn)
        .await
    {
        Ok(mode) => mode,
        Err(err) => {
            drop(conn);
            writer.close().await;
            return Err(format!("database: read auto_vacuum mode: {err}"));
        }
    };
    if mode == 2 {
        return Ok(writer);
    }
    if let Err(err) = sqlx::query("PRAGMA auto_vacuum = INCREMENTAL")
        .execute(&mut *conn)
        .await
    {
        drop(conn);
        writer.close().await;
        return Err(format!("database: set auto_vacuum incremental: {err}"));
    }
    let updated_mode: i64 = match sqlx::query_scalar("PRAGMA auto_vacuum")
        .fetch_one(&mut *conn)
        .await
    {
        Ok(mode) => mode,
        Err(err) => {
            drop(conn);
            writer.close().await;
            return Err(format!("database: verify auto_vacuum mode: {err}"));
        }
    };
    if updated_mode == 2 || !allow_rebuild {
        return Ok(writer);
    }

    // Android's bundled SQLite compiles with SQLITE_TEMP_STORE=3 (always memory),
    // so an in-place VACUUM copies the entire database into RAM and hits Scudo OOM
    // on large user databases. VACUUM INTO streams directly to disk with cache spill
    // while applying the pending PRAGMA auto_vacuum = INCREMENTAL setting.
    let tmp_path = sqlite_sidecar_path(path, ".auto-vacuum.tmp");
    let bak_path = sqlite_sidecar_path(path, ".auto-vacuum.bak");
    if let Err(err) = remove_sqlite_files_if_exists(&tmp_path) {
        drop(conn);
        writer.close().await;
        return Err(err);
    }
    let tmp_path_str = match tmp_path.to_str() {
        Some(value) => value.to_owned(),
        None => {
            drop(conn);
            writer.close().await;
            return Err("database: non-UTF-8 path for auto_vacuum staging file".into());
        }
    };
    if let Err(err) = sqlx::query("VACUUM INTO ?")
        .bind(&tmp_path_str)
        .execute(&mut *conn)
        .await
    {
        let _ = remove_sqlite_files_if_exists(&tmp_path);
        drop(conn);
        writer.close().await;
        return Err(format!(
            "database: vacuum into disk copy for auto_vacuum conversion: {err}"
        ));
    }
    if let Err(err) = verify_vacuumed_incremental_database(&tmp_path).await {
        let _ = remove_sqlite_files_if_exists(&tmp_path);
        drop(conn);
        writer.close().await;
        return Err(err);
    }
    if let Err(err) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&mut *conn)
        .await
    {
        let _ = remove_sqlite_files_if_exists(&tmp_path);
        drop(conn);
        writer.close().await;
        return Err(format!(
            "database: checkpoint before auto_vacuum swap: {err}"
        ));
    }
    drop(conn);
    writer.close().await;

    if let Err(err) = remove_sqlite_files_if_exists(&bak_path) {
        let _ = remove_sqlite_files_if_exists(&tmp_path);
        return Err(err);
    }
    if let Err(err) = fs::rename(path, &bak_path) {
        let _ = remove_sqlite_files_if_exists(&tmp_path);
        return Err(format!("database: stage original db before auto_vacuum swap: {err}"));
    }
    let _ = remove_file_if_exists(&sqlite_sidecar_path(path, "-wal"));
    let _ = remove_file_if_exists(&sqlite_sidecar_path(path, "-shm"));
    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::rename(&bak_path, path);
        let _ = remove_sqlite_files_if_exists(&tmp_path);
        return Err(format!("database: finalize auto_vacuum swap: {err}"));
    }
    let _ = remove_sqlite_files_if_exists(&bak_path);

    sqlite_pool_options()
        .connect_with(writer_connect_options(path, false))
        .await
        .map_err(|err| format!("database: reopen writer pool after auto_vacuum swap: {err}"))
}

pub async fn open_and_migrate_pools(path: &Path) -> Result<AppDatabase, String> {
    recover_interrupted_auto_vacuum_swap(path)?;

    let writer = sqlite_pool_options()
        .connect_with(writer_connect_options(path, true))
        .await
        .map_err(|err| format!("database: open writer pool: {err}"))?;

    let schema_objects = match sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sqlite_master")
        .fetch_one(&writer)
        .await
    {
        Ok(count) => count,
        Err(err) => {
            writer.close().await;
            return Err(format!("database: inspect schema objects: {err}"));
        }
    };
    let writer = if schema_objects == 0 {
        ensure_incremental_auto_vacuum(path, writer, false).await?
    } else {
        writer
    };

    let migrator = Migrator {
        migrations: Cow::Owned(sqlx_migrations()),
        ..Migrator::DEFAULT
    };
    if let Err(err) = migrator.run(&writer).await {
        writer.close().await;
        return Err(format!("database: run migrations: {err}"));
    }

    let writer = ensure_incremental_auto_vacuum(path, writer, true).await?;

    let reader_options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .read_only(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS));
    let reader = match SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(reader_options)
        .await
    {
        Ok(pool) => pool,
        Err(err) => {
            writer.close().await;
            return Err(format!("database: open reader pool: {err}"));
        }
    };

    Ok(AppDatabase::from_pools(writer, reader))
}

pub fn install_sqlite_pools(app: &AppHandle) -> Result<(), String> {
    run_async_command(async move {
        let db_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| format!("database: app config dir: {err}"))?;
        fs::create_dir_all(&db_dir).map_err(|err| format!("database: create db dir: {err}"))?;

        let pools = open_and_migrate_pools(&db_dir.join(DB_FILE)).await?;
        app.manage(pools);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(sql: &str) -> SqlxMigration {
        SqlxMigration::new(
            1,
            "fixture".into(),
            MigrationType::ReversibleUp,
            sql.to_owned().into(),
            false,
        )
    }

    async fn bootstrap(path: &std::path::Path, expected: &[SqlxMigration]) -> Result<sqlx::SqlitePool, sqlx::migrate::MigrateError> {
        let pool = sqlite_pool_options()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await?;
        let migration = Migrator {
            migrations: Cow::Owned(expected.to_vec()),
            ..Migrator::DEFAULT
        }
        .run(&pool)
        .await;
        if let Err(error) = migration {
            pool.close().await;
            return Err(error);
        }
        Ok(pool)
    }

    const CURRENT: &str = "CREATE TABLE sample (value INTEGER);";

    #[tokio::test]
    async fn registered_v2_upgrade_preserves_vpn_jobs_and_batch_issue_history_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..2]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'source','/work','Work')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position) VALUES(1,1,'/chapter','Chapter',1)").execute(&pool).await.unwrap();
        let payload = r#"{"id":"plan","revision":3,"ranges":[{"checkpoint":1,"attemptedProfileIds":["failed"],"userPaused":true}]}"#;
        let job = r#"{"id":1,"vpnPlanId":"plan","batchId":"shared-batch"}"#;
        sqlx::query("INSERT INTO vpn_download_plan VALUES('plan',?1,3)").bind(payload).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_queue VALUES(1,?1,10,20,30,4)").bind(job).execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        let migrated: String = sqlx::query_scalar("SELECT payload FROM vpn_download_plan").fetch_one(&pool).await.unwrap();
        let mut expected: serde_json::Value = serde_json::from_str(payload).unwrap();
        expected["batchId"] = "shared-batch".into();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&migrated).unwrap(), expected);
        assert_eq!(sqlx::query_as::<_, (String, i64, i64, Option<i64>, i64)>(
            "SELECT job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue")
            .fetch_one(&pool).await.unwrap(), (job.into(),10,20,Some(30),4));
        sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('shared-batch','192.0.2.1','failed','hash','plan','range',4,'captcha',100,1,1)")
            .execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (String, i64, i64)>("SELECT cause,excluded,revision FROM vpn_download_profile_issue")
            .fetch_one(&pool).await.unwrap(), ("captcha".into(),1,1));
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v8_upgrade_keeps_vpn_profile_issues_and_accepts_page_causes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..8]).await.unwrap();
        sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('batch','192.0.2.1','profile','hash','plan','range',4,'tunnel-lost',100,0,3)")
            .execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (String, String, String, String, String, String, i64, String, i64, i64, i64)>(
            "SELECT * FROM vpn_download_profile_issue").fetch_one(&pool).await.unwrap(),
            ("batch".into(), "192.0.2.1".into(), "profile".into(), "hash".into(), "plan".into(), "range".into(), 4, "tunnel-lost".into(), 100, 0, 3));
        for (ip, cause) in [("192.0.2.2", "page-unresponsive"), ("192.0.2.3", "site-forbidden")] {
            sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('batch',?1,'profile','hash','plan','range',4,?2,200,1,1)")
                .bind(ip).bind(cause).execute(&pool).await.unwrap();
        }
        assert!(sqlx::query("INSERT INTO vpn_download_profile_issue VALUES('batch','192.0.2.4','profile','hash','plan','range',4,'unknown',200,1,1)")
            .execute(&pool).await.is_err());
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM vpn_download_profile_issue").fetch_one(&pool).await.unwrap(), 3);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v3_upgrade_preserves_queue_and_plans_and_tracks_failures_per_chapter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..3]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40),(2,1,'/two','Two',2,0)")
            .execute(&pool).await.unwrap();
        let job = r#"{"id":1,"pluginId":"source","chapterPath":"/one","title":"One"}"#;
        sqlx::query("INSERT INTO chapter_download_queue VALUES(1,?1,10,20,NULL,0)").bind(job).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO vpn_download_plan VALUES('plan','{\"batchId\":\"batch\"}',2)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (String, i64)>("SELECT job_json,attempt_count FROM chapter_download_queue")
                .fetch_one(&pool).await.unwrap(), (job.into(), 0));
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id=1").fetch_one(&pool).await.unwrap(), 40);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT revision FROM vpn_download_plan").fetch_one(&pool).await.unwrap(), 2);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_failure VALUES(2,'source','transient','Timed out',NULL,1,30000,'{}',10)")
            .execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO chapter_download_failure VALUES(1,'source','unknown','x',NULL,1,NULL,'{}',10)")
            .execute(&pool).await.is_err());
        assert!(sqlx::query("INSERT INTO chapter_download_failure VALUES(99,'source','content','x',NULL,1,NULL,'{}',10)")
            .execute(&pool).await.is_err());
        sqlx::query("DELETE FROM chapter WHERE id=2").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM chapter_download_failure").fetch_one(&pool).await.unwrap(), 0);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v4_upgrade_preserves_failures_and_stores_one_goal_per_novel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..4]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter_download_failure VALUES(1,'source','transient','Timed out',NULL,2,500,'{}',10)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, i64)>("SELECT progress,(SELECT attempts FROM chapter_download_failure) FROM chapter")
                .fetch_one(&pool).await.unwrap(), (40, 2));
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'keep_ahead',3,10),(2,'entire',NULL,10)").execute(&pool).await.unwrap();
        for invalid in ["(1,'entire',NULL,11)", "(2,'keep_ahead',NULL,10)", "(2,'all_remaining',5,10)", "(2,'unknown',NULL,10)", "(99,'entire',NULL,10)"] {
            assert!(sqlx::query(&format!("INSERT INTO novel_download_goal VALUES{invalid}")).execute(&pool).await.is_err(), "{invalid}");
        }
        sqlx::query("DELETE FROM novel WHERE id=2").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, String, Option<i64>)>("SELECT novel_id,kind,count FROM novel_download_goal")
            .fetch_all(&pool).await.unwrap(), [(1, "keep_ahead".into(), Some(3))]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v5_upgrade_keeps_goals_and_allows_an_explicit_opt_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..5]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',1),(3,'source','/third','Third',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40),(2,2,'/two','Two',1,0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'keep_ahead',5,10),(2,'entire',NULL,20)").execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO novel_download_goal VALUES(3,'none',NULL,30)").execute(&pool).await.is_err());
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, Option<i64>, i64)>("SELECT novel_id,kind,count,updated_at FROM novel_download_goal ORDER BY novel_id")
                .fetch_all(&pool).await.unwrap(), [(1, "keep_ahead".into(), Some(5), 10), (2, "entire".into(), None, 20)]);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT progress FROM chapter WHERE id=1").fetch_one(&pool).await.unwrap(), 40);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(3,'none',NULL,30)").execute(&pool).await.unwrap();
        assert!(sqlx::query("UPDATE novel_download_goal SET count=2 WHERE novel_id=3").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE novel_download_goal SET kind='skip' WHERE novel_id=3").execute(&pool).await.is_err());
        sqlx::query("INSERT INTO chapter_download_goal_exclusion VALUES(1,50),(2,60)").execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO chapter_download_goal_exclusion VALUES(99,70)").execute(&pool).await.is_err());
        sqlx::query("DELETE FROM novel WHERE id IN (2,3)").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT chapter_id FROM chapter_download_goal_exclusion").fetch_all(&pool).await.unwrap(), [1]);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT novel_id FROM novel_download_goal").fetch_all(&pool).await.unwrap(), [1]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v6_upgrade_flags_no_existing_chapter_and_records_freshness_per_novel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..6]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Work',1),(2,'source','/other','Other',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress,found_at) VALUES(1,1,'/one','One',1,40,500),(2,2,'/two','Two',1,0,600)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'none',NULL,10)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, i64, i64, i64)>("SELECT id,progress,found_at,found_by_check FROM chapter ORDER BY id")
                .fetch_all(&pool).await.unwrap(), [(1, 40, 500, 0), (2, 0, 600, 0)]);
            assert_eq!(sqlx::query_scalar::<_, String>("SELECT kind FROM novel_download_goal").fetch_one(&pool).await.unwrap(), "none");
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,found_by_check) VALUES(3,1,'/three','Three',2,1)").execute(&pool).await.unwrap();
        assert!(sqlx::query("UPDATE chapter SET found_by_check=2 WHERE id=3").execute(&pool).await.is_err());
        sqlx::query("INSERT INTO novel_freshness(novel_id,last_checked_at,last_success_at) VALUES(1,100,100),(2,200,NULL)").execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO novel_freshness(novel_id) VALUES(99)").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE novel_freshness SET consecutive_failures=-1 WHERE novel_id=2").execute(&pool).await.is_err());
        sqlx::query("DELETE FROM novel WHERE id=2").execute(&pool).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, i64)>("SELECT novel_id,consecutive_failures FROM novel_freshness").fetch_all(&pool).await.unwrap(), [(1, 0)]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v7_upgrade_keeps_the_repository_first_and_binds_publishers_by_source_url() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..7]).await.unwrap();
        sqlx::query("INSERT INTO repository(id,url,name,added_at) VALUES(1,'https://repo.test/plugins.json','Saved',50)")
            .execute(&pool).await.unwrap();
        sqlx::query(r#"INSERT INTO repository_index_cache(repo_url,items_json) VALUES('https://repo.test/plugins.json','[{"id":"bound","url":"https://repo.test/bound.js"},7,{"id":"github","url":"https://repo.test/github.js"},{"id":"moved","url":"https://repo.test/new-moved.js"}]')"#)
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO installed_plugin(id,name,lang,version,icon_url,source_url,source_code) VALUES
            ('bound','Bound','en','1','','https://repo.test/bound.js','a'),
            ('github:shelf','Shelf','en','1','','https://repo.test/github.js','b'),
            ('moved','Moved','en','1','','https://repo.test/old-moved.js','c'),
            ('local','Local','en','1','','local:local.js','d')")
            .execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, Option<String>, i64, i64, i64)>(
                "SELECT id,url,name,added_at,priority,enabled FROM repository").fetch_all(&pool).await.unwrap(),
                [(1, "https://repo.test/plugins.json".to_string(), Some("Saved".to_string()), 50, 1, 1)]);
            assert_eq!(sqlx::query_as::<_, (String, Option<String>, String)>(
                "SELECT id,repository_url,source_code FROM installed_plugin ORDER BY id").fetch_all(&pool).await.unwrap(), [
                ("bound".to_string(), Some("https://repo.test/plugins.json".to_string()), "a".to_string()),
                ("github:shelf".to_string(), Some("https://repo.test/plugins.json".to_string()), "b".to_string()),
                ("local".to_string(), None, "d".to_string()),
                ("moved".to_string(), None, "c".to_string()),
            ]);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO repository(url,priority,enabled) VALUES('https://second.test/plugins.json',2,0)")
            .execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO repository(url) VALUES('https://second.test/plugins.json')").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE repository SET enabled=2 WHERE id=1").execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE repository SET priority=0 WHERE id=1").execute(&pool).await.is_err());
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v12_upgrade_keeps_library_data_and_stores_one_override_per_novel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..12]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,status,in_library) VALUES(1,'source','work-1','/work','Work','Ongoing',1),(2,'source','work-2','/other','Other',NULL,1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,progress) VALUES(1,1,'/one','One',1,40)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO novel_download_goal VALUES(1,'keep_ahead',3,10)").execute(&pool).await.unwrap();
        sqlx::query(r#"INSERT INTO novel_chapter_composition VALUES(1,'{"version":1,"updatedAt":5,"entries":[]}')"#).execute(&pool).await.unwrap();
        assert!(sqlx::query("SELECT 1 FROM novel_override").fetch_optional(&pool).await.is_err());
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, Option<String>, i64)>("SELECT id,name,status,in_library FROM novel ORDER BY id")
                .fetch_all(&pool).await.unwrap(), [(1, "Work".into(), Some("Ongoing".into()), 1), (2, "Other".into(), None, 1)]);
            assert_eq!(sqlx::query_as::<_, (i64, String, Option<i64>)>(
                "SELECT c.progress,g.kind,g.count FROM chapter c JOIN novel_download_goal g ON g.novel_id=c.novel_id")
                .fetch_one(&pool).await.unwrap(), (40, "keep_ahead".into(), Some(3)));
            assert_eq!(sqlx::query_scalar::<_, String>("SELECT payload FROM novel_chapter_composition").fetch_one(&pool).await.unwrap(),
                r#"{"version":1,"updatedAt":5,"entries":[]}"#);
            pool.close().await;
        }
        let pool = bootstrap(&path, &migrations).await.unwrap();
        let payload = r#"{"fields":{"completed":{"value":true,"updatedAt":1763350000000}}}"#;
        sqlx::query("INSERT INTO novel_override VALUES(1,?1),(2,?1)").bind(payload).execute(&pool).await.unwrap();
        assert!(sqlx::query("INSERT INTO novel_override VALUES(1,?1)").bind(payload).execute(&pool).await.is_err());
        assert!(sqlx::query("INSERT INTO novel_override VALUES(99,?1)").bind(payload).execute(&pool).await.is_err());
        assert!(sqlx::query("UPDATE novel_override SET payload=NULL WHERE novel_id=1").execute(&pool).await.is_err());
        sqlx::query("DELETE FROM novel WHERE id=2").execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, String)>("SELECT novel_id,payload FROM novel_override").fetch_all(&pool).await.unwrap(),
            [(1, payload.to_string())]);
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v13_upgrade_converts_completed_overrides_to_canonical_status() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..13]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,source_novel_id,path,name,status,in_library) VALUES(1,'source','work-1','/one','One','Ongoing',1),(2,'source','work-2','/two','Two','Completed',1),(3,'source','work-3','/three','Three','Completed',1),(4,'source','work-4','/four','Four','Ongoing',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO novel_override VALUES(1,?1),(2,?2),(3,?3),(4,?4)")
            .bind(r#"{"fields":{"completed":{"value":true,"updatedAt":100},"note":{"value":"kept","updatedAt":5}}}"#)
            .bind(r#"{"fields":{"completed":{"value":false,"updatedAt":200}}}"#)
            .bind(r#"{"fields":{"completed":{"value":null,"updatedAt":300}}}"#)
            .bind(r#"{"fields":{"completed":{"value":true,"updatedAt":100},"status":{"value":"On Hiatus","updatedAt":250}}}"#)
            .execute(&pool).await.unwrap();
        pool.close().await;

        let pool = bootstrap(&path, &migrations).await.unwrap();
        let rows = sqlx::query_as::<_, (i64, Option<String>, Option<i64>, Option<String>)>(
            "SELECT novel_id, json_extract(payload, '$.fields.status.value'), json_extract(payload, '$.fields.status.updatedAt'), json_extract(payload, '$.fields.completed') FROM novel_override ORDER BY novel_id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(rows, [
            (1, Some("Completed".into()), Some(100), None),
            (2, Some("Ongoing".into()), Some(200), None),
            (3, None, Some(300), None),
            (4, Some("On Hiatus".into()), Some(250), None),
        ]);
        let note: Option<String> = sqlx::query_scalar("SELECT json_extract(payload, '$.fields.note.value') FROM novel_override WHERE novel_id = 1")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(note.as_deref(), Some("kept"));
        pool.close().await;
    }

    #[tokio::test]
    async fn registered_v1_upgrade_preserves_library_chapters_and_ordinary_queue() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations[..1]).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Retained work',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(id,novel_id,path,name,position,is_downloaded,progress,content_bytes) VALUES(1,1,'/chapter','Retained chapter',1,1,73,456)")
            .execute(&pool).await.unwrap();
        let job = r#"{"id":1,"pluginId":"source","chapterPath":"/chapter","title":"Ordinary"}"#;
        sqlx::query("INSERT INTO chapter_download_queue VALUES(1,?1,10,20,30,4)").bind(job)
            .execute(&pool).await.unwrap();
        pool.close().await;
        let expected_versions: Vec<_> = migrations.iter().map(|migration| migration.version).collect();
        for _ in 0..2 {
            let pool = bootstrap(&path, &migrations).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String, i64, i64, i64)>(
                "SELECT n.in_library,c.name,c.is_downloaded,c.progress,c.content_bytes FROM novel n JOIN chapter c ON c.novel_id=n.id")
                .fetch_one(&pool).await.unwrap(), (1,"Retained chapter".into(),1,73,456));
            assert_eq!(sqlx::query_as::<_, (String, i64, i64, Option<i64>, i64)>(
                "SELECT job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue")
                .fetch_one(&pool).await.unwrap(), (job.into(),10,20,Some(30),4));
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM vpn_download_plan")
                .fetch_one(&pool).await.unwrap(), 0);
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations ORDER BY version")
                .fetch_all(&pool).await.unwrap(), expected_versions);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn registered_app_migrations_preserve_library_and_downloads_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations().into_iter().map(|migration| {
            SqlxMigration::new(migration.version, migration.description.into(),
                MigrationType::ReversibleUp, migration.sql.into(), false)
        }).collect();
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'source','/work','Retained work',1)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chapter(novel_id,path,name,position,is_downloaded,stored_content_type) VALUES(1,'/chapter','Retained chapter',1,1,'html')")
            .execute(&pool).await.unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (String, i64, String, i64)>(
            "SELECT n.name,n.in_library,c.name,c.is_downloaded FROM novel n JOIN chapter c ON c.novel_id=n.id")
            .fetch_one(&pool).await.unwrap(), ("Retained work".into(),1,"Retained chapter".into(),1));
        pool.close().await;
    }

    #[tokio::test]
    async fn current_schema_reopens_without_changing_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT value FROM sample")
                .fetch_one(&pool)
                .await
                .unwrap(),
            42
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn changed_checksum_preserves_database_and_media() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let media = dir.path().join("content.html");
        fs::write(&media, "chapter content").unwrap();
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
        pool.close().await;
        assert!(bootstrap(&path, &[schema("CREATE TABLE sample (value TEXT);")]).await.is_err());
        let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&pool).await.unwrap(), 42);
        assert_eq!(fs::read_to_string(media).unwrap(), "chapter content");
        pool.close().await;
    }

    #[tokio::test]
    async fn appended_migration_preserves_rows_and_reopens() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let first = schema(CURRENT);
        let second = SqlxMigration::new(2, "add label".into(), MigrationType::ReversibleUp,
            "ALTER TABLE sample ADD COLUMN label TEXT NOT NULL DEFAULT 'retained';".into(), false);
        let pool = bootstrap(&path, &[first.clone()]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
        pool.close().await;
        for _ in 0..2 {
            let pool = bootstrap(&path, &[first.clone(), second.clone()]).await.unwrap();
            assert_eq!(sqlx::query_as::<_, (i64, String)>("SELECT value, label FROM sample").fetch_one(&pool).await.unwrap(),
                (42, "retained".into()));
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations ORDER BY version").fetch_all(&pool).await.unwrap(), vec![1, 2]);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn invalid_or_newer_history_preserves_database() {
        for change in [
            "UPDATE _sqlx_migrations SET version = 2",
            "UPDATE _sqlx_migrations SET success = 0",
            "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) \
             SELECT 2,description,success,checksum,execution_time FROM _sqlx_migrations",
            "DELETE FROM _sqlx_migrations",
            "DROP TABLE _sqlx_migrations",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(DB_FILE);
            let pool = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
            sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
            sqlx::query(change).execute(&pool).await.unwrap();
            pool.close().await;
            assert!(bootstrap(&path, &[schema(CURRENT)]).await.is_err(), "{change}");
            let pool = sqlite_pool_options().connect_with(SqliteConnectOptions::new().filename(&path).create_if_missing(false)).await.unwrap();
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&pool).await.unwrap(), 42);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn failed_upgrade_rolls_back_and_keeps_the_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let first = schema(CURRENT);
        let pool = bootstrap(&path, &[first.clone()]).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)").execute(&pool).await.unwrap();
        pool.close().await;
        let second = SqlxMigration::new(2, "broken upgrade".into(), MigrationType::ReversibleUp,
            "UPDATE sample SET value = 99; INSERT INTO missing_table VALUES (1);".into(), false);
        assert!(bootstrap(&path, &[first.clone(), second]).await.is_err());
        let pool = bootstrap(&path, &[first]).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&pool).await.unwrap(), 42);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations").fetch_all(&pool).await.unwrap(), vec![1]);
        pool.close().await;
    }

    #[tokio::test]
    async fn unreadable_database_is_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let contents = b"not a SQLite database";
        fs::write(&path, contents).unwrap();
        assert!(bootstrap(&path, &[schema(CURRENT)]).await.is_err());
        assert_eq!(fs::read(path).unwrap(), contents);
    }

    #[tokio::test]
    async fn connection_expiry_interrupts_manual_transactions() {
        let pool = sqlite_pool_options()
            .max_lifetime(Duration::from_millis(20))
            .idle_timeout(None)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&pool).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let error = sqlx::query("COMMIT").execute(&pool).await.unwrap_err();
        assert!(error.to_string().contains("no transaction is active"));
        pool.close().await;
    }

    #[tokio::test]
    async fn work_home_reads_committed_metadata_during_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrated = bootstrap(&path, &[schema(CURRENT)]).await.unwrap();
        let mut migrated_connection = migrated.acquire().await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (1)").execute(&mut *migrated_connection).await.unwrap();
        migrated_connection.close().await.unwrap();
        migrated.close().await;
        let (writer, reader) = open_sqlite_pools(&path).await.unwrap();
        let mut writer_connection = writer.acquire().await.unwrap();
        let mut reader_connection = reader.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer_connection).await.unwrap();
        sqlx::query("UPDATE sample SET value=2").execute(&mut *writer_connection).await.unwrap();
        let saved = tokio::time::timeout(Duration::from_secs(1),
            sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&mut *reader_connection))
            .await.unwrap().unwrap();
        assert_eq!(saved, 1);
        sqlx::query("COMMIT").execute(&mut *writer_connection).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&mut *reader_connection).await.unwrap(), 2);
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *writer_connection).await.unwrap();
        sqlx::query("UPDATE sample SET value=3").execute(&mut *writer_connection).await.unwrap();
        sqlx::query("ROLLBACK").execute(&mut *writer_connection).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT value FROM sample").fetch_one(&mut *reader_connection).await.unwrap(), 2);
        assert!(sqlx::query("UPDATE sample SET value=4").execute(&mut *reader_connection).await.is_err());
        reader_connection.close().await.unwrap();
        writer_connection.close().await.unwrap();
        reader.close().await;
        writer.close().await;
        fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn app_pool_preserves_transactions_between_ipc_calls() {
        let options = sqlite_pool_options();
        assert_eq!(options.get_max_lifetime(), None);
        assert_eq!(options.get_idle_timeout(), None);
        let pool = options.connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE sample (value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO sample VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        sqlx::query("COMMIT").execute(&pool).await.unwrap();
        let value: i64 = sqlx::query_scalar("SELECT value FROM sample")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, 42);
        pool.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_creates_and_reopens_existing_database_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);

        let db = open_and_migrate_pools(&path).await.unwrap();
        sqlx::query("INSERT INTO novel(id, plugin_id, path, name, in_library) VALUES (1, 'source', '/book', 'Saved Book', 1)")
            .execute(db.writer())
            .await
            .unwrap();
        let committed: String = sqlx::query_scalar("SELECT name FROM novel WHERE id = 1")
            .fetch_one(db.reader())
            .await
            .unwrap();
        assert_eq!(committed, "Saved Book");
        db.close().await;

        let reopened = open_and_migrate_pools(&path).await.unwrap();
        let retained: (String, i64) =
            sqlx::query_as("SELECT name, in_library FROM novel WHERE id = 1")
                .fetch_one(reopened.reader())
                .await
                .unwrap();
        assert_eq!(retained, ("Saved Book".to_string(), 1));
        reopened.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_enables_incremental_auto_vacuum_for_new_and_legacy_dbs() {
        let dir = tempfile::tempdir().unwrap();
        let new_path = dir.path().join("new.db");

        let new_db = open_and_migrate_pools(&new_path).await.unwrap();
        let new_mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(new_db.writer())
            .await
            .unwrap();
        assert_eq!(new_mode, 2);
        new_db.close().await;

        let legacy_path = dir.path().join("legacy.db");
        let migrations: Vec<_> = sqlx_migrations().into_iter().take(14).collect();
        let legacy_pool = bootstrap(&legacy_path, &migrations).await.unwrap();
        let initial_mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&legacy_pool)
            .await
            .unwrap();
        assert_eq!(initial_mode, 0);
        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, name, in_library) \
             VALUES (1, 'source', '/legacy', 'Legacy Work', 1)",
        )
        .execute(&legacy_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status, receipt) \
             VALUES \
               ('op-ack', 'ns', 'k1', 1, '{}', 'acknowledged', '{\"status\":\"applied\"}'), \
               ('op-pend', 'ns', 'k2', 2, '{}', 'pending', NULL)",
        )
        .execute(&legacy_pool)
        .await
        .unwrap();
        legacy_pool.close().await;

        let upgraded = open_and_migrate_pools(&legacy_path).await.unwrap();
        let upgraded_mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(upgraded.writer())
            .await
            .unwrap();
        assert_eq!(upgraded_mode, 2);
        let novel_name: String = sqlx::query_scalar("SELECT name FROM novel WHERE id = 1")
            .fetch_one(upgraded.reader())
            .await
            .unwrap();
        assert_eq!(novel_name, "Legacy Work");
        let ack_ts: Option<i64> = sqlx::query_scalar(
            "SELECT acknowledged_at FROM user_state_operation WHERE operation_id = 'op-ack'",
        )
        .fetch_one(upgraded.reader())
        .await
        .unwrap();
        assert!(ack_ts.is_some_and(|v| v >= 0));
        let pend_ts: Option<i64> = sqlx::query_scalar(
            "SELECT acknowledged_at FROM user_state_operation WHERE operation_id = 'op-pend'",
        )
        .fetch_one(upgraded.reader())
        .await
        .unwrap();
        assert_eq!(pend_ts, None);
        upgraded.close().await;

        let reopened = open_and_migrate_pools(&legacy_path).await.unwrap();
        let reopened_mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(reopened.writer())
            .await
            .unwrap();
        assert_eq!(reopened_mode, 2);
        reopened.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_does_not_vacuum_or_alter_invalid_existing_databases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tampered.db");
        let migrations: Vec<_> = sqlx_migrations().into_iter().take(14).collect();
        let pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, name, in_library) \
             VALUES (1, 'source', '/keep', 'Kept Work', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 14")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        assert!(open_and_migrate_pools(&path).await.is_err());

        let verify_pool = sqlite_pool_options()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(false),
            )
            .await
            .unwrap();
        let mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(&verify_pool)
            .await
            .unwrap();
        assert_eq!(mode, 0);
        let name: String = sqlx::query_scalar("SELECT name FROM novel WHERE id = 1")
            .fetch_one(&verify_pool)
            .await
            .unwrap();
        assert_eq!(name, "Kept Work");
        verify_pool.close().await;

        let corrupt_path = dir.path().join("corrupt.db");
        fs::write(&corrupt_path, b"not sqlite data").unwrap();
        assert!(open_and_migrate_pools(&corrupt_path).await.is_err());
        assert_eq!(fs::read(&corrupt_path).unwrap(), b"not sqlite data");
    }

    #[tokio::test]
    async fn reclaim_space_vacuums_freelist_pages_and_truncates_wal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reclaim.db");
        let db = open_and_migrate_pools(&path).await.unwrap();

        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, name) VALUES (1, 'source', '/w', 'Work')",
        )
        .execute(db.writer())
        .await
        .unwrap();
        let large_text = "x".repeat(4000);
        for idx in 1..=80_i64 {
            sqlx::query(
                "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status, acknowledged_at) \
                 VALUES (?1, 'ns', ?2, ?3, ?4, 'acknowledged', 100)",
            )
            .bind(format!("op-{idx}"))
            .bind(format!("k-{idx}"))
            .bind(idx)
            .bind(&large_text)
            .execute(db.writer())
            .await
            .unwrap();
        }
        sqlx::query("DELETE FROM user_state_operation")
            .execute(db.writer())
            .await
            .unwrap();

        let freelist_initial: i64 = sqlx::query_scalar("PRAGMA freelist_count")
            .fetch_one(db.writer())
            .await
            .unwrap();
        assert!(freelist_initial > 2);

        let bounded = db.reclaim_space(Some(1)).await.unwrap();
        assert_eq!(bounded.auto_vacuum_mode, 2);
        assert_eq!(bounded.freelist_before, freelist_initial);
        assert!(bounded.freelist_after < bounded.freelist_before);
        assert!(bounded.freelist_after > 0);
        assert_eq!(bounded.wal_checkpoint_busy, 0);

        let full = db.reclaim_space(None).await.unwrap();
        assert_eq!(full.freelist_after, 0);
        assert_eq!(full.wal_checkpoint_busy, 0);

        let wal_path = dir.path().join("reclaim.db-wal");
        if wal_path.exists() {
            assert_eq!(fs::metadata(&wal_path).unwrap().len(), 0);
        }
        db.close().await;
    }

    #[tokio::test]
    async fn registered_v15_upgrade_preserves_workspace_and_enforces_epoch_retention_checks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let migrations: Vec<_> = schema_migrations()
            .into_iter()
            .map(|migration| {
                SqlxMigration::new(
                    migration.version,
                    migration.description.into(),
                    MigrationType::ReversibleUp,
                    migration.sql.into(),
                    false,
                )
            })
            .collect();
        let pool = bootstrap(&path, &migrations[..15]).await.unwrap();
        sqlx::query(
            "INSERT INTO user_state_workspace(server_url, namespace, workspace_id, epoch, cursor, read_through, last_success_at) \
             VALUES ('https://state.example', '[\"https://state.example\",\"ws-1\",\"epoch-1\"]', 'ws-1', 'epoch-1', 42, NULL, 9000)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let pool = bootstrap(&path, &migrations).await.unwrap();
        let row = sqlx::query_as::<_, (String, String, i64, i64, Option<i64>)>(
            "SELECT workspace_id, epoch, cursor, seed_suppressed, seed_cutoff_at FROM user_state_workspace",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, ("ws-1".into(), "epoch-1".into(), 42, 0, None));

        assert!(sqlx::query(
            "UPDATE user_state_workspace SET seed_suppressed = 2 WHERE server_url = 'https://state.example'",
        )
        .execute(&pool)
        .await
        .is_err());
        assert!(sqlx::query(
            "UPDATE user_state_workspace SET seed_cutoff_at = -1 WHERE server_url = 'https://state.example'",
        )
        .execute(&pool)
        .await
        .is_err());

        sqlx::query(
            "UPDATE user_state_workspace SET seed_suppressed = 1, seed_cutoff_at = 1700000000000 WHERE server_url = 'https://state.example'",
        )
        .execute(&pool)
        .await
        .unwrap();
        let updated = sqlx::query_as::<_, (i64, Option<i64>)>(
            "SELECT seed_suppressed, seed_cutoff_at FROM user_state_workspace",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(updated, (1, Some(1_700_000_000_000)));
        pool.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_upgrades_populated_v15_to_v16_and_preserves_incremental_vacuum() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v15_populated.db");
        let migrations: Vec<_> = sqlx_migrations().into_iter().take(15).collect();

        let v15_pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query(
            "INSERT INTO user_state_workspace(server_url, namespace, workspace_id, epoch, cursor, read_through, last_success_at) \
             VALUES ('https://state.example', '[\"https://state.example\",\"ws-1\",\"ep-1\"]', 'ws-1', 'ep-1', 77, NULL, 9999)",
        )
        .execute(&v15_pool)
        .await
        .unwrap();
        v15_pool.close().await;

        let db = open_and_migrate_pools(&path).await.unwrap();
        let mode: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(db.writer())
            .await
            .unwrap();
        assert_eq!(mode, 2);

        let ws: (String, String, i64, i64, Option<i64>) = sqlx::query_as(
            "SELECT workspace_id, epoch, cursor, seed_suppressed, seed_cutoff_at \
             FROM user_state_workspace WHERE server_url = 'https://state.example'",
        )
        .fetch_one(db.reader())
        .await
        .unwrap();
        assert_eq!(ws, ("ws-1".into(), "ep-1".into(), 77, 0, None));

        assert!(sqlx::query(
            "UPDATE user_state_workspace SET seed_suppressed = -1 WHERE server_url = 'https://state.example'",
        )
        .execute(db.writer())
        .await
        .is_err());
        sqlx::query(
            "UPDATE user_state_workspace SET seed_cutoff_at = 0 WHERE server_url = 'https://state.example'",
        )
        .execute(db.writer())
        .await
        .unwrap();
        db.close().await;

        let reopened = open_and_migrate_pools(&path).await.unwrap();
        let mode_after: i64 = sqlx::query_scalar("PRAGMA auto_vacuum")
            .fetch_one(reopened.writer())
            .await
            .unwrap();
        assert_eq!(mode_after, 2);
        let cutoff_after: Option<i64> = sqlx::query_scalar(
            "SELECT seed_cutoff_at FROM user_state_workspace WHERE server_url = 'https://state.example'",
        )
        .fetch_one(reopened.reader())
        .await
        .unwrap();
        assert_eq!(cutoff_after, Some(0));
        assert!(!sqlite_sidecar_path(&path, ".auto-vacuum.tmp").exists());
        assert!(!sqlite_sidecar_path(&path, ".auto-vacuum.bak").exists());
        reopened.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_recovers_interrupted_auto_vacuum_swap_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recover.db");
        let db = open_and_migrate_pools(&path).await.unwrap();
        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, name, in_library) \
             VALUES (1, 'source', '/recovered', 'Recovered Work', 1)",
        )
        .execute(db.writer())
        .await
        .unwrap();
        db.reclaim_space(None).await.unwrap();
        db.close().await;

        let bak_path = sqlite_sidecar_path(&path, ".auto-vacuum.bak");
        let tmp_path = sqlite_sidecar_path(&path, ".auto-vacuum.tmp");
        fs::rename(&path, &bak_path).unwrap();
        fs::write(&tmp_path, b"partial-temp-data").unwrap();

        let recovered = open_and_migrate_pools(&path).await.unwrap();
        let name: String = sqlx::query_scalar("SELECT name FROM novel WHERE id = 1")
            .fetch_one(recovered.reader())
            .await
            .unwrap();
        assert_eq!(name, "Recovered Work");
        assert!(!bak_path.exists());
        assert!(!tmp_path.exists());
        recovered.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_upgrades_populated_v16_to_v17_single_progress_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v16_populated.db");
        let migrations: Vec<_> = sqlx_migrations().into_iter().take(16).collect();

        let v16_pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query(
            "INSERT INTO novel(id, plugin_id, path, name, in_library) \
             VALUES (1, 'source', '/n1', 'Novel One', 1)",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        // c1: unread=0, progress=35 -> becomes progress=100
        // c2: unread=1, progress=55 -> stays progress=55
        // c3: unread=1, progress=0  -> stays progress=0
        sqlx::query(
            "INSERT INTO chapter(id, novel_id, path, name, position, unread, progress, read_at) VALUES \
             (1, 1, '/c1', 'Ch 1', 1, 0, 35, 100), \
             (2, 1, '/c2', 'Ch 2', 2, 1, 55, 200), \
             (3, 1, '/c3', 'Ch 3', 3, 1, 0, NULL)",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO work_metadata_reading_state(plugin_id, novel_path, chapter_path, progress, bookmark, unread, read_at) VALUES \
             ('source', '/n1', '/deleted-read', 20, 0, 0, 50), \
             ('source', '/n1', '/deleted-partial', 40, 1, 1, 60)",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_intent(entity_key, entity_json, value_json, seed) VALUES \
             ('k1', '{\"kind\":\"reading\",\"work\":{\"pluginId\":\"source\",\"novelPath\":\"/n1\",\"name\":\"N\"},\"chapter\":{\"chapterPath\":\"/c1\"}}', '{\"progress\":35,\"unread\":false,\"readAt\":100}', 0), \
             ('k2', '{\"kind\":\"reading\",\"work\":{\"pluginId\":\"source\",\"novelPath\":\"/n1\",\"name\":\"N\"},\"chapter\":{\"chapterPath\":\"/c2\"}}', '{\"progress\":55,\"unread\":true,\"readAt\":200}', 0)",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_record(namespace, entity_key, revision, payload) VALUES \
             ('ns', 'k1', 1, '{\"entity\":{\"kind\":\"reading\"},\"value\":{\"progress\":10,\"unread\":false,\"readAt\":90}}')",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_private(entity_key, public_value_json) VALUES \
             ('k1', '{\"progress\":25,\"unread\":false,\"readAt\":80}')",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status, receipt) VALUES \
             ('op-pending', 'ns', 'k1', 1, '{\"entity\":{\"kind\":\"reading\"},\"value\":{\"progress\":35,\"unread\":false,\"readAt\":100}}', 'pending', NULL), \
             ('op-ack', 'ns', 'k2', 2, '{\"entity\":{\"kind\":\"reading\"},\"value\":{\"progress\":35,\"unread\":false,\"readAt\":100}}', 'acknowledged', '{\"status\":\"applied\",\"current\":{\"entity\":{\"kind\":\"reading\"},\"value\":{\"progress\":35,\"unread\":false,\"readAt\":100}}}')",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO content_sync_cache(cache_key, payload) VALUES \
             ('user-state-current:ns', '{}'), \
             ('user-state-current-status:ns', '{}'), \
             ('keep-me', '{}')",
        )
        .execute(&v16_pool)
        .await
        .unwrap();
        v16_pool.close().await;

        let db = open_and_migrate_pools(&path).await.unwrap();
        let chapter_has_unread: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('chapter') WHERE name = 'unread'",
        )
        .fetch_one(db.reader())
        .await
        .unwrap();
        assert_eq!(chapter_has_unread, 0);

        let progresses: Vec<(i64, i64)> =
            sqlx::query_as("SELECT id, progress FROM chapter ORDER BY id")
                .fetch_all(db.reader())
                .await
                .unwrap();
        assert_eq!(progresses, vec![(1, 100), (2, 55), (3, 0)]);

        let stats: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT total_chapters, chapters_unread, progress_sum, reading_progress \
             FROM novel_stats WHERE novel_id = 1",
        )
        .fetch_one(db.reader())
        .await
        .unwrap();
        assert_eq!(stats, (3, 2, 155, 52));

        let preserved: Vec<(String, i64)> = sqlx::query_as(
            "SELECT chapter_path, progress FROM work_metadata_reading_state ORDER BY chapter_path",
        )
        .fetch_all(db.reader())
        .await
        .unwrap();
        assert_eq!(
            preserved,
            vec![
                ("/deleted-partial".to_string(), 40),
                ("/deleted-read".to_string(), 100),
            ]
        );

        let intent_vals: Vec<(String, String)> =
            sqlx::query_as("SELECT entity_key, value_json FROM user_state_intent ORDER BY entity_key")
                .fetch_all(db.reader())
                .await
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&intent_vals[0].1).unwrap(),
            serde_json::json!({ "progress": 100, "readAt": 100 })
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&intent_vals[1].1).unwrap(),
            serde_json::json!({ "progress": 55, "readAt": 200 })
        );

        let rec_payload: String =
            sqlx::query_scalar("SELECT payload FROM user_state_record WHERE entity_key = 'k1'")
                .fetch_one(db.reader())
                .await
                .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&rec_payload).unwrap()["value"],
            serde_json::json!({ "progress": 100, "readAt": 90 })
        );

        let priv_val: String = sqlx::query_scalar(
            "SELECT public_value_json FROM user_state_private WHERE entity_key = 'k1'",
        )
        .fetch_one(db.reader())
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&priv_val).unwrap(),
            serde_json::json!({ "progress": 100, "readAt": 80 })
        );

        // Pending legacy reading op dropped; acknowledged op normalized.
        let ops: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT operation_id, payload, receipt FROM user_state_operation ORDER BY operation_id",
        )
        .fetch_all(db.reader())
        .await
        .unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].0, "op-ack");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&ops[0].1).unwrap()["value"],
            serde_json::json!({ "progress": 100, "readAt": 100 })
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(ops[0].2.as_deref().unwrap()).unwrap()
                ["current"]["value"],
            serde_json::json!({ "progress": 100, "readAt": 100 })
        );

        let cache_keys: Vec<String> =
            sqlx::query_scalar("SELECT cache_key FROM content_sync_cache ORDER BY cache_key")
                .fetch_all(db.reader())
                .await
                .unwrap();
        assert_eq!(cache_keys, vec!["keep-me".to_string()]);

        // Verify triggers work after dropping unread column (delete chapter -> preserves reading state + updates novel_stats).
        sqlx::query("DELETE FROM chapter WHERE id = 2")
            .execute(db.writer())
            .await
            .unwrap();
        let after_del: (i64, i64, i64) = sqlx::query_as(
            "SELECT total_chapters, chapters_unread, progress_sum FROM novel_stats WHERE novel_id = 1",
        )
        .fetch_one(db.reader())
        .await
        .unwrap();
        assert_eq!(after_del, (2, 1, 100));
        db.close().await;
    }

    #[tokio::test]
    async fn open_and_migrate_pools_upgrades_populated_v17_to_v18_with_pending_entity_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v17_populated.db");
        let migrations: Vec<_> = sqlx_migrations().into_iter().take(17).collect();

        let v17_pool = bootstrap(&path, &migrations).await.unwrap();
        sqlx::query(
            "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload, status, receipt, acknowledged_at) VALUES \
             ('op-pending', 'ns-1', '[\"reading\",\"k1\"]', 1, '{}', 'pending', NULL, NULL), \
             ('op-ack', 'ns-1', '[\"reading\",\"k2\"]', 2, '{}', 'acknowledged', '{}', 500)",
        )
        .execute(&v17_pool)
        .await
        .unwrap();
        v17_pool.close().await;

        let db = open_and_migrate_pools(&path).await.unwrap();
        let index_exists: Option<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'user_state_operation_pending_entity_idx'",
        )
        .fetch_optional(db.reader())
        .await
        .unwrap();
        assert_eq!(
            index_exists.as_deref(),
            Some("user_state_operation_pending_entity_idx")
        );

        let ops: Vec<(String, String, String, i64, Option<i64>)> = sqlx::query_as(
            "SELECT operation_id, entity_key, status, intent_sequence, acknowledged_at \
             FROM user_state_operation ORDER BY intent_sequence",
        )
        .fetch_all(db.reader())
        .await
        .unwrap();
        assert_eq!(
            ops,
            vec![
                ("op-pending".into(), "[\"reading\",\"k1\"]".into(), "pending".into(), 1, None),
                ("op-ack".into(), "[\"reading\",\"k2\"]".into(), "acknowledged".into(), 2, Some(500)),
            ]
        );

        let plan_rows = sqlx::query(
            "EXPLAIN QUERY PLAN \
             SELECT 1 FROM user_state_operation \
             WHERE namespace = 'ns-1' AND status = 'pending' AND entity_key = '[\"reading\",\"k1\"]'",
        )
        .fetch_all(db.reader())
        .await
        .unwrap();
        let plan_details: Vec<String> = plan_rows.into_iter().map(|r| r.get("detail")).collect();
        assert!(
            plan_details
                .iter()
                .any(|detail| detail.contains("user_state_operation_pending_entity_idx")),
            "expected pending entity lookup to use covering index, got: {plan_details:?}"
        );
        db.close().await;

        let reopened = open_and_migrate_pools(&path).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM user_state_operation")
            .fetch_one(reopened.reader())
            .await
            .unwrap();
        assert_eq!(count, 2);
        reopened.close().await;
    }
}
