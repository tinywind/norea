use std::collections::{HashMap, HashSet};

use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};

use crate::db::chapter_composition::get_chapter_composition_in_tx;
use crate::db::tx::TxContext;
use crate::db::UserStateCommitPriority;

use super::types::{
    canonical_user_state_json, is_local_user_state_entity, namespace_for, parse_user_state_entity,
    parse_user_state_value, random_uuid_v4, sha256_hex, user_state_entity_key,
    user_state_work_key_parts, UserStateBindingDto, UserStateWorkReferenceDto,
};

#[derive(Debug, Clone)]
pub struct IntentRow {
    pub sequence: i64,
    pub entity_key: String,
    pub entity_json: String,
    pub value_json: String,
    pub seed: i64,
}

#[derive(Debug, Clone)]
pub struct WorkspaceRow {
    pub server_url: String,
    pub namespace: String,
    pub workspace_id: String,
    pub epoch: String,
    pub cursor: i64,
    pub through: Option<i64>,
    pub last_success_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct UserChapterRow {
    pub id: i64,
    pub novel_id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub novel_path: String,
    pub name: String,
    pub chapter_path: String,
    pub chapter_name: String,
    pub composition_entry_id: Option<String>,
    pub progress: f64,
    pub unread: i64,
    pub read_at: Option<i64>,
    pub bookmark: i64,
}

pub const USER_CHAPTER_SELECT: &str = "\
SELECT c.id, c.novel_id AS novelId, n.plugin_id AS pluginId, n.source_novel_id AS sourceNovelId, \
  n.path AS novelPath, n.name, c.path AS chapterPath, c.name AS chapterName, \
  c.progress, c.unread, c.read_at AS readAt, c.bookmark, \
  NULL AS compositionEntryId \
FROM chapter c JOIN novel n ON n.id = c.novel_id";

pub async fn populate_user_chapter_composition_ids_in_tx(
    conn: &mut SqliteConnection,
    rows: &mut [UserChapterRow],
) -> Result<(), String> {
    let composed_novel_ids: Vec<i64> = rows
        .iter()
        .filter(|r| {
            r.chapter_path.starts_with("norea-composed:")
                || r.chapter_path.starts_with("norea-source:")
        })
        .map(|r| r.novel_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if composed_novel_ids.is_empty() {
        return Ok(());
    }
    let mut entry_ids: HashMap<(i64, String), String> = HashMap::new();
    for chunk in composed_novel_ids.chunks(400) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT novel_id, payload FROM novel_chapter_composition WHERE novel_id IN ({})",
            placeholders.join(",")
        );
        let mut q = sqlx::query(&sql);
        for id in chunk {
            q = q.bind(*id);
        }
        let comp_rows = q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load chapter compositions: {err}"))?;
        for r in comp_rows {
            let novel_id: i64 = r.get("novel_id");
            let payload_str: String = r.get("payload");
            let raw_val: JsonValue = serde_json::from_str(&payload_str)
                .map_err(|err| format!("db user state: parse chapter composition JSON: {err}"))?;
            let Some(entries) = raw_val.get("entries").and_then(JsonValue::as_array) else {
                continue;
            };
            for entry in entries {
                let Some(path) = entry.get("path").and_then(JsonValue::as_str) else {
                    continue;
                };
                let Some(id) = entry.get("id").and_then(JsonValue::as_str) else {
                    continue;
                };
                entry_ids
                    .entry((novel_id, path.to_string()))
                    .or_insert_with(|| id.to_string());
            }
        }
    }
    for row in rows {
        if row.chapter_path.starts_with("norea-composed:")
            || row.chapter_path.starts_with("norea-source:")
        {
            if let Some(entry_id) = entry_ids.get(&(row.novel_id, row.chapter_path.clone())) {
                row.composition_entry_id = Some(entry_id.clone());
            }
        }
    }
    Ok(())
}

pub fn map_user_chapter_row(row: &sqlx::sqlite::SqliteRow) -> UserChapterRow {
    UserChapterRow {
        id: row.get("id"),
        novel_id: row.get("novelId"),
        plugin_id: row.get("pluginId"),
        source_novel_id: row.get("sourceNovelId"),
        novel_path: row.get("novelPath"),
        name: row.get("name"),
        chapter_path: row.get("chapterPath"),
        chapter_name: row.get("chapterName"),
        composition_entry_id: row.get("compositionEntryId"),
        progress: crate::db::decode_sqlite_f64(row, "progress"),
        unread: row.get("unread"),
        read_at: row.get("readAt"),
        bookmark: row.get("bookmark"),
    }
}

pub fn chapter_reference_json(row: &UserChapterRow) -> JsonValue {
    let mut map = serde_json::Map::new();
    map.insert("chapterPath".into(), JsonValue::String(row.chapter_path.clone()));
    map.insert("name".into(), JsonValue::String(row.chapter_name.clone()));
    if let Some(ref entry_id) = row.composition_entry_id {
        if row.chapter_path.starts_with("norea-composed:")
            || row.chapter_path.starts_with("norea-source:")
        {
            map.insert("compositionEntryId".into(), JsonValue::String(entry_id.clone()));
        }
    }
    JsonValue::Object(map)
}

