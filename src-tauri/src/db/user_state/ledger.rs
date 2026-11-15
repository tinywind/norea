use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};

use crate::db::tx::TxContext;

use super::core::{
    assert_user_state_available_in_tx, canonical_entity_in_tx, chapter_reference_json,
    chapter_work_json, has_user_state_schema_in_tx, intent_from_row, map_user_chapter_row,
    record_user_state_changes_in_tx, require_binding_in_tx, resolve_category_alias_in_tx,
    seed_user_state_in_tx, user_state_restore_paused_in_tx, workspace_rows_in_tx, IntentRow,
    USER_CHAPTER_SELECT,
};
use super::current::{is_current_work_held, load_current_held_sources_in_tx};
use super::materialize::{materialize_user_state_record_with_options_in_tx, MaterializeError};
use super::stored_chapter::portable_stored_user_state_intent_in_tx;
use super::types::{
    canonical_user_state_json, is_local_user_state_entity, namespace_for, parse_user_state_entity,
    parse_user_state_merge_result, parse_user_state_operation, parse_user_state_read_response,
    parse_user_state_record, random_uuid_v4, user_state_entity_key, user_state_json_bytes,
    CategoryAliasPair, ParsedUserStateMergeResult, ParsedUserStateOperation,
    ParsedUserStateRecord, ResolveUserStateLedgerConflictInputDto, UserStateApplyEffectsDto,
    UserStateBindingDto, UserStateConflictDto, UserStateDeferredDto, UserStateLedgerStatusDto,
    UserStateWorkReferenceDto, USER_STATE_CLIENT_BATCH_BYTES, USER_STATE_PRELINK_BASE_REVISION,
};

const USER_STATE_DB_BATCH_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUserStateOperationsLimitsDto {
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
    #[serde(default)]
    pub allow_opaque_identity: Option<bool>,
    #[serde(default)]
    pub skipped_chapter_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone)]
struct OperationRow {
    operation_id: String,
    entity_key: String,
    intent_sequence: i64,
    payload: String,
    receipt: Option<String>,
}

#[derive(Debug, Clone)]
struct StoredRecordRow {
    entity_key: String,
    revision: i64,
    applied_revision: i64,
    payload: String,
    deletion_revision: i64,
}

pub async fn purge_and_settle_local_user_state_in_tx(
    conn: &mut SqliteConnection,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM user_state_operation \
         WHERE json_extract(payload, '$.entity.work.pluginId') = 'local' \
            OR (json_extract(payload, '$.entity.kind') = 'composition' \
                AND EXISTS ( \
                  SELECT 1 FROM json_each(payload, '$.value.composition.entries') e, \
                                json_each(e.value, '$.sources') s \
                  WHERE json_extract(s.value, '$.pluginId') = 'local' \
                ))",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: purge local operations: {err}"))?;

    sqlx::query(
        "DELETE FROM user_state_conflict \
         WHERE entity_key IN ( \
           SELECT entity_key FROM user_state_intent \
           WHERE json_extract(entity_json, '$.work.pluginId') = 'local' \
              OR (json_extract(entity_json, '$.kind') = 'composition' \
                  AND EXISTS ( \
                    SELECT 1 FROM json_each(value_json, '$.composition.entries') e, \
                                  json_each(e.value, '$.sources') s \
                    WHERE json_extract(s.value, '$.pluginId') = 'local' \
                  )) \
         )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: purge local conflicts: {err}"))?;

    sqlx::query(
        "DELETE FROM user_state_progress \
         WHERE entity_key IN ( \
           SELECT entity_key FROM user_state_intent \
           WHERE json_extract(entity_json, '$.work.pluginId') = 'local' \
              OR (json_extract(entity_json, '$.kind') = 'composition' \
                  AND EXISTS ( \
                    SELECT 1 FROM json_each(value_json, '$.composition.entries') e, \
                                  json_each(e.value, '$.sources') s \
                    WHERE json_extract(s.value, '$.pluginId') = 'local' \
                  )) \
         )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: purge local progress: {err}"))?;

    sqlx::query(
        "DELETE FROM user_state_intent \
         WHERE json_extract(entity_json, '$.work.pluginId') = 'local' \
            OR (json_extract(entity_json, '$.kind') = 'composition' \
                AND EXISTS ( \
                  SELECT 1 FROM json_each(value_json, '$.composition.entries') e, \
                                json_each(e.value, '$.sources') s \
                  WHERE json_extract(s.value, '$.pluginId') = 'local' \
                ))",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: purge local intents: {err}"))?;

    sqlx::query(
        "UPDATE user_state_record \
         SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL \
         WHERE (applied_revision < revision OR deferred_reason IS NOT NULL) \
           AND ( \
             json_extract(payload, '$.entity.work.pluginId') = 'local' \
             OR (json_extract(payload, '$.entity.kind') = 'composition' \
                 AND EXISTS ( \
                   SELECT 1 FROM json_each(payload, '$.value.composition.entries') e, \
                                 json_each(e.value, '$.sources') s \
                   WHERE json_extract(s.value, '$.pluginId') = 'local' \
                 )) \
           )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: settle local records: {err}"))?;

    Ok(())
}

async fn settle_held_source_records_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    server_url: &str,
) -> Result<u64, String> {
    let held = load_current_held_sources_in_tx(conn, server_url).await?;
    if held.id_pairs.is_empty() && held.paths.is_empty() {
        return Ok(0);
    }
    let id_json: Vec<JsonValue> = held
        .id_pairs
        .iter()
        .map(|(plugin_id, novel_id)| json!({ "pluginId": plugin_id, "sourceNovelId": novel_id }))
        .collect();
    let path_json: Vec<JsonValue> = held
        .paths
        .iter()
        .map(|(plugin_id, novel_path)| json!({ "pluginId": plugin_id, "novelPath": novel_path }))
        .collect();
    let encoded_ids = serde_json::to_string(&id_json).unwrap();
    let encoded_paths = serde_json::to_string(&path_json).unwrap();
    let res = sqlx::query(
        "UPDATE user_state_record \
         SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL \
         WHERE namespace = ?1 \
           AND (applied_revision < revision OR deferred_reason IS NOT NULL) \
           AND json_extract(payload, '$.entity.kind') <> 'category' \
           AND ( \
             (json_extract(payload, '$.entity.work.sourceNovelId') IS NOT NULL \
              AND EXISTS ( \
                SELECT 1 FROM json_each(?2) h \
                WHERE json_extract(h.value, '$.pluginId') = json_extract(user_state_record.payload, '$.entity.work.pluginId') \
                  AND json_extract(h.value, '$.sourceNovelId') = lower(json_extract(user_state_record.payload, '$.entity.work.sourceNovelId')) \
              )) \
             OR EXISTS ( \
               SELECT 1 FROM json_each(?3) hp \
               WHERE json_extract(hp.value, '$.pluginId') = json_extract(user_state_record.payload, '$.entity.work.pluginId') \
                 AND json_extract(hp.value, '$.novelPath') = json_extract(user_state_record.payload, '$.entity.work.novelPath') \
             ) \
           )",
    )
    .bind(namespace)
    .bind(&encoded_ids)
    .bind(&encoded_paths)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: settle held migration source records: {err}"))?;
    Ok(res.rows_affected())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_batches<'a, T, F>(rows: &'a [T], size: F) -> Vec<&'a [T]>
where
    F: Fn(&T) -> usize,
{
    let mut batches: Vec<&'a [T]> = Vec::new();
    let mut start = 0;
    let mut bytes = 2_usize;
    for (idx, row) in rows.iter().enumerate() {
        let row_bytes = size(row).saturating_add(1);
        if idx > start && bytes.saturating_add(row_bytes) > USER_STATE_DB_BATCH_BYTES {
            batches.push(&rows[start..idx]);
            start = idx;
            bytes = 2;
        }
        bytes = bytes.saturating_add(row_bytes);
    }
    if start < rows.len() {
        batches.push(&rows[start..]);
    }
    batches
}

