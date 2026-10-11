use std::{borrow::Cow, fs, path::Path, time::Duration};

use sqlx::{
    migrate::{Migration as SqlxMigration, MigrationType, Migrator},
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    SqlitePool,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

const DB_URL: &str = "sqlite:norea.db";
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

pub fn compatibility_plugin(migrations: Vec<Migration>) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let migrator = Migrator {
        migrations: Cow::Owned(
            migrations
                .into_iter()
                .filter_map(|migration| match migration.kind {
                    MigrationKind::Up => Some(SqlxMigration::new(
                        migration.version,
                        migration.description.into(),
                        MigrationType::ReversibleUp,
                        migration.sql.into(),
                        false,
                    )),
                    MigrationKind::Down => None,
                })
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    tauri::plugin::Builder::new("database-compatibility")
        .setup(move |app, _| {
            let path = app.path().app_config_dir()?.join(DB_FILE);
            run_async_command(reset_incompatible_database(&path, &migrator))?;
            Ok(())
        })
        .build()
}

async fn history_is_compatible(
    pool: &SqlitePool,
    migrator: &Migrator,
) -> Result<bool, sqlx::Error> {
    let has_history: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations')",
    ).fetch_one(pool).await?;
    let applied = if has_history {
        sqlx::query_as::<_, (i64, Vec<u8>, bool)>(
            "SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version",
        )
        .fetch_all(pool)
        .await?
    } else {
        Vec::new()
    };
    if applied.is_empty() {
        let has_tables: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' \
             AND name != '_sqlx_migrations' AND name NOT GLOB 'sqlite_*')",
        )
        .fetch_one(pool)
        .await?;
        return Ok(!has_tables);
    }
    // Applied migrations must be an exact prefix, including every checksum.
    Ok(applied.len() <= migrator.migrations.len()
        && applied
            .iter()
            .zip(migrator.iter())
            .all(|((version, checksum, success), expected)| {
                *success
                    && *version == expected.version
                    && checksum.as_slice() == expected.checksum.as_ref()
            }))
}

async fn reset_incompatible_database(path: &Path, migrator: &Migrator) -> Result<(), sqlx::Error> {
    if !path.try_exists()? {
        return Ok(());
    }
    let pool = sqlite_pool_options()
        .connect_with(
            SqliteConnectOptions::new()
                .filename(path)
                .create_if_missing(false)
                .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS)),
        )
        .await?;
    let compatible = history_is_compatible(&pool, migrator).await;
    pool.close().await;
    if compatible? {
        return Ok(());
    }
    log::warn!("Resetting application database because migration history is incompatible");
    // Run before the SQL plugin opens any connections; leave media and other app files intact.
    for suffix in ["-wal", "-shm", "-journal", ""] {
        let mut file = path.as_os_str().to_os_string();
        file.push(suffix);
        match fs::remove_file(Path::new(&file)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub fn install_single_connection_sqlite_pool(app: &AppHandle) -> Result<(), String> {
    run_async_command(async move {
        let db_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| format!("database: app config dir: {err}"))?;
        fs::create_dir_all(&db_dir).map_err(|err| format!("database: create db dir: {err}"))?;

        let options = SqliteConnectOptions::new()
            .filename(db_dir.join(DB_FILE))
            .create_if_missing(true)
            .busy_timeout(Duration::from_millis(DB_BUSY_TIMEOUT_MS));
        let pool = sqlite_pool_options()
            .connect_with(options)
            .await
            .map_err(|err| format!("database: open sqlite pool: {err}"))?;

        {
            let instances = app.state::<DbInstances>();
            let mut guard = instances.0.write().await;
            let _ = guard.insert(DB_URL.to_string(), DbPool::Sqlite(pool));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::{Migration, MigrationType, Migrator};
    use std::borrow::Cow;

    fn migrations(scripts: &[&str]) -> Migrator {
        Migrator {
            migrations: Cow::Owned(
                scripts
                    .iter()
                    .enumerate()
                    .map(|(index, sql)| {
                        Migration::new(
                            index as i64 + 1,
                            "fixture".into(),
                            MigrationType::ReversibleUp,
                            (*sql).to_owned().into(),
                            false,
                        )
                    })
                    .collect(),
            ),
            ..Migrator::DEFAULT
        }
    }

    async fn bootstrap(path: &std::path::Path, migrator: &Migrator) -> sqlx::SqlitePool {
        reset_incompatible_database(path, migrator).await.unwrap();
        let pool = sqlite_pool_options()
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        migrator.run(&pool).await.unwrap();
        pool
    }

    const V1: &str = "CREATE TABLE sample (value INTEGER);";
    const V2: &str = "ALTER TABLE sample ADD COLUMN title TEXT;";

    #[tokio::test]
    async fn compatible_upgrade_and_reopen_preserve_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let pool = bootstrap(&path, &migrations(&[V1])).await;
        sqlx::query("INSERT INTO sample VALUES (42)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations(&[V1, V2])).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT value FROM sample")
                .fetch_one(&pool)
                .await
                .unwrap(),
            42
        );
        sqlx::query("UPDATE sample SET title = 'kept'")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let pool = bootstrap(&path, &migrations(&[V1, V2])).await;
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT title FROM sample")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "kept"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn incompatible_history_resets_only_database() {
        let cases = [
            (vec![V1], vec!["CREATE TABLE sample (value TEXT);"]),
            (vec![V1, V2], vec![V1]),
            (
                vec![V1, V2],
                vec![
                    V1,
                    "ALTER TABLE sample ADD COLUMN name TEXT;",
                    "CREATE TABLE added (id INTEGER);",
                ],
            ),
        ];
        for (old, new) in cases {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(DB_FILE);
            let media = dir.path().join("content.html");
            fs::write(&media, "chapter content").unwrap();
            let pool = bootstrap(&path, &migrations(&old)).await;
            sqlx::query("INSERT INTO sample (value) VALUES (42)")
                .execute(&pool)
                .await
                .unwrap();
            pool.close().await;
            let pool = bootstrap(&path, &migrations(&new)).await;
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sample")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                new.len() as i64
            );
            assert_eq!(fs::read_to_string(media).unwrap(), "chapter content");
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn incomplete_or_missing_history_resets_database() {
        for change in [
            "DELETE FROM _sqlx_migrations WHERE version = 1",
            "UPDATE _sqlx_migrations SET success = 0 WHERE version = 2",
            "DELETE FROM _sqlx_migrations",
            "DROP TABLE _sqlx_migrations",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(DB_FILE);
            let migrator = migrations(&[V1, V2]);
            let pool = bootstrap(&path, &migrator).await;
            sqlx::query("INSERT INTO sample (value) VALUES (42)")
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(change).execute(&pool).await.unwrap();
            pool.close().await;
            let pool = bootstrap(&path, &migrator).await;
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sample")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn unreadable_database_is_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        let contents = b"not a SQLite database";
        fs::write(&path, contents).unwrap();
        assert!(reset_incompatible_database(&path, &migrations(&[V1]))
            .await
            .is_err());
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