pub fn chapter_work_dto(row: &UserChapterRow) -> UserStateWorkReferenceDto {
    UserStateWorkReferenceDto {
        plugin_id: row.plugin_id.clone(),
        source_novel_id: row.source_novel_id.clone(),
        novel_path: row.novel_path.clone(),
        name: row.name.clone(),
    }
}

pub fn chapter_work_json(row: &UserChapterRow) -> JsonValue {
    serde_json::to_value(chapter_work_dto(row)).unwrap()
}

pub fn intent_from_row(row: &IntentRow) -> Result<(JsonValue, JsonValue), String> {
    let raw_entity: JsonValue = serde_json::from_str(&row.entity_json)
        .map_err(|err| format!("User state: invalid stored entity JSON: {err}"))?;
    let entity = parse_user_state_entity(&raw_entity)?;
    let kind = entity["kind"].as_str().unwrap_or("");
    let raw_value: JsonValue = serde_json::from_str(&row.value_json)
        .map_err(|err| format!("User state: invalid stored value JSON: {err}"))?;
    let value = parse_user_state_value(kind, &raw_value)?;
    Ok((entity, value))
}

pub async fn has_user_state_schema_in_tx(conn: &mut SqliteConnection) -> Result<bool, String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'user_state_intent'",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db user state: check schema: {err}"))?;
    Ok(count == 1)
}

pub async fn require_user_state_schema_in_tx(conn: &mut SqliteConnection) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Err("Personal state sharing requires database migration 11.".to_string());
    }
    Ok(())
}

pub async fn workspace_rows_in_tx(conn: &mut SqliteConnection) -> Result<Vec<WorkspaceRow>, String> {
    let rows = sqlx::query(
        "SELECT server_url, namespace, workspace_id, epoch, cursor, read_through, last_success_at \
         FROM user_state_workspace",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load workspaces: {err}"))?;
    Ok(rows
        .into_iter()
        .map(|r| WorkspaceRow {
            server_url: r.get("server_url"),
            namespace: r.get("namespace"),
            workspace_id: r.get("workspace_id"),
            epoch: r.get("epoch"),
            cursor: r.get("cursor"),
            through: r.get("read_through"),
            last_success_at: r.get("last_success_at"),
        })
        .collect())
}

pub async fn require_binding_in_tx(
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
) -> Result<WorkspaceRow, String> {
    require_user_state_schema_in_tx(conn).await?;
    let row = sqlx::query(
        "SELECT server_url, namespace, workspace_id, epoch, cursor, read_through, last_success_at \
         FROM user_state_workspace WHERE server_url = ?1",
    )
    .bind(&binding.server_url)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup workspace: {err}"))?;
    let Some(r) = row else {
        return Err(
            "The personal state workspace changed. Pending changes were retained.".to_string(),
        );
    };
    let ws = WorkspaceRow {
        server_url: r.get("server_url"),
        namespace: r.get("namespace"),
        workspace_id: r.get("workspace_id"),
        epoch: r.get("epoch"),
        cursor: r.get("cursor"),
        through: r.get("read_through"),
        last_success_at: r.get("last_success_at"),
    };
    if ws.namespace != namespace_for(binding) {
        return Err(
            "The personal state workspace changed. Pending changes were retained.".to_string(),
        );
    }
    Ok(ws)
}

pub async fn resolve_category_alias_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    category_id: &str,
) -> Result<String, String> {
    let mut visited = HashSet::new();
    let mut current = category_id.to_string();
    loop {
        if !visited.insert(current.clone()) {
            return Err("Personal state category alias cycle.".to_string());
        }
        let next: Option<String> = sqlx::query_scalar(
            "SELECT canonical_id FROM user_state_alias WHERE namespace = ?1 AND alias_id = ?2",
        )
        .bind(namespace)
        .bind(&current)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: resolve category alias: {err}"))?;
        match next {
            Some(canonical) => current = canonical,
            None => return Ok(current),
        }
    }
}

pub async fn canonical_entity_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    entity: &JsonValue,
) -> Result<JsonValue, String> {
    if let Some(cat_id) = entity.get("categoryId").and_then(JsonValue::as_str) {
        let resolved = resolve_category_alias_in_tx(conn, namespace, cat_id).await?;
        let mut cloned = entity.clone();
        cloned["categoryId"] = JsonValue::String(resolved);
        Ok(cloned)
    } else {
        Ok(entity.clone())
    }
}

