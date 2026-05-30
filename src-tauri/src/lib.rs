#[cfg(target_os = "android")]
mod android_tls;
mod backup;
mod chapter_media;
mod download_queue;
mod native_stream;
mod plugin_host;
mod scraper;
mod tray;
mod update;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
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
    ];

    let builder = tauri::Builder::default();

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    builder
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
        .invoke_handler(tauri::generate_handler![
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
            chapter_media::chapter_content_mirror_read_file,
            chapter_media::chapter_content_mirror_store,
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
            chapter_media::chapter_storage_relocate_dir,
            chapter_media::chapter_storage_remove_dir,
            download_queue::chapter_download_queue_enqueue,
            download_queue::chapter_download_queue_lease,
            download_queue::chapter_download_queue_remove,
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
            scraper::scraper_media_fetch,
            scraper::webview_extract,
            scraper::scraper_cancel_executor,
            scraper::scraper_navigate,
            scraper::scraper_set_bounds,
            scraper::scraper_hide,
            scraper::scraper_poll_control_message,
            scraper::scraper_clear_cookies,
            scraper::scraper_open_devtools,
            set_runtime_log_level,
            tray::tray_set_task_progress,
            update::download_and_open_update,
            update::get_build_info,
            update::open_downloaded_update,
            update::open_downloaded_update_handle,
            write_frontend_log,
        ])
        .setup(|app| {
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