pub async fn bind_user_state_workspace_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    if binding.server_url.is_empty() || binding.workspace_id.is_empty() || binding.epoch.is_empty()
    {
        return Err("A complete personal state workspace is required.".to_string());
    }
    let namespace = namespace_for(binding);
    let existing = workspace_rows_in_tx(conn)
        .await?
        .into_iter()
        .any(|row| row.server_url == binding.server_url);
    if existing {
        require_binding_in_tx(conn, binding).await?;
    } else {
        sqlx::query(
            "INSERT INTO user_state_workspace(server_url, namespace, workspace_id, epoch) \
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&binding.server_url)
        .bind(&namespace)
        .bind(&binding.workspace_id)
        .bind(&binding.epoch)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: insert workspace: {err}"))?;
    }

    sqlx::query(
        "DELETE FROM user_state_conflict WHERE namespace = ?1 AND reason = 'revision-mismatch'",
    )
    .bind(&namespace)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clear revision-mismatch conflicts: {err}"))?;

    purge_and_settle_local_user_state_in_tx(conn).await?;

    let ready_key = format!("user-state-delta-ready:{namespace}");
    let ready: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM content_sync_cache WHERE cache_key = ?1",
    )
    .bind(&ready_key)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db user state: check delta ready: {err}"))?;
    if ready != 0 {
        ctx.record_user_state_ledger_change();
        return Ok(());
    }

    sqlx::query(
        "INSERT INTO user_state_progress(namespace, entity_key, local_sequence, base_revision) \
         SELECT ?1, entity_key, sequence, ?2 FROM user_state_intent WHERE seed = 0 AND true \
         ON CONFLICT(namespace, entity_key) DO NOTHING",
    )
    .bind(&namespace)
    .bind(USER_STATE_PRELINK_BASE_REVISION)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: mark prelink progress: {err}"))?;

    seed_user_state_in_tx(conn, ctx).await?;

    sqlx::query(
        "INSERT INTO user_state_progress(namespace, entity_key, local_sequence, base_revision) \
         SELECT ?1, entity_key, sequence, CASE WHEN seed = 0 THEN ?2 ELSE 0 END \
         FROM user_state_intent WHERE true \
         ON CONFLICT(namespace, entity_key) DO NOTHING",
    )
    .bind(&namespace)
    .bind(USER_STATE_PRELINK_BASE_REVISION)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: seed progress: {err}"))?;

    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO NOTHING",
    )
    .bind(&ready_key)
    .bind(r#"{"version":1}"#)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: save delta ready flag: {err}"))?;

    ctx.record_user_state_ledger_change();
    Ok(())
}

pub fn unresolved_intent(entity: &JsonValue, value: Option<&JsonValue>) -> Option<&'static str> {
    if let Some(work) = entity.get("work") {
        if work.get("sourceNovelId").is_none_or(JsonValue::is_null) {
            return Some("missing-work-identity");
        }
    }
    let kind = entity.get("kind").and_then(JsonValue::as_str).unwrap_or("");
    if matches!(kind, "reading" | "bookmark") {
        let path = entity
            .get("chapter")
            .and_then(|c| c.get("chapterPath"))
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        if path.starts_with("norea-folder:") || path.starts_with("local-folder:") {
            return Some("missing-chapter-identity");
        }
    }
    if kind == "resume" {
        if let Some(ch_path) = value
            .and_then(|v| v.get("chapter"))
            .and_then(|c| c.get("chapterPath"))
            .and_then(JsonValue::as_str)
        {
            if ch_path.starts_with("norea-folder:") || ch_path.starts_with("local-folder:") {
                return Some("missing-chapter-identity");
            }
        }
    }
    None
}

pub async fn prepare_user_state_operations_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    limits: &PrepareUserStateOperationsLimitsDto,
) -> Result<Vec<JsonValue>, String> {
    assert_user_state_available_in_tx(conn).await?;
    let ws = require_binding_in_tx(conn, binding).await?;
    purge_and_settle_local_user_state_in_tx(conn).await?;
    let limit = limits.limit.map(|n| n.max(1));
    let max_bytes = limits
        .max_bytes
        .unwrap_or(USER_STATE_CLIENT_BATCH_BYTES)
        .min(USER_STATE_CLIENT_BATCH_BYTES);
    let allow_opaque_identity = limits.allow_opaque_identity == Some(true);
    let skipped: HashSet<i64> = limits
        .skipped_chapter_ids
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .copied()
        .collect();

    let mut result: Vec<JsonValue> = Vec::new();
    let mut bytes = user_state_json_bytes(&json!({
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "operations": [],
    }))?;

    let mut include = |op_json: JsonValue| -> Result<bool, String> {
        let size = user_state_json_bytes(&op_json)?.saturating_add(1);
        if limit.is_some_and(|max_len| result.len() >= max_len)
            || bytes.saturating_add(size) > max_bytes
        {
            return Ok(false);
        }
        result.push(op_json);
        bytes = bytes.saturating_add(size);
        Ok(true)
    };

    let retry_rows = sqlx::query(
        "SELECT operation_id, entity_key, intent_sequence, payload, receipt \
         FROM user_state_operation \
         WHERE namespace = ?1 AND status = 'pending' \
         ORDER BY CASE json_extract(payload, '$.entity.kind') WHEN 'category' THEN 0 ELSE 1 END, \
                  intent_sequence, operation_id",
    )
    .bind(&ws.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load pending operations: {err}"))?;

    for r in retry_rows {
        let payload: String = r.get("payload");
        let raw_op: JsonValue = serde_json::from_str(&payload)
            .map_err(|err| format!("db user state: parse pending operation: {err}"))?;
        let op = parse_user_state_operation(&raw_op)?;
        if !allow_opaque_identity && unresolved_intent(&op.entity, Some(&op.value)).is_some() {
            continue;
        }
        if !include(op.to_json())? {
            ctx.record_user_state_ledger_change();
            return Ok(result);
        }
    }

    let opaque_filter = if allow_opaque_identity {
        ""
    } else {
        " AND (json_type(i.entity_json, '$.work') IS NULL \
               OR json_extract(i.entity_json, '$.work.sourceNovelId') IS NOT NULL) \
          AND COALESCE(json_extract(i.entity_json, '$.chapter.chapterPath'), \
                       json_extract(i.value_json, '$.chapter.chapterPath'), '') NOT LIKE 'norea-folder:%' \
          AND COALESCE(json_extract(i.entity_json, '$.chapter.chapterPath'), \
                       json_extract(i.value_json, '$.chapter.chapterPath'), '') NOT LIKE 'local-folder:%'"
    };
    let limit_clause = if limit.is_some() { " LIMIT ?2" } else { "" };
    let intent_sql = format!(
        "SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed, \
                p.base_revision AS baseRevision \
         FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.sequence > p.acknowledged_sequence \
           AND NOT EXISTS(SELECT 1 FROM user_state_operation o \
                          WHERE o.namespace = ?1 AND o.entity_key = i.entity_key AND o.status = 'pending') \
           AND NOT EXISTS(SELECT 1 FROM user_state_conflict c \
                          WHERE c.namespace = ?1 AND c.entity_key = i.entity_key)\
         {opaque_filter} \
         ORDER BY CASE json_extract(i.entity_json, '$.kind') WHEN 'category' THEN 0 ELSE 1 END, \
                  i.sequence{limit_clause}"
    );
    let mut query = sqlx::query(&intent_sql).bind(&ws.namespace);
    if let Some(lim) = limit {
        query = query.bind(lim as i64);
    }
    let intent_rows = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load pending intents: {err}"))?;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AttemptInsert {
        operation_id: String,
        entity_key: String,
        intent_sequence: i64,
        payload: String,
    }
    use serde::Serialize;

    let mut new_attempts: Vec<AttemptInsert> = Vec::new();
    for r in intent_rows {
        let intent_row = IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        };
        let base_revision: i64 = r.get("baseRevision");
        let (local_entity, local_value) = intent_from_row(&intent_row)?;
        let (entity, value) = portable_stored_user_state_intent_in_tx(
            root,
            conn,
            &local_entity,
            &local_value,
            &skipped,
        )
        .await?;
        if !allow_opaque_identity && unresolved_intent(&entity, Some(&value)).is_some() {
            continue;
        }
        let baseline = intent_row.seed == 1 || base_revision == USER_STATE_PRELINK_BASE_REVISION;
        let canonical_entity = canonical_entity_in_tx(conn, &ws.namespace, &entity).await?;
        let raw_op = if baseline {
            json!({
                "operationId": random_uuid_v4()?,
                "entity": canonical_entity,
                "value": value,
                "baseRevision": 0,
                "seed": true,
            })
        } else {
            json!({
                "operationId": random_uuid_v4()?,
                "entity": canonical_entity,
                "value": value,
                "baseRevision": base_revision,
            })
        };
        let op = parse_user_state_operation(&raw_op)?;
        let op_json = op.to_json();
        if !include(op_json.clone())? {
            break;
        }
        new_attempts.push(AttemptInsert {
            operation_id: op.operation_id,
            entity_key: intent_row.entity_key,
            intent_sequence: intent_row.sequence,
            payload: canonical_user_state_json(&op_json)?,
        });
    }

    for batch in json_batches(&new_attempts, |row| {
        row.payload.len() + row.entity_key.len() + 128
    }) {
        let encoded = serde_json::to_string(batch)
            .map_err(|err| format!("db user state: encode operation batch: {err}"))?;
        sqlx::query(
            "INSERT INTO user_state_operation(operation_id, namespace, entity_key, intent_sequence, payload) \
             SELECT json_extract(value, '$.operationId'), ?1, json_extract(value, '$.entityKey'), \
                    json_extract(value, '$.intentSequence'), json_extract(value, '$.payload') \
             FROM json_each(?2)",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: insert operations: {err}"))?;
    }

    ctx.record_user_state_ledger_change();
    Ok(result)
}

