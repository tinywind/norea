use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};

use crate::db::chapter_composition::{
    get_chapter_composition_in_tx, materialize_chapter_composition_in_tx,
    parse_chapter_composition, set_chapter_composition_in_tx, ChapterCompositionV1Dto,
};
use crate::db::tx::TxContext;

use super::core::{
    canonical_entity_in_tx, has_user_state_schema_in_tx, intent_from_row, non_empty_source_id,
    promote_private_work_identities_in_tx, resolve_category_alias_in_tx, IntentRow,
};
use super::is_user_state_current_mode;
use super::stored_chapter::resolve_stored_chapter_reference_in_tx;
use super::types::{
    is_local_user_state_entity, merge_user_state_composition, parse_chapter_reference,
    parse_portable_reader_anchor, parse_stored_chapter_path, parse_user_state_record,
    parse_work_reference, user_state_entity_key, ParsedUserStateRecord, UserStateApplyEffectsDto,
    UserStateChapterReferenceDto, UserStateResumeEffectDto, UserStateWorkReferenceDto,
    USER_STATE_PRELINK_BASE_REVISION,
};

#[derive(Debug, Clone)]
pub struct DeferredUserStateError {
    pub reason: String,
    pub detail: String,
}

impl DeferredUserStateError {
    pub fn new(reason: impl Into<String>, detail: Option<String>) -> Self {
        let r = reason.into();
        let d = detail.unwrap_or_else(|| r.clone());
        Self {
            reason: r,
            detail: d,
        }
    }
}

#[derive(Debug)]
pub enum MaterializeError {
    Deferred(DeferredUserStateError),
    Fatal(String),
}

impl From<String> for MaterializeError {
    fn from(value: String) -> Self {
        Self::Fatal(value)
    }
}

#[derive(Debug, Clone)]
pub struct LocalWork {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub path: String,
}

pub async fn find_user_state_work_in_tx(
    conn: &mut SqliteConnection,
    work: &UserStateWorkReferenceDto,
) -> Result<Option<LocalWork>, MaterializeError> {
    let rows = match &work.source_novel_id {
        None => sqlx::query(
            "SELECT id, plugin_id, source_novel_id, path FROM novel \
             WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(&work.plugin_id)
        .bind(&work.novel_path)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup work by path: {err}"))?,
        Some(source_id) => sqlx::query(
            "SELECT id, plugin_id, source_novel_id, path FROM novel \
             WHERE plugin_id = ?1 AND lower(source_novel_id) = lower(?2)",
        )
        .bind(&work.plugin_id)
        .bind(source_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup work by id: {err}"))?,
    };
    if rows.len() > 1 {
        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
            "ambiguous-work-identity",
            None,
        )));
    }
    Ok(rows.into_iter().next().map(|r| LocalWork {
        id: r.get("id"),
        plugin_id: r.get("plugin_id"),
        source_novel_id: non_empty_source_id(r.get("source_novel_id")),
        path: r.get("path"),
    }))
}

/// Composition entry ids by chapter path for the works one projection pass touches. Without it, every
/// composed chapter's record parses its work's whole composition again.
#[derive(Debug, Default)]
pub struct CompositionEntryCache(HashMap<i64, HashMap<String, Option<String>>>);

