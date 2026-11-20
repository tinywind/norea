pub mod core;
pub mod ledger;
pub mod materialize;
pub mod migration;
pub mod stored_chapter;
pub mod types;
pub mod work_categories;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;

use super::tx::{with_write_tx, MetadataRoot, TxOptions};
use super::{DbMutationEnvelope, ReadMode};

pub use core::{
    assert_user_state_available_in_tx, chapter_reference_json, chapter_work_json,
    has_user_state_schema_in_tx, load_user_chapter_rows_by_ids_in_tx, record_resume_cleared_in_tx,
    record_user_state_changes_in_tx, user_state_restore_paused_in_tx, workspace_rows_in_tx,
};
pub use ledger::{
    acknowledge_user_state_operations_in_tx, apply_local_user_state_retention_in_tx,
    apply_user_state_read_page_in_tx, bind_user_state_workspace_with_options_in_tx,
    get_user_state_cursor_in_tx, get_user_state_ledger_status_in_tx,
    list_user_state_conflicts_in_tx, list_user_state_deferred_in_tx,
    prepare_user_state_operations_in_tx, project_pending_user_state_bounded_in_tx,
    prune_acknowledged_user_state_operations_in_tx, rebind_user_state_workspace_in_tx,
    reconcile_user_state_snapshot_in_tx, resolve_user_state_ledger_conflict_in_tx,
    PrepareUserStateOperationsLimitsDto, DEFAULT_USER_STATE_OPERATION_RETENTION_SECS,
};
pub use materialize::{
    defer_user_state_for_novel_in_tx, refresh_unattempted_user_state_identities_in_tx,
};
pub use work_categories::{WorkCategoriesDto, WorkCategoryLookupDto};
pub use types::{
    anchor_to_json, parse_portable_reader_anchor, ResolveUserStateLedgerConflictInputDto,
    UserStateApplyEffectsDto, UserStateBindingDto, UserStateConflictDto, UserStateCursorDto,
    UserStateDeferredDto, UserStateLedgerStatusDto, UserStateRebindMode,
};

const USER_STATE_BUSY_RETRIES: u32 = 3;
const MAX_SAFE_INT_I64: i64 = 9_007_199_254_740_991;

fn ledger_tx_options() -> TxOptions {
    TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: USER_STATE_BUSY_RETRIES,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    }
}

#[tauri::command]
pub async fn db_user_state_list_work_categories(
    db: State<'_, AppDatabase>,
    server_url: String,
    works: Vec<WorkCategoryLookupDto>,
    mode: Option<ReadMode>,
) -> Result<Vec<WorkCategoriesDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    work_categories::list_work_categories_in_conn(&mut conn, &server_url, &works).await
}

#[tauri::command]
pub async fn db_user_state_get_binding(
    db: State<'_, AppDatabase>,
    server_url: Option<String>,
    mode: Option<ReadMode>,
) -> Result<Option<UserStateBindingDto>, String> {
    let Some(target_url) = server_url else {
        return Ok(None);
    };
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    if !has_user_state_schema_in_tx(&mut conn).await? {
        return Ok(None);
    }
    let rows = workspace_rows_in_tx(&mut conn).await?;
    Ok(rows
        .into_iter()
        .find(|r| r.server_url == target_url)
        .map(|r| UserStateBindingDto {
            server_url: r.server_url,
            workspace_id: r.workspace_id,
            epoch: r.epoch,
        }))
}