pub async fn store_user_state_records_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    records: &[ParsedUserStateRecord],
) -> Result<(), String> {
    if records.is_empty() {
        return Ok(());
    }
    let mut rows: Vec<StoredRecordRow> = Vec::with_capacity(records.len());
    for record in records {
        let rec_json = record.to_json();
        let payload = canonical_user_state_json(&rec_json)?;
        let entity_key = user_state_entity_key(&record.entity)?;
        let deletion_revision = if record.entity["kind"].as_str() == Some("category")
            && record.value.get("deleted") == Some(&JsonValue::Bool(true))
        {
            record.revision
        } else {
            0
        };
        let applied_revision = if is_local_user_state_entity(&record.entity, Some(&record.value)) {
            record.revision
        } else {
            0
        };
        rows.push(StoredRecordRow {
            entity_key,
            revision: record.revision,
            applied_revision,
            payload,
            deletion_revision,
        });
    }

    for batch in json_batches(&rows, |r| r.payload.len() + r.entity_key.len() + 96) {
        let batch_json: Vec<JsonValue> = batch
            .iter()
            .map(|r| {
                json!({
                    "entityKey": r.entity_key,
                    "revision": r.revision,
                    "appliedRevision": r.applied_revision,
                    "payload": r.payload,
                    "deletionRevision": r.deletion_revision,
                })
            })
            .collect();
        let encoded = serde_json::to_string(&batch_json)
            .map_err(|err| format!("db user state: encode stored record batch: {err}"))?;
        let existing = sqlx::query(
            "SELECT r.entity_key AS entityKey, r.revision, r.payload \
             FROM json_each(?2) incoming CROSS JOIN user_state_record r \
               ON r.entity_key = json_extract(incoming.value, '$.entityKey') \
             WHERE r.namespace = ?1",
        )
        .bind(namespace)
        .bind(&encoded)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup existing records: {err}"))?;

        let incoming: HashMap<(String, i64), &str> = batch
            .iter()
            .map(|r| ((r.entity_key.clone(), r.revision), r.payload.as_str()))
            .collect();
        for r in existing {
            let ek: String = r.get("entityKey");
            let rev: i64 = r.get("revision");
            let existing_payload: String = r.get("payload");
            if let Some(in_payload) = incoming.get(&(ek, rev)) {
                if *in_payload != existing_payload {
                    return Err("The shared state revision changed its contents.".to_string());
                }
            }
        }

        sqlx::query(
            "INSERT INTO user_state_record(namespace, entity_key, revision, applied_revision, payload, deletion_revision) \
             SELECT ?1, json_extract(value, '$.entityKey'), json_extract(value, '$.revision'), \
                    json_extract(value, '$.appliedRevision'), json_extract(value, '$.payload'), \
                    json_extract(value, '$.deletionRevision') \
             FROM json_each(?2) WHERE true \
             ON CONFLICT(namespace, entity_key) DO UPDATE SET \
               revision = excluded.revision, \
               applied_revision = MAX(user_state_record.applied_revision, excluded.applied_revision), \
               payload = excluded.payload, \
               deletion_revision = MAX(user_state_record.deletion_revision, excluded.deletion_revision), \
               deferred_reason = NULL, \
               deferred_detail = NULL \
             WHERE excluded.revision > user_state_record.revision",
        )
        .bind(namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: upsert records: {err}"))?;
    }
    Ok(())
}

pub async fn apply_user_state_read_page_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    raw_page: &JsonValue,
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    let workspace = require_binding_in_tx(conn, binding).await?;
    let page = parse_user_state_read_response(raw_page)?;
    if page.workspace_id != binding.workspace_id
        || page.epoch != binding.epoch
        || page.next_cursor < workspace.cursor
        || workspace.through.is_some_and(|t| t != page.through)
        || page.records.iter().any(|r| r.revision <= workspace.cursor)
    {
        return Err("The personal state page does not continue this workspace cursor.".to_string());
    }
    store_user_state_records_in_tx(conn, &workspace.namespace, &page.records).await?;
    let next_through = if page.has_more {
        Some(page.through)
    } else {
        None
    };
    sqlx::query(
        "UPDATE user_state_workspace SET cursor = ?2, read_through = ?3, last_success_at = ?4 \
         WHERE namespace = ?1",
    )
    .bind(&workspace.namespace)
    .bind(page.next_cursor)
    .bind(next_through)
    .bind(now_ms())
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: update workspace cursor: {err}"))?;

    ctx.request_user_state_deferred_apply();
    ctx.record_user_state_ledger_change();
    Ok(())
}

async fn remember_alias_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    alias: &CategoryAliasPair,
) -> Result<(), String> {
    let canonical = resolve_category_alias_in_tx(conn, namespace, &alias.to).await?;
    let prev: Option<String> = sqlx::query_scalar(
        "SELECT canonical_id FROM user_state_alias WHERE namespace = ?1 AND alias_id = ?2",
    )
    .bind(namespace)
    .bind(&alias.from)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup alias: {err}"))?;
    if let Some(prev_canon) = prev {
        if resolve_category_alias_in_tx(conn, namespace, &prev_canon).await? != canonical {
            return Err("The shared category alias changed ownership.".to_string());
        }
    }
    if canonical == alias.from {
        return Err("The shared category alias is cyclic.".to_string());
    }
    sqlx::query(
        "INSERT INTO user_state_alias(namespace, alias_id, canonical_id) VALUES (?1, ?2, ?3) \
         ON CONFLICT(namespace, alias_id) DO NOTHING",
    )
    .bind(namespace)
    .bind(&alias.from)
    .bind(&canonical)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: insert alias: {err}"))?;

    let local_id: Option<i64> = sqlx::query_scalar(
        "SELECT local_id FROM user_state_category WHERE category_id = ?1",
    )
    .bind(&alias.from)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup alias local category: {err}"))?
    .flatten();
    if let Some(from_local) = local_id {
        let target_local: Option<i64> = sqlx::query_scalar(
            "SELECT local_id FROM user_state_category WHERE category_id = ?1",
        )
        .bind(&canonical)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup canonical local category: {err}"))?
        .flatten();
        if let Some(to_local) = target_local.filter(|&id| id != from_local) {
            sqlx::query(
                "INSERT OR IGNORE INTO novel_category(novel_id, category_id) \
                 SELECT novel_id, ?2 FROM novel_category WHERE category_id = ?1",
            )
            .bind(from_local)
            .bind(to_local)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: merge aliased category members: {err}"))?;
            sqlx::query(
                "UPDATE user_state_category SET local_id = ?2 \
                 WHERE local_id = ?1 OR category_id = ?3",
            )
            .bind(from_local)
            .bind(to_local)
            .bind(&alias.from)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: retarget aliased category map: {err}"))?;
            sqlx::query("DELETE FROM category WHERE id = ?1")
                .bind(from_local)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: delete merged duplicate category: {err}"))?;
        } else {
            sqlx::query(
                "INSERT INTO user_state_category(category_id, local_id) VALUES (?1, ?2) \
                 ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id",
            )
            .bind(&canonical)
            .bind(from_local)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: map canonical category: {err}"))?;
        }
    }
    Ok(())
}