impl CompositionEntryCache {
    async fn entry_id_in_tx(
        &mut self,
        conn: &mut SqliteConnection,
        novel_id: i64,
        chapter_path: &str,
    ) -> Result<Option<String>, String> {
        if !self.0.contains_key(&novel_id) {
            let rows = sqlx::query(
                "SELECT json_extract(entry.value, '$.path') AS path, \
                        json_extract(entry.value, '$.id') AS id \
                 FROM novel_chapter_composition c, json_each(c.payload, '$.entries') entry \
                 WHERE c.novel_id = ?1",
            )
            .bind(novel_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load composition entries: {err}"))?;
            let mut entries: HashMap<String, Option<String>> = HashMap::with_capacity(rows.len());
            for row in rows {
                if let Some(path) = row.get::<Option<String>, _>("path") {
                    entries.entry(path).or_insert_with(|| row.get("id"));
                }
            }
            self.0.insert(novel_id, entries);
        }
        Ok(self.0[&novel_id].get(chapter_path).cloned().flatten())
    }

    fn forget(&mut self, novel_id: i64) {
        self.0.remove(&novel_id);
    }
}

async fn find_chapter_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    novel_id: i64,
    chapter: &UserStateChapterReferenceDto,
    skipped_chapter_ids: &HashSet<i64>,
    composition_entries: Option<&mut CompositionEntryCache>,
) -> Result<i64, MaterializeError> {
    if parse_stored_chapter_path(&chapter.chapter_path).is_some() {
        let resolved = resolve_stored_chapter_reference_in_tx(
            root,
            conn,
            novel_id,
            chapter,
            skipped_chapter_ids,
        )
        .await?;
        return resolved.ok_or_else(|| {
            MaterializeError::Deferred(DeferredUserStateError::new(
                "stored-chapter-mismatch",
                None,
            ))
        });
    }
    if chapter.chapter_path.starts_with("norea-folder:")
        || chapter.chapter_path.starts_with("local-folder:")
    {
        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
            "missing-chapter-identity",
            None,
        )));
    }
    let id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM chapter WHERE novel_id = ?1 AND path = ?2")
            .bind(novel_id)
            .bind(&chapter.chapter_path)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: lookup chapter: {err}"))?;
    let Some(chapter_id) = id else {
        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
            "missing-chapter",
            None,
        )));
    };
    if chapter.chapter_path.starts_with("norea-composed:")
        || chapter.chapter_path.starts_with("norea-source:")
    {
        let entry_id: Option<String> = match composition_entries {
            Some(cache) => {
                cache
                    .entry_id_in_tx(conn, novel_id, &chapter.chapter_path)
                    .await?
            }
            None => sqlx::query_scalar(
                "SELECT json_extract(entry.value, '$.id') \
                 FROM novel_chapter_composition c, json_each(c.payload, '$.entries') entry \
                 WHERE c.novel_id = ?1 AND json_extract(entry.value, '$.path') = ?2",
            )
            .bind(novel_id)
            .bind(&chapter.chapter_path)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: check chapter ownership: {err}"))?,
        };
        if chapter.composition_entry_id.is_none() || entry_id != chapter.composition_entry_id {
            return Err(MaterializeError::Deferred(DeferredUserStateError::new(
                "chapter-ownership-mismatch",
                None,
            )));
        }
    }
    Ok(chapter_id)
}

pub async fn has_pending_user_state_for_record_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    record: &ParsedUserStateRecord,
) -> Result<bool, String> {
    let key = user_state_entity_key(&record.entity)?;
    let direct: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.entity_key = ?2 AND i.seed = 0 AND p.base_revision <> ?3 \
           AND i.sequence > p.acknowledged_sequence",
    )
    .bind(namespace)
    .bind(&key)
    .bind(USER_STATE_PRELINK_BASE_REVISION)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: check pending record intent: {err}"))?;
    if direct.is_some() {
        return Ok(true);
    }
    if record.entity.get("categoryId").is_none() {
        return Ok(false);
    }
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
    .map_err(|err| format!("db user state: check aliased pending intents: {err}"))?;
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
            return Ok(true);
        }
    }
    Ok(false)
}

async fn category_local_id_in_tx(
    conn: &mut SqliteConnection,
    namespace: &str,
    category_id: &str,
) -> Result<Option<i64>, MaterializeError> {
    let canonical = resolve_category_alias_in_tx(conn, namespace, category_id).await?;
    let owners: Vec<i64> = sqlx::query_scalar(
        "WITH RECURSIVE owners(category_id) AS ( \
           SELECT ?2 \
           UNION \
           SELECT a.alias_id FROM user_state_alias a \
           JOIN owners o ON a.canonical_id = o.category_id WHERE a.namespace = ?1 \
         ) \
         SELECT DISTINCT m.local_id FROM user_state_category m \
         JOIN owners o ON o.category_id = m.category_id \
         JOIN category c ON c.id = m.local_id",
    )
    .bind(namespace)
    .bind(&canonical)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: resolve category local owner: {err}"))?;
    if owners.len() > 1 {
        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
            "ambiguous-category-identity",
            None,
        )));
    }
    let local_id = owners.first().copied();
    if let Some(id) = local_id {
        sqlx::query(
            "INSERT INTO user_state_category(category_id, local_id) VALUES (?1, ?2) \
             ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id WHERE local_id IS NULL",
        )
        .bind(&canonical)
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: cache category owner: {err}"))?;
    }
    Ok(local_id)
}

