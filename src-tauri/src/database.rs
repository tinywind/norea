use std::{fs, time::Duration};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

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