#[tauri::command]
pub async fn db_user_state_bind_workspace(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    seed_allowed: Option<bool>,
    seed_cutoff_ms: Option<i64>,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                bind_user_state_workspace_with_options_in_tx(
                    conn,
                    ctx,
                    &binding,
                    seed_allowed,
                    seed_cutoff_ms,
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_rebind_workspace(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    mode: UserStateRebindMode,
    head_revision: Option<i64>,
    seed_cutoff_ms: Option<i64>,
    seed_allowed: Option<bool>,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                rebind_user_state_workspace_in_tx(
                    conn,
                    ctx,
                    &binding,
                    mode,
                    head_revision,
                    seed_cutoff_ms,
                    seed_allowed,
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_reconcile_snapshot(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    records: Vec<JsonValue>,
    snapshot_revision: i64,
    seed_allowed: Option<bool>,
    seed_cutoff_ms: Option<i64>,
    skipped_chapter_ids: Option<Vec<i64>>,
) -> Result<DbMutationEnvelope<UserStateApplyEffectsDto>, String> {
    let resolved_root = crate::chapter_media::media_root(&app).ok();
    let skipped: HashSet<i64> = skipped_chapter_ids.unwrap_or_default().into_iter().collect();
    let opts = TxOptions {
        remote_content_sync: true,
        notify_content_sync: false,
        busy_begin_retries: USER_STATE_BUSY_RETRIES,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    };
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move {
            reconcile_user_state_snapshot_in_tx(
                resolved_root.as_deref(),
                conn,
                ctx,
                &binding,
                &records,
                snapshot_revision,
                seed_allowed,
                seed_cutoff_ms,
                &skipped,
            )
            .await
        })
    })
    .await
}

#[tauri::command]
pub async fn db_user_state_apply_local_retention(
    db: State<'_, AppDatabase>,
    prune_non_library_days: Option<i64>,
    strip_timestamps_days: Option<i64>,
    now_ms: Option<i64>,
) -> Result<DbMutationEnvelope<u64>, String> {
    let reference_now_ms = now_ms.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    });
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                apply_local_user_state_retention_in_tx(
                    conn,
                    ctx,
                    prune_non_library_days,
                    strip_timestamps_days,
                    reference_now_ms,
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_prepare_operations(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    limits: Option<PrepareUserStateOperationsLimitsDto>,
) -> Result<DbMutationEnvelope<Vec<JsonValue>>, String> {
    let resolved_root = crate::chapter_media::media_root(&app).ok();
    let limits = limits.unwrap_or_default();
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                refresh_unattempted_user_state_identities_in_tx(conn, None).await?;
                prepare_user_state_operations_in_tx(
                    resolved_root.as_deref(),
                    conn,
                    ctx,
                    &binding,
                    &limits,
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_get_cursor(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    mode: Option<ReadMode>,
) -> Result<UserStateCursorDto, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    get_user_state_cursor_in_tx(&mut conn, &binding).await
}

#[tauri::command]
pub async fn db_user_state_get_ledger_status(
    db: State<'_, AppDatabase>,
    binding: Option<UserStateBindingDto>,
    mode: Option<ReadMode>,
) -> Result<UserStateLedgerStatusDto, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    get_user_state_ledger_status_in_tx(&mut conn, binding.as_ref()).await
}

#[tauri::command]
pub async fn db_user_state_list_conflicts(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    mode: Option<ReadMode>,
) -> Result<Vec<UserStateConflictDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    list_user_state_conflicts_in_tx(&mut conn, &binding).await
}

#[tauri::command]
pub async fn db_user_state_list_deferred(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    mode: Option<ReadMode>,
) -> Result<Vec<UserStateDeferredDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    list_user_state_deferred_in_tx(&mut conn, &binding).await
}

#[tauri::command]
pub async fn db_user_state_apply_read_page(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    page: JsonValue,
) -> Result<DbMutationEnvelope<UserStateApplyEffectsDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                apply_user_state_read_page_in_tx(conn, ctx, &binding, &page).await?;
                Ok(UserStateApplyEffectsDto::default())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_acknowledge_operations(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    results: Vec<JsonValue>,
) -> Result<DbMutationEnvelope<UserStateApplyEffectsDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                acknowledge_user_state_operations_in_tx(conn, ctx, &binding, &results).await?;
                Ok(UserStateApplyEffectsDto::default())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_prune_operations(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    older_than_secs: Option<i64>,
) -> Result<DbMutationEnvelope<u64>, String> {
    let retention = older_than_secs.unwrap_or(DEFAULT_USER_STATE_OPERATION_RETENTION_SECS);
    let envelope = with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                prune_acknowledged_user_state_operations_in_tx(conn, ctx, &binding, retention).await
            })
        },
    )
    .await?;
    if envelope.value > 0 {
        if let Err(err) = db.reclaim_space(None).await {
            log::warn!("[user-state] space reclaim after operation pruning failed: {err}");
        }
    }
    Ok(envelope)
}