pub async fn acknowledge_user_state_operations_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    raw_results: &[JsonValue],
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    let ws = require_binding_in_tx(conn, binding).await?;
    let mut results = Vec::with_capacity(raw_results.len());
    let mut seen_ids = HashSet::with_capacity(raw_results.len());
    for raw in raw_results {
        let parsed = parse_user_state_merge_result(raw)?;
        if !seen_ids.insert(parsed.operation_id.clone()) {
            return Err("Duplicate personal state acknowledgements.".to_string());
        }
        results.push(parsed);
    }

    let op_ids: Vec<String> = results.iter().map(|r| r.operation_id.clone()).collect();
    let mut attempts: HashMap<String, OperationRow> = HashMap::with_capacity(op_ids.len());
    for batch in json_batches(&op_ids, |v| v.len() + 4) {
        let encoded = serde_json::to_string(batch).unwrap();
        let rows = sqlx::query(
            "SELECT operation_id, entity_key, intent_sequence, payload, receipt \
             FROM user_state_operation \
             WHERE namespace = ?1 AND operation_id IN (SELECT value FROM json_each(?2))",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup acknowledged operations: {err}"))?;
        for r in rows {
            let id: String = r.get("operation_id");
            attempts.insert(
                id.clone(),
                OperationRow {
                    operation_id: id,
                    entity_key: r.get("entity_key"),
                    intent_sequence: r.get("intent_sequence"),
                    payload: r.get("payload"),
                    receipt: r.get("receipt"),
                },
            );
        }
    }
    if attempts.len() != results.len() {
        return Err("The personal state receipt does not belong to a pending operation.".to_string());
    }

    struct PendingAck {
        result: ParsedUserStateMergeResult,
        attempt: OperationRow,
        operation: ParsedUserStateOperation,
        receipt: String,
        effective_key: String,
        equivalent_alias: bool,
    }

    let mut pending: Vec<PendingAck> = Vec::with_capacity(results.len());
    let mut current_records: Vec<ParsedUserStateRecord> = Vec::new();
    for result in results {
        let attempt = attempts.remove(&result.operation_id).unwrap();
        let receipt = canonical_user_state_json(&result.to_json())?;
        if let Some(ref prev_receipt) = attempt.receipt {
            if prev_receipt != &receipt {
                return Err("The personal state receipt changed after acknowledgement.".to_string());
            }
        }
        let raw_op: JsonValue = serde_json::from_str(&attempt.payload)
            .map_err(|err| format!("db user state: parse stored operation: {err}"))?;
        let operation = parse_user_state_operation(&raw_op)?;
        if let Some(ref alias) = result.category_alias {
            let op_cat_id = operation.entity.get("categoryId").and_then(JsonValue::as_str);
            if op_cat_id != Some(alias.from.as_str()) {
                return Err("The category alias does not match its operation.".to_string());
            }
            remember_alias_in_tx(conn, &ws.namespace, alias).await?;
            let category_id =
                resolve_category_alias_in_tx(conn, &ws.namespace, &alias.to).await?;
            let cat_key =
                user_state_entity_key(&json!({ "kind": "category", "categoryId": category_id }))?;
            sqlx::query(
                "UPDATE user_state_record SET applied_revision = 0, \
                 deferred_reason = NULL, deferred_detail = NULL \
                 WHERE namespace = ?1 AND entity_key = ?2",
            )
            .bind(&ws.namespace)
            .bind(&cat_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: reopen aliased category record: {err}"))?;
        }
        let effective = canonical_entity_in_tx(conn, &ws.namespace, &operation.entity).await?;
        let effective_key = user_state_entity_key(&effective)?;
        if let Some(ref current) = result.current {
            if user_state_entity_key(&current.entity)? != effective_key {
                return Err("The receipt has a different personal state identity.".to_string());
            }
            current_records.push(current.clone());
        }
        let equivalent_alias = if result.status != "aliased" {
            true
        } else if let Some(ref current) = result.current {
            canonical_user_state_json(&operation.value)?
                == canonical_user_state_json(&current.value)?
        } else {
            false
        };
        pending.push(PendingAck {
            result,
            attempt,
            operation,
            receipt,
            effective_key,
            equivalent_alias,
        });
    }

    store_user_state_records_in_tx(conn, &ws.namespace, &current_records).await?;

    let mut already_projected: Vec<(String, i64)> = Vec::new();
    for row in &pending {
        if row.result.status == "conflict" {
            continue;
        }
        if let Some(ref current) = row.result.current {
            if canonical_user_state_json(&row.operation.value)?
                == canonical_user_state_json(&current.value)?
            {
                already_projected.push((row.effective_key.clone(), current.revision));
            }
        }
    }
    for batch in json_batches(&already_projected, |(k, _)| k.len() + 48) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(k, rev)| json!({ "entityKey": k, "revision": rev }))
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "WITH incoming AS ( \
               SELECT json_extract(value, '$.entityKey') AS entity_key, \
                      json_extract(value, '$.revision') AS revision \
               FROM json_each(?2) \
             ) \
             UPDATE user_state_record AS record SET \
               applied_revision = MAX(record.applied_revision, incoming.revision), \
               deferred_reason = NULL, deferred_detail = NULL \
             FROM incoming \
             WHERE record.namespace = ?1 AND record.entity_key = incoming.entity_key \
               AND record.revision = incoming.revision",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: mark self-projected ack records: {err}"))?;
    }

    let unique_keys: Vec<String> = pending
        .iter()
        .map(|r| r.effective_key.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut revisions: HashMap<String, i64> = HashMap::with_capacity(unique_keys.len());
    for batch in json_batches(&unique_keys, |k| k.len() + 4) {
        let encoded = serde_json::to_string(batch).unwrap();
        let rows = sqlx::query(
            "SELECT entity_key, revision FROM user_state_record \
             WHERE namespace = ?1 AND entity_key IN (SELECT value FROM json_each(?2))",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load record revisions: {err}"))?;
        for r in rows {
            revisions.insert(r.get("entity_key"), r.get("revision"));
        }
    }

    let op_updates: Vec<(String, &'static str, String)> = pending
        .iter()
        .map(|r| {
            (
                r.attempt.operation_id.clone(),
                if r.result.status == "conflict" {
                    "conflict"
                } else {
                    "acknowledged"
                },
                r.receipt.clone(),
            )
        })
        .collect();
    for batch in json_batches(&op_updates, |(id, _, rec)| rec.len() + id.len() + 64) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(id, st, rec)| json!({ "operationId": id, "status": st, "receipt": rec }))
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "WITH incoming AS ( \
               SELECT json_extract(value, '$.operationId') AS operation_id, \
                      json_extract(value, '$.status') AS status, \
                      json_extract(value, '$.receipt') AS receipt \
               FROM json_each(?1) \
             ) \
             UPDATE user_state_operation AS operation \
             SET status = incoming.status, receipt = incoming.receipt \
             FROM incoming WHERE operation.operation_id = incoming.operation_id",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: update operation status: {err}"))?;
    }

    let conflicts: Vec<(String, String, String)> = pending
        .iter()
        .filter(|r| r.result.status == "conflict")
        .map(|r| {
            (
                r.attempt.operation_id.clone(),
                r.attempt.entity_key.clone(),
                r.result
                    .reason
                    .clone()
                    .unwrap_or_else(|| "revision-mismatch".to_string()),
            )
        })
        .collect();
    for batch in json_batches(&conflicts, |(id, ek, rsn)| {
        id.len() + ek.len() + rsn.len() + 64
    }) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(id, ek, rsn)| json!({ "id": id, "entityKey": ek, "reason": rsn }))
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "INSERT INTO user_state_conflict(id, namespace, entity_key, reason) \
             SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.entityKey'), \
                    json_extract(value, '$.reason') \
             FROM json_each(?2) WHERE true \
             ON CONFLICT(namespace, entity_key) DO UPDATE SET \
               id = excluded.id, reason = excluded.reason",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: upsert conflicts: {err}"))?;
    }

    let progress: Vec<(String, i64, Option<i64>)> = pending
        .iter()
        .filter(|r| r.result.status != "conflict")
        .map(|r| {
            let can_rebase = r.result.status != "seed-skipped"
                && r.equivalent_alias
                && r.result.current.as_ref().is_some_and(|cur| {
                    revisions.get(&r.effective_key).copied().unwrap_or(0) <= cur.revision
                });
            let base_rev = if can_rebase {
                r.result.current.as_ref().map(|c| c.revision)
            } else {
                None
            };
            (
                r.attempt.entity_key.clone(),
                r.attempt.intent_sequence,
                base_rev,
            )
        })
        .collect();
    for batch in json_batches(&progress, |(ek, _, _)| ek.len() + 80) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(ek, seq, rev)| {
                json!({
                    "entityKey": ek,
                    "intentSequence": seq,
                    "baseRevision": rev,
                })
            })
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "WITH incoming AS ( \
               SELECT json_extract(value, '$.entityKey') AS entity_key, \
                      json_extract(value, '$.intentSequence') AS intent_sequence, \
                      json_extract(value, '$.baseRevision') AS base_revision \
               FROM json_each(?2) \
             ) \
             UPDATE user_state_progress AS progress SET \
               acknowledged_sequence = MAX(progress.acknowledged_sequence, incoming.intent_sequence), \
               base_revision = CASE WHEN incoming.base_revision IS NULL \
                                    THEN progress.base_revision \
                                    ELSE incoming.base_revision END \
             FROM incoming \
             WHERE progress.namespace = ?1 AND progress.entity_key = incoming.entity_key",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: advance progress: {err}"))?;
    }

    sqlx::query("UPDATE user_state_workspace SET last_success_at = ?2 WHERE namespace = ?1")
        .bind(&ws.namespace)
        .bind(now_ms())
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: touch workspace last_success_at: {err}"))?;

    ctx.request_user_state_deferred_apply();
    ctx.record_user_state_ledger_change();
    Ok(())
}

