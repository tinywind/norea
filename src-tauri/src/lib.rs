mod android_file_open;
#[cfg(target_os = "android")]
mod android_tls;
mod backup;
mod chapter_media;
mod database;
mod desktop_file_open;
mod download_cache;
mod download_queue;
mod native_stream;
mod plugin_host;
mod scraper;
mod task_notifications;
mod tray;
mod update;
mod webview_resource_capture;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

fn parse_runtime_log_level(level: &str) -> Result<log::LevelFilter, String> {
    match level {
        "trace" => Ok(log::LevelFilter::Trace),
        "debug" => Ok(log::LevelFilter::Debug),
        "info" => Ok(log::LevelFilter::Info),
        "warn" => Ok(log::LevelFilter::Warn),
        "error" => Ok(log::LevelFilter::Error),
        "off" => Ok(log::LevelFilter::Off),
        _ => Err(format!("invalid log level: {level}")),
    }
}

#[tauri::command]
fn set_runtime_log_level(level: String) -> Result<(), String> {
    log::set_max_level(parse_runtime_log_level(&level)?);
    Ok(())
}

#[tauri::command]
fn write_frontend_log(level: String, message: String) -> Result<(), String> {
    match parse_runtime_log_level(&level)? {
        log::LevelFilter::Off => {}
        log::LevelFilter::Error => log::error!(target: "frontend", "{message}"),
        log::LevelFilter::Warn => log::warn!(target: "frontend", "{message}"),
        log::LevelFilter::Info => log::info!(target: "frontend", "{message}"),
        log::LevelFilter::Debug => log::debug!(target: "frontend", "{message}"),
        log::LevelFilter::Trace => log::trace!(target: "frontend", "{message}"),
    }
    Ok(())
}

