use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};

use crate::db::tx::TxContext;

use super::core::{
    assert_user_state_available_in_tx, canonical_entity_in_tx, chapter_reference_json,
    chapter_work_json, has_user_state_schema_in_tx, intent_from_row, is_before_seed_cutoff,
    map_user_chapter_row, populate_user_chapter_composition_ids_in_tx,
    promote_private_work_identities_in_tx, record_chapter_rows_in_tx,
    record_resume_cleared_in_tx, record_user_state_changes_in_tx, require_binding_in_tx,
    resolve_category_alias_in_tx, seed_user_state_with_options_in_tx,
    user_state_restore_paused_in_tx, workspace_rows_in_tx, IntentRow, UserChapterRow,
    USER_CHAPTER_SELECT,
};
use super::current::{is_current_work_held, load_current_held_sources_in_tx};
use super::materialize::{
    has_pending_user_state_for_record_in_tx, materialize_user_state_record_with_options_in_tx,
    CompositionEntryCache, MaterializeError,
};
use super::stored_chapter::portable_stored_user_state_intent_in_tx;
use super::types::{
    canonical_user_state_json, fold_ascii, is_local_user_state_entity, namespace_for,
    parse_user_state_entity, parse_user_state_merge_result, parse_user_state_operation,
    parse_user_state_read_response, parse_user_state_record, parse_work_reference,
    random_uuid_v4, user_state_entity_key, user_state_json_bytes, user_state_work_key_parts,
    CategoryAliasPair, ParsedUserStateMergeResult, ParsedUserStateOperation, ParsedUserStateRecord,
    ResolveUserStateLedgerConflictInputDto, UserStateApplyEffectsDto, UserStateBindingDto,
    UserStateConflictDto, UserStateDeferredDto, UserStateLedgerStatusDto, UserStateRebindMode,
    UserStateWorkReferenceDto, USER_STATE_CLIENT_BATCH_BYTES, USER_STATE_PRELINK_BASE_REVISION,
};

const USER_STATE_DB_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_USER_STATE_OPERATION_RETENTION_SECS: i64 = 7 * 24 * 60 * 60;

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

// The acknowledgement batches are materialized first: joined lazily, SQLite parses the JSON batch once for
// every row of the namespace instead of looking each incoming key up through the primary key.
pub(super) const MARK_ACKNOWLEDGED_RECORDS_APPLIED_SQL: &str = "WITH incoming AS MATERIALIZED ( \
       SELECT json_extract(value, '$.entityKey') AS entity_key, \
              json_extract(value, '$.revision') AS revision \
       FROM json_each(?2) \
     ) \
     UPDATE user_state_record AS record SET \
       applied_revision = MAX(record.applied_revision, incoming.revision), \
       deferred_reason = NULL, deferred_detail = NULL \
     FROM incoming \
     WHERE record.namespace = ?1 AND record.entity_key = incoming.entity_key \
       AND record.revision = incoming.revision";

pub(super) const ADVANCE_ACKNOWLEDGED_PROGRESS_SQL: &str = "WITH incoming AS MATERIALIZED ( \
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
     WHERE progress.namespace = ?1 AND progress.entity_key = incoming.entity_key";

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