pub async fn record_user_state_changes_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &[(JsonValue, JsonValue)],
    seed: bool,
) -> Result<(), String> {
    if input.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    let mut entries = Vec::with_capacity(input.len());
    for (raw_ent, raw_val) in input {
        let ent = parse_user_state_entity(raw_ent)?;
        let kind = ent["kind"].as_str().unwrap_or("");
        let val = parse_user_state_value(kind, raw_val)?;
        if is_local_user_state_entity(&ent, Some(&val)) {
            continue;
        }
        entries.push((ent, val));
    }
    if entries.is_empty() {
        return Ok(());
    }

    for batch in entries.chunks(80) {
        let mut sql =
            String::from("INSERT INTO user_state_intent(entity_key, entity_json, value_json, seed) VALUES ");
        let mut placeholders = Vec::with_capacity(batch.len());
        for idx in 0..batch.len() {
            let base = idx * 4;
            placeholders.push(format!(
                "(?{}, ?{}, ?{}, ?{})",
                base + 1,
                base + 2,
                base + 3,
                base + 4
            ));
        }
        sql.push_str(&placeholders.join(","));
        if seed {
            sql.push_str(" ON CONFLICT(entity_key) DO NOTHING");
        } else {
            sql.push_str(
                " ON CONFLICT(entity_key) DO UPDATE SET sequence = excluded.sequence, \
                 entity_json = excluded.entity_json, value_json = excluded.value_json, seed = 0",
            );
        }
        let mut query = sqlx::query(&sql);
        for (ent, val) in batch {
            query = query
                .bind(user_state_entity_key(ent)?)
                .bind(canonical_user_state_json(ent)?)
                .bind(canonical_user_state_json(val)?)
                .bind(if seed { 1_i64 } else { 0_i64 });
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: upsert intents: {err}"))?;
    }

    let workspaces = workspace_rows_in_tx(conn).await?;
    for workspace in workspaces {
        let mut aliases: HashMap<String, String> = HashMap::new();
        for batch in entries.chunks(150) {
            let mut key_pairs = Vec::with_capacity(batch.len());
            for (ent, _) in batch {
                let local_key = user_state_entity_key(ent)?;
                let effective_ent = if let Some(cat_id) =
                    ent.get("categoryId").and_then(JsonValue::as_str)
                {
                    let resolved = if let Some(cached) = aliases.get(cat_id) {
                        cached.clone()
                    } else {
                        let r = resolve_category_alias_in_tx(conn, &workspace.namespace, cat_id)
                            .await?;
                        aliases.insert(cat_id.to_string(), r.clone());
                        r
                    };
                    let mut cloned = ent.clone();
                    cloned["categoryId"] = JsonValue::String(resolved);
                    cloned
                } else {
                    ent.clone()
                };
                let record_key = user_state_entity_key(&effective_ent)?;
                key_pairs.push((local_key, record_key));
            }
            let values_clause: Vec<String> = (0..key_pairs.len())
                .map(|idx| format!("(?{}, ?{})", idx * 2 + 2, idx * 2 + 3))
                .collect();
            let base_rev_cond = if seed {
                "0"
            } else {
                "user_state_progress.base_revision = -1"
            };
            let sql = format!(
                "WITH intent_keys(local_key, record_key) AS (VALUES {}) \
                 INSERT INTO user_state_progress(namespace, entity_key, local_sequence, base_revision) \
                 SELECT ?1, i.entity_key, i.sequence, COALESCE(r.revision, 0) \
                 FROM intent_keys k \
                 JOIN user_state_intent i ON i.entity_key = k.local_key \
                 LEFT JOIN user_state_record r ON r.namespace = ?1 AND r.entity_key = k.record_key \
                 WHERE true \
                 ON CONFLICT(namespace, entity_key) DO UPDATE SET \
                   local_sequence = excluded.local_sequence, \
                   base_revision = CASE \
                     WHEN {base_rev_cond} THEN excluded.base_revision \
                     WHEN acknowledged_sequence >= local_sequence THEN excluded.base_revision \
                     ELSE base_revision \
                   END",
                values_clause.join(",")
            );
            let mut query = sqlx::query(&sql).bind(&workspace.namespace);
            for (local_key, record_key) in &key_pairs {
                query = query.bind(local_key).bind(record_key);
            }
            query
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: upsert progress: {err}"))?;
        }
    }

    let priority = if entries.iter().all(|(ent, _)| {
        matches!(
            ent.get("kind").and_then(JsonValue::as_str),
            Some("reading" | "resume")
        )
    }) {
        UserStateCommitPriority::Reading
    } else {
        UserStateCommitPriority::Normal
    };
    ctx.record_user_state_change(priority);
    Ok(())
}

pub async fn work_reference_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<UserStateWorkReferenceDto>, String> {
    let row = sqlx::query(
        "SELECT plugin_id, source_novel_id, path, name FROM novel WHERE id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup work reference: {err}"))?;
    Ok(row.map(|r| UserStateWorkReferenceDto {
        plugin_id: r.get("plugin_id"),
        source_novel_id: r.get("source_novel_id"),
        novel_path: r.get("path"),
        name: r.get("name"),
    }))
}

pub async fn load_user_chapter_rows_by_ids_in_tx(
    conn: &mut SqliteConnection,
    ids: &[i64],
) -> Result<Vec<UserChapterRow>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(400) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "{USER_CHAPTER_SELECT} WHERE c.id IN ({})",
            placeholders.join(",")
        );
        let mut q = sqlx::query(&sql);
        for id in chunk {
            q = q.bind(*id);
        }
        let rows = q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load chapters by ids: {err}"))?;
        out.extend(rows.iter().map(map_user_chapter_row));
    }
    populate_user_chapter_composition_ids_in_tx(conn, &mut out).await?;
    Ok(out)
}