async fn category_name_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    entity: &JsonValue,
) -> Result<Option<String>, String> {
    let Some(raw_cat_id) = entity.get("categoryId").and_then(JsonValue::as_str) else {
        return Ok(None);
    };
    let category_id = resolve_category_alias_in_tx(conn, namespace, raw_cat_id).await?;
    let cat_key = user_state_entity_key(&json!({ "kind": "category", "categoryId": category_id }))?;
    let rec_payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM user_state_record WHERE namespace = ?1 AND entity_key = ?2",
    )
    .bind(namespace)
    .bind(&cat_key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup conflict category record: {err}"))?;
    if let Some(payload) = rec_payload {
        let raw: JsonValue = serde_json::from_str(&payload)
            .map_err(|err| format!("db user state: parse conflict category record: {err}"))?;
        let parsed = parse_user_state_record(&raw)?;
        return Ok(parsed.value.get("name").and_then(JsonValue::as_str).map(String::from));
    }
    let local_name: Option<String> = sqlx::query_scalar(
        "SELECT c.name FROM category c JOIN user_state_category m ON m.local_id = c.id \
         WHERE m.category_id = ?1",
    )
    .bind(&category_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup local conflict category name: {err}"))?;
    Ok(local_name)
}

pub async fn list_user_state_conflicts_in_tx(
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
) -> Result<Vec<UserStateConflictDto>, String> {
    let ws = require_binding_in_tx(conn, binding).await?;
    let rows = sqlx::query(
        "SELECT c.id, c.reason, i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
         FROM user_state_conflict c \
         JOIN user_state_intent i ON i.entity_key = c.entity_key \
         WHERE c.namespace = ?1 ORDER BY i.sequence",
    )
    .bind(&ws.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: list conflicts: {err}"))?;

    let mut result = Vec::with_capacity(rows.len());
    for r in rows {
        let id: String = r.get("id");
        let reason: String = r.get("reason");
        let intent_row = IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        };
        let (entity, local) = intent_from_row(&intent_row)?;
        if is_local_user_state_entity(&entity, Some(&local)) {
            continue;
        }
        let effective = canonical_entity_in_tx(conn, &ws.namespace, &entity).await?;
        let shared_payload: Option<String> = sqlx::query_scalar(
            "SELECT payload FROM user_state_record WHERE namespace = ?1 AND entity_key = ?2",
        )
        .bind(&ws.namespace)
        .bind(user_state_entity_key(&effective)?)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup conflict shared record: {err}"))?;
        let shared_rec = match shared_payload {
            Some(payload) => {
                let raw: JsonValue = serde_json::from_str(&payload)
                    .map_err(|err| format!("db user state: parse conflict shared record: {err}"))?;
                Some(parse_user_state_record(&raw)?)
            }
            None => None,
        };
        let category_name = category_name_in_tx(conn, &ws.namespace, &entity).await?;
        let rev = shared_rec.as_ref().map_or(0, |rec| rec.revision);
        let version = canonical_user_state_json(&json!([id, intent_row.sequence, rev]))?;
        result.push(UserStateConflictDto {
            id,
            category_name,
            entity,
            local,
            shared: shared_rec.map(|rec| rec.to_json()),
            reason,
            version,
        });
    }
    Ok(result)
}

pub async fn list_user_state_deferred_in_tx(
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
) -> Result<Vec<UserStateDeferredDto>, String> {
    let ws = require_binding_in_tx(conn, binding).await?;
    let rows = sqlx::query(
        "SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
         FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key \
         WHERE p.namespace = ?1 AND i.sequence > p.acknowledged_sequence",
    )
    .bind(&ws.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: list deferred intents: {err}"))?;

    let mut result = Vec::new();
    for r in rows {
        let intent_row = IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        };
        let (entity, value) = intent_from_row(&intent_row)?;
        if is_local_user_state_entity(&entity, Some(&value)) {
            continue;
        }
        if let Some(reason) = unresolved_intent(&entity, Some(&value)) {
            result.push(UserStateDeferredDto {
                id: intent_row.entity_key,
                category_name: None,
                entity,
                reason: reason.to_string(),
                detail: None,
            });
        }
    }
    Ok(result)
}

pub async fn get_user_state_ledger_status_in_tx(
    conn: &mut SqliteConnection,
    binding: Option<&UserStateBindingDto>,
) -> Result<UserStateLedgerStatusDto, String> {
    let paused_after_restore = user_state_restore_paused_in_tx(conn).await?;
    let Some(binding) = binding else {
        if !has_user_state_schema_in_tx(conn).await? {
            return Ok(UserStateLedgerStatusDto {
                cursor: 0,
                through: None,
                pending: 0,
                conflicts: 0,
                deferred: 0,
                projection_pending: 0,
                projection_failed: 0,
                last_success_at: None,
                paused_after_restore,
            });
        }
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM user_state_intent \
             WHERE COALESCE(json_extract(entity_json, '$.work.pluginId'), '') <> 'local'",
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| format!("db user state: count unlinked intents: {err}"))?;
        return Ok(UserStateLedgerStatusDto {
            cursor: 0,
            through: None,
            pending,
            conflicts: 0,
            deferred: 0,
            projection_pending: 0,
            projection_failed: 0,
            last_success_at: None,
            paused_after_restore,
        });
    };

    let workspace = require_binding_in_tx(conn, binding).await?;
    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key \
         WHERE p.namespace = ?1 AND i.sequence > p.acknowledged_sequence \
           AND COALESCE(json_extract(i.entity_json, '$.work.pluginId'), '') <> 'local'",
    )
    .bind(&workspace.namespace)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db user state: count pending intents: {err}"))?;

    let deferred: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.sequence > p.acknowledged_sequence \
           AND COALESCE(json_extract(i.entity_json, '$.work.pluginId'), '') <> 'local' \
           AND ((json_type(i.entity_json, '$.work') = 'object' \
                 AND json_extract(i.entity_json, '$.work.sourceNovelId') IS NULL) \
                OR COALESCE(json_extract(i.entity_json, '$.chapter.chapterPath'), \
                            json_extract(i.value_json, '$.chapter.chapterPath'), '') LIKE 'norea-folder:%' \
                OR COALESCE(json_extract(i.entity_json, '$.chapter.chapterPath'), \
                            json_extract(i.value_json, '$.chapter.chapterPath'), '') LIKE 'local-folder:%')",
    )
    .bind(&workspace.namespace)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db user state: count deferred intents: {err}"))?;

    let held_intents = sqlx::query(
        "SELECT i.entity_json FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.seed = 0 AND p.base_revision <> ?2 AND i.sequence > p.acknowledged_sequence \
           AND COALESCE(json_extract(i.entity_json, '$.work.pluginId'), '') <> 'local'",
    )
    .bind(&workspace.namespace)
    .bind(USER_STATE_PRELINK_BASE_REVISION)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load held intents: {err}"))?;

    let mut held_keys: HashSet<String> = HashSet::new();
    for r in held_intents {
        let entity_json: String = r.get("entity_json");
        let raw: JsonValue = serde_json::from_str(&entity_json)
            .map_err(|err| format!("db user state: parse held entity: {err}"))?;
        let ent = parse_user_state_entity(&raw)?;
        held_keys.insert(user_state_entity_key(&ent)?);
        let canon = canonical_entity_in_tx(conn, &workspace.namespace, &ent).await?;
        held_keys.insert(user_state_entity_key(&canon)?);
    }

    let held_sources = load_current_held_sources_in_tx(conn, &binding.server_url).await?;
    let proj_rows = sqlx::query(
        "SELECT entity_key, applied_revision < revision AS waiting, deferred_reason, \
           json_extract(payload, '$.entity.kind') AS kind, \
           json_extract(payload, '$.entity.work.pluginId') AS plugin_id, \
           json_extract(payload, '$.entity.work.sourceNovelId') AS novel_id, \
           json_extract(payload, '$.entity.work.novelPath') AS novel_path, \
           (json_extract(payload, '$.entity.kind') = 'category' OR EXISTS ( \
             SELECT 1 FROM novel n \
             WHERE n.plugin_id = json_extract(user_state_record.payload, '$.entity.work.pluginId') \
               AND n.plugin_id <> 'local' AND n.is_local = 0 \
               AND (CASE WHEN json_extract(user_state_record.payload, '$.entity.work.sourceNovelId') IS NULL \
                    THEN n.path = json_extract(user_state_record.payload, '$.entity.work.novelPath') \
                    ELSE lower(n.source_novel_id) = lower(json_extract(user_state_record.payload, '$.entity.work.sourceNovelId')) END) \
           )) AS applicable \
         FROM user_state_record \
         WHERE namespace = ?1 \
           AND (applied_revision < revision OR deferred_reason = 'projection-error') \
           AND COALESCE(json_extract(payload, '$.entity.work.pluginId'), '') <> 'local'",
    )
    .bind(&workspace.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: classify projection status: {err}"))?;

    let mut projection_pending: i64 = 0;
    let mut projection_failed: i64 = 0;
    for r in proj_rows {
        let plugin_id: Option<String> = r.get("plugin_id");
        if let Some(pid) = plugin_id {
            let work_ref = UserStateWorkReferenceDto {
                plugin_id: pid,
                source_novel_id: r.get("novel_id"),
                novel_path: r.get::<Option<String>, _>("novel_path").unwrap_or_default(),
                name: String::new(),
            };
            if is_current_work_held(&held_sources, &work_ref) {
                continue;
            }
        }
        let deferred_reason: Option<String> = r.get("deferred_reason");
        if deferred_reason.as_deref() == Some("projection-error") {
            projection_failed += 1;
            continue;
        }
        let waiting: i64 = r.get("waiting");
        let applicable: i64 = r.get("applicable");
        let entity_key: String = r.get("entity_key");
        if waiting != 0 && deferred_reason.is_none() && applicable != 0 && !held_keys.contains(&entity_key) {
            projection_pending += 1;
        }
    }

    let conflicts = list_user_state_conflicts_in_tx(conn, binding).await?.len();
    Ok(UserStateLedgerStatusDto {
        cursor: workspace.cursor,
        through: workspace.through,
        pending,
        conflicts,
        deferred,
        projection_pending,
        projection_failed,
        last_success_at: workspace.last_success_at,
        paused_after_restore,
    })
}