pub async fn apply_shared_composition_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    novel_id: i64,
    shared: &ChapterCompositionV1Dto,
    namespace: &str,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<UserStateApplyEffectsDto, MaterializeError> {
    let current = get_chapter_composition_in_tx(conn, novel_id).await?;
    let work_row =
        sqlx::query("SELECT plugin_id, source_novel_id FROM novel WHERE id = ?1")
            .bind(novel_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: load composition work: {err}"))?;
    let Some(r) = work_row else {
        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
            "missing-work-identity",
            None,
        )));
    };
    let plugin_id: String = r.get("plugin_id");
    let source_novel_id = non_empty_source_id(r.get("source_novel_id"));
    let Some(source_novel_id) = source_novel_id else {
        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
            "missing-work-identity",
            None,
        )));
    };
    let composition = merge_user_state_composition(
        shared,
        current.as_ref(),
        &plugin_id,
        &source_novel_id,
    )?;
    materialize_chapter_composition_in_tx(root, conn, novel_id, &composition, &[]).await?;
    set_chapter_composition_in_tx(conn, novel_id, Some(&composition)).await?;
    reapply_composed_chapter_user_state_in_tx(
        root,
        conn,
        namespace,
        &plugin_id,
        &source_novel_id,
        skipped_chapter_ids,
    )
    .await
}