pub async fn mark_private_chapter_progress_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    let rows = load_user_chapter_rows_by_ids_in_tx(conn, &[chapter_id]).await?;
    if let Some(row) = rows.first() {
        if row.plugin_id == "local" {
            return Ok(());
        }
        let entity = json!({
            "kind": "reading",
            "work": chapter_work_json(row),
            "chapter": chapter_reference_json(row),
        });
        let public_value = parse_user_state_value(
            "reading",
            &json!({
                "progress": row.progress,
                "unread": row.unread != 0,
                "readAt": row.read_at,
            }),
        )?;
        sqlx::query(
            "INSERT OR IGNORE INTO user_state_private(entity_key, public_value_json) VALUES (?1, ?2)",
        )
        .bind(user_state_entity_key(&entity)?)
        .bind(serde_json::to_string(&public_value).unwrap())
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: mark private progress: {err}"))?;
    }
    Ok(())
}

pub async fn record_chapter_rows_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    rows: &[UserChapterRow],
    kind: &str,
    seed: bool,
) -> Result<(), String> {
    if rows.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    let non_local_rows: Vec<&UserChapterRow> =
        rows.iter().filter(|r| r.plugin_id != "local").collect();
    if non_local_rows.is_empty() {
        return Ok(());
    }
    if kind == "reading" && !seed {
        for chunk in non_local_rows.chunks(400) {
            let mut keys = Vec::with_capacity(chunk.len());
            for row in chunk {
                let ent = json!({
                    "kind": "reading",
                    "work": chapter_work_json(row),
                    "chapter": chapter_reference_json(row),
                });
                keys.push(user_state_entity_key(&ent)?);
            }
            let placeholders: Vec<String> = (1..=keys.len()).map(|i| format!("?{i}")).collect();
            let sql = format!(
                "DELETE FROM user_state_private WHERE entity_key IN ({})",
                placeholders.join(",")
            );
            let mut q = sqlx::query(&sql);
            for k in &keys {
                q = q.bind(k);
            }
            q.execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: clear private reading markers: {err}"))?;
        }
    }
    let mut entries = Vec::with_capacity(non_local_rows.len());
    for row in non_local_rows {
        let ent = json!({
            "kind": kind,
            "work": chapter_work_json(row),
            "chapter": chapter_reference_json(row),
        });
        let val = if kind == "reading" {
            json!({
                "progress": row.progress,
                "unread": row.unread != 0,
                "readAt": row.read_at,
            })
        } else {
            json!({
                "bookmarked": row.bookmark != 0,
            })
        };
        entries.push((ent, val));
    }
    record_user_state_changes_in_tx(conn, ctx, &entries, seed).await
}

pub async fn record_chapters_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    ids: &[i64],
    kind: &str,
) -> Result<(), String> {
    if ids.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    for chunk in ids.chunks(400) {
        let rows = load_user_chapter_rows_by_ids_in_tx(conn, chunk).await?;
        record_chapter_rows_in_tx(conn, ctx, &rows, kind, false).await?;
    }
    Ok(())
}

pub async fn record_novel_chapters_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: Option<&[i64]>,
) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    match novel_ids {
        Some([]) => Ok(()),
        Some(ids) => {
            for chunk in ids.chunks(400) {
                let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
                let sql = format!(
                    "{USER_CHAPTER_SELECT} WHERE c.novel_id IN ({})",
                    placeholders.join(",")
                );
                let mut q = sqlx::query(&sql);
                for id in chunk {
                    q = q.bind(*id);
                }
                let rows = q
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: load novel chapters: {err}"))?;
                let mut mapped: Vec<UserChapterRow> = rows.iter().map(map_user_chapter_row).collect();
                populate_user_chapter_composition_ids_in_tx(conn, &mut mapped).await?;
                record_chapter_rows_in_tx(conn, ctx, &mapped, "reading", false).await?;
            }
            Ok(())
        }
        None => {
            let rows = sqlx::query(USER_CHAPTER_SELECT)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db user state: load all chapters: {err}"))?;
            let mut mapped: Vec<UserChapterRow> = rows.iter().map(map_user_chapter_row).collect();
            populate_user_chapter_composition_ids_in_tx(conn, &mut mapped).await?;
            record_chapter_rows_in_tx(conn, ctx, &mapped, "reading", false).await
        }
    }
}