#[tauri::command]
pub async fn db_user_state_resolve_conflict(
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    input: ResolveUserStateLedgerConflictInputDto,
) -> Result<DbMutationEnvelope<UserStateApplyEffectsDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                resolve_user_state_ledger_conflict_in_tx(conn, ctx, &binding, &input).await?;
                Ok(UserStateApplyEffectsDto::default())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_project_pending(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    binding: UserStateBindingDto,
    skipped_chapter_ids: Option<Vec<i64>>,
    limit: Option<usize>,
    skip_entity_keys: Option<Vec<String>>,
) -> Result<DbMutationEnvelope<UserStateApplyEffectsDto>, String> {
    let resolved_root = crate::chapter_media::media_root(&app).ok();
    let skipped: HashSet<i64> = skipped_chapter_ids.unwrap_or_default().into_iter().collect();
    let skipped_entities: HashSet<String> = skip_entity_keys.unwrap_or_default().into_iter().collect();
    let opts = TxOptions {
        remote_content_sync: true,
        notify_content_sync: false,
        busy_begin_retries: USER_STATE_BUSY_RETRIES,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    };
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move {
            project_pending_user_state_bounded_in_tx(
                resolved_root.as_deref(),
                conn,
                ctx,
                &binding,
                &skipped,
                limit,
                &skipped_entities,
            )
            .await
        })
    })
    .await
}

#[tauri::command]
pub async fn db_user_state_record_resume(
    db: State<'_, AppDatabase>,
    chapter_id: i64,
    anchor: Option<JsonValue>,
    opened_at: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    if !(0..=MAX_SAFE_INT_I64).contains(&opened_at) {
        return Err("Reader opened time must be in whole seconds.".to_string());
    }
    let anchor_json = match anchor {
        None | Some(JsonValue::Null) => JsonValue::Null,
        Some(ref raw) => {
            let parsed = parse_portable_reader_anchor(raw)?;
            anchor_to_json(&parsed)?
        }
    };
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                if !has_user_state_schema_in_tx(conn).await? {
                    return Ok(());
                }
                let rows = load_user_chapter_rows_by_ids_in_tx(conn, &[chapter_id]).await?;
                if let Some(row) = rows.first() {
                    record_user_state_changes_in_tx(
                        conn,
                        ctx,
                        &[(
                            json!({ "kind": "resume", "work": chapter_work_json(row) }),
                            json!({
                                "chapter": chapter_reference_json(row),
                                "anchor": anchor_json,
                                "openedAt": opened_at,
                            }),
                        )],
                        false,
                    )
                    .await?;
                }
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_record_resume_cleared(
    db: State<'_, AppDatabase>,
    novel_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(
                async move { record_resume_cleared_in_tx(conn, ctx, Some(&[novel_id])).await },
            )
        },
    )
    .await
}

#[tauri::command]
pub async fn db_user_state_get_restore_paused(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<bool, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    user_state_restore_paused_in_tx(&mut conn).await
}

#[tauri::command]
pub async fn db_user_state_assert_available(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<(), String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db user state: acquire read connection: {err}"))?;
    assert_user_state_available_in_tx(&mut conn).await
}

#[tauri::command]
pub async fn db_user_state_resume_after_restore(
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        ledger_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                sqlx::query("UPDATE user_state_restore_state SET paused = 0 WHERE id = 1")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: clear restore pause: {err}"))?;
                sqlx::query(
                    "UPDATE user_state_record \
                     SET applied_revision = 0, deferred_reason = NULL, deferred_detail = NULL \
                     WHERE COALESCE(json_extract(payload, '$.entity.kind'), '') <> 'library'",
                )
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: reopen records after restore: {err}"))?;
                ctx.record_user_state_ledger_change();
                Ok(())
            })
        },
    )
    .await
}