fn application_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create current application schema",
            sql: include_str!("schema.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create chapter download queue",
            sql: include_str!("schema_download_queue.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create download cache work queue",
            sql: include_str!("schema_download_cache_work.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "separate stored chapter content type",
            sql: include_str!("schema_chapter_stored_content_type.sql"),
            kind: MigrationKind::Up,
        },
        // Released migrations remain registered after their feature is retired.
        Migration {
            version: 5,
            description: "create VPN Gate server verdicts",
            sql: include_str!("schema_vpn_gate_server_verdict.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = application_migrations();

    let context = tauri::generate_context!();
    let desktop_open_files = desktop_file_open::DesktopOpenFileState::from_process_args();
    let builder = tauri::Builder::default();

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        desktop_file_open::enqueue_new_instance(app, args, cwd);
        tray::show_main_window(app);
    }));

    builder
        .manage(android_file_open::AndroidOpenFileState::default())
        .manage(desktop_open_files)
        .manage(download_queue::DownloadQueueState::default())
        .manage(native_stream::NativeStreamState::default())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:norea.db", migrations)
                .build(),
        )
        .register_uri_scheme_protocol("norea-media", |ctx, request| {
            chapter_media::norea_media_protocol_response(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
            android_file_open::android_open_file_temp_read,
            android_file_open::android_open_file_url_take,
            backup::backup_cleanup_staged_unpack,
            backup::backup_delete_temp_file,
            backup::backup_pack,
            backup::backup_pack_bytes,
            backup::backup_pack_temp_file,
            backup::backup_restore_staged_media,
            backup::backup_restore_snapshot,
            backup::backup_unpack,
            backup::backup_unpack_bytes,
            backup::backup_unpack_bytes_staged,
            backup::backup_unpack_staged,
            chapter_media::chapter_content_mirror_clear,
            chapter_media::chapter_content_mirror_cleanup_legacy_manifest,
            chapter_media::chapter_content_mirror_inspect,
            chapter_media::chapter_content_mirror_read_file,
            chapter_media::chapter_content_mirror_store,
            chapter_media::chapter_content_mirror_store_partial,
            chapter_media::chapter_media_archive_cache,
            chapter_media::chapter_media_begin_restore,
            chapter_media::chapter_media_clear,
            chapter_media::chapter_media_clear_all,
            chapter_media::chapter_media_commit_restore,
            chapter_media::chapter_media_cleanup_workspace,
            chapter_media::chapter_media_data_url,
            chapter_media::chapter_media_get_storage_root,
            chapter_media::chapter_media_path,
            chapter_media::chapter_media_prepare_workspace,
            chapter_media::chapter_media_prune,
            chapter_media::chapter_media_read_manifest,
            chapter_media::chapter_media_rollback_restore,
            chapter_media::chapter_media_set_storage_root,
            chapter_media::chapter_media_store,
            chapter_media::chapter_media_store_handle,
            chapter_media::chapter_media_total_size,
            chapter_media::chapter_media_use_default_storage_root,
            chapter_media::chapter_media_write_manifest,
            chapter_media::chapter_storage_prune_dir_children,
            chapter_media::chapter_storage_prepare_transfer,
            chapter_media::chapter_storage_finalize_transfer,
            chapter_media::chapter_storage_relocate_dir,
            chapter_media::chapter_storage_remove_dir,
            chapter_media::chapter_storage_rollback_transfer,
            chapter_media::novel_cover_read_manifest,
            chapter_media::novel_cover_store,
            desktop_file_open::desktop_open_file_discard,
            desktop_file_open::desktop_open_file_list,
            desktop_file_open::desktop_open_file_take,
            download_queue::chapter_download_queue_enqueue,
            download_queue::chapter_download_queue_lease,
            download_queue::chapter_download_queue_remove,
            download_cache::download_cache_delete_work_cancel,
            download_cache::download_cache_delete_work_enqueue,
            download_cache::download_cache_delete_work_list_resumable,
            download_cache::download_cache_delete_work_run,
            native_stream::native_stream_cancel,
            native_stream::native_stream_cleanup,
            native_stream::native_stream_create,
            native_stream::native_stream_delete,
            native_stream::native_stream_finish,
            native_stream::native_stream_info,
            native_stream::native_stream_read_chunk,
            native_stream::native_stream_write_chunk,
            plugin_host::plugin_zip_list,
            plugin_host::plugin_zip_read_file,
            scraper::webview_fetch,
            scraper::scraper_take_captured_resource,
            scraper::scraper_take_captured_resource_handle,
            scraper::webview_extract,
            scraper::scraper_cancel_executor,
            scraper::scraper_navigate,
            scraper::scraper_set_bounds,
            scraper::scraper_hide,
            scraper::scraper_current_origin,
            scraper::scraper_clear_cache,
            scraper::scraper_clear_cookies,
            scraper::scraper_open_devtools,
            set_runtime_log_level,
            task_notifications::task_notification_show_download_progress,
            task_notifications::task_notification_update_download_progress,
            tray::tray_set_task_progress,
            update::download_and_open_update,
            update::get_build_info,
            update::open_downloaded_update,
            update::open_downloaded_update_handle,
            write_frontend_log,
        ])
        .setup(move |app| {
            database::install_single_connection_sqlite_pool(app.handle())
                .map_err(|err| format!("database init: {err}"))?;
            native_stream::cleanup_startup(app.handle())
                .map_err(|err| format!("native stream init: {err}"))?;
            app.manage(scraper::ScraperState::default());
            tray::init(app).map_err(|err| format!("tray init: {err}"))?;
            scraper::init_scraper(app.handle()).map_err(|err| format!("scraper init: {err}"))?;
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Trace)
                    .level_for("h2", log::LevelFilter::Warn)
                    .level_for("hyper", log::LevelFilter::Warn)
                    .level_for("hyper_util", log::LevelFilter::Warn)
                    .level_for("reqwest", log::LevelFilter::Warn)
                    .level_for("sqlx", log::LevelFilter::Info)
                    .level_for("tracing", log::LevelFilter::Warn)
                    .build(),
            )?;
            log::set_max_level(log::LevelFilter::Info);
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "android")]
            if let tauri::RunEvent::Opened { urls } = _event {
                android_file_open::enqueue_opened_urls(_app, urls);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::borrow::Cow;

    use sqlx::{
        migrate::{Migration as SqlxMigration, MigrationType, Migrator},
        sqlite::SqlitePoolOptions,
    };

    const RELEASED_MIGRATION_5_SQL: &str = concat!(
        "CREATE TABLE IF NOT EXISTS vpn_gate_server_verdict (\n",
        "  ip text PRIMARY KEY NOT NULL,\n",
        "  verdict text NOT NULL,\n",
        "  updated_at integer DEFAULT (unixepoch()) NOT NULL,\n",
        "  CONSTRAINT vpn_gate_server_verdict_verdict_check\n",
        "    CHECK (verdict IN ('works', 'fails'))\n",
        ");\n",
    );

    fn sqlx_migrator(migrations: Vec<Migration>) -> Migrator {
        let migrations = migrations
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
            .collect();

        Migrator {
            migrations: Cow::Owned(migrations),
            ..Migrator::DEFAULT
        }
    }

    fn released_migrations_through_v5() -> Vec<Migration> {
        let mut migrations = application_migrations()
            .into_iter()
            .filter(|migration| migration.version <= 4)
            .collect::<Vec<_>>();
        migrations.push(Migration {
            version: 5,
            description: "create VPN Gate server verdicts",
            sql: RELEASED_MIGRATION_5_SQL,
            kind: MigrationKind::Up,
        });
        migrations
    }

    #[test]
    fn current_migrations_accept_released_v5_database() {
        tauri::async_runtime::block_on(async {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .expect("open in-memory database");
            sqlx_migrator(released_migrations_through_v5())
                .run(&pool)
                .await
                .expect("apply released migrations");

            sqlx::query(
                "INSERT INTO novel (id, plugin_id, path, name, in_library) \
                 VALUES (7, 'fixture-source', '/fixture-novel', 'Fixture Novel', 1)",
            )
            .execute(&pool)
            .await
            .expect("seed novel");
            sqlx::query(
                "INSERT INTO chapter (\
                   id, novel_id, path, name, position, progress, is_downloaded, \
                   content_type, stored_content_type\
                 ) VALUES (\
                   11, 7, '/chapter-11', 'Chapter 11', 11, 37, 1, 'text', 'html'\
                 )",
            )
            .execute(&pool)
            .await
            .expect("seed chapter");
            sqlx::query(
                "INSERT INTO vpn_gate_server_verdict (ip, verdict) \
                 VALUES ('198.51.100.7', 'works')",
            )
            .execute(&pool)
            .await
            .expect("seed released migration data");

            sqlx_migrator(application_migrations())
                .run(&pool)
                .await
                .expect("current migrations should accept released migration 5");

            let versions = sqlx::query_scalar::<_, i64>(
                "SELECT version FROM _sqlx_migrations ORDER BY version",
            )
            .fetch_all(&pool)
            .await
            .expect("read applied migrations");
            assert_eq!(versions, vec![1, 2, 3, 4, 5]);

            let chapter = sqlx::query_as::<_, (String, i64, String)>(
                "SELECT name, progress, stored_content_type FROM chapter WHERE id = 11",
            )
            .fetch_one(&pool)
            .await
            .expect("read preserved chapter");
            assert_eq!(chapter, ("Chapter 11".to_string(), 37, "html".to_string()));

            let verdict = sqlx::query_as::<_, (String, String)>(
                "SELECT ip, verdict FROM vpn_gate_server_verdict WHERE ip = '198.51.100.7'",
            )
            .fetch_one(&pool)
            .await
            .expect("read preserved migration data");
            assert_eq!(verdict, ("198.51.100.7".to_string(), "works".to_string()));
        });
    }
}
