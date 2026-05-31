use std::{fs, time::Duration};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tauri::{AppHandle, Manager};
use tauri_plugin_sql::{DbInstances, DbPool};

const DB_URL: &str = "sqlite:norea.db";
const DB_FILE: &str = "norea.db";
const DB_BUSY_TIMEOUT_MS: u64 = 5000;

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
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
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