pub async fn resolve_user_state_ledger_conflict_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    input: &ResolveUserStateLedgerConflictInputDto,
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    let ws = require_binding_in_tx(conn, binding).await?;
    let conflict = list_user_state_conflicts_in_tx(conn, binding)
        .await?
        .into_iter()
        .find(|row| row.id == input.id);
    let Some(conflict) = conflict.filter(|c| c.version == input.version) else {
        return Err(
            "This conflict changed. Review its current values before resolving it.".to_string(),
        );
    };
    let key = user_state_entity_key(&conflict.entity)?;
    let kind = conflict.entity["kind"].as_str().unwrap_or("").to_string();
    let shared_revision = conflict
        .shared
        .as_ref()
        .and_then(|s| s.get("revision"))
        .and_then(JsonValue::as_i64)
        .unwrap_or(0);

    if input.choice == "local" {
        let trimmed_cat_name = if kind == "category" {
            input.category_name.as_ref().map(|n| n.trim().to_string())
        } else {
            None
        };
        if let Some(ref name) = trimmed_cat_name {
            if name.is_empty() {
                return Err("Provide a category name before resolving this conflict.".to_string());
            }
        }
        let mut value = conflict.local.clone();
        if let Some(ref name) = trimmed_cat_name {
            value["name"] = JsonValue::String(name.clone());
        }
        let mut entity = conflict.entity.clone();

        if kind == "category" {
            if let Some(ref name) = trimmed_cat_name {
                let raw_cat_id = conflict.entity["categoryId"].as_str().unwrap_or("");
                let category_id =
                    resolve_category_alias_in_tx(conn, &ws.namespace, raw_cat_id).await?;
                sqlx::query(
                    "UPDATE category SET name = ?2 \
                     WHERE is_system = 0 \
                       AND id = (SELECT local_id FROM user_state_category \
                                 WHERE category_id IN (?1, ?3) ORDER BY rowid LIMIT 1) \
                       AND NOT EXISTS(SELECT 1 FROM category existing \
                                      WHERE lower(existing.name) = lower(?2) \
                                        AND existing.id <> category.id)",
                )
                .bind(&category_id)
                .bind(name)
                .bind(raw_cat_id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: rename local conflict category: {err}"))?;
            }
        } else if kind == "membership" && conflict.reason == "category-deleted" {
            let raw_cat_id = conflict.entity["categoryId"].as_str().unwrap_or("");
            let category_id = resolve_category_alias_in_tx(conn, &ws.namespace, raw_cat_id).await?;
            let category_key =
                user_state_entity_key(&json!({ "kind": "category", "categoryId": category_id }))?;
            let cat_payload: Option<String> = sqlx::query_scalar(
                "SELECT payload FROM user_state_record WHERE namespace = ?1 AND entity_key = ?2",
            )
            .bind(&ws.namespace)
            .bind(&category_key)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: lookup deleted category record: {err}"))?;
            let Some(cat_payload) = cat_payload else {
                return Err(
                    "The deleted category must be downloaded before it can be restored."
                        .to_string(),
                );
            };
            let raw_rec: JsonValue = serde_json::from_str(&cat_payload)
                .map_err(|err| format!("db user state: parse deleted category record: {err}"))?;
            let record = parse_user_state_record(&raw_rec)?;
            let mut next_cat_val = record.value.clone();
            if let Some(ref name) = input.category_name {
                next_cat_val["name"] = JsonValue::String(name.trim().to_string());
            }
            next_cat_val["deleted"] = JsonValue::Bool(false);
            record_user_state_changes_in_tx(conn, ctx, &[(record.entity, next_cat_val)], false)
                .await?;
            sqlx::query(
                "UPDATE user_state_progress SET base_revision = ?3 \
                 WHERE namespace = ?1 AND entity_key = ?2",
            )
            .bind(&ws.namespace)
            .bind(&category_key)
            .bind(record.revision)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: rebase restored category progress: {err}"))?;
        } else if kind == "membership" && conflict.reason == "category-missing" {
            let raw_cat_id = conflict.entity["categoryId"].as_str().unwrap_or("");
            let category_id = resolve_category_alias_in_tx(conn, &ws.namespace, raw_cat_id).await?;
            let local_cat = sqlx::query(
                "SELECT c.name, c.sort FROM category c \
                 JOIN user_state_category m ON m.local_id = c.id \
                 WHERE m.category_id IN (?1, ?2) ORDER BY m.rowid LIMIT 1",
            )
            .bind(&category_id)
            .bind(raw_cat_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: lookup missing local category: {err}"))?;
            let fallback_name = local_cat
                .as_ref()
                .map(|r| r.get::<String, _>("name"))
                .or_else(|| conflict.category_name.clone())
                .unwrap_or_default();
            let name = input
                .category_name
                .as_deref()
                .unwrap_or(&fallback_name)
                .trim()
                .to_string();
            if name.is_empty() {
                return Err(
                    "Provide a category name before recreating the missing category.".to_string(),
                );
            }
            let sort = local_cat
                .as_ref()
                .map_or(0_i64, |r| r.get::<i64, _>("sort"));
            let cat_entity = json!({ "kind": "category", "categoryId": category_id });
            let cat_key = user_state_entity_key(&cat_entity)?;
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(
                    cat_entity,
                    json!({ "name": name, "sort": sort, "deleted": false }),
                )],
                false,
            )
            .await?;
            sqlx::query(
                "UPDATE user_state_progress SET base_revision = 0 \
                 WHERE namespace = ?1 AND entity_key = ?2",
            )
            .bind(&ws.namespace)
            .bind(&cat_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: reset recreated category progress: {err}"))?;
        } else if matches!(kind.as_str(), "reading" | "bookmark")
            && conflict.reason == "chapter-ownership-conflict"
        {
            let plugin_id = conflict.entity["work"]["pluginId"].as_str().unwrap_or("");
            let source_novel_id = conflict.entity["work"]["sourceNovelId"].as_str();
            let novel_path = conflict.entity["work"]["novelPath"].as_str().unwrap_or("");
            let ch_path = conflict.entity["chapter"]["chapterPath"]
                .as_str()
                .unwrap_or("");
            let sql = format!(
                "{USER_CHAPTER_SELECT} WHERE n.plugin_id = ?1 \
                 AND (CASE WHEN ?2 IS NULL THEN n.path = ?3 \
                      ELSE lower(n.source_novel_id) = lower(?2) END) \
                 AND c.path = ?4 LIMIT 1"
            );
            let local_ch = sqlx::query(&sql)
                .bind(plugin_id)
                .bind(source_novel_id)
                .bind(novel_path)
                .bind(ch_path)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db user state: lookup local conflict chapter: {err}"))?
                .map(|r| map_user_chapter_row(&r));
            if let Some(ch) = local_ch {
                entity["work"] = chapter_work_json(&ch);
                entity["chapter"] = chapter_reference_json(&ch);
            } else if let Some(shared_ch) = conflict
                .shared
                .as_ref()
                .and_then(|s| s.get("entity"))
                .and_then(|e| e.get("chapter"))
            {
                entity["chapter"] = shared_ch.clone();
            }
        }

        let resolved_key = user_state_entity_key(&entity)?;
        record_user_state_changes_in_tx(conn, ctx, &[(entity, value)], false).await?;
        sqlx::query(
            "UPDATE user_state_progress SET base_revision = ?3 \
             WHERE namespace = ?1 AND entity_key = ?2",
        )
        .bind(&ws.namespace)
        .bind(&resolved_key)
        .bind(shared_revision)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: rebase resolved local progress: {err}"))?;
    } else if input.choice == "shared" {
        if kind == "category" {
            if let Some(ref shared) = conflict.shared {
                if shared["entity"]["kind"].as_str() == Some("category") {
                    let raw_cat_id = conflict.entity["categoryId"].as_str().unwrap_or("");
                    let category_id =
                        resolve_category_alias_in_tx(conn, &ws.namespace, raw_cat_id).await?;
                    let deleted = shared["value"]["deleted"].as_bool().unwrap_or(false);
                    if deleted {
                        sqlx::query(
                            "DELETE FROM category WHERE is_system = 0 \
                             AND id = (SELECT local_id FROM user_state_category \
                                       WHERE category_id IN (?1, ?2) ORDER BY rowid LIMIT 1)",
                        )
                        .bind(&category_id)
                        .bind(raw_cat_id)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db user state: delete conflict category: {err}"))?;
                    } else {
                        let sh_name = shared["value"]["name"].as_str().unwrap_or("");
                        let sh_sort = shared["value"]["sort"].as_i64().unwrap_or(0);
                        sqlx::query(
                            "UPDATE category SET name = ?2, sort = ?3 \
                             WHERE is_system = 0 \
                               AND id = (SELECT local_id FROM user_state_category \
                                         WHERE category_id IN (?1, ?4) ORDER BY rowid LIMIT 1) \
                               AND NOT EXISTS(SELECT 1 FROM category existing \
                                              WHERE lower(existing.name) = lower(?2) \
                                                AND existing.id <> category.id)",
                        )
                        .bind(&category_id)
                        .bind(sh_name)
                        .bind(sh_sort)
                        .bind(raw_cat_id)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| {
                            format!("db user state: apply shared conflict category: {err}")
                        })?;
                    }
                }
            }
        }
        sqlx::query(
            "UPDATE user_state_progress \
             SET acknowledged_sequence = local_sequence, base_revision = ?3 \
             WHERE namespace = ?1 AND entity_key = ?2",
        )
        .bind(&ws.namespace)
        .bind(&key)
        .bind(shared_revision)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: acknowledge shared conflict choice: {err}"))?;

        if let Some(ref shared) = conflict.shared {
            let shared_key = user_state_entity_key(&shared["entity"])?;
            sqlx::query(
                "UPDATE user_state_record \
                 SET applied_revision = 0, deferred_reason = NULL, deferred_detail = NULL \
                 WHERE namespace = ?1 AND entity_key = ?2",
            )
            .bind(&ws.namespace)
            .bind(&shared_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: reopen shared conflict record: {err}"))?;
        }
    } else {
        return Err(format!("Unsupported conflict resolution choice: {}", input.choice));
    }

    if matches!(kind.as_str(), "category" | "membership") {
        sqlx::query(
            "UPDATE user_state_record \
             SET applied_revision = 0, deferred_reason = NULL, deferred_detail = NULL \
             WHERE namespace = ?1 \
               AND deferred_reason IN ('category-name-conflict', 'missing-category')",
        )
        .bind(&ws.namespace)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: reopen parked category records: {err}"))?;
    }

    sqlx::query("DELETE FROM user_state_conflict WHERE namespace = ?1 AND id = ?2")
        .bind(&ws.namespace)
        .bind(&input.id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: delete resolved conflict: {err}"))?;

    ctx.request_user_state_deferred_apply();
    ctx.record_user_state_ledger_change();
    Ok(())
}

pub async fn project_pending_user_state_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<UserStateApplyEffectsDto, String> {
    let ws = require_binding_in_tx(conn, binding).await?;
    assert_user_state_available_in_tx(conn).await?;
    let mut effects = UserStateApplyEffectsDto::default();

    purge_and_settle_local_user_state_in_tx(conn).await?;
    let settled_held =
        settle_held_source_records_in_tx(conn, &ws.namespace, &binding.server_url).await?;

    let parked_missing = sqlx::query(
        "UPDATE user_state_record \
         SET applied_revision = revision, deferred_reason = 'missing-work', deferred_detail = NULL \
         WHERE namespace = ?1 \
           AND applied_revision < revision \
           AND (deferred_reason IS NULL OR deferred_reason = 'projection-error') \
           AND json_extract(payload, '$.entity.kind') <> 'category' \
           AND NOT EXISTS ( \
             SELECT 1 FROM novel n \
             WHERE n.plugin_id = json_extract(user_state_record.payload, '$.entity.work.pluginId') \
               AND n.plugin_id <> 'local' AND n.is_local = 0 \
               AND (CASE WHEN json_extract(user_state_record.payload, '$.entity.work.sourceNovelId') IS NULL \
                    THEN n.path = json_extract(user_state_record.payload, '$.entity.work.novelPath') \
                    ELSE lower(n.source_novel_id) = lower(json_extract(user_state_record.payload, '$.entity.work.sourceNovelId')) END) \
           )",
    )
    .bind(&ws.namespace)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: bulk skip missing works: {err}"))?;

    let pending_rows = sqlx::query(
        "SELECT entity_key, revision, payload FROM user_state_record \
         WHERE namespace = ?1 AND applied_revision < revision \
           AND (deferred_reason IS NULL OR deferred_reason = 'projection-error') \
         ORDER BY CASE json_extract(payload, '$.entity.kind') \
                    WHEN 'category' THEN 0 \
                    WHEN 'library' THEN 1 \
                    WHEN 'composition' THEN 2 \
                    ELSE 3 \
                  END, revision",
    )
    .bind(&ws.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load pending projection records: {err}"))?;

    if pending_rows.is_empty() {
        if settled_held > 0 || parked_missing.rows_affected() > 0 {
            ctx.record_user_state_ledger_change();
        }
        return Ok(effects);
    }

    let dirty_before: Vec<(String, String)> = sqlx::query(
        "SELECT plugin_id, path FROM work_metadata_dirty ORDER BY plugin_id, path",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: snapshot work_metadata_dirty: {err}"))?
    .into_iter()
    .map(|r| (r.get("plugin_id"), r.get("path")))
    .collect();

    let held_intents = sqlx::query(
        "SELECT i.entity_json FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.seed = 0 AND p.base_revision <> ?2 AND i.sequence > p.acknowledged_sequence",
    )
    .bind(&ws.namespace)
    .bind(USER_STATE_PRELINK_BASE_REVISION)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load held projection intents: {err}"))?;

    let mut held_keys: HashSet<String> = HashSet::new();
    for r in held_intents {
        let entity_json: String = r.get("entity_json");
        let raw: JsonValue = serde_json::from_str(&entity_json)
            .map_err(|err| format!("db user state: parse held projection entity: {err}"))?;
        let ent = parse_user_state_entity(&raw)?;
        held_keys.insert(user_state_entity_key(&ent)?);
        let canon = canonical_entity_in_tx(conn, &ws.namespace, &ent).await?;
        held_keys.insert(user_state_entity_key(&canon)?);
    }

    let mut saw_composition = false;
    let mut touched_last_read_novels: HashSet<i64> = HashSet::new();

    for row in pending_rows {
        let key: String = row.get("entity_key");
        let payload: String = row.get("payload");
        let raw: JsonValue = serde_json::from_str(&payload)
            .map_err(|err| format!("db user state: parse pending projection record: {err}"))?;
        let record = parse_user_state_record(&raw)?;

        if is_local_user_state_entity(&record.entity, Some(&record.value)) {
            sqlx::query(
                "UPDATE user_state_record \
                 SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL \
                 WHERE namespace = ?1 AND entity_key = ?2 AND revision = ?3",
            )
            .bind(&ws.namespace)
            .bind(&key)
            .bind(record.revision)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: settle local projection record: {err}"))?;
            continue;
        }

        if saw_composition {
            let applied_rev: Option<i64> = sqlx::query_scalar(
                "SELECT applied_revision FROM user_state_record \
                 WHERE namespace = ?1 AND entity_key = ?2 AND revision = ?3",
            )
            .bind(&ws.namespace)
            .bind(&key)
            .bind(record.revision)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: recheck projection revision: {err}"))?;
            if applied_rev.is_none_or(|rev| rev >= record.revision) {
                continue;
            }
        }

        if held_keys.contains(&key) {
            continue;
        }
        if record.entity.get("categoryId").is_some() {
            let canon = canonical_entity_in_tx(conn, &ws.namespace, &record.entity).await?;
            if held_keys.contains(&user_state_entity_key(&canon)?) {
                continue;
            }
        }

        match materialize_user_state_record_with_options_in_tx(
            root,
            conn,
            &ws.namespace,
            &record,
            skipped_chapter_ids,
            true,
        )
        .await
        {
            Ok((next, touched_novel_id)) => {
                if record.entity["kind"].as_str() == Some("composition") {
                    saw_composition = true;
                }
                if let Some(novel_id) = touched_novel_id {
                    touched_last_read_novels.insert(novel_id);
                }
                effects.resumes.extend(next.resumes);
                sqlx::query(
                    "UPDATE user_state_record \
                     SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL \
                     WHERE namespace = ?1 AND entity_key = ?2 AND revision = ?3",
                )
                .bind(&ws.namespace)
                .bind(&key)
                .bind(record.revision)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: mark projected record: {err}"))?;
            }
            Err(MaterializeError::Deferred(deferred)) => {
                let truncated: String = deferred.detail.chars().take(500).collect();
                sqlx::query(
                    "UPDATE user_state_record \
                     SET applied_revision = revision, deferred_reason = ?4, deferred_detail = ?5 \
                     WHERE namespace = ?1 AND entity_key = ?2 AND revision = ?3",
                )
                .bind(&ws.namespace)
                .bind(&key)
                .bind(record.revision)
                .bind(&deferred.reason)
                .bind(&truncated)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: park deferred record: {err}"))?;
            }
            Err(MaterializeError::Fatal(err)) => {
                let truncated: String = err.chars().take(500).collect();
                sqlx::query(
                    "UPDATE user_state_record \
                     SET deferred_reason = 'projection-error', deferred_detail = ?4 \
                     WHERE namespace = ?1 AND entity_key = ?2 AND revision = ?3",
                )
                .bind(&ws.namespace)
                .bind(&key)
                .bind(record.revision)
                .bind(&truncated)
                .execute(&mut *conn)
                .await
                .map_err(|e| format!("db user state: record projection failure: {e}"))?;
                log::warn!(
                    "[user-state] stored shared state but could not project it into local content: {err}"
                );
            }
        }
    }

    if !touched_last_read_novels.is_empty() {
        let ids: Vec<i64> = touched_last_read_novels.into_iter().collect();
        let encoded = serde_json::to_string(&ids).unwrap();
        sqlx::query(
            "UPDATE novel \
             SET last_read_at = (SELECT MAX(read_at) FROM chapter WHERE novel_id = novel.id) \
             WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: bulk update novel last_read_at: {err}"))?;
    }

    sqlx::query("DELETE FROM work_metadata_dirty")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: reset work_metadata_dirty: {err}"))?;
    if !dirty_before.is_empty() {
        let dirty_json: Vec<JsonValue> = dirty_before
            .into_iter()
            .map(|(plugin_id, path)| json!({ "pluginId": plugin_id, "path": path }))
            .collect();
        let encoded = serde_json::to_string(&dirty_json).unwrap();
        sqlx::query(
            "INSERT INTO work_metadata_dirty(plugin_id, path) \
             SELECT json_extract(value, '$.pluginId'), json_extract(value, '$.path') \
             FROM json_each(?1) WHERE true \
             ON CONFLICT(plugin_id, path) DO NOTHING",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: restore work_metadata_dirty: {err}"))?;
    }

    ctx.record_user_state_ledger_change();
    Ok(effects)
}