async fn reapply_composed_chapter_user_state_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    namespace: &str,
    plugin_id: &str,
    source_novel_id: &str,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<UserStateApplyEffectsDto, MaterializeError> {
    let mut effects = UserStateApplyEffectsDto::default();
    let records: Vec<String> = sqlx::query_scalar(
        "SELECT payload FROM user_state_record WHERE namespace = ?1 \
         AND json_extract(payload, '$.entity.work.pluginId') = ?2 \
         AND lower(json_extract(payload, '$.entity.work.sourceNovelId')) = lower(?3) \
         AND json_extract(payload, '$.entity.kind') IN ('reading', 'bookmark', 'resume') \
         ORDER BY revision",
    )
    .bind(namespace)
    .bind(plugin_id)
    .bind(source_novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load composed work records: {err}"))?;

    let mut ordered_keys: Vec<String> = Vec::new();
    let mut effective: HashMap<String, (ParsedUserStateRecord, bool)> = HashMap::new();
    for payload in records {
        let raw: JsonValue = serde_json::from_str(&payload)
            .map_err(|err| format!("db user state: parse stored record: {err}"))?;
        let record = parse_user_state_record(&raw)?;
        let key = user_state_entity_key(&record.entity)?;
        if !effective.contains_key(&key) {
            ordered_keys.push(key.clone());
        }
        effective.insert(key, (record, false));
    }

    let intent_rows = sqlx::query(
        "SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
         FROM user_state_intent i \
         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.seed = 0 AND i.sequence > p.acknowledged_sequence \
           AND json_extract(i.entity_json, '$.work.pluginId') = ?2 \
           AND lower(json_extract(i.entity_json, '$.work.sourceNovelId')) = lower(?3) \
           AND json_extract(i.entity_json, '$.kind') IN ('reading', 'bookmark', 'resume')",
    )
    .bind(namespace)
    .bind(plugin_id)
    .bind(source_novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: load composed work pending intents: {err}"))?;
    for r in intent_rows {
        let intent_row = IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        };
        let (entity, value) = intent_from_row(&intent_row)?;
        let key = intent_row.entity_key;
        if !effective.contains_key(&key) {
            ordered_keys.push(key.clone());
        }
        effective.insert(
            key,
            (
                ParsedUserStateRecord {
                    entity,
                    value,
                    revision: 1,
                    operation_id: "local-pending".to_string(),
                    updated_at: 0,
                    device_id: "local".to_string(),
                    device_name: String::new(),
                },
                true,
            ),
        );
    }

    // The composition is fixed while its chapter records are replayed.
    let mut composition_entries = CompositionEntryCache::default();
    for key in ordered_keys {
        let (record, is_local) = effective.remove(&key).unwrap();
        match materialize_user_state_record_with_options_in_tx(
            root,
            conn,
            namespace,
            &record,
            skipped_chapter_ids,
            false,
            Some(&mut composition_entries),
        )
        .await
        {
            Ok((next, _)) => {
                effects.resumes.extend(next.resumes);
                if !is_local {
                    sqlx::query(
                        "UPDATE user_state_record SET applied_revision = revision, \
                         deferred_reason = NULL, deferred_detail = NULL \
                         WHERE namespace = ?1 AND entity_key = ?2",
                    )
                    .bind(namespace)
                    .bind(&key)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: mark composed record applied: {err}"))?;
                }
            }
            Err(MaterializeError::Deferred(deferred)) => {
                sqlx::query(
                    "UPDATE user_state_record SET applied_revision = 0, \
                     deferred_reason = ?3, deferred_detail = ?4 \
                     WHERE namespace = ?1 AND entity_key = ?2",
                )
                .bind(namespace)
                .bind(&key)
                .bind(&deferred.reason)
                .bind(&deferred.detail)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: mark composed record deferred: {err}"))?;
            }
            Err(MaterializeError::Fatal(err)) => return Err(MaterializeError::Fatal(err)),
        }
    }
    Ok(effects)
}

pub fn materialize_user_state_record_in_tx<'a>(
    root: Option<&'a Path>,
    conn: &'a mut SqliteConnection,
    namespace: &'a str,
    record: &'a ParsedUserStateRecord,
    skipped_chapter_ids: &'a HashSet<i64>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<UserStateApplyEffectsDto, MaterializeError>> + Send + 'a>,
> {
    Box::pin(async move {
        materialize_user_state_record_with_options_in_tx(
            root,
            conn,
            namespace,
            record,
            skipped_chapter_ids,
            false,
            None,
        )
        .await
        .map(|(effects, _)| effects)
    })
}

pub fn materialize_user_state_record_with_options_in_tx<'a>(
    root: Option<&'a Path>,
    conn: &'a mut SqliteConnection,
    namespace: &'a str,
    record: &'a ParsedUserStateRecord,
    skipped_chapter_ids: &'a HashSet<i64>,
    defer_last_read_at: bool,
    mut composition_entries: Option<&'a mut CompositionEntryCache>,
) -> std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = Result<(UserStateApplyEffectsDto, Option<i64>), MaterializeError>,
            > + Send
            + 'a,
    >,