pub async fn record_library_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: Option<&[i64]>,
    removed: bool,
) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    if novel_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(());
    }
    let batches: Vec<Option<&[i64]>> = match novel_ids {
        Some(ids) => ids.chunks(400).map(Some).collect(),
        None => vec![None],
    };
    for batch in batches {
        let rows = match batch {
            Some(ids) => {
                let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{i}")).collect();
                let sql = format!(
                    "SELECT plugin_id, source_novel_id, path, name, in_library, library_added_at \
                     FROM novel WHERE id IN ({}) AND plugin_id <> 'local' AND is_local = 0",
                    placeholders.join(",")
                );
                let mut q = sqlx::query(&sql);
                for id in ids {
                    q = q.bind(*id);
                }
                q.fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: load library works: {err}"))?
            }
            None => sqlx::query(
                "SELECT plugin_id, source_novel_id, path, name, in_library, library_added_at \
                 FROM novel WHERE plugin_id <> 'local' AND is_local = 0",
            )
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load all library works: {err}"))?,
        };
        let mut entries = Vec::with_capacity(rows.len());
        for r in rows {
            let work = UserStateWorkReferenceDto {
                plugin_id: r.get("plugin_id"),
                source_novel_id: r.get("source_novel_id"),
                novel_path: r.get("path"),
                name: r.get("name"),
            };
            let in_lib: i64 = r.get("in_library");
            let added_at: Option<i64> = r.get("library_added_at");
            entries.push((
                json!({ "kind": "library", "work": serde_json::to_value(work).unwrap() }),
                json!({
                    "inLibrary": if removed { false } else { in_lib != 0 },
                    "addedAt": if removed { None } else { added_at },
                }),
            ));
        }
        record_user_state_changes_in_tx(conn, ctx, &entries, false).await?;
    }
    Ok(())
}

pub async fn stable_category_id_in_tx(
    conn: &mut SqliteConnection,
    id: i64,
    create: bool,
) -> Result<Option<String>, String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(None);
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT category_id FROM user_state_category WHERE local_id = ?1 ORDER BY rowid LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup stable category id: {err}"))?;
    if let Some(cat_id) = existing {
        return Ok(Some(cat_id));
    }
    let name: Option<String> =
        sqlx::query_scalar("SELECT name FROM category WHERE id = ?1 AND is_system = 0")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: lookup category name: {err}"))?;
    let Some(name) = name else {
        return Ok(None);
    };
    let category_id = if create {
        random_uuid_v4()?
    } else {
        format!("legacy-{}", sha256_hex(name.as_bytes()))
    };
    sqlx::query(
        "INSERT INTO user_state_category(category_id, local_id) VALUES (?1, ?2) \
         ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id WHERE local_id IS NULL",
    )
    .bind(&category_id)
    .bind(id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state: save stable category id: {err}"))?;
    Ok(Some(category_id))
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RecordCategoryOptions {
    pub create: bool,
    pub deleted: bool,
    pub seed: bool,
}

pub async fn record_category_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    id: i64,
    options: RecordCategoryOptions,
) -> Result<(), String> {
    let Some(category_id) = stable_category_id_in_tx(conn, id, options.create).await? else {
        return Ok(());
    };
    let row = sqlx::query("SELECT name, sort FROM category WHERE id = ?1 AND is_system = 0")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load category row: {err}"))?;
    if let Some(r) = row {
        let name: String = r.get("name");
        let sort: i64 = r.get("sort");
        record_user_state_changes_in_tx(
            conn,
            ctx,
            &[(
                json!({ "kind": "category", "categoryId": category_id }),
                json!({ "name": name, "sort": sort, "deleted": options.deleted }),
            )],
            options.seed,
        )
        .await?;
    }
    if !options.seed && !options.create {
        sqlx::query(
            "UPDATE user_state_record SET applied_revision = 0, deferred_reason = NULL, deferred_detail = NULL \
             WHERE deferred_reason IN ('category-name-conflict', 'missing-category')",
        )
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: reset deferred category records: {err}"))?;
        ctx.request_user_state_deferred_apply();
    }
    Ok(())
}

pub async fn record_membership_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: &[i64],
    category_id: i64,
    included: bool,
    seed: bool,
) -> Result<(), String> {
    if novel_ids.is_empty() {
        return Ok(());
    }
    let mut works = Vec::with_capacity(novel_ids.len());
    for chunk in novel_ids.chunks(400) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT plugin_id, source_novel_id, path, name \
             FROM novel WHERE id IN ({}) AND plugin_id <> 'local' AND is_local = 0",
            placeholders.join(",")
        );
        let mut q = sqlx::query(&sql);
        for id in chunk {
            q = q.bind(*id);
        }
        let rows = q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load membership works: {err}"))?;
        for r in rows {
            works.push(UserStateWorkReferenceDto {
                plugin_id: r.get("plugin_id"),
                source_novel_id: r.get("source_novel_id"),
                novel_path: r.get("path"),
                name: r.get("name"),
            });
        }
    }
    if works.is_empty() {
        return Ok(());
    }
    let Some(stable_id) = stable_category_id_in_tx(conn, category_id, false).await? else {
        return Ok(());
    };
    if !seed && included {
        let cat_key = user_state_entity_key(&json!({ "kind": "category", "categoryId": stable_id }))?;
        let has_intent: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM user_state_intent WHERE entity_key = ?1 LIMIT 1",
        )
        .bind(&cat_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: check category intent: {err}"))?;
        if has_intent.is_none() {
            let workspaces = workspace_rows_in_tx(conn).await?;
            let mut known_everywhere = !workspaces.is_empty();
            for ws in workspaces {
                let canonical_cat_id =
                    resolve_category_alias_in_tx(conn, &ws.namespace, &stable_id).await?;
                let record_key = user_state_entity_key(
                    &json!({ "kind": "category", "categoryId": canonical_cat_id }),
                )?;
                let has_record: Option<i64> = sqlx::query_scalar(
                    "SELECT 1 FROM user_state_record WHERE namespace = ?1 AND entity_key = ?2 LIMIT 1",
                )
                .bind(&ws.namespace)
                .bind(&record_key)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db user state: check category record: {err}"))?;
                if has_record.is_none() {
                    known_everywhere = false;
                    break;
                }
            }
            if !known_everywhere {
                record_category_in_tx(conn, ctx, category_id, RecordCategoryOptions::default())
                    .await?;
            }
        }
    }
    for chunk in works.chunks(400) {
        let mut entries = Vec::with_capacity(chunk.len());
        for work in chunk {
            entries.push((
                json!({
                    "kind": "membership",
                    "work": serde_json::to_value(work).unwrap(),
                    "categoryId": stable_id,
                }),
                json!({ "included": included }),
            ));
        }
        record_user_state_changes_in_tx(conn, ctx, &entries, seed).await?;
    }
    Ok(())
}

