use std::{fs, time::Duration};

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

const DB_URL: &str = "sqlite:norea.db";
const READ_DB_URL: &str = "sqlite:norea-readonly.db";
const DB_FILE: &str = "norea.db";
const DB_BUSY_TIMEOUT_MS: u64 = 5000;

fn sqlite_pool_options() -> SqlitePoolOptions {
    // Frontend transactions span IPC calls, so the shared connection must not expire between them.
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

pub fn schema_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create current application schema",
        sql: include_str!("schema.sql"),
        kind: MigrationKind::Up,
    }]
}

async fn open_sqlite_pools(path: &std::path::Path) -> Result<(SqlitePool, SqlitePool), sqlx::Error> {
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

pub fn install_sqlite_pools(app: &AppHandle) -> Result<(), String> {
    run_async_command(async move {
        let db_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| format!("database: app config dir: {err}"))?;
        fs::create_dir_all(&db_dir).map_err(|err| format!("database: create db dir: {err}"))?;

        let (writer, reader) = open_sqlite_pools(&db_dir.join(DB_FILE))
            .await
            .map_err(|err| format!("database: open sqlite pools: {err}"))?;

        {
            let instances = app.state::<DbInstances>();
            let mut guard = instances.0.write().await;
            let _ = guard.insert(DB_URL.to_string(), DbPool::Sqlite(writer));
            let _ = guard.insert(READ_DB_URL.to_string(), DbPool::Sqlite(reader));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use std::borrow::Cow;

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
}