> {
    Box::pin(async move {
        let mut effects = UserStateApplyEffectsDto::default();
        if is_local_user_state_entity(&record.entity, Some(&record.value)) {
            return Ok((effects, None));
        }
        let kind = record.entity["kind"].as_str().unwrap_or("");
        if kind == "category" {
            let raw_cat_id = record.entity["categoryId"].as_str().unwrap_or("");
            let name = record.value["name"].as_str().unwrap_or("");
            let sort = record.value["sort"].as_i64().unwrap_or(0);
            let deleted = record.value["deleted"].as_bool().unwrap_or(false);
            let category_id = resolve_category_alias_in_tx(conn, namespace, raw_cat_id).await?;
            let mapped_id = category_local_id_in_tx(conn, namespace, &category_id).await?;
            if deleted {
                if let Some(id) = mapped_id {
                    sqlx::query("DELETE FROM category WHERE id = ?1 AND is_system = 0")
                        .bind(id)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db user state: delete category: {err}"))?;
                }
                sqlx::query(
                    "INSERT INTO user_state_category(category_id) VALUES (?1) ON CONFLICT(category_id) DO NOTHING",
                )
                .bind(&category_id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: tombstone category mapping: {err}"))?;
                return Ok((effects, None));
            }
            let collision_id: Option<i64> =
                sqlx::query_scalar("SELECT id FROM category WHERE name = ?1")
                    .bind(name)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: check category collision: {err}"))?;
            if let Some(col_id) = collision_id {
                if Some(col_id) != mapped_id {
                    let baseline: Option<String> = sqlx::query_scalar(
                        "SELECT m.category_id FROM user_state_category m \
                         JOIN user_state_intent i ON json_extract(i.entity_json, '$.kind') = 'category' \
                           AND json_extract(i.entity_json, '$.categoryId') = m.category_id \
                         JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?2 \
                         WHERE m.local_id = ?1 AND m.category_id LIKE 'legacy-%' \
                           AND i.seed = 1 AND i.sequence > p.acknowledged_sequence",
                    )
                    .bind(col_id)
                    .bind(namespace)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: check legacy category baseline: {err}"))?;
                    if mapped_id.is_none() && baseline.is_some() {
                        sqlx::query(
                            "INSERT INTO user_state_category(category_id, local_id) VALUES (?1, ?2) \
                             ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id",
                        )
                        .bind(&category_id)
                        .bind(col_id)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db user state: adopt baseline category: {err}"))?;
                        sqlx::query("UPDATE category SET sort = ?2 WHERE id = ?1")
                            .bind(col_id)
                            .bind(sort)
                            .execute(&mut *conn)
                            .await
                            .map_err(|err| format!("db user state: update baseline sort: {err}"))?;
                        return Ok((effects, None));
                    }
                    return Err(MaterializeError::Deferred(DeferredUserStateError::new(
                        "category-name-conflict",
                        Some(name.to_string()),
                    )));
                }
            }
            if let Some(id) = mapped_id {
                sqlx::query("UPDATE category SET name = ?2, sort = ?3 WHERE id = ?1 AND is_system = 0")
                    .bind(id)
                    .bind(name)
                    .bind(sort)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: update category: {err}"))?;
            } else {
                let inserted =
                    sqlx::query("INSERT INTO category(name, sort, is_system) VALUES (?1, ?2, 0)")
                        .bind(name)
                        .bind(sort)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db user state: insert category: {err}"))?;
                sqlx::query(
                    "INSERT INTO user_state_category(category_id, local_id) VALUES (?1, ?2) \
                     ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id",
                )
                .bind(&category_id)
                .bind(inserted.last_insert_rowid())
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: map inserted category: {err}"))?;
            }
            return Ok((effects, None));
        }

        let work_ref = parse_work_reference(&record.entity["work"])?;
        let Some(work) = find_user_state_work_in_tx(conn, &work_ref).await? else {
            return Err(MaterializeError::Deferred(DeferredUserStateError::new(
                "missing-work",
                None,
            )));
        };

        match kind {
            "library" => {
                let in_library = record.value["inLibrary"].as_bool().unwrap_or(false);
                let added_at = record.value.get("addedAt").and_then(JsonValue::as_i64);
                sqlx::query("UPDATE novel SET in_library = ?2, library_added_at = ?3 WHERE id = ?1")
                    .bind(work.id)
                    .bind(if in_library { 1_i64 } else { 0_i64 })
                    .bind(if in_library { added_at } else { None })
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: project library: {err}"))?;
                if !in_library {
                    sqlx::query("DELETE FROM novel_download_goal WHERE novel_id = ?1")
                        .bind(work.id)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db user state: delete download goal: {err}"))?;
                }
            }
            "membership" => {
                let included = record.value["included"].as_bool().unwrap_or(false);
                let raw_cat_id = record.entity["categoryId"].as_str().unwrap_or("");
                let category_id =
                    resolve_category_alias_in_tx(conn, namespace, raw_cat_id).await?;
                let category_local_id =
                    category_local_id_in_tx(conn, namespace, &category_id).await?;
                let cat_key = user_state_entity_key(
                    &json!({ "kind": "category", "categoryId": category_id }),
                )?;
                let cat_state = sqlx::query(
                    "SELECT payload, deletion_revision FROM user_state_record \
                     WHERE namespace = ?1 AND entity_key = ?2",
                )
                .bind(namespace)
                .bind(&cat_key)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db user state: check category state: {err}"))?;
                if let Some(ref st) = cat_state {
                    let payload: String = st.get("payload");
                    let del_rev: i64 = st.get("deletion_revision");
                    let raw_cat_rec: JsonValue = serde_json::from_str(&payload)
                        .map_err(|err| format!("db user state: parse category state: {err}"))?;
                    let cat_rec = parse_user_state_record(&raw_cat_rec)?;
                    let deleted = cat_rec.value["deleted"].as_bool().unwrap_or(false);
                    if included && (deleted || del_rev >= record.revision) {
                        return Err(MaterializeError::Deferred(DeferredUserStateError::new(
                            "category-deleted",
                            None,
                        )));
                    }
                }
                let Some(local_cat_id) = category_local_id else {
                    if !included {
                        return Ok((effects, None));
                    }
                    return Err(MaterializeError::Deferred(DeferredUserStateError::new(
                        "category-missing",
                        None,
                    )));
                };
                if included {
                    sqlx::query(
                        "INSERT OR IGNORE INTO novel_category(novel_id, category_id) VALUES (?1, ?2)",
                    )
                    .bind(work.id)
                    .bind(local_cat_id)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: insert membership: {err}"))?;
                } else {
                    sqlx::query(
                        "DELETE FROM novel_category WHERE novel_id = ?1 AND category_id = ?2",
                    )
                    .bind(work.id)
                    .bind(local_cat_id)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: delete membership: {err}"))?;
                }
            }
            "reading" => {
                let ch_ref = parse_chapter_reference(&record.entity["chapter"])?;
                let chapter_id = find_chapter_in_tx(
                    root,
                    conn,
                    work.id,
                    &ch_ref,
                    skipped_chapter_ids,
                    composition_entries.as_deref_mut(),
                )
                .await?;
                let progress = record.value["progress"].as_f64().unwrap_or(0.0);
                let unread = record.value["unread"].as_bool().unwrap_or(true);
                let read_at = record.value.get("readAt").and_then(JsonValue::as_i64);
                sqlx::query(
                    "UPDATE chapter SET progress = ?2, unread = ?3, read_at = ?4 WHERE id = ?1",
                )
                .bind(chapter_id)
                .bind(progress)
                .bind(if unread { 1_i64 } else { 0_i64 })
                .bind(read_at)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: project reading: {err}"))?;
                if defer_last_read_at {
                    return Ok((effects, Some(work.id)));
                }
                sqlx::query(
                    "UPDATE novel SET last_read_at = (SELECT MAX(read_at) FROM chapter WHERE novel_id = ?1) \
                     WHERE id = ?1",
                )
                .bind(work.id)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state: update novel last_read_at: {err}"))?;
            }
            "bookmark" => {
                let ch_ref = parse_chapter_reference(&record.entity["chapter"])?;
                let chapter_id = find_chapter_in_tx(
                    root,
                    conn,
                    work.id,
                    &ch_ref,
                    skipped_chapter_ids,
                    composition_entries.as_deref_mut(),
                )
                .await?;
                let bookmarked = record.value["bookmarked"].as_bool().unwrap_or(false);
                sqlx::query("UPDATE chapter SET bookmark = ?2 WHERE id = ?1")
                    .bind(chapter_id)
                    .bind(if bookmarked { 1_i64 } else { 0_i64 })
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db user state: project bookmark: {err}"))?;
            }
            "resume" => {
                let chapter_id = match record.value.get("chapter").filter(|v| !v.is_null()) {
                    Some(raw_ch) => {
                        let ch_ref = parse_chapter_reference(raw_ch)?;
                        Some(
                            find_chapter_in_tx(
                                root,
                                conn,
                                work.id,
                                &ch_ref,
                                skipped_chapter_ids,
                                composition_entries.as_deref_mut(),
                            )
                            .await?,
                        )
                    }
                    None => None,
                };
                let anchor = match record.value.get("anchor").filter(|v| !v.is_null()) {
                    Some(raw_anchor) => Some(parse_portable_reader_anchor(raw_anchor)?),
                    None => None,
                };
                let opened_at = record.value.get("openedAt").and_then(JsonValue::as_i64);
                effects.resumes.push(UserStateResumeEffectDto {
                    novel_id: work.id,
                    chapter_id,
                    anchor,
                    opened_at,
                });
            }
            "composition" => {
                let comp = parse_chapter_composition(&record.value["composition"])?;
                if let Some(cache) = composition_entries.as_deref_mut() {
                    cache.forget(work.id);
                }
                let next = apply_shared_composition_in_tx(
                    root,
                    conn,
                    work.id,
                    &comp,
                    namespace,
                    skipped_chapter_ids,
                )
                .await?;
                effects.resumes.extend(next.resumes);
            }
            _ => {}
        }
        Ok((effects, None))
    })
}

pub async fn refresh_unattempted_user_state_identities_in_tx(
    conn: &mut SqliteConnection,
    novel_id: Option<i64>,
) -> Result<(), String> {
    promote_private_work_identities_in_tx(conn).await?;
    let rows = match novel_id {
        None => sqlx::query(
            "SELECT sequence, entity_key, entity_json, value_json, seed \
             FROM user_state_intent \
             WHERE json_type(entity_json, '$.work') = 'object' \
               AND json_extract(entity_json, '$.work.sourceNovelId') IS NULL",
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load unattempted intents: {err}"))?,
        Some(id) => sqlx::query(
            "SELECT sequence, entity_key, entity_json, value_json, seed \
             FROM user_state_intent \
             WHERE json_type(entity_json, '$.work') = 'object' \
               AND json_extract(entity_json, '$.work.sourceNovelId') IS NULL \
               AND json_extract(entity_json, '$.work.pluginId') = (SELECT plugin_id FROM novel WHERE id = ?1) \
               AND json_extract(entity_json, '$.work.novelPath') = (SELECT path FROM novel WHERE id = ?1)",
        )
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: load novel unattempted intents: {err}"))?,
    };

    let mut works: HashMap<(String, String), Option<(Option<String>, String)>> = HashMap::new();
    for r in rows {
        let intent_row = IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        };
        let (mut entity, _) = intent_from_row(&intent_row)?;
        let Some(work_obj) = entity.get("work") else {
            continue;
        };
        let work_ref = parse_work_reference(work_obj)?;
        let cache_key = (work_ref.plugin_id.clone(), work_ref.novel_path.clone());
        let resolved = if let Some(cached) = works.get(&cache_key) {
            cached.clone()
        } else {
            let found = sqlx::query(
                "SELECT source_novel_id, name FROM novel WHERE plugin_id = ?1 AND path = ?2",
            )
            .bind(&work_ref.plugin_id)
            .bind(&work_ref.novel_path)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: lookup upgraded work: {err}"))?
            .map(|row| {
                (
                    non_empty_source_id(row.get("source_novel_id")),
                    row.get::<String, _>("name"),
                )
            });
            works.insert(cache_key, found.clone());
            found
        };
        let Some((Some(source_novel_id), name)) = resolved else {
            continue;
        };
        let has_attempt: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM user_state_operation WHERE entity_key = ?1 \
             UNION ALL \
             SELECT 1 FROM user_state_progress WHERE entity_key = ?1 AND acknowledged_sequence > 0 \
             LIMIT 1",
        )
        .bind(&intent_row.entity_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: check intent attempt: {err}"))?;
        if has_attempt.is_some() {
            continue;
        }
        entity["work"]["sourceNovelId"] = JsonValue::String(source_novel_id);
        entity["work"]["name"] = JsonValue::String(name);
        let next_key = user_state_entity_key(&entity)?;
        let next_entity_json = serde_json::to_string(&entity)
            .map_err(|err| format!("db user state: serialize upgraded intent: {err}"))?;

        sqlx::query("DELETE FROM user_state_intent WHERE entity_key = ?1")
            .bind(&intent_row.entity_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: delete old unattempted intent: {err}"))?;
        sqlx::query(
            "INSERT INTO user_state_intent(sequence, entity_key, entity_json, value_json, seed) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(entity_key) DO UPDATE SET \
               sequence = excluded.sequence, entity_json = excluded.entity_json, \
               value_json = excluded.value_json, seed = excluded.seed \
             WHERE excluded.sequence > sequence",
        )
        .bind(intent_row.sequence)
        .bind(&next_key)
        .bind(&next_entity_json)
        .bind(&intent_row.value_json)
        .bind(intent_row.seed)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: insert upgraded intent: {err}"))?;
        sqlx::query(
            "INSERT INTO user_state_progress(namespace, entity_key, local_sequence, acknowledged_sequence, base_revision) \
             SELECT namespace, ?2, local_sequence, acknowledged_sequence, base_revision \
             FROM user_state_progress WHERE entity_key = ?1 \
             ON CONFLICT(namespace, entity_key) DO UPDATE SET \
               local_sequence = MAX(local_sequence, excluded.local_sequence)",
        )
        .bind(&intent_row.entity_key)
        .bind(&next_key)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: migrate upgraded progress: {err}"))?;
        sqlx::query("DELETE FROM user_state_intent WHERE entity_key = ?1")
            .bind(&intent_row.entity_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: cleanup old intent: {err}"))?;
        sqlx::query("DELETE FROM user_state_progress WHERE entity_key = ?1")
            .bind(&intent_row.entity_key)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state: cleanup old progress: {err}"))?;
    }
    Ok(())
}

pub async fn defer_user_state_for_novel_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
) -> Result<(), String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    if is_user_state_current_mode() {
        ctx.record_user_state_deferred_novel(novel_id);
        return Ok(());
    }
    refresh_unattempted_user_state_identities_in_tx(conn, Some(novel_id)).await?;
    let work = sqlx::query("SELECT plugin_id, source_novel_id, path FROM novel WHERE id = ?1")
        .bind(novel_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup deferred work: {err}"))?;
    if let Some(w) = work {
        let plugin_id: String = w.get("plugin_id");
        if plugin_id == "local" {
            return Ok(());
        }
        let source_novel_id = non_empty_source_id(w.get("source_novel_id"));
        let novel_path: String = w.get("path");
        let reopened = sqlx::query(
            "UPDATE user_state_record SET applied_revision = 0, deferred_reason = NULL, deferred_detail = NULL \
             WHERE deferred_reason IS NOT NULL \
               AND json_extract(payload, '$.entity.work.pluginId') = ?1 \
               AND (json_extract(payload, '$.entity.work.novelPath') = ?3 \
                    OR (?2 IS NOT NULL AND lower(json_extract(payload, '$.entity.work.sourceNovelId')) = lower(?2)))",
        )
        .bind(&plugin_id)
        .bind(&source_novel_id)
        .bind(&novel_path)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state: reopen deferred work records: {err}"))?;
        let has_waiting = if reopened.rows_affected() > 0 {
            true
        } else {
            sqlx::query_scalar::<_, i64>(
                "SELECT 1 FROM user_state_record \
                 WHERE applied_revision < revision \
                   AND json_extract(payload, '$.entity.work.pluginId') = ?1 \
                   AND (json_extract(payload, '$.entity.work.novelPath') = ?3 \
                        OR (?2 IS NOT NULL AND lower(json_extract(payload, '$.entity.work.sourceNovelId')) = lower(?2))) \
                 LIMIT 1",
            )
            .bind(&plugin_id)
            .bind(&source_novel_id)
            .bind(&novel_path)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state: check waiting work records: {err}"))?
            .is_some()
        };
        if has_waiting {
            ctx.record_user_state_deferred_novel(novel_id);
        }
    }
    Ok(())
}
