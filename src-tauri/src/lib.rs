mod android_content_io;
mod android_file_open;
#[cfg(target_os = "android")]
mod android_lifecycle;
mod app_logging;
#[cfg(target_os = "android")]
mod android_tls;
mod backup;
mod chapter_media;
mod content_sync;
mod database;
mod db;
mod device_backup;
mod desktop_file_open;
mod device;
mod download_budget;
mod download_cache;
mod download_queue;
mod native_stream;
mod network;
mod plugin_host;
mod plugin_vpn;
mod scraper;
mod task_notifications;
mod tray;
mod update;
mod webview_resource_capture;

use tauri::Manager;

fn allow_main_navigation(label: &str, url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    if label != "main" || url.as_str() == "about:blank" {
        return true;
    }
    let bundled = (url.scheme() == "tauri"
        && url.host_str() == Some("localhost")
        && url.port().is_none())
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none());
    bundled || dev_url.is_some_and(|dev| url.origin() == dev.origin())
}

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
async fn set_runtime_log_level(level: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app_logging::set_runtime_level(&level))
        .await.map_err(|error| format!("Set native log level task: {error}"))?
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
    app_logging::install_panic_hook();
    if let Err(error) = app_logging::initialize("io.github.tinywind.norea") {
        eprintln!("Application logging initialization failed: {error}");
    }

    let plugin_vpn = plugin_vpn::PluginVpnState::bind()
        .expect("could not start the plugin VPN proxy");
    #[cfg(target_os = "windows")]
    let mut context = tauri::generate_context!();
    #[cfg(not(target_os = "windows"))]
    let context = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    {
        let main_window = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
            .expect("main WebView configuration is missing");
        main_window.additional_browser_args = Some(
            plugin_vpn::windows_webview_browser_args(
                main_window.additional_browser_args.as_deref(),
                plugin_vpn.proxy_port(),
            )
            .expect("main WebView proxy configuration conflicts with existing browser arguments"),
        );
    }
    let plugin_vpn_for_setup = plugin_vpn.clone();
    let download_vpn_workers = plugin_vpn::download_workers::DownloadVpnWorkers::bind()
        .expect("could not start the VPN download worker proxies");
    let desktop_open_files = desktop_file_open::DesktopOpenFileState::from_process_args();
    let builder = tauri::Builder::default();

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link().handle_cli_arguments(args.iter());
        desktop_file_open::enqueue_new_instance(app, args, cwd);
        tray::show_main_window(app);
    }));

    builder
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("local-logging")
                .setup(|app, _| {
                    if let Err(error) = app_logging::configure(app) {
                        eprintln!("Application log destination setup failed: {error}");
                    }
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("device-restore-guard")
                .setup(|app, _| device_backup::device_backup_restore_check(app.clone()).map_err(Into::into))
                .build(),
        )
        .plugin(
            tauri::plugin::Builder::<_, ()>::new("main-navigation")
                .on_navigation(|webview, url| {
                    let dev_url = cfg!(dev)
                        .then_some(webview.app_handle().config().build.dev_url.as_ref())
                        .flatten();
                    allow_main_navigation(webview.label(), url, dev_url)
                })
                .build(),
        )
        .manage(android_file_open::AndroidOpenFileState::default())
        .manage(desktop_open_files)
        .manage(native_stream::NativeStreamState::default())
        .manage(db::chapter_digest::ChapterDigestScanState::default())
        .manage(db::work_metadata::WorkMetadataRecoveryState::default())
        .manage(task_notifications::TaskNotificationState::default())
        .manage(plugin_vpn)
        .manage(download_vpn_workers)
        // Register plugins here, not in `setup`: registering a plugin after the
        // WebView exists deadlocks the Android main thread (tauri-apps/tauri#13990).
        .plugin(
            tauri_plugin_log::Builder::default()
                .skip_logger()
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("norea-media", |ctx, request| {
            chapter_media::norea_media_protocol_response(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
            device::get_default_device_name,
            db::repository::db_repo_list,
            db::repository::db_repo_add,
            db::repository::db_repo_set_enabled,
            db::repository::db_repo_reorder,
            db::repository::db_repo_remove,
            db::repository::db_plugin_list_installed,
            db::repository::db_plugin_upsert_installed,
            db::repository::db_plugin_delete_installed,
            db::repository::db_repo_cache_get,
            db::repository::db_repo_cache_list_all,
            db::repository::db_repo_cache_set,
            db::repository::db_repo_cache_delete,
            db::vpn::db_vpn_list_verdicts,
            db::vpn::db_vpn_plan_read,
            db::vpn::db_vpn_plan_list,
            db::vpn::db_vpn_plan_create,
            db::vpn::db_vpn_plan_get_range_jobs,
            db::vpn::db_vpn_plan_update,
            db::vpn::db_vpn_plan_settle_chapter,
            db::vpn::db_vpn_plan_cancel_range,
            db::vpn::db_vpn_plan_cancel,
            db::vpn::db_vpn_profile_issue_list,
            db::vpn::db_vpn_profile_issue_record,
            db::vpn::db_vpn_profile_issue_reallow,
            db::work_metadata::db_work_metadata_restore_directories,
            db::work_metadata::db_work_metadata_get_work_directory,
            db::work_metadata::db_work_metadata_apply_scanned_downloads,
            db::work_metadata::db_work_metadata_refresh_stored_downloads,
            db::work_metadata::db_work_metadata_flush_pending,
            db::work_metadata::db_work_metadata_rescan_work,
            db::work_metadata::db_work_metadata_read_sync_files,
            db::work_metadata::db_work_metadata_read_sync_file,
            db::work_metadata::db_work_metadata_persist_cover,
            db::work_metadata::db_work_metadata_inspect_install,
            db::work_metadata::db_work_metadata_reindex_preserved_work,
            db::work_metadata::db_work_metadata_install_stored,
            db::work_metadata::db_startup_recover_work_metadata,
            db::work_metadata::db_work_metadata_cancel_recovery,
            db::user_state::db_user_state_get_binding,
            db::user_state::db_user_state_list_work_categories,
            db::user_state::db_user_state_bind_workspace,
            db::user_state::db_user_state_rebind_workspace,
            db::user_state::db_user_state_reconcile_snapshot,
            db::user_state::db_user_state_apply_local_retention,
            db::user_state::db_user_state_prepare_operations,
            db::user_state::db_user_state_get_cursor,
            db::user_state::db_user_state_get_ledger_status,
            db::user_state::db_user_state_list_conflicts,
            db::user_state::db_user_state_list_deferred,
            db::user_state::db_user_state_apply_read_page,
            db::user_state::db_user_state_acknowledge_operations,
            db::user_state::db_user_state_prune_operations,
            db::user_state::db_user_state_resolve_conflict,
            db::user_state::db_user_state_project_pending,
            db::user_state::db_user_state_record_resume,
            db::user_state::db_user_state_record_resume_cleared,
            db::user_state::db_user_state_get_restore_paused,
            db::user_state::db_user_state_assert_available,
            db::user_state::db_user_state_resume_after_restore,
            db::category::db_category_list,
            db::category::db_category_get_library_counts,
            db::category::db_category_insert,
            db::category::db_category_update,
            db::category::db_category_reorder,
            db::category::db_category_delete,
            db::category::db_category_add_novels,
            db::category::db_category_remove_novels,
            db::category::db_category_count_novels_by_category,
            db::category::db_category_get_novel_ids,
            db::category::db_category_set_for_novel,
            db::category::db_maintenance_clear_library_membership,
            db::category::db_maintenance_clear_downloaded_chapter_content,
            db::category::db_maintenance_clear_updates_tab,
            db::category::db_maintenance_clear_reading_progress,
            db::novel::db_novel_list_library,
            db::novel::db_novel_list_library_page,
            db::novel::db_novel_list_library_ids,
            db::novel::db_novel_list_library_identities,
            db::novel::db_novel_get_library_summary,
            db::novel::db_novel_count_library_stored_chapters,
            db::novel::db_novel_list_library_source_filters,
            db::novel::db_novel_list_library_status_filters,
            db::novel::db_novel_list_library_tag_filters,
            db::novel::db_novel_list_library_refresh_targets,
            db::novel::db_novel_list_for_update_check,
            db::novel::db_novel_get_by_id,
            db::novel::db_novel_find_by_source,
            db::novel::db_novel_count,
            db::novel::db_novel_set_in_library,
            db::novel::db_novel_insert_if_absent,
            db::novel::db_novel_renumber_local_chapters,
            db::novel::db_novel_update_local_metadata,
            db::novel::db_novel_reorder_local_chapters,
            db::novel::db_novel_upsert_local,
            db::novel::db_novel_persist_chapter_directories,
            db::novel::db_novel_freshness_get,
            db::novel::db_novel_freshness_record_check,
            db::novel::db_novel_freshness_record_cover_fetched,
            db::novel::db_novel_freshness_list_candidates,
            db::novel::db_novel_freshness_count_recent_by_source,
            db::novel::db_novel_freshness_get_latest_library_check_at,
            db::novel::db_novel_goal_get,
            db::novel::db_novel_goal_list,
            db::novel::db_novel_goal_set,
            db::novel::db_novel_goal_list_novels,
            db::novel::db_novel_goal_list_ids_for_scope,
            db::novel::db_novel_goal_exclude_chapters,
            db::novel::db_novel_goal_list_excluded_chapter_ids,
            db::novel::db_novel_goal_resume_stopped,
            db::novel::db_novel_goal_list_library_without_goal,
            db::novel_override::db_novel_override_get,
            db::novel_override::db_novel_override_list,
            db::novel_override::db_novel_override_read_cover,
            db::novel_override::db_novel_override_set_field,
            db::novel_override::db_novel_override_update,
            db::novel_override::db_novel_override_merge,
            db::chapter::db_chapter_find_local_imported,
            db::chapter::db_chapter_list_by_novel,
            db::chapter::db_chapter_list_library_download,
            db::chapter::db_chapter_list_unqueued_downloads,
            db::chapter::db_chapter_get_by_id,
            db::chapter::db_chapter_list_existing_ids,
            db::chapter::db_chapter_get_latest_source_anchor,
            db::chapter::db_chapter_get_sync_since_anchor,
            db::chapter::db_chapter_get_adjacent,
            db::chapter::db_chapter_upsert_source,
            db::chapter::db_chapter_upsert_downloaded,
            db::chapter::db_chapter_insert_if_absent,
            db::chapter::db_chapter_upsert,
            db::chapter::db_chapter_update_progress,
            db::chapter::db_chapter_set_read_state,
            db::chapter::db_chapter_set_novels_read_state,
            db::chapter::db_chapter_restore_read_states,
            db::chapter::db_chapter_set_relative_read_state,
            db::chapter::db_chapter_mark_opened,
            db::chapter::db_chapter_clear_novel_history,
            db::chapter::db_chapter_set_bookmark,
            db::chapter::db_chapter_save_content_metadata,
            db::chapter::db_chapter_save_partial_content_metadata,
            db::chapter::db_chapter_mark_media_repair_pending,
            db::chapter::db_chapter_adopt_stored_content_metadata,
            db::chapter::db_chapter_mark_stored_content_missing,
            db::chapter::db_chapter_clear_content,
            db::chapter::db_chapter_list_library_updates,
            db::chapter::db_chapter_count_new_since,
            db::chapter::db_chapter_list_recently_read,
            db::chapter::db_chapter_list_continue_reading,
            db::chapter::db_chapter_list_reading_history_page,
            db::chapter::db_chapter_list_cleanup_candidates,
            db::chapter::db_chapter_reconcile_cleaned,
            db::chapter::db_chapter_get_storage_row,
            db::chapter::db_chapter_list_storage_rows,
            db::chapter_digest::db_chapter_resolve_payload_digests,
            db::chapter_digest::db_chapter_cancel_payload_digest_scan,
            db::chapter_digest::db_chapter_backfill_payload_digests,
            db::chapter::db_novel_sync_from_source,
            db::download::db_download_queue_list_ordinary,
            db::download::db_download_queue_list_pending_vpn,
            db::download::db_download_queue_enqueue_pending_vpn,
            db::download::db_download_queue_adopt_ordinary,
            db::download::db_download_queue_cancel_pending_vpn_batch,
            db::download::db_download_queue_cancel_pending_vpn_jobs,
            db::download::db_download_queue_set_pending_vpn_paused,
            db::download::db_download_failure_record,
            db::download::db_download_failure_clear,
            db::download::db_download_failure_get,
            db::download::db_download_failure_clear_scheduled_retries,
            db::download::db_download_failure_list,
            db::download::db_download_cache_list_novels,
            db::download::db_download_cache_list_chapters,
            db::download::db_download_cache_list_delete_candidates,
            db::download::db_download_cache_list_ordinary_queued_ids,
            db::download::db_download_cache_delete_chapter,
            db::download::db_download_cache_delete_novel,
            db::download::db_download_cache_delete_all,
            db::download::db_download_cache_list_media_backfill_candidates,
            db::download::db_download_cache_update_media_bytes,
            db::novel_merge::db_chapter_composition_get,
            db::novel_merge::db_novel_merge_find_target_preview,
            db::novel_merge::db_novel_merge_create_storage_journal,
            db::novel_merge::db_novel_merge_save_storage_preparation,
            db::novel_merge::db_novel_merge_commit_storage_journal,
            db::novel_merge::db_novel_merge_list_storage_journals,
            db::novel_merge::db_novel_merge_verify_storage_recovery,
            db::novel_merge::db_novel_merge_delete_storage_journal,
            db::novel_merge::db_novel_merge_apply,
            db::novel_merge::db_novel_merge_complete_incoming_migration,
            db::novel_merge::db_source_renumber_inspect_work,
            db::novel_merge::db_source_renumber_read_chapters,
            db::novel_merge::db_source_renumber_list_journals,
            db::novel_merge::db_source_renumber_read_journal,
            db::novel_merge::db_source_renumber_flush_and_read_work,
            db::novel_merge::db_source_renumber_create_journal,
            db::novel_merge::db_source_renumber_save_journal,
            db::novel_merge::db_source_renumber_apply_changes,
            db::novel_merge::db_source_renumber_commit,
            db::novel_merge::db_source_renumber_verify_recovery,
            db::novel_merge::db_source_renumber_delete_journal,
            db::content_sync::db_content_sync_cache_server_chapters,
            db::content_sync::db_content_sync_read_cache,
            db::content_sync::db_content_sync_write_cache,
            db::content_sync::db_content_sync_clear_download_proof,
            db::content_sync::db_content_sync_list_cache_entries,
            db::content_sync::db_content_sync_list_pending_renumber_reconciliations,
            db::content_sync::db_content_sync_list_chapters,
            db::content_sync::db_content_sync_list_untracked_chapters,
            db::content_sync::db_content_sync_can_upload_chapter,
            db::content_sync::db_content_sync_import_metadata,
            db::content_sync::db_content_sync_mark_installed,
            db::content_sync::db_content_sync_journal_head,
            db::content_sync::db_content_sync_read_journal,
            db::content_sync::db_content_sync_record_source_download,
            db::content_sync::db_content_sync_is_migration_source_held,
            db::content_sync::db_content_sync_record_pending_novel_merge,
            db::content_sync::db_content_sync_list_incoming_migration_summaries,
            db::content_sync::db_content_sync_read_incoming_migrations,
            db::content_sync::db_content_sync_save_incoming_migration,
            db::content_sync::db_content_sync_get_incoming_migration_cursor,
            db::content_sync::db_content_sync_save_incoming_migration_cursor,
            db::content_sync::db_content_sync_remember_incoming_migration_page,
            db::content_sync::db_content_deletion_list_stored_novel_ids,
            db::content_sync::db_content_deletion_list_downloaded_chapter_ids,
            db::content_sync::db_content_deletion_find_local_novel,
            db::content_sync::db_content_deletion_delete_novel_records,
            db::content_sync::db_content_deletion_verify_download_clear,
            db::content_sync::db_content_deletion_commit_download_clear,
            db::content_sync::db_content_deletion_list_novel_chapter_ids,
            content_sync::content_sync_create_stage,
            content_sync::content_sync_snapshot,
            content_sync::content_sync_fingerprint,
            content_sync::content_sync_remove_stage,
            content_sync::content_sync_upload,
            content_sync::content_sync_download,
            content_sync::content_sync_install,
            android_content_io::local_file_describe,
            android_content_io::local_file_read,
            android_file_open::android_open_file_url_take,
            backup::backup_gather_snapshot,
            backup::backup_list_cached_chapter_directories,
            backup::backup_pack,
            backup::backup_pack_bytes,
            backup::backup_publish_auto,
            backup::backup_restore_snapshot,
            backup::backup_unpack,
            device_backup::device_backup_create,
            device_backup::device_backup_inspect,
            device_backup::device_backup_restore,
            device_backup::device_backup_restore_check,
            device_backup::device_backup_restore_complete,
            device_backup::device_backup_cleanup,
            device_backup::device_backup_upload,
            device_backup::device_backup_download,
            chapter_media::chapter_content_mirror_clear,
            chapter_media::chapter_content_mirror_inspect,
            chapter_media::chapter_payload_inventory,
            chapter_media::chapter_payload_delete,
            chapter_media::chapter_payload_delete_fast,
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
            chapter_media::chapter_media_pick_storage_root,
            chapter_media::chapter_media_prepare_reader_cache,
            chapter_media::chapter_media_prepare_workspace,
            chapter_media::chapter_media_prune,
            chapter_media::chapter_media_read_manifest,
            chapter_media::chapter_media_rollback_restore,
            chapter_media::chapter_media_set_storage_root,
            chapter_media::chapter_media_store_handle,
            chapter_media::chapter_media_stored_entry_sizes,
            chapter_media::chapter_media_total_size,
            chapter_media::chapter_media_use_default_storage_root,
            chapter_media::chapter_media_write_manifest,
            chapter_media::chapter_storage_prune_dir_children,
            chapter_media::chapter_storage_prepare_transfer,
            chapter_media::chapter_storage_finalize_transfer,
            chapter_media::chapter_storage_relocate_dir,
            chapter_media::chapter_storage_remove_dir,
            chapter_media::chapter_storage_rollback_transfer,
            chapter_media::work_metadata_operation,
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
            network::network_status,
            download_budget::download_budget_status,
            plugin_host::plugin_zip_list,
            plugin_host::plugin_zip_read_file,
            plugin_vpn::state::plugin_vpn_apply_finder_profile,
            plugin_vpn::state::plugin_vpn_apply_saved_profile,
            plugin_vpn::state::plugin_vpn_capture_saved_profile,
            plugin_vpn::state::plugin_vpn_list_saved_profiles,
            plugin_vpn::state::plugin_vpn_list_manual_profiles,
            plugin_vpn::state::plugin_vpn_sync_stored_profiles,
            plugin_vpn::state::plugin_vpn_revoke_saved_profile,
            plugin_vpn::state::plugin_vpn_set_saved_profile_limit,
            plugin_vpn::state::plugin_vpn_list_automatic_profiles,
            plugin_vpn::state::plugin_vpn_approve_working_automatic_profiles,
            plugin_vpn::state::plugin_vpn_record_automatic_profile_result,
            plugin_vpn::state::plugin_vpn_test_automatic_candidate,
            plugin_vpn::state::plugin_vpn_prepare_automatic_candidate_test,
            plugin_vpn::state::plugin_vpn_cancel_automatic_candidate_test,
            plugin_vpn::state::plugin_vpn_test_profile_url,
            plugin_vpn::state::plugin_vpn_cancel_url_test,
            plugin_vpn::state::plugin_vpn_cancel_finder_query,
            plugin_vpn::state::plugin_vpn_connect,
            plugin_vpn::state::plugin_vpn_disconnect,
            plugin_vpn::state::plugin_vpn_release_profile,
            plugin_vpn::state::plugin_vpn_load_finder_servers,
            plugin_vpn::state::plugin_vpn_import_profile,
            plugin_vpn::state::plugin_vpn_remove_profile,
            plugin_vpn::state::plugin_vpn_status,
            plugin_vpn::state::plugin_vpn_check_health,
            plugin_vpn::state::plugin_vpn_transport_cursor,
            plugin_vpn::state::plugin_vpn_transport_failure,
            scraper::scraper_reset_vpn_session,
            plugin_vpn::download_workers::plugin_vpn_download_worker_connect,
            plugin_vpn::download_workers::plugin_vpn_download_worker_disconnect,
            plugin_vpn::download_workers::plugin_vpn_download_worker_status,
            plugin_vpn::download_workers::plugin_vpn_download_worker_validate,
            plugin_vpn::download_workers::plugin_vpn_download_workers_stop,
            plugin_vpn::download_workers::plugin_vpn_download_workers_generation_floor,
            scraper::webview_fetch,
            scraper::scraper_take_captured_resource,
            scraper::scraper_take_captured_resource_handle,
            scraper::webview_extract,
            scraper::scraper_cancel_executor,
            scraper::scraper_navigate,
            scraper::scraper_set_bounds,
            scraper::scraper_hide,
            scraper::scraper_current_origin,
            scraper::scraper_current_url,
            scraper::scraper_clear_cache,
            scraper::scraper_clear_cookies,
            scraper::scraper_open_devtools,
            set_runtime_log_level,
            app_logging::record_frontend_crash,
            task_notifications::task_notification_reconcile,
            tray::tray_set_task_progress,
            update::download_and_open_update,
            update::get_build_info,
            update::open_downloaded_update,
            update::open_downloaded_update_handle,
            write_frontend_log,
        ])
        .setup(move |app| {
            database::install_sqlite_pools(app.handle())
                .map_err(|err| format!("database init: {err}"))?;
            native_stream::cleanup_startup(app.handle())
                .map_err(|err| format!("native stream init: {err}"))?;
            plugin_vpn_for_setup
                .initialize(app.handle())
                .map_err(|err| format!("plugin VPN init: {err}"))?;
            network::initialize(app.handle());
            plugin_vpn_for_setup.watch_network(app.handle());
            app.state::<plugin_vpn::download_workers::DownloadVpnWorkers>().watch_network(app.handle());
            app.manage(scraper::ScraperState::default());
            tray::init(app).map_err(|err| format!("tray init: {err}"))?;
            scraper::init_scraper(app.handle()).map_err(|err| format!("scraper init: {err}"))?;
            #[cfg(target_os = "android")]
            android_lifecycle::initialize(app.handle())
                .map_err(|err| format!("Android lifecycle init: {err}"))?;
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "android")]
            match _event {
                tauri::RunEvent::Opened { urls } => android_file_open::enqueue_opened_urls(_app, urls),
                tauri::RunEvent::ExitRequested { code: None, api, .. } => {
                    // Activity replacement must not terminate the process hosting its successor.
                    api.prevent_exit();
                    android_lifecycle::request_main_window_restore();
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    #[test]
    fn main_navigation_keeps_app_routes_and_rejects_remote_documents() {
        for url in [
            "tauri://localhost/reader?id=1",
            "http://tauri.localhost/library",
            "https://tauri.localhost/settings#appearance",
            "about:blank",
        ] {
            assert!(allow_main_navigation("main", &url.parse().unwrap(), None), "{url}");
        }
        for url in [
            "https://source.test/chapter",
            "https://tauri.localhost.foreign.test/",
            "http://tauri.localhost:8080/",
            "content://documents/private",
            "file:///data/user/0/app/private",
            "javascript:alert(1)",
            "data:text/html,private",
        ] {
            let parsed = url.parse().unwrap();
            assert!(!allow_main_navigation("main", &parsed, None), "{url}");
            assert!(allow_main_navigation("scraper-fixture", &parsed, None), "{url}");
        }
    }

    #[test]
    fn main_development_navigation_requires_the_configured_origin() {
        let dev_url = "http://dev-norea.test:1420/".parse().unwrap();
        for url in ["http://dev-norea.test:1420/reader", "http://dev-norea.test:1420/settings"] {
            assert!(allow_main_navigation("main", &url.parse().unwrap(), Some(&dev_url)));
            assert!(!allow_main_navigation("main", &url.parse().unwrap(), None));
        }
        for url in ["https://dev-norea.test:1420/", "http://dev-norea.test:1421/", "http://foreign.test:1420/"] {
            assert!(!allow_main_navigation("main", &url.parse().unwrap(), Some(&dev_url)));
        }
    }
}

#[cfg(test)]
mod android_ipc_channel_regression_tests {
    use std::str::FromStr;
    use std::sync::{Arc, Mutex};

    use serde::Serialize;
    use serde_json::json;
    use tauri::ipc::{Channel, InvokeResponseBody, JavaScriptChannelId, Response};
    use tauri::test::{
        INVOKE_KEY, app_manager_strong_count, mobile_channel_is_registered, mock_builder,
        mock_context, noop_assets, send_mobile_channel_data, send_post_message_ipc,
        unregister_mobile_channel,
    };

    #[tauri::command]
    fn ipc_echo_object() -> serde_json::Value {
        json!({ "ok": true })
    }

    #[tauri::command]
    fn ipc_echo_array() -> serde_json::Value {
        json!([1, 2, 3])
    }

    #[tauri::command]
    fn ipc_echo_large_json() -> serde_json::Value {
        json!({ "payload": "x".repeat(16_384) })
    }

    #[tauri::command]
    fn ipc_echo_raw() -> Response {
        Response::new(vec![1u8, 2, 3, 4, 5, 6, 7, 8])
    }

    #[test]
    fn post_message_ipc_responses_do_not_leak_mobile_channels_or_webviews() {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                ipc_echo_object,
                ipc_echo_array,
                ipc_echo_large_json,
                ipc_echo_raw,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        let window =
            tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
                .build()
                .unwrap();
        let origin = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };

        let baseline_refs = app_manager_strong_count(&app);

        for round in 0..25u32 {
            for (offset, cmd) in [
                (0u32, "ipc_echo_object"),
                (1u32, "ipc_echo_array"),
                (2u32, "ipc_echo_large_json"),
                (3u32, "ipc_echo_raw"),
            ] {
                let callback_id = 930_000 + round * 10 + offset;
                let error_id = 931_000 + round * 10 + offset;
                let body = serde_json::to_string(&json!({
                    "cmd": cmd,
                    "callback": callback_id,
                    "error": error_id,
                    "payload": {},
                    "__TAURI_INVOKE_KEY__": INVOKE_KEY,
                }))
                .unwrap();
                send_post_message_ipc(&app, window.label(), origin, body);

                assert!(
                    !mobile_channel_is_registered(callback_id),
                    "one-shot postMessage response for `{cmd}` must not register in MOBILE_CHANNELS"
                );
            }
        }

        assert_eq!(
            app_manager_strong_count(&app),
            baseline_refs,
            "100 postMessage IPC responses must retain zero additional Webview/AppHandle references"
        );
    }

    #[test]
    fn mobile_plugin_channels_stay_active_while_rust_command_channels_drop() {
        #[derive(Serialize)]
        struct PluginEventArgs {
            handler: Channel,
        }

        let delivered = Arc::new(Mutex::new(Vec::<String>::new()));
        let delivered_clone = delivered.clone();
        let plugin_channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(payload) = body {
                delivered_clone.lock().unwrap().push(payload);
            }
            Ok(())
        });
        let plugin_channel_id = plugin_channel.id();
        let wire = serde_json::to_value(PluginEventArgs {
            handler: plugin_channel,
        })
        .unwrap();
        assert_eq!(wire["handler"], format!("__CHANNEL__:{plugin_channel_id}"));
        assert!(mobile_channel_is_registered(plugin_channel_id));
        assert!(send_mobile_channel_data(
            plugin_channel_id,
            json!({ "url": "norea://chapter/1" })
        ));
        assert_eq!(
            delivered.lock().unwrap().as_slice(),
            &[r#"{"url":"norea://chapter/1"}"#.to_string()]
        );
        unregister_mobile_channel(plugin_channel_id);
        assert!(!mobile_channel_is_registered(plugin_channel_id));

        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let window =
            tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
                .build()
                .unwrap();
        let baseline_refs = app_manager_strong_count(&app);

        let rust_only_id = 940_001u32;
        let rust_only = JavaScriptChannelId::from_str(&format!("__CHANNEL__:{rust_only_id}"))
            .unwrap()
            .channel_on::<_, serde_json::Value>(window.as_ref().clone());
        assert!(!mobile_channel_is_registered(rust_only_id));
        rust_only.send(json!({ "progress": 1 })).unwrap();
        drop(rust_only);
        assert!(!mobile_channel_is_registered(rust_only_id));
        assert_eq!(app_manager_strong_count(&app), baseline_refs);

        let forwarded_id = 940_002u32;
        let forwarded = JavaScriptChannelId::from_str(&format!("__CHANNEL__:{forwarded_id}"))
            .unwrap()
            .channel_on::<_, serde_json::Value>(window.as_ref().clone());
        let _serialized = serde_json::to_string(&forwarded).unwrap();
        drop(forwarded);
        assert!(mobile_channel_is_registered(forwarded_id));
        assert!(
            app_manager_strong_count(&app) > baseline_refs,
            "registered mobile channel must keep its Webview alive until unregistered"
        );
        unregister_mobile_channel(forwarded_id);
        assert!(!mobile_channel_is_registered(forwarded_id));
        assert_eq!(app_manager_strong_count(&app), baseline_refs);
    }
}