const LOCAL_OR_COMPOSITION_KEY_RANGES: [(&str, &str); 6] = [
    (r#"["bookmark","[\"local","#, r#"["bookmark","[\"local\"-"#),
    (r#"["composition","#, r#"["composition"-"#),
    (r#"["library","[\"local","#, r#"["library","[\"local\"-"#),
    (r#"["membership","[\"local","#, r#"["membership","[\"local\"-"#),
    (r#"["reading","[\"local","#, r#"["reading","[\"local\"-"#),
    (r#"["resume","[\"local","#, r#"["resume","[\"local\"-"#),
];

struct KnownNonLocalWorks {
    by_source_id: HashSet<(String, String)>,
    by_path: HashSet<(String, String)>,
}

impl KnownNonLocalWorks {
    async fn load_in_tx(conn: &mut SqliteConnection) -> Result<Self, String> {
        let rows = sqlx::query(
            "SELECT plugin_id, source_novel_id, path \
             FROM novel \
             WHERE plugin_id <> 'local' AND is_local = 0",
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load known works: {err}"))?;
        let mut by_source_id = HashSet::with_capacity(rows.len());
        let mut by_path = HashSet::with_capacity(rows.len());
        for row in rows {
            let plugin_id: String = row.get("plugin_id");
            let source_novel_id = super::core::non_empty_source_id(row.get("source_novel_id"));
            let path: String = row.get("path");
            if let Some(sid) = source_novel_id {
                by_source_id.insert((plugin_id.clone(), fold_ascii(&sid)));
            }
            by_path.insert((plugin_id, path));
        }
        Ok(Self {
            by_source_id,
            by_path,
        })
    }

    fn contains(
        &self,
        plugin_id: &str,
        source_novel_id: Option<&str>,
        novel_path: &str,
    ) -> bool {
        if plugin_id == "local" {
            return false;
        }
        match source_novel_id {
            Some(sid) => self
                .by_source_id
                .contains(&(plugin_id.to_string(), fold_ascii(sid))),
            None => self
                .by_path
                .contains(&(plugin_id.to_string(), novel_path.to_string())),
        }
    }
}

pub async fn purge_and_settle_local_user_state_in_tx(
    conn: &mut SqliteConnection,
) -> Result<(), String> {
    sqlx::query(
        r#"DELETE FROM user_state_operation
         WHERE (instr(entity_key, '[\"local\",') > 0
                OR (entity_key >= '["composition",' AND entity_key < '["composition"-'))
           AND (
             json_extract(payload, '$.entity.work.pluginId') = 'local'
             OR (json_extract(payload, '$.entity.kind') = 'composition'
                 AND EXISTS (
                   SELECT 1 FROM json_each(payload, '$.value.composition.entries') e,
                                 json_each(e.value, '$.sources') s
                   WHERE json_extract(s.value, '$.pluginId') = 'local'
                 ))
           )"#,
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: purge local operations: {err}"))?;

    let intent_sql = (0..LOCAL_OR_COMPOSITION_KEY_RANGES.len())
        .map(|idx| {
            let base = idx * 2;
            format!(
                "SELECT entity_key FROM user_state_intent \
                 WHERE entity_key >= ?{} AND entity_key < ?{} \
                   AND (json_extract(entity_json, '$.work.pluginId') = 'local' \
                        OR (json_extract(entity_json, '$.kind') = 'composition' \
                            AND EXISTS ( \
                              SELECT 1 FROM json_each(value_json, '$.composition.entries') e, \
                                            json_each(e.value, '$.sources') s \
                              WHERE json_extract(s.value, '$.pluginId') = 'local' \
                            )))",
                base + 1,
                base + 2,
            )
        })
        .collect::<Vec<_>>()
        .join(" UNION ALL ");
    let mut intent_query = sqlx::query_scalar::<_, String>(&intent_sql);
    for (lower, upper) in LOCAL_OR_COMPOSITION_KEY_RANGES {
        intent_query = intent_query.bind(lower).bind(upper);
    }
    let local_intent_keys = intent_query
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: find local intents: {err}"))?;

    for batch in json_batches(&local_intent_keys, |k| k.len() + 4) {
        let encoded = serde_json::to_string(batch).unwrap();
        sqlx::query(
            "DELETE FROM user_state_conflict WHERE entity_key IN (SELECT value FROM json_each(?1))",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: purge local conflicts: {err}"))?;

        sqlx::query(
            "DELETE FROM user_state_progress WHERE entity_key IN (SELECT value FROM json_each(?1))",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: purge local progress: {err}"))?;

        sqlx::query(
            "DELETE FROM user_state_intent WHERE entity_key IN (SELECT value FROM json_each(?1))",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: purge local intents: {err}"))?;
    }

    let namespaces: Vec<String> = workspace_rows_in_tx(conn)
        .await?
        .into_iter()
        .map(|ws| ws.namespace)
        .collect();
    if !namespaces.is_empty() {
        let record_sql = (0..LOCAL_OR_COMPOSITION_KEY_RANGES.len())
            .map(|idx| {
                let base = idx * 2 + 1;
                format!(
                    "SELECT entity_key FROM user_state_record \
                     WHERE namespace = ?1 \
                       AND entity_key >= ?{} AND entity_key < ?{} \
                       AND (applied_revision < revision OR deferred_reason IS NOT NULL) \
                       AND ( \
                         json_extract(payload, '$.entity.work.pluginId') = 'local' \
                         OR (json_extract(payload, '$.entity.kind') = 'composition' \
                             AND EXISTS ( \
                               SELECT 1 FROM json_each(payload, '$.value.composition.entries') e, \
                                             json_each(e.value, '$.sources') s \
                               WHERE json_extract(s.value, '$.pluginId') = 'local' \
                             )) \
                       )",
                    base + 1,
                    base + 2,
                )
            })
            .collect::<Vec<_>>()
            .join(" UNION ALL ");
        for ns in namespaces {
            let mut record_query = sqlx::query_scalar::<_, String>(&record_sql).bind(&ns);
            for (lower, upper) in LOCAL_OR_COMPOSITION_KEY_RANGES {
                record_query = record_query.bind(lower).bind(upper);
            }
            let local_record_keys = record_query
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db user state: find local records: {err}"))?;
            for batch in json_batches(&local_record_keys, |k| k.len() + 4) {
                let encoded = serde_json::to_string(batch).unwrap();
                sqlx::query(
                    "UPDATE user_state_record \
                     SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL \
                     WHERE namespace = ?1 AND entity_key IN (SELECT value FROM json_each(?2))",
                )
                .bind(&ns)
                .bind(&encoded)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: settle local records: {err}"))?;
            }
        }
    }

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
    let plugin_needles: Vec<String> = held
        .id_pairs
        .iter()
        .map(|(plugin_id, _)| plugin_id)
        .chain(held.paths.iter().map(|(plugin_id, _)| plugin_id))
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|plugin_id| {
            let single = serde_json::to_string(plugin_id).unwrap();
            let double = serde_json::to_string(&single).unwrap();
            format!("[{},", &double[1..double.len() - 1])
        })
        .collect();
    let encoded_ids = serde_json::to_string(&id_json).unwrap();
    let encoded_paths = serde_json::to_string(&path_json).unwrap();
    let encoded_needles = serde_json::to_string(&plugin_needles).unwrap();
    let res = sqlx::query(
        "UPDATE user_state_record \
         SET applied_revision = revision, deferred_reason = NULL, deferred_detail = NULL \
         WHERE namespace = ?1 \
           AND (applied_revision < revision OR deferred_reason IS NOT NULL) \
           AND EXISTS (SELECT 1 FROM json_each(?4) hp WHERE instr(entity_key, hp.value) > 0) \
           AND json_extract(payload, '$.entity.kind') <> 'category' \
           AND ( \
             (json_extract(payload, '$.entity.work.sourceNovelId') IS NOT NULL \
              AND (json_extract(payload, '$.entity.work.pluginId'), \
                   lower(json_extract(payload, '$.entity.work.sourceNovelId'))) IN ( \
                SELECT json_extract(h.value, '$.pluginId'), json_extract(h.value, '$.sourceNovelId') \
                FROM json_each(?2) h \
              )) \
             OR (json_extract(payload, '$.entity.work.pluginId'), \
                 json_extract(payload, '$.entity.work.novelPath')) IN ( \
               SELECT json_extract(hp.value, '$.pluginId'), json_extract(hp.value, '$.novelPath') \
               FROM json_each(?3) hp \
             ) \
           )",
    )
    .bind(namespace)
    .bind(&encoded_ids)
    .bind(&encoded_paths)
    .bind(&encoded_needles)
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
    bind_user_state_workspace_with_options_in_tx(conn, ctx, binding, None, None).await
}

fn intent_timestamp_for_cutoff(entity: &JsonValue, value: &JsonValue) -> Option<i64> {
    match entity.get("kind").and_then(JsonValue::as_str) {
        Some("reading") => value.get("readAt").and_then(JsonValue::as_i64),
        Some("resume") => {
            let opened = value.get("openedAt").and_then(JsonValue::as_i64);
            let saved = value
                .get("anchor")
                .and_then(|a| a.get("savedAt"))
                .and_then(JsonValue::as_i64);
            match (opened, saved) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (Some(a), None) | (None, Some(a)) => Some(a),
                (None, None) => None,
            }
        }
        _ => None,
    }
}

async fn insert_seed_progress_for_intents_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    seed_cutoff_ms: Option<i64>,
) -> Result<(), String> {
    if seed_cutoff_ms.is_none() {
        sqlx::query(
            "INSERT INTO user_state_progress(namespace, entity_key, local_sequence, base_revision) \
             SELECT ?1, entity_key, sequence, CASE WHEN seed = 0 THEN ?2 ELSE 0 END \
             FROM user_state_intent WHERE true \
             ON CONFLICT(namespace, entity_key) DO NOTHING",
        )
        .bind(namespace)
        .bind(USER_STATE_PRELINK_BASE_REVISION)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: seed progress: {err}"))?;
        return Ok(());
    }
    let rows = sqlx::query(
        "SELECT sequence, entity_key, entity_json, value_json, seed FROM user_state_intent",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load intents for cutoff progress: {err}"))?;
    let mut eligible: Vec<(String, i64, i64)> = Vec::with_capacity(rows.len());
    for r in rows {
        let row = IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        };
        if let Ok((ent, val)) = intent_from_row(&row) {
            if is_before_seed_cutoff(intent_timestamp_for_cutoff(&ent, &val), seed_cutoff_ms) {
                continue;
            }
        }
        let base_rev = if row.seed == 0 {
            USER_STATE_PRELINK_BASE_REVISION
        } else {
            0
        };
        eligible.push((row.entity_key, row.sequence, base_rev));
    }
    for batch in json_batches(&eligible, |(k, _, _)| k.len() + 64) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(k, seq, rev)| {
                json!({ "entityKey": k, "sequence": seq, "baseRevision": rev })
            })
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "INSERT INTO user_state_progress(namespace, entity_key, local_sequence, base_revision) \
             SELECT ?1, json_extract(value, '$.entityKey'), json_extract(value, '$.sequence'), \
                    json_extract(value, '$.baseRevision') \
             FROM json_each(?2) WHERE true \
             ON CONFLICT(namespace, entity_key) DO NOTHING",
        )
        .bind(namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: insert cutoff progress: {err}"))?;
    }
    Ok(())
}

pub async fn bind_user_state_workspace_with_options_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    seed_allowed: Option<bool>,
    seed_cutoff_ms: Option<i64>,
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    if binding.server_url.is_empty() || binding.workspace_id.is_empty() || binding.epoch.is_empty()
    {
        return Err("A complete personal state workspace is required.".to_string());
    }
    if seed_cutoff_ms.is_some_and(|v| v < 0) {
        return Err("Seed cutoff time must be non-negative.".to_string());
    }
    let namespace = namespace_for(binding);
    let existing = workspace_rows_in_tx(conn)
        .await?
        .into_iter()
        .find(|row| row.server_url == binding.server_url);
    let seed_suppressed = if existing.is_some() {
        let ws = require_binding_in_tx(conn, binding).await?;
        if seed_allowed.is_some() {
            sqlx::query(
                "UPDATE user_state_workspace SET seed_cutoff_at = ?2 WHERE namespace = ?1",
            )
            .bind(&namespace)
            .bind(seed_cutoff_ms)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: update workspace seed cutoff: {err}"))?;
        }
        ws.seed_suppressed
    } else {
        sqlx::query(
            "INSERT INTO user_state_workspace(server_url, namespace, workspace_id, epoch, seed_suppressed, seed_cutoff_at) \
             VALUES (?1, ?2, ?3, ?4, 0, ?5)",
        )
        .bind(&binding.server_url)
        .bind(&namespace)
        .bind(&binding.workspace_id)
        .bind(&binding.epoch)
        .bind(seed_cutoff_ms)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: insert workspace: {err}"))?;
        false
    };

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
    if ready != 0 || seed_suppressed {
        if ready == 0 && seed_suppressed {
            sqlx::query(
                "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
                 ON CONFLICT(cache_key) DO NOTHING",
            )
            .bind(&ready_key)
            .bind(r#"{"version":1}"#)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: save delta ready flag: {err}"))?;
        }
        ctx.record_user_state_ledger_change();
        return Ok(());
    }

    if seed_allowed != Some(false) {
        if seed_cutoff_ms.is_none() {
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
        }

        seed_user_state_with_options_in_tx(conn, ctx, true, seed_cutoff_ms).await?;

        insert_seed_progress_for_intents_in_tx(conn, &namespace, seed_cutoff_ms).await?;
    }

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

    let mut pending_op_keys: HashSet<String> = HashSet::with_capacity(retry_rows.len());
    for r in &retry_rows {
        pending_op_keys.insert(r.get("entity_key"));
    }

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
           AND NOT EXISTS(SELECT 1 FROM user_state_conflict c \
                          WHERE c.namespace = ?1 AND c.entity_key = i.entity_key)\
         {opaque_filter} \
         ORDER BY CASE json_extract(i.entity_json, '$.kind') WHEN 'category' THEN 0 ELSE 1 END, \
                  i.sequence{limit_clause}"
    );
    let mut query = sqlx::query(&intent_sql).bind(&ws.namespace);
    if let Some(lim) = limit {
        query = query.bind(lim.saturating_add(pending_op_keys.len()) as i64);
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
        if pending_op_keys.contains(&intent_row.entity_key) {
            continue;
        }
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
        sqlx::query(MARK_ACKNOWLEDGED_RECORDS_APPLIED_SQL)
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
             SET status = incoming.status, \
                 receipt = incoming.receipt, \
                 acknowledged_at = CASE \
                   WHEN incoming.status = 'acknowledged' THEN COALESCE(operation.acknowledged_at, unixepoch()) \
                   ELSE NULL \
                 END \
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
        sqlx::query(ADVANCE_ACKNOWLEDGED_PROGRESS_SQL)
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

pub async fn prune_acknowledged_user_state_operations_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    older_than_secs: i64,
) -> Result<u64, String> {
    if !(0..=super::MAX_SAFE_INT_I64).contains(&older_than_secs) {
        return Err("Operation retention age must be a non-negative number of seconds.".to_string());
    }
    assert_user_state_available_in_tx(conn).await?;
    let ws = require_binding_in_tx(conn, binding).await?;
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let now_i64 = i64::try_from(now_secs).unwrap_or(i64::MAX);
    let cutoff = now_i64.saturating_sub(older_than_secs);
    let res = sqlx::query(
        "DELETE FROM user_state_operation \
         WHERE namespace = ?1 \
           AND status = 'acknowledged' \
           AND (acknowledged_at IS NULL OR acknowledged_at <= ?2)",
    )
    .bind(&ws.namespace)
    .bind(cutoff)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: prune acknowledged operations: {err}"))?;
    let pruned = res.rows_affected();
    if pruned > 0 {
        ctx.record_user_state_ledger_change();
    }
    Ok(pruned)
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
    let known_works = KnownNonLocalWorks::load_in_tx(conn).await?;
    let proj_rows = sqlx::query(
        "SELECT entity_key, applied_revision < revision AS waiting, deferred_reason, \
           json_extract(payload, '$.entity.kind') AS kind, \
           json_extract(payload, '$.entity.work.pluginId') AS plugin_id, \
           json_extract(payload, '$.entity.work.sourceNovelId') AS novel_id, \
           json_extract(payload, '$.entity.work.novelPath') AS novel_path \
         FROM user_state_record \
         WHERE namespace = ?1 \
           AND (applied_revision < revision OR deferred_reason = 'projection-error')",
    )
    .bind(&workspace.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: classify projection status: {err}"))?;

    let mut projection_pending: i64 = 0;
    let mut projection_failed: i64 = 0;
    for r in proj_rows {
        let kind: Option<String> = r.get("kind");
        let plugin_id: Option<String> = r.get("plugin_id");
        if plugin_id.as_deref() == Some("local") {
            continue;
        }
        let novel_id: Option<String> = r.get("novel_id");
        let novel_path: Option<String> = r.get("novel_path");
        if let Some(ref pid) = plugin_id {
            let work_ref = UserStateWorkReferenceDto {
                plugin_id: pid.clone(),
                source_novel_id: novel_id.clone(),
                novel_path: novel_path.clone().unwrap_or_default(),
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
        let applicable = kind.as_deref() == Some("category")
            || plugin_id.as_deref().is_some_and(|pid| {
                known_works.contains(pid, novel_id.as_deref(), novel_path.as_deref().unwrap_or(""))
            });
        let waiting: i64 = r.get("waiting");
        let entity_key: String = r.get("entity_key");
        if waiting != 0 && deferred_reason.is_none() && applicable && !held_keys.contains(&entity_key) {
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
            let mut matched_chapters = sqlx::query(&sql)
                .bind(plugin_id)
                .bind(source_novel_id)
                .bind(novel_path)
                .bind(ch_path)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db user state: lookup local conflict chapter: {err}"))?
                .iter()
                .map(map_user_chapter_row)
                .collect::<Vec<_>>();
            populate_user_chapter_composition_ids_in_tx(conn, &mut matched_chapters).await?;
            let local_ch = matched_chapters.into_iter().next();
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
    project_pending_user_state_bounded_in_tx(
        root,
        conn,
        ctx,
        binding,
        skipped_chapter_ids,
        None,
        &HashSet::new(),
    )
    .await
}

pub async fn project_pending_user_state_bounded_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    skipped_chapter_ids: &HashSet<i64>,
    limit: Option<usize>,
    skip_entity_keys: &HashSet<String>,
) -> Result<UserStateApplyEffectsDto, String> {
    let ws = require_binding_in_tx(conn, binding).await?;
    assert_user_state_available_in_tx(conn).await?;
    let mut effects = UserStateApplyEffectsDto::default();
    let max_actions = limit.filter(|n| *n > 0);

    purge_and_settle_local_user_state_in_tx(conn).await?;
    let settled_held =
        settle_held_source_records_in_tx(conn, &ws.namespace, &binding.server_url).await?;

    let known_works = KnownNonLocalWorks::load_in_tx(conn).await?;

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

    let candidate_headers = sqlx::query(
        "SELECT entity_key, revision, \
                json_extract(payload, '$.entity.kind') AS kind, \
                json_extract(payload, '$.entity.work.pluginId') AS plugin_id, \
                json_extract(payload, '$.entity.work.sourceNovelId') AS source_novel_id, \
                json_extract(payload, '$.entity.work.novelPath') AS novel_path, \
                json_extract(payload, '$.entity.categoryId') AS category_id \
         FROM user_state_record \
         WHERE namespace = ?1 \
           AND applied_revision < revision \
           AND (deferred_reason IS NULL OR deferred_reason = 'projection-error')",
    )
    .bind(&ws.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: scan pending projection headers: {err}"))?;

    let mut missing_work_targets: Vec<(String, i64)> = Vec::new();
    let mut local_targets: Vec<(String, i64)> = Vec::new();
    let mut actionable_targets: Vec<(u8, i64, String)> = Vec::new();
    let mut alias_cache: HashMap<String, String> = HashMap::new();

    for row in candidate_headers {
        let key: String = row.get("entity_key");
        let revision: i64 = row.get("revision");
        let kind: Option<String> = row.get("kind");
        let kind_str = kind.as_deref().unwrap_or("");
        let plugin_id: Option<String> = row.get("plugin_id");
        let source_novel_id: Option<String> = row.get("source_novel_id");
        let novel_path: Option<String> = row.get("novel_path");
        let category_id: Option<String> = row.get("category_id");

        if plugin_id.as_deref() == Some("local") {
            local_targets.push((key, revision));
            continue;
        }
        if kind_str != "category"
            && !plugin_id.as_deref().is_some_and(|pid| {
                known_works.contains(
                    pid,
                    source_novel_id.as_deref(),
                    novel_path.as_deref().unwrap_or(""),
                )
            })
        {
            missing_work_targets.push((key, revision));
            continue;
        }
        if skip_entity_keys.contains(&key) || held_keys.contains(&key) {
            continue;
        }
        if !held_keys.is_empty() {
            if let Some(cat_id) = category_id {
                let canon_cat_id = if let Some(cached) = alias_cache.get(&cat_id) {
                    cached.clone()
                } else {
                    let resolved = resolve_category_alias_in_tx(conn, &ws.namespace, &cat_id).await?;
                    alias_cache.insert(cat_id, resolved.clone());
                    resolved
                };
                let canon_key = if kind_str == "category" {
                    user_state_entity_key(&json!({ "kind": "category", "categoryId": canon_cat_id }))?
                } else if kind_str == "membership" {
                    if let Some(ref pid) = plugin_id {
                        let work_ref = UserStateWorkReferenceDto {
                            plugin_id: pid.clone(),
                            source_novel_id: source_novel_id.clone(),
                            novel_path: novel_path.clone().unwrap_or_default(),
                            name: String::new(),
                        };
                        user_state_entity_key(&json!({
                            "kind": "membership",
                            "work": work_ref,
                            "categoryId": canon_cat_id,
                        }))?
                    } else {
                        key.clone()
                    }
                } else {
                    key.clone()
                };
                if held_keys.contains(&canon_key) {
                    continue;
                }
            }
        }
        let rank: u8 = match kind_str {
            "category" => 0,
            "library" => 1,
            "composition" => 2,
            _ => 3,
        };
        actionable_targets.push((rank, revision, key));
    }

    for batch in json_batches(&local_targets, |(k, _)| k.len() + 48) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(k, rev)| json!({ "entityKey": k, "revision": rev }))
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "WITH targets AS MATERIALIZED ( \
               SELECT json_extract(value, '$.entityKey') AS entity_key, \
                      json_extract(value, '$.revision') AS revision \
               FROM json_each(?2) \
             ) \
             UPDATE user_state_record AS record SET \
               applied_revision = targets.revision, \
               deferred_reason = NULL, \
               deferred_detail = NULL \
             FROM targets \
             WHERE record.namespace = ?1 \
               AND record.entity_key = targets.entity_key \
               AND record.revision = targets.revision",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: settle local pending records: {err}"))?;
    }

    let park_cap = max_actions.map(|l| l.saturating_mul(8).max(l));
    let more_missing = park_cap.is_some_and(|cap| missing_work_targets.len() > cap);
    let park_len = park_cap.map_or(missing_work_targets.len(), |cap| {
        missing_work_targets.len().min(cap)
    });
    let to_park = &missing_work_targets[..park_len];
    for batch in json_batches(to_park, |(k, _)| k.len() + 48) {
        let items: Vec<JsonValue> = batch
            .iter()
            .map(|(k, rev)| json!({ "entityKey": k, "revision": rev }))
            .collect();
        let encoded = serde_json::to_string(&items).unwrap();
        sqlx::query(
            "WITH targets AS MATERIALIZED ( \
               SELECT json_extract(value, '$.entityKey') AS entity_key, \
                      json_extract(value, '$.revision') AS revision \
               FROM json_each(?2) \
             ) \
             UPDATE user_state_record AS record SET \
               applied_revision = targets.revision, \
               deferred_reason = 'missing-work', \
               deferred_detail = NULL \
             FROM targets \
             WHERE record.namespace = ?1 \
               AND record.entity_key = targets.entity_key \
               AND record.revision = targets.revision",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: bulk skip missing works: {err}"))?;
    }

    actionable_targets.sort_by(|lhs, rhs| lhs.0.cmp(&rhs.0).then(lhs.1.cmp(&rhs.1)));
    let action_cap = max_actions.unwrap_or(actionable_targets.len());
    let more_actionable = actionable_targets.len() > action_cap;
    let to_project_keys: Vec<String> = actionable_targets
        .into_iter()
        .take(action_cap)
        .map(|(_, _, k)| k)
        .collect();
    effects.has_more = more_missing || more_actionable;

    if to_project_keys.is_empty() {
        if settled_held > 0 || !to_park.is_empty() || !local_targets.is_empty() {
            ctx.record_user_state_ledger_change();
        }
        return Ok(effects);
    }

    let mut fetched_by_key: HashMap<String, String> = HashMap::with_capacity(to_project_keys.len());
    for batch in json_batches(&to_project_keys, |k| k.len() + 4) {
        let encoded = serde_json::to_string(batch).unwrap();
        let rows = sqlx::query(
            "SELECT entity_key, payload \
             FROM user_state_record \
             WHERE namespace = ?1 AND entity_key IN (SELECT value FROM json_each(?2))",
        )
        .bind(&ws.namespace)
        .bind(&encoded)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load pending projection records: {err}"))?;
        for r in rows {
            fetched_by_key.insert(r.get("entity_key"), r.get("payload"));
        }
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

    let mut saw_composition = false;
    let mut touched_last_read_novels: HashSet<i64> = HashSet::new();
    let mut composition_entries = CompositionEntryCache::default();

    for key in to_project_keys {
        let Some(payload) = fetched_by_key.remove(&key) else {
            continue;
        };
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

        match materialize_user_state_record_with_options_in_tx(
            root,
            conn,
            &ws.namespace,
            &record,
            skipped_chapter_ids,
            true,
            Some(&mut composition_entries),
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
                effects.failed_entity_keys.push(key);
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

async fn clear_namespace_ledger_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
) -> Result<(), String> {
    for table in [
        "user_state_conflict",
        "user_state_operation",
        "user_state_record",
        "user_state_progress",
        "user_state_alias",
    ] {
        let sql = format!("DELETE FROM {table} WHERE namespace = ?1");
        sqlx::query(&sql)
            .bind(namespace)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: clear {table}: {err}"))?;
    }
    Ok(())
}

pub async fn rebind_user_state_workspace_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    mode: UserStateRebindMode,
    head_revision: Option<i64>,
    seed_cutoff_ms: Option<i64>,
    seed_allowed: Option<bool>,
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    if binding.server_url.is_empty() || binding.workspace_id.is_empty() || binding.epoch.is_empty()
    {
        return Err("A complete personal state workspace is required.".to_string());
    }
    if let Some(rev) = head_revision {
        if rev < 0 {
            return Err("Workspace head revision must be non-negative.".to_string());
        }
    }
    if let Some(cutoff) = seed_cutoff_ms {
        if cutoff < 0 {
            return Err("Seed cutoff time must be non-negative.".to_string());
        }
    }

    let new_ns = namespace_for(binding);
    let existing = workspace_rows_in_tx(conn)
        .await?
        .into_iter()
        .find(|row| row.server_url == binding.server_url);

    let ready_key = format!("user-state-delta-ready:{new_ns}");
    if mode == UserStateRebindMode::Reseed {
        if let Some(ref ws) = existing {
            if ws.namespace == new_ns && !ws.seed_suppressed {
                let ready: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM content_sync_cache WHERE cache_key = ?1",
                )
                .bind(&ready_key)
                .fetch_one(&mut *conn)
                .await
                .map_err(|err| format!("db user state: check rebind delta ready: {err}"))?;
                if ready != 0 {
                    if seed_allowed.is_some() || seed_cutoff_ms.is_some() {
                        sqlx::query(
                            "UPDATE user_state_workspace SET seed_cutoff_at = ?2 WHERE namespace = ?1",
                        )
                        .bind(&new_ns)
                        .bind(seed_cutoff_ms)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db user state: update rebind seed cutoff: {err}"))?;
                    }
                    ctx.record_user_state_ledger_change();
                    return Ok(());
                }
            }
        }
    }

    let mut namespaces_to_clear = vec![new_ns.clone()];
    if let Some(ref old_ws) = existing {
        if old_ws.namespace != new_ns {
            namespaces_to_clear.push(old_ws.namespace.clone());
        }
    }
    for ns in &namespaces_to_clear {
        clear_namespace_ledger_in_tx(conn, ns).await?;
        let old_ready_key = format!("user-state-delta-ready:{ns}");
        sqlx::query("DELETE FROM content_sync_cache WHERE cache_key = ?1")
            .bind(&old_ready_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: clear delta ready flag: {err}"))?;
    }

    sqlx::query(
        "DELETE FROM user_state_intent \
         WHERE NOT EXISTS (SELECT 1 FROM user_state_progress p WHERE p.entity_key = user_state_intent.entity_key)",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clear orphaned intents on rebind: {err}"))?;

    let (cursor, seed_suppressed) = match mode {
        UserStateRebindMode::Reseed => (0_i64, 0_i64),
        UserStateRebindMode::StartFresh => (head_revision.unwrap_or(0), 1_i64),
    };
    sqlx::query(
        "INSERT INTO user_state_workspace(server_url, namespace, workspace_id, epoch, cursor, read_through, last_success_at, seed_suppressed, seed_cutoff_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7) \
         ON CONFLICT(server_url) DO UPDATE SET \
           namespace = excluded.namespace, \
           workspace_id = excluded.workspace_id, \
           epoch = excluded.epoch, \
           cursor = excluded.cursor, \
           read_through = NULL, \
           last_success_at = NULL, \
           seed_suppressed = excluded.seed_suppressed, \
           seed_cutoff_at = excluded.seed_cutoff_at",
    )
    .bind(&binding.server_url)
    .bind(&new_ns)
    .bind(&binding.workspace_id)
    .bind(&binding.epoch)
    .bind(cursor)
    .bind(seed_suppressed)
    .bind(seed_cutoff_ms)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: upsert rebound workspace: {err}"))?;

    purge_and_settle_local_user_state_in_tx(conn).await?;

    if mode == UserStateRebindMode::Reseed && seed_allowed != Some(false) {
        seed_user_state_with_options_in_tx(conn, ctx, true, seed_cutoff_ms).await?;
        insert_seed_progress_for_intents_in_tx(conn, &new_ns, seed_cutoff_ms).await?;
    }

    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO NOTHING",
    )
    .bind(&ready_key)
    .bind(r#"{"version":1}"#)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: save rebound delta ready flag: {err}"))?;

    ctx.record_user_state_ledger_change();
    Ok(())
}

fn canonical_tombstone_for_entity(entity: &JsonValue, prev_value: &JsonValue) -> Option<JsonValue> {
    match entity.get("kind").and_then(JsonValue::as_str)? {
        "library" => Some(json!({ "inLibrary": false, "addedAt": null })),
        "category" => {
            let name = prev_value
                .get("name")
                .and_then(JsonValue::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Deleted");
            Some(json!({ "name": name, "sort": 0, "deleted": true }))
        }
        "membership" => Some(json!({ "included": false })),
        "reading" => Some(json!({ "progress": 0, "unread": true, "readAt": null })),
        "bookmark" => Some(json!({ "bookmarked": false })),
        "resume" => Some(json!({ "chapter": null, "anchor": null, "openedAt": null })),
        _ => None,
    }
}

fn is_record_before_seed_cutoff(
    entity: &JsonValue,
    value: &JsonValue,
    seed_cutoff_ms: Option<i64>,
) -> bool {
    let Some(cutoff) = seed_cutoff_ms else {
        return false;
    };
    is_before_seed_cutoff(intent_timestamp_for_cutoff(entity, value), Some(cutoff))
}

async fn rebase_pending_progress_to_zero_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    record: &ParsedUserStateRecord,
) -> Result<(), String> {
    let key = user_state_entity_key(&record.entity)?;
    sqlx::query(
        "UPDATE user_state_progress SET base_revision = 0 \
         WHERE namespace = ?1 AND entity_key = ?2",
    )
    .bind(namespace)
    .bind(&key)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: rebase pending progress: {err}"))?;
    sqlx::query(
        "DELETE FROM user_state_operation \
         WHERE namespace = ?1 AND entity_key = ?2 AND status = 'pending'",
    )
    .bind(namespace)
    .bind(&key)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clear stale pending operation on rebase: {err}"))?;

    if record.entity.get("categoryId").is_some() {
        let kind = record.entity["kind"].as_str().unwrap_or("");
        let rows = sqlx::query(
            "SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
             FROM user_state_intent i \
             JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
             WHERE i.seed = 0 AND p.base_revision <> ?3 AND i.sequence > p.acknowledged_sequence \
               AND json_extract(i.entity_json, '$.kind') = ?2",
        )
        .bind(namespace)
        .bind(kind)
        .bind(USER_STATE_PRELINK_BASE_REVISION)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load aliased pending intents for rebase: {err}"))?;
        for r in rows {
            let intent_row = IntentRow {
                sequence: r.get("sequence"),
                entity_key: r.get("entity_key"),
                entity_json: r.get("entity_json"),
                value_json: r.get("value_json"),
                seed: r.get("seed"),
            };
            let (ent, _) = intent_from_row(&intent_row)?;
            let canonical = canonical_entity_in_tx(conn, namespace, &ent).await?;
            if user_state_entity_key(&canonical)? == key {
                sqlx::query(
                    "UPDATE user_state_progress SET base_revision = 0 \
                     WHERE namespace = ?1 AND entity_key = ?2",
                )
                .bind(namespace)
                .bind(&intent_row.entity_key)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: rebase aliased pending progress: {err}"))?;
                sqlx::query(
                    "DELETE FROM user_state_operation \
                     WHERE namespace = ?1 AND entity_key = ?2 AND status = 'pending'",
                )
                .bind(namespace)
                .bind(&intent_row.entity_key)
                .execute(&mut *conn)
                .await
                .map_err(|err| {
                    format!("db user state: clear stale aliased pending operation on rebase: {err}")
                })?;
            }
        }
    }
    Ok(())
}

async fn clear_non_pending_or_seed_intent_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    entity_key: &str,
    remove_any_seed: bool,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM user_state_operation \
         WHERE namespace = ?1 AND entity_key = ?2 \
           AND (status <> 'pending' OR (?3 = 1 AND json_extract(payload, '$.seed') = 1))",
    )
    .bind(namespace)
    .bind(entity_key)
    .bind(if remove_any_seed { 1_i64 } else { 0_i64 })
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clear settled operations for absent entity: {err}"))?;

    sqlx::query(
        "DELETE FROM user_state_progress \
         WHERE namespace = ?1 AND entity_key = ?2 \
           AND ( \
             base_revision = ?3 \
             OR acknowledged_sequence >= local_sequence \
             OR (?4 = 1 AND EXISTS (SELECT 1 FROM user_state_intent i WHERE i.entity_key = user_state_progress.entity_key AND i.seed = 1)) \
           )",
    )
    .bind(namespace)
    .bind(entity_key)
    .bind(USER_STATE_PRELINK_BASE_REVISION)
    .bind(if remove_any_seed { 1_i64 } else { 0_i64 })
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clear settled progress for absent entity: {err}"))?;

    sqlx::query(
        "DELETE FROM user_state_intent \
         WHERE entity_key = ?1 \
           AND NOT EXISTS (SELECT 1 FROM user_state_progress p WHERE p.entity_key = user_state_intent.entity_key)",
    )
    .bind(entity_key)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clear orphaned intent for absent entity: {err}"))?;
    Ok(())
}

pub async fn reconcile_user_state_snapshot_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
    raw_records: &[JsonValue],
    snapshot_revision: i64,
    seed_allowed: Option<bool>,
    seed_cutoff_ms: Option<i64>,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<UserStateApplyEffectsDto, String> {
    assert_user_state_available_in_tx(conn).await?;
    if snapshot_revision < 0 {
        return Err("Snapshot revision must be non-negative.".to_string());
    }
    if seed_cutoff_ms.is_some_and(|v| v < 0) {
        return Err("Seed cutoff time must be non-negative.".to_string());
    }
    let ws = require_binding_in_tx(conn, binding).await?;

    let mut snapshot_records = Vec::with_capacity(raw_records.len());
    let mut snapshot_keys = HashSet::with_capacity(raw_records.len());
    for raw in raw_records {
        let parsed = parse_user_state_record(raw)?;
        snapshot_keys.insert(user_state_entity_key(&parsed.entity)?);
        snapshot_records.push(parsed);
    }

    let held_sources = load_current_held_sources_in_tx(conn, &binding.server_url).await?;
    let dirty_before: Vec<(String, String)> = sqlx::query(
        "SELECT plugin_id, path FROM work_metadata_dirty ORDER BY plugin_id, path",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: snapshot work_metadata_dirty before reconcile: {err}"))?
    .into_iter()
    .map(|r| (r.get("plugin_id"), r.get("path")))
    .collect();

    let existing_rows = sqlx::query(
        "SELECT entity_key, payload FROM user_state_record WHERE namespace = ?1",
    )
    .bind(&ws.namespace)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load existing records for reconcile: {err}"))?;

    promote_private_work_identities_in_tx(conn).await?;

    let private_keys: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT entity_key FROM user_state_private")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load private keys for reconcile: {err}"))?
            .into_iter()
            .collect();

    let mut effects = UserStateApplyEffectsDto::default();
    let mut touched_last_read_novels: HashSet<i64> = HashSet::new();
    let mut composition_entries = CompositionEntryCache::default();

    for row in existing_rows {
        let entity_key: String = row.get("entity_key");
        if snapshot_keys.contains(&entity_key) {
            continue;
        }
        let payload: String = row.get("payload");
        sqlx::query("DELETE FROM user_state_record WHERE namespace = ?1 AND entity_key = ?2")
            .bind(&ws.namespace)
            .bind(&entity_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: delete absent record: {err}"))?;

        let raw: JsonValue = serde_json::from_str(&payload)
            .map_err(|err| format!("db user state: parse absent record: {err}"))?;
        let rec = parse_user_state_record(&raw)?;

        if is_local_user_state_entity(&rec.entity, Some(&rec.value)) {
            continue;
        }
        if let Some(work_val) = rec.entity.get("work") {
            if let Ok(work_ref) = parse_work_reference(work_val) {
                if is_current_work_held(&held_sources, &work_ref) {
                    clear_non_pending_or_seed_intent_in_tx(conn, &ws.namespace, &entity_key, true)
                        .await?;
                    continue;
                }
            }
        }
        if has_pending_user_state_for_record_in_tx(conn, &ws.namespace, &rec).await? {
            rebase_pending_progress_to_zero_in_tx(conn, &ws.namespace, &rec).await?;
            continue;
        }

        let is_private_reading = if rec.entity["kind"].as_str() == Some("reading") {
            if private_keys.contains(&entity_key) {
                true
            } else if let (Some(plugin_id), Some(novel_path), Some(chapter_path)) = (
                rec.entity["work"]["pluginId"].as_str(),
                rec.entity["work"]["novelPath"].as_str(),
                rec.entity["chapter"]["chapterPath"].as_str(),
            ) {
                if rec.entity["work"]["sourceNovelId"].is_string() {
                    let path_work = user_state_work_key_parts(plugin_id, None, novel_path);
                    let path_key =
                        serde_json::to_string(&("reading", path_work, chapter_path)).unwrap();
                    private_keys.contains(&path_key)
                } else if !private_keys.is_empty() {
                    let source_novel_id: Option<String> = sqlx::query_scalar(
                        "SELECT source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2 LIMIT 1",
                    )
                    .bind(plugin_id)
                    .bind(novel_path)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| {
                        format!(
                            "db user state: lookup novel source id for private reconcile: {err}"
                        )
                    })?
                    .flatten();
                    if let Some(source_novel_id) = super::core::non_empty_source_id(source_novel_id) {
                        let id_work = user_state_work_key_parts(
                            plugin_id,
                            Some(&source_novel_id),
                            novel_path,
                        );
                        let id_key =
                            serde_json::to_string(&("reading", id_work, chapter_path)).unwrap();
                        private_keys.contains(&id_key)
                    } else {
                        false
                    }
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };
        let preserve_local = is_record_before_seed_cutoff(&rec.entity, &rec.value, seed_cutoff_ms)
            || is_private_reading;

        if !preserve_local {
            if let Some(tombstone_val) = canonical_tombstone_for_entity(&rec.entity, &rec.value) {
                let tombstone_rec = ParsedUserStateRecord {
                    entity: rec.entity.clone(),
                    value: tombstone_val,
                    revision: rec.revision.max(1),
                    operation_id: "snapshot-gc-tombstone".to_string(),
                    updated_at: rec.updated_at,
                    device_id: rec.device_id.clone(),
                    device_name: rec.device_name.clone(),
                };
                match materialize_user_state_record_with_options_in_tx(
                    root,
                    conn,
                    &ws.namespace,
                    &tombstone_rec,
                    skipped_chapter_ids,
                    true,
                    Some(&mut composition_entries),
                )
                .await
                {
                    Ok((next, touched_novel_id)) => {
                        if let Some(novel_id) = touched_novel_id {
                            touched_last_read_novels.insert(novel_id);
                        }
                        effects.resumes.extend(next.resumes);
                    }
                    Err(MaterializeError::Deferred(_)) => {}
                    Err(MaterializeError::Fatal(err)) => {
                        log::warn!("[user-state] failed to materialize GC tombstone for {entity_key}: {err}");
                    }
                }
            }
        }

        sqlx::query("DELETE FROM user_state_conflict WHERE namespace = ?1 AND entity_key = ?2")
            .bind(&ws.namespace)
            .bind(&entity_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: clear conflict for absent record: {err}"))?;
        clear_non_pending_or_seed_intent_in_tx(conn, &ws.namespace, &entity_key, true).await?;
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
        .map_err(|err| format!("db user state: update novel last_read_at on reconcile: {err}"))?;
    }

    store_user_state_records_in_tx(conn, &ws.namespace, &snapshot_records).await?;

    if seed_allowed == Some(false) {
        sqlx::query(
            "DELETE FROM user_state_operation \
             WHERE namespace = ?1 AND json_extract(payload, '$.seed') = 1",
        )
        .bind(&ws.namespace)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: clear seed operations on reconcile: {err}"))?;

        sqlx::query(
            "DELETE FROM user_state_progress \
             WHERE namespace = ?1 \
               AND ( \
                 base_revision = ?2 \
                 OR EXISTS (SELECT 1 FROM user_state_intent i WHERE i.entity_key = user_state_progress.entity_key AND i.seed = 1) \
               )",
        )
        .bind(&ws.namespace)
        .bind(USER_STATE_PRELINK_BASE_REVISION)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: clear seed progress on reconcile: {err}"))?;

        sqlx::query(
            "DELETE FROM user_state_intent \
             WHERE seed = 1 \
               AND NOT EXISTS (SELECT 1 FROM user_state_progress p WHERE p.entity_key = user_state_intent.entity_key)",
        )
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: clear orphaned seed intents on reconcile: {err}"))?;
    }

    sqlx::query(
        "DELETE FROM user_state_alias \
         WHERE namespace = ?1 \
           AND NOT EXISTS ( \
             SELECT 1 FROM user_state_record r \
             WHERE r.namespace = ?1 \
               AND r.entity_key = json_array('category', user_state_alias.canonical_id) \
           )",
    )
    .bind(&ws.namespace)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: clean dangling category aliases: {err}"))?;

    sqlx::query(
        "UPDATE user_state_workspace \
         SET cursor = ?2, read_through = NULL, last_success_at = ?3, seed_cutoff_at = ?4 \
         WHERE namespace = ?1",
    )
    .bind(&ws.namespace)
    .bind(snapshot_revision)
    .bind(now_ms())
    .bind(seed_cutoff_ms)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: update workspace cursor on reconcile: {err}"))?;

    sqlx::query("DELETE FROM work_metadata_dirty")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: reset work_metadata_dirty on reconcile: {err}"))?;
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
        .map_err(|err| format!("db user state: restore work_metadata_dirty on reconcile: {err}"))?;
    }

    ctx.request_user_state_deferred_apply();
    ctx.record_user_state_ledger_change();
    Ok(effects)
}

pub async fn apply_local_user_state_retention_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    prune_non_library_days: Option<i64>,
    strip_timestamps_days: Option<i64>,
    reference_now_ms: i64,
) -> Result<u64, String> {
    if let Some(days) = prune_non_library_days {
        if days < 1 {
            return Err("Non-library retention days must be at least 1.".to_string());
        }
    }
    if let Some(days) = strip_timestamps_days {
        if days < 1 {
            return Err("Reading timestamp retention days must be at least 1.".to_string());
        }
    }
    if prune_non_library_days.is_none() && strip_timestamps_days.is_none() {
        return Ok(0);
    }

    let has_schema = has_user_state_schema_in_tx(conn).await?;
    let private_keys: HashSet<String> = if has_schema {
        promote_private_work_identities_in_tx(conn).await?;
        sqlx::query_scalar::<_, String>("SELECT entity_key FROM user_state_private")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load private keys for retention: {err}"))?
            .into_iter()
            .collect()
    } else {
        HashSet::new()
    };

    let mut affected: u64 = 0;
    let mut touched_novels: HashSet<i64> = HashSet::new();
    let mut public_touched_novels: HashSet<i64> = HashSet::new();

    // Run 2-A (prune non-library) before 2-B (strip timestamps) so 2-B does not clear read_at
    // before 2-A checks older non-library chapters when both policies are enabled together.
    if let Some(days) = prune_non_library_days {
        let cutoff_ms = reference_now_ms.saturating_sub(days.saturating_mul(86_400_000));
        let sql = format!(
            "{USER_CHAPTER_SELECT} WHERE n.in_library = 0 AND n.plugin_id <> 'local' AND n.is_local = 0 \
             AND c.read_at IS NOT NULL"
        );
        let rows = sqlx::query(&sql)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load non-library retention chapters: {err}"))?;
        let mut target_rows: Vec<UserChapterRow> = rows
            .iter()
            .map(map_user_chapter_row)
            .filter(|ch| is_before_seed_cutoff(ch.read_at, Some(cutoff_ms)))
            .collect();
        if !target_rows.is_empty() {
            populate_user_chapter_composition_ids_in_tx(conn, &mut target_rows).await?;
            let ch_ids: Vec<i64> = target_rows.iter().map(|ch| ch.id).collect();
            let mut public_rows = Vec::with_capacity(target_rows.len());
            for ch in &mut target_rows {
                touched_novels.insert(ch.novel_id);
                let is_private = if has_schema && !private_keys.is_empty() {
                    let key = user_state_entity_key(&json!({
                        "kind": "reading",
                        "work": chapter_work_json(ch),
                        "chapter": chapter_reference_json(ch),
                    }))?;
                    private_keys.contains(&key)
                } else {
                    false
                };
                ch.progress = 0.0;
                ch.unread = 1;
                ch.read_at = None;
                if !is_private {
                    public_touched_novels.insert(ch.novel_id);
                    public_rows.push(ch.clone());
                }
            }
            let encoded_ids = serde_json::to_string(&ch_ids).unwrap();
            let res = sqlx::query(
                "UPDATE chapter \
                 SET progress = 0, unread = 1, read_at = NULL, updated_at = unixepoch() \
                 WHERE id IN (SELECT value FROM json_each(?1))",
            )
            .bind(&encoded_ids)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: prune non-library chapters: {err}"))?;
            affected = affected.saturating_add(res.rows_affected());
            if has_schema && !public_rows.is_empty() {
                record_chapter_rows_in_tx(conn, ctx, &public_rows, "reading", false).await?;
            }
        }
    }

    if let Some(days) = strip_timestamps_days {
        let cutoff_ms = reference_now_ms.saturating_sub(days.saturating_mul(86_400_000));
        let sql = format!(
            "{USER_CHAPTER_SELECT} WHERE n.plugin_id <> 'local' AND n.is_local = 0 AND c.read_at IS NOT NULL"
        );
        let rows = sqlx::query(&sql)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load timestamp retention chapters: {err}"))?;
        let mut target_rows: Vec<UserChapterRow> = rows
            .iter()
            .map(map_user_chapter_row)
            .filter(|ch| is_before_seed_cutoff(ch.read_at, Some(cutoff_ms)))
            .collect();
        if !target_rows.is_empty() {
            populate_user_chapter_composition_ids_in_tx(conn, &mut target_rows).await?;
            let ch_ids: Vec<i64> = target_rows.iter().map(|ch| ch.id).collect();
            let mut public_rows = Vec::with_capacity(target_rows.len());
            for ch in &mut target_rows {
                touched_novels.insert(ch.novel_id);
                let is_private = if has_schema && !private_keys.is_empty() {
                    let key = user_state_entity_key(&json!({
                        "kind": "reading",
                        "work": chapter_work_json(ch),
                        "chapter": chapter_reference_json(ch),
                    }))?;
                    private_keys.contains(&key)
                } else {
                    false
                };
                ch.read_at = None;
                if !is_private {
                    public_touched_novels.insert(ch.novel_id);
                    public_rows.push(ch.clone());
                }
            }
            let encoded_ids = serde_json::to_string(&ch_ids).unwrap();
            let res = sqlx::query(
                "UPDATE chapter SET read_at = NULL, updated_at = unixepoch() \
                 WHERE id IN (SELECT value FROM json_each(?1))",
            )
            .bind(&encoded_ids)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: strip reading timestamps: {err}"))?;
            affected = affected.saturating_add(res.rows_affected());
            if has_schema && !public_rows.is_empty() {
                record_chapter_rows_in_tx(conn, ctx, &public_rows, "reading", false).await?;
            }
        }
    }

    if !touched_novels.is_empty() {
        let novel_ids: Vec<i64> = touched_novels.into_iter().collect();
        let encoded = serde_json::to_string(&novel_ids).unwrap();
        sqlx::query(
            "UPDATE novel \
             SET last_read_at = (SELECT MAX(read_at) FROM chapter WHERE novel_id = novel.id), \
                 updated_at = unixepoch() \
             WHERE id IN (SELECT value FROM json_each(?1))",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: update novel last_read_at on retention: {err}"))?;

        if has_schema && !public_touched_novels.is_empty() {
            let public_ids: Vec<i64> = public_touched_novels.into_iter().collect();
            let encoded_public = serde_json::to_string(&public_ids).unwrap();
            let cleared_resumes: Vec<i64> = if private_keys.is_empty() {
                sqlx::query_scalar(
                    "SELECT id FROM novel \
                     WHERE id IN (SELECT value FROM json_each(?1)) AND last_read_at IS NULL",
                )
                .bind(&encoded_public)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| {
                    format!("db user state: find cleared resume novels on retention: {err}")
                })?
            } else {
                let sql = format!(
                    "{USER_CHAPTER_SELECT} \
                     WHERE c.novel_id IN (SELECT value FROM json_each(?1)) AND c.read_at IS NOT NULL"
                );
                let remaining_rows = sqlx::query(&sql)
                    .bind(&encoded_public)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| {
                        format!(
                            "db user state: check remaining public chapters on retention: {err}"
                        )
                    })?;
                let mut remaining: Vec<UserChapterRow> =
                    remaining_rows.iter().map(map_user_chapter_row).collect();
                populate_user_chapter_composition_ids_in_tx(conn, &mut remaining).await?;
                let mut novels_with_public_read_at: HashSet<i64> = HashSet::new();
                for ch in &remaining {
                    let key = user_state_entity_key(&json!({
                        "kind": "reading",
                        "work": chapter_work_json(ch),
                        "chapter": chapter_reference_json(ch),
                    }))?;
                    if !private_keys.contains(&key) {
                        novels_with_public_read_at.insert(ch.novel_id);
                    }
                }
                public_ids
                    .into_iter()
                    .filter(|id| !novels_with_public_read_at.contains(id))
                    .collect()
            };
            if !cleared_resumes.is_empty() {
                record_resume_cleared_in_tx(conn, ctx, Some(&cleared_resumes)).await?;
            }
        }
    }

    Ok(affected)
}