pub async fn record_resume_cleared_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: Option<&[i64]>,
) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    if novel_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(());
    }
    let batches: Vec<Option<&[i64]>> = match novel_ids {
        Some(ids) => ids.chunks(400).map(Some).collect(),
        None => vec![None],
    };
    for batch in batches {
        let rows = match batch {
            Some(ids) => {
                let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{i}")).collect();
                let sql = format!(
                    "SELECT plugin_id, source_novel_id, path, name \
                     FROM novel WHERE id IN ({}) AND plugin_id <> 'local' AND is_local = 0",
                    placeholders.join(",")
                );
                let mut q = sqlx::query(&sql);
                for id in ids {
                    q = q.bind(*id);
                }
                q.fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: load cleared resume works: {err}"))?
            }
            None => sqlx::query(
                "SELECT plugin_id, source_novel_id, path, name \
                 FROM novel WHERE plugin_id <> 'local' AND is_local = 0",
            )
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db user state: load all resume works: {err}"))?,
        };
        let mut entries = Vec::with_capacity(rows.len());
        for r in rows {
            let work = UserStateWorkReferenceDto {
                plugin_id: r.get("plugin_id"),
                source_novel_id: r.get("source_novel_id"),
                novel_path: r.get("path"),
                name: r.get("name"),
            };
            entries.push((
                json!({ "kind": "resume", "work": serde_json::to_value(work).unwrap() }),
                json!({ "chapter": null, "anchor": null, "openedAt": null }),
            ));
        }
        record_user_state_changes_in_tx(conn, ctx, &entries, false).await?;
    }
    Ok(())
}

pub async fn record_composition_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    let Some(work) = work_reference_in_tx(conn, novel_id).await? else {
        return Ok(());
    };
    let Some(comp) = get_chapter_composition_in_tx(conn, novel_id).await? else {
        return Ok(());
    };
    record_user_state_changes_in_tx(
        conn,
        ctx,
        &[(
            json!({ "kind": "composition", "work": serde_json::to_value(work).unwrap() }),
            json!({ "composition": serde_json::to_value(comp).unwrap() }),
        )],
        false,
    )
    .await
}

pub async fn promote_private_work_identities_in_tx(
    conn: &mut SqliteConnection,
) -> Result<(), String> {
    let markers = sqlx::query("SELECT entity_key, public_value_json FROM user_state_private")
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load private markers: {err}"))?;
    for marker in markers {
        let entity_key: String = marker.get("entity_key");
        let public_value_json: String = marker.get("public_value_json");
        let Ok((kind, encoded_work, chapter_path)) =
            serde_json::from_str::<(String, String, String)>(&entity_key)
        else {
            continue;
        };
        let Ok((plugin_id, identity_kind, novel_path)) =
            serde_json::from_str::<(String, String, String)>(&encoded_work)
        else {
            continue;
        };
        if kind != "reading" || identity_kind != "path" {
            continue;
        }
        let source_novel_id: Option<String> = sqlx::query_scalar(
            "SELECT source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(&plugin_id)
        .bind(&novel_path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup private marker work: {err}"))?
        .flatten();
        let Some(source_novel_id) = source_novel_id else {
            continue;
        };
        let upgraded_work =
            user_state_work_key_parts(&plugin_id, Some(&source_novel_id), &novel_path);
        let upgraded_key = serde_json::to_string(&("reading", upgraded_work, chapter_path))
            .map_err(|err| format!("db user state: encode upgraded private key: {err}"))?;
        sqlx::query(
            "INSERT OR IGNORE INTO user_state_private(entity_key, public_value_json) VALUES (?1, ?2)",
        )
        .bind(&upgraded_key)
        .bind(&public_value_json)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: insert upgraded private key: {err}"))?;
        sqlx::query("DELETE FROM user_state_private WHERE entity_key = ?1")
            .bind(&entity_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: delete old private key: {err}"))?;
    }
    Ok(())
}

pub async fn seed_user_state_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
) -> Result<(), String> {
    let restored: Option<i64> =
        sqlx::query_scalar("SELECT restored FROM user_state_restore_state WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: check restore state: {err}"))?;
    if restored.unwrap_or(0) != 0 {
        return Ok(());
    }
    promote_private_work_identities_in_tx(conn).await?;

    let novels = sqlx::query(
        "SELECT id, plugin_id, source_novel_id, path, name, in_library, library_added_at \
         FROM novel WHERE plugin_id <> 'local' AND is_local = 0",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: seed load novels: {err}"))?;
    let mut lib_entries = Vec::new();
    let mut novel_works = Vec::with_capacity(novels.len());
    for r in novels {
        let id: i64 = r.get("id");
        let in_lib: i64 = r.get("in_library");
        let added_at: Option<i64> = r.get("library_added_at");
        let work = UserStateWorkReferenceDto {
            plugin_id: r.get("plugin_id"),
            source_novel_id: r.get("source_novel_id"),
            novel_path: r.get("path"),
            name: r.get("name"),
        };
        if in_lib != 0 {
            lib_entries.push((
                json!({ "kind": "library", "work": serde_json::to_value(&work).unwrap() }),
                json!({ "inLibrary": true, "addedAt": added_at }),
            ));
        }
        novel_works.push((id, work));
    }
    record_user_state_changes_in_tx(conn, ctx, &lib_entries, true).await?;

    let composed_ids: HashSet<i64> = sqlx::query_scalar::<_, i64>(
        "SELECT novel_id FROM novel_chapter_composition",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: seed load composed novels: {err}"))?
    .into_iter()
    .collect();
    for (id, work) in &novel_works {
        if !composed_ids.contains(id) {
            continue;
        }
        if let Some(comp) = get_chapter_composition_in_tx(conn, *id).await? {
            record_user_state_changes_in_tx(
                conn,
                ctx,
                &[(
                    json!({ "kind": "composition", "work": serde_json::to_value(work).unwrap() }),
                    json!({ "composition": serde_json::to_value(comp).unwrap() }),
                )],
                true,
            )
            .await?;
        }
    }

    let category_ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM category WHERE is_system = 0")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: seed load categories: {err}"))?;
    for cat_id in category_ids {
        record_category_in_tx(
            conn,
            ctx,
            cat_id,
            RecordCategoryOptions {
                seed: true,
                ..RecordCategoryOptions::default()
            },
        )
        .await?;
        let member_ids: Vec<i64> = sqlx::query_scalar(
            "SELECT novel_id FROM novel_category WHERE category_id = ?1",
        )
        .bind(cat_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: seed load category members: {err}"))?;
        record_membership_in_tx(conn, ctx, &member_ids, cat_id, true, true).await?;
    }

    let ch_sql = format!(
        "{USER_CHAPTER_SELECT} WHERE n.plugin_id <> 'local' AND n.is_local = 0 \
         AND (c.progress > 0 OR c.unread = 0 OR c.read_at IS NOT NULL OR c.bookmark = 1)"
    );
    let ch_rows = sqlx::query(&ch_sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: seed load chapters: {err}"))?;
    let mut chapters: Vec<UserChapterRow> = ch_rows.iter().map(map_user_chapter_row).collect();
    populate_user_chapter_composition_ids_in_tx(conn, &mut chapters).await?;

    let private_keys: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT entity_key FROM user_state_private")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: seed load private keys: {err}"))?
            .into_iter()
            .collect();

    let mut reading_rows = Vec::new();
    let mut bookmark_rows = Vec::new();
    let mut resumes: HashMap<i64, UserChapterRow> = HashMap::new();
    for ch in &chapters {
        let reading_ent = json!({
            "kind": "reading",
            "work": chapter_work_json(ch),
            "chapter": chapter_reference_json(ch),
        });
        let is_private = private_keys.contains(&user_state_entity_key(&reading_ent)?);
        if (ch.progress > 0.0 || ch.unread == 0 || ch.read_at.is_some()) && !is_private {
            reading_rows.push(ch.clone());
        }
        if ch.bookmark != 0 {
            bookmark_rows.push(ch.clone());
        }
        if let Some(read_at) = ch.read_at {
            if !is_private
                && resumes
                    .get(&ch.novel_id)
                    .and_then(|prev| prev.read_at)
                    .unwrap_or(-1)
                    < read_at
            {
                resumes.insert(ch.novel_id, ch.clone());
            }
        }
    }
    record_chapter_rows_in_tx(conn, ctx, &reading_rows, "reading", true).await?;
    record_chapter_rows_in_tx(conn, ctx, &bookmark_rows, "bookmark", true).await?;

    let resume_entries: Vec<(JsonValue, JsonValue)> = resumes
        .into_values()
        .map(|row| {
            (
                json!({ "kind": "resume", "work": chapter_work_json(&row) }),
                json!({
                    "chapter": chapter_reference_json(&row),
                    "anchor": null,
                    "openedAt": row.read_at,
                }),
            )
        })
        .collect();
    record_user_state_changes_in_tx(conn, ctx, &resume_entries, true).await
}

pub async fn record_public_novel_reading_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: &[i64],
    clear_history: bool,
) -> Result<(), String> {
    if novel_ids.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    for chunk in novel_ids.chunks(400) {
        let private_rows =
            sqlx::query("SELECT entity_key, public_value_json FROM user_state_private")
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db user state: load private values: {err}"))?;
        let mut private_values: HashMap<String, JsonValue> = HashMap::new();
        for r in private_rows {
            let k: String = r.get("entity_key");
            let v: String = r.get("public_value_json");
            if let Ok(parsed) = serde_json::from_str::<JsonValue>(&v) {
                private_values.insert(k, parsed);
            }
        }

        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "{USER_CHAPTER_SELECT} WHERE c.novel_id IN ({})",
            placeholders.join(",")
        );
        let mut q = sqlx::query(&sql);
        for id in chunk {
            q = q.bind(*id);
        }
        let rows = q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load public novel chapters: {err}"))?;
        let mut chapters: Vec<UserChapterRow> = rows.iter().map(map_user_chapter_row).collect();
        populate_user_chapter_composition_ids_in_tx(conn, &mut chapters).await?;
        let mut entries = Vec::with_capacity(chapters.len());
        for row in chapters {
            let entity = json!({
                "kind": "reading",
                "work": chapter_work_json(&row),
                "chapter": chapter_reference_json(&row),
            });
            let key = user_state_entity_key(&entity)?;
            if let Some(prev) = private_values.get(&key) {
                if !clear_history {
                    continue;
                }
                let mut updated = prev.clone();
                updated["readAt"] = JsonValue::Null;
                let normalized = parse_user_state_value("reading", &updated)?;
                sqlx::query(
                    "UPDATE user_state_private SET public_value_json = ?2 WHERE entity_key = ?1",
                )
                .bind(&key)
                .bind(serde_json::to_string(&normalized).unwrap())
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: update private public value: {err}"))?;
                entries.push((entity, normalized));
            } else {
                entries.push((
                    entity,
                    json!({
                        "progress": row.progress,
                        "unread": row.unread != 0,
                        "readAt": row.read_at,
                    }),
                ));
            }
        }
        record_user_state_changes_in_tx(conn, ctx, &entries, false).await?;
    }
    Ok(())
}

pub async fn record_chapter_unread_flags_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    ids: &[i64],
    unread: bool,
) -> Result<(), String> {
    if ids.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    let private_rows = sqlx::query("SELECT entity_key, public_value_json FROM user_state_private")
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load private unread values: {err}"))?;
    let mut private_values: HashMap<String, JsonValue> = HashMap::new();
    for r in private_rows {
        let k: String = r.get("entity_key");
        let v: String = r.get("public_value_json");
        if let Ok(parsed) = serde_json::from_str::<JsonValue>(&v) {
            private_values.insert(k, parsed);
        }
    }
    for chunk in ids.chunks(400) {
        let rows = load_user_chapter_rows_by_ids_in_tx(conn, chunk).await?;
        let mut entries = Vec::with_capacity(rows.len());
        for row in rows {
            let entity = json!({
                "kind": "reading",
                "work": chapter_work_json(&row),
                "chapter": chapter_reference_json(&row),
            });
            let key = user_state_entity_key(&entity)?;
            if let Some(prev) = private_values.get(&key) {
                let mut updated = prev.clone();
                updated["unread"] = JsonValue::Bool(unread);
                let normalized = parse_user_state_value("reading", &updated)?;
                sqlx::query(
                    "UPDATE user_state_private SET public_value_json = ?2 WHERE entity_key = ?1",
                )
                .bind(&key)
                .bind(serde_json::to_string(&normalized).unwrap())
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: update private unread flag: {err}"))?;
                entries.push((entity, normalized));
            } else {
                entries.push((
                    entity,
                    json!({
                        "progress": row.progress,
                        "unread": unread,
                        "readAt": row.read_at,
                    }),
                ));
            }
        }
        record_user_state_changes_in_tx(conn, ctx, &entries, false).await?;
    }
    Ok(())
}

pub async fn user_state_restore_paused_in_tx(conn: &mut SqliteConnection) -> Result<bool, String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(false);
    }
    let paused: Option<i64> =
        sqlx::query_scalar("SELECT paused FROM user_state_restore_state WHERE id = 1")
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: check restore paused: {err}"))?;
    Ok(paused.unwrap_or(0) != 0)
}

pub async fn assert_user_state_available_in_tx(conn: &mut SqliteConnection) -> Result<(), String> {
    require_user_state_schema_in_tx(conn).await?;
    if user_state_restore_paused_in_tx(conn).await? {
        return Err(
            "Personal state sharing is paused after restoring a backup. Reconnect to the existing shared state explicitly before synchronizing."
                .to_string(),
        );
    }
    Ok(())
}
