use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::db::chapter_composition::{
    get_chapter_composition_in_tx, materialize_chapter_composition_in_tx,
    parse_chapter_composition, set_chapter_composition_in_tx, ChapterCompositionV1Dto,
    ChapterSourceSnapshotDto,
};
use crate::db::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use crate::db::{DbMutationEffects, DbMutationEnvelope};

use super::core::{
    assert_user_state_available_in_tx, has_user_state_schema_in_tx, require_binding_in_tx,
};
use super::stored_chapter::verified_chapter_storage_dir_in_tx;
use super::types::{
    canonical_user_state_json, fold_ascii, is_local_user_state_entity,
    merge_user_state_composition, merge_user_state_current_reading,
    merge_user_state_current_resume, namespace_for, parse_chapter_reference,
    parse_portable_reader_anchor, parse_stored_chapter_path, parse_user_state_current_item,
    parse_user_state_current_snapshot, parse_user_state_entity, parse_user_state_value,
    parse_work_reference, sha256_hex, stored_chapter_digest, stored_chapter_number,
    stored_chapter_path, user_state_entity_key, user_state_work_key, user_state_work_key_parts,
    CurrentSnapshotRetryDto, PreparedDeferredCurrentRetryDto, UserStateBindingDto,
    UserStateChapterReferenceDto, UserStateCurrentApplyResultDto, UserStateCurrentStatusDto,
    UserStateResumeEffectDto, UserStateWorkReferenceDto,
};

#[derive(Debug, Clone)]
pub struct CurrentWork {
    pub id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub novel_path: String,
    pub name: String,
}

impl CurrentWork {
    pub fn work_ref(&self) -> UserStateWorkReferenceDto {
        UserStateWorkReferenceDto {
            plugin_id: self.plugin_id.clone(),
            source_novel_id: self.source_novel_id.clone(),
            novel_path: self.novel_path.clone(),
            name: self.name.clone(),
        }
    }

    pub fn work_key(&self) -> String {
        user_state_work_key_parts(
            &self.plugin_id,
            self.source_novel_id.as_deref(),
            &self.novel_path,
        )
    }
}

#[derive(Debug, Clone)]
pub struct CurrentChapter {
    pub id: i64,
    pub novel_id: i64,
    pub path: String,
    pub name: String,
    pub progress: f64,
    pub unread: i64,
    pub read_at: Option<i64>,
    pub bookmark: i64,
    pub chapter_number: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone)]
pub struct CurrentCategory {
    pub id: i64,
    pub name: String,
    pub sort: i64,
    pub is_system: i64,
}

#[derive(Debug, Clone, Default)]
pub struct CurrentHeldSources {
    pub ids: HashSet<String>,
    pub id_pairs: HashSet<(String, String)>,
    pub paths: HashSet<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct CurrentData {
    pub works: Vec<CurrentWork>,
    pub held_sources: CurrentHeldSources,
    pub chapters: Vec<CurrentChapter>,
    pub categories: Vec<CurrentCategory>,
    pub memberships: Vec<(i64, i64)>,
    pub category_identities: Vec<(String, Option<i64>)>,
    pub private_values: HashMap<String, JsonValue>,
    pub compositions: HashMap<i64, ChapterCompositionV1Dto>,
    pub resumes: Vec<(JsonValue, JsonValue)>,
    pub applied_resumes: Vec<(JsonValue, JsonValue)>,
    pub stored_chapter_paths: HashMap<i64, String>,
    composition_entry_ids: HashMap<(i64, String), String>,
    stored_chapter_index: HashMap<(i64, String), Option<CurrentChapter>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn current_cache_key(binding: &UserStateBindingDto) -> String {
    format!("user-state-current:{}", namespace_for(binding))
}

pub fn current_status_key(binding: &UserStateBindingDto) -> String {
    format!("user-state-current-status:{}", namespace_for(binding))
}

pub fn current_export_key(binding: &UserStateBindingDto) -> String {
    format!("user-state-current-export:{}", namespace_for(binding))
}

pub fn current_category_id(name: &str) -> String {
    format!("name-{}", sha256_hex(name.trim().as_bytes()))
}

pub fn same_current_value(left: &JsonValue, right: &JsonValue) -> Result<bool, String> {
    Ok(canonical_user_state_json(left)? == canonical_user_state_json(right)?)
}

pub fn is_current_work_held(
    held: &CurrentHeldSources,
    work: &UserStateWorkReferenceDto,
) -> bool {
    held.ids.contains(&user_state_work_key(work))
        || held
            .paths
            .contains(&(work.plugin_id.clone(), work.novel_path.clone()))
}

pub async fn load_current_held_sources_in_tx(
    conn: &mut SqliteConnection,
    server_url: &str,
) -> Result<CurrentHeldSources, String> {
    let rows = sqlx::query(
        "SELECT 'outgoing' AS kind, \
                json_extract(payload, '$.status') AS status, \
                json_extract(payload, '$.operationId') AS operationId, \
                json_extract(payload, '$.lineage.legacyOperationId') AS legacyOperationId, \
                COALESCE(json_extract(payload, '$.source.pluginId'), \
                         json_extract(payload, '$.identity.pluginId')) AS pluginId, \
                COALESCE(json_extract(payload, '$.source.novelId'), \
                         json_extract(payload, '$.identity.novelId')) AS sourceNovelId, \
                COALESCE(json_extract(payload, '$.source.novelPath'), \
                         json_extract(payload, '$.identity.novelPath')) AS novelPath \
         FROM content_sync_cache \
         WHERE cache_key >= 'norea-content-novel-migration:' \
           AND cache_key < 'norea-content-novel-migration;' \
           AND rtrim(json_extract(payload, '$.serverUrl'), '/') = rtrim(?1, '/') \
         UNION ALL \
         SELECT 'incoming' AS kind, \
                json_extract(payload, '$.status') AS status, \
                json_extract(payload, '$.operationId') AS operationId, \
                json_extract(payload, '$.lineage.legacyOperationId') AS legacyOperationId, \
                COALESCE(json_extract(payload, '$.source.pluginId'), \
                         json_extract(payload, '$.identity.pluginId')) AS pluginId, \
                COALESCE(json_extract(payload, '$.source.novelId'), \
                         json_extract(payload, '$.identity.novelId')) AS sourceNovelId, \
                COALESCE(json_extract(payload, '$.source.novelPath'), \
                         json_extract(payload, '$.identity.novelPath')) AS novelPath \
         FROM content_sync_cache \
         WHERE cache_key >= 'norea-content-incoming-migration:' \
           AND cache_key < 'norea-content-incoming-migration;' \
           AND rtrim(json_extract(payload, '$.serverUrl'), '/') = rtrim(?1, '/') \
         UNION ALL \
         SELECT 'number' AS kind, \
                json_extract(payload, '$.status') AS status, \
                json_extract(payload, '$.operationId') AS operationId, \
                json_extract(payload, '$.lineage.legacyOperationId') AS legacyOperationId, \
                COALESCE(json_extract(payload, '$.source.pluginId'), \
                         json_extract(payload, '$.identity.pluginId')) AS pluginId, \
                COALESCE(json_extract(payload, '$.source.novelId'), \
                         json_extract(payload, '$.identity.novelId')) AS sourceNovelId, \
                COALESCE(json_extract(payload, '$.source.novelPath'), \
                         json_extract(payload, '$.identity.novelPath')) AS novelPath \
         FROM content_sync_cache \
         WHERE cache_key >= 'norea-content-chapter-number-reconciliation:' \
           AND cache_key < 'norea-content-chapter-number-reconciliation;' \
           AND rtrim(json_extract(payload, '$.serverUrl'), '/') = rtrim(?1, '/')",
    )
    .bind(server_url)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: load held sources: {err}"))?;

    #[derive(Clone)]
    struct RawHold {
        kind: String,
        status: Option<String>,
        operation_id: Option<String>,
        legacy_operation_id: Option<String>,
        plugin_id: Option<String>,
        source_novel_id: Option<String>,
        novel_path: Option<String>,
    }

    let parsed: Vec<RawHold> = rows
        .into_iter()
        .map(|r| RawHold {
            kind: r.get("kind"),
            status: r.get("status"),
            operation_id: r.get("operationId"),
            legacy_operation_id: r.get("legacyOperationId"),
            plugin_id: r.get("pluginId"),
            source_novel_id: r.get("sourceNovelId"),
            novel_path: r.get("novelPath"),
        })
        .collect();

    let mut revoked: HashSet<String> = HashSet::new();
    for r in &parsed {
        if r.kind == "incoming" && r.status.as_deref() == Some("inactive") {
            if let Some(ref op) = r.operation_id {
                revoked.insert(op.clone());
            }
            if let Some(ref leg) = r.legacy_operation_id {
                revoked.insert(leg.clone());
            }
        }
    }

    let mut result = CurrentHeldSources::default();
    for r in parsed {
        let Some(plugin_id) = r.plugin_id.filter(|s| !s.is_empty()) else {
            continue;
        };
        if (r.kind == "number" && r.status.as_deref() != Some("pending"))
            || (r.kind == "incoming" && r.status.as_deref() == Some("inactive"))
            || r.operation_id.as_ref().is_some_and(|op| revoked.contains(op))
            || r.legacy_operation_id
                .as_ref()
                .is_some_and(|op| revoked.contains(op))
        {
            continue;
        }
        let novel_path_str = r.novel_path.as_deref().unwrap_or("");
        if let Some(ref source_novel_id) = r.source_novel_id.filter(|s| !s.is_empty()) {
            result.ids.insert(user_state_work_key_parts(
                &plugin_id,
                Some(source_novel_id),
                novel_path_str,
            ));
            result
                .id_pairs
                .insert((plugin_id.clone(), fold_ascii(source_novel_id)));
        }
        if let Some(novel_path) = r.novel_path.filter(|s| !s.is_empty()) {
            result.paths.insert((plugin_id, novel_path));
        }
    }
    Ok(result)
}

pub async fn load_current_works_in_tx(conn: &mut SqliteConnection) -> Result<Vec<CurrentWork>, String> {
    let rows = sqlx::query(
        "SELECT id, plugin_id, source_novel_id, path, name \
         FROM novel WHERE plugin_id <> 'local' AND is_local = 0",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: load works: {err}"))?;
    Ok(rows
        .into_iter()
        .map(|r| CurrentWork {
            id: r.get("id"),
            plugin_id: r.get("plugin_id"),
            source_novel_id: super::core::non_empty_source_id(r.get("source_novel_id")),
            novel_path: r.get("path"),
            name: r.get("name"),
        })
        .collect())
}

pub async fn load_current_data_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
    skipped_chapter_ids: &HashSet<i64>,
    requested: Option<&[(JsonValue, JsonValue)]>,
) -> Result<CurrentData, String> {
    let works = load_current_works_in_tx(conn).await?;
    let held_sources = load_current_held_sources_in_tx(conn, &binding.server_url).await?;
    let categories: Vec<CurrentCategory> =
        sqlx::query("SELECT id, name, sort, is_system FROM category")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state current: load categories: {err}"))?
            .into_iter()
            .map(|r| CurrentCategory {
                id: r.get("id"),
                name: r.get("name"),
                sort: r.get("sort"),
                is_system: r.get("is_system"),
            })
            .collect();
    let memberships: Vec<(i64, i64)> =
        sqlx::query("SELECT novel_id, category_id FROM novel_category")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state current: load memberships: {err}"))?
            .into_iter()
            .map(|r| (r.get("novel_id"), r.get("category_id")))
            .collect();
    let category_identities: Vec<(String, Option<i64>)> =
        sqlx::query("SELECT category_id, local_id FROM user_state_category")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state current: load category identities: {err}"))?
            .into_iter()
            .map(|r| (r.get("category_id"), r.get("local_id")))
            .collect();

    let raw_private = sqlx::query("SELECT entity_key, public_value_json FROM user_state_private")
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: load private values: {err}"))?;
    let mut private_values: HashMap<String, JsonValue> = HashMap::with_capacity(raw_private.len());
    for r in raw_private {
        let entity_key: String = r.get("entity_key");
        let raw_str: String = r.get("public_value_json");
        let raw_val: JsonValue = serde_json::from_str(&raw_str)
            .map_err(|err| format!("db user state current: parse private value: {err}"))?;
        let val = parse_user_state_value("reading", &raw_val)?;
        private_values.insert(entity_key, val);
    }

    let raw_comps = sqlx::query("SELECT novel_id, payload FROM novel_chapter_composition")
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: load compositions: {err}"))?;
    let mut compositions: HashMap<i64, ChapterCompositionV1Dto> =
        HashMap::with_capacity(raw_comps.len());
    let mut composition_entry_ids: HashMap<(i64, String), String> = HashMap::new();
    for r in raw_comps {
        let novel_id: i64 = r.get("novel_id");
        let payload_str: String = r.get("payload");
        let raw_val: JsonValue = serde_json::from_str(&payload_str)
            .map_err(|err| format!("db user state current: parse composition JSON: {err}"))?;
        let comp = parse_chapter_composition(&raw_val)?;
        for entry in &comp.entries {
            composition_entry_ids.insert((novel_id, entry.path.clone()), entry.id.clone());
        }
        compositions.insert(novel_id, comp);
    }

    let works_by_path: HashMap<(String, String), &CurrentWork> = works
        .iter()
        .map(|w| ((w.plugin_id.clone(), w.novel_path.clone()), w))
        .collect();
    let raw_resumes = sqlx::query(
        "SELECT entity_json, value_json FROM user_state_intent \
         WHERE json_extract(entity_json, '$.kind') = 'resume'",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: load resume intents: {err}"))?;
    let mut resumes: Vec<(JsonValue, JsonValue)> = Vec::with_capacity(raw_resumes.len());
    for r in raw_resumes {
        let ent_str: String = r.get("entity_json");
        let val_str: String = r.get("value_json");
        let raw_ent: JsonValue = serde_json::from_str(&ent_str)
            .map_err(|err| format!("db user state current: parse resume entity: {err}"))?;
        let mut ent = parse_user_state_entity(&raw_ent)?;
        if ent["kind"].as_str() == Some("resume") && ent["work"]["sourceNovelId"].is_null() {
            let pid = ent["work"]["pluginId"].as_str().unwrap_or("").to_string();
            let npath = ent["work"]["novelPath"].as_str().unwrap_or("").to_string();
            if let Some(work) = works_by_path.get(&(pid, npath)) {
                if work.source_novel_id.is_some() {
                    ent = json!({ "kind": "resume", "work": serde_json::to_value(work.work_ref()).unwrap() });
                }
            }
        }
        let raw_val: JsonValue = serde_json::from_str(&val_str)
            .map_err(|err| format!("db user state current: parse resume value: {err}"))?;
        let val = parse_user_state_value("resume", &raw_val)?;
        if !is_local_user_state_entity(&ent, Some(&val)) {
            resumes.push((ent, val));
        }
    }

    let cached_resumes: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(payload, '$.resumes') FROM content_sync_cache WHERE cache_key = ?1",
    )
    .bind(current_status_key(binding))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: load cached status resumes: {err}"))?
    .flatten();
    let mut applied_resumes: Vec<(JsonValue, JsonValue)> = Vec::new();
    if let Some(resumes_json) = cached_resumes {
        let raw_arr: Vec<JsonValue> = serde_json::from_str(&resumes_json)
            .map_err(|err| format!("db user state current: parse cached resumes: {err}"))?;
        for item in raw_arr {
            let (ent, val) = parse_user_state_current_item(&item)?;
            if !is_local_user_state_entity(&ent, Some(&val)) {
                applied_resumes.push((ent, val));
            }
        }
    }

    let ref_source_items: Vec<(JsonValue, JsonValue)> = match requested {
        Some(items) => items.to_vec(),
        None => {
            let mut combined = applied_resumes.clone();
            combined.extend(resumes.iter().cloned());
            combined
        }
    };
    let mut chapter_refs: Vec<JsonValue> = Vec::new();
    let mut stored_requests: HashSet<(String, Option<String>, String)> = HashSet::new();
    for (ent, val) in &ref_source_items {
        let Some(work_obj) = ent.get("work") else {
            continue;
        };
        let kind = ent["kind"].as_str().unwrap_or("");
        let ch_obj = match kind {
            "reading" | "bookmark" => ent.get("chapter"),
            "resume" => val.get("chapter").filter(|v| !v.is_null()),
            _ => None,
        };
        let Some(ch) = ch_obj else {
            continue;
        };
        let ch_path = ch["chapterPath"].as_str().unwrap_or("");
        let plugin_id = work_obj["pluginId"].as_str().unwrap_or("");
        let source_novel_id = work_obj["sourceNovelId"].as_str();
        let stored = parse_stored_chapter_path(ch_path);
        if let Some(ref st) = stored {
            stored_requests.insert((
                plugin_id.to_string(),
                source_novel_id.map(fold_ascii),
                st.chapter_number.clone(),
            ));
        }
        chapter_refs.push(json!({
            "pluginId": plugin_id,
            "sourceNovelId": source_novel_id,
            "path": stored.as_ref().map_or(ch_path, |s| s.folder_path.as_str()),
            "storageNumber": stored.map(|s| s.chapter_number),
        }));
    }

    let columns = "c.id, c.novel_id AS novelId, c.path, c.name, c.progress, c.unread, \
                   c.read_at AS readAt, c.bookmark, c.chapter_number AS chapterNumber, c.position";
    let requested_from = " FROM json_each(?1) r \
                           JOIN novel n ON json_extract(r.value, '$.pluginId') = n.plugin_id \
                             AND n.plugin_id <> 'local' AND n.is_local = 0 \
                             AND lower(json_extract(r.value, '$.sourceNovelId')) = lower(n.source_novel_id) \
                           JOIN chapter c ON c.novel_id = n.id";
    let requested_chapters_sql = format!(
        "SELECT {columns}{requested_from} AND json_extract(r.value, '$.path') = c.path \
         UNION \
         SELECT {columns}{requested_from} \
           AND CAST(json_extract(r.value, '$.storageNumber') AS REAL) = CAST(c.chapter_number AS REAL) \
         WHERE json_extract(r.value, '$.storageNumber') IS NOT NULL"
    );
    let chapter_refs_json = serde_json::to_string(&chapter_refs).unwrap();

    let ch_rows = if let Some(req_items) = requested {
        let resume_work_keys: HashSet<String> = req_items
            .iter()
            .filter(|(ent, _)| ent["kind"].as_str() == Some("resume"))
            .filter_map(|(ent, _)| parse_work_reference(&ent["work"]).ok())
            .map(|w| user_state_work_key(&w))
            .collect();
        let resume_novel_ids: Vec<i64> = works
            .iter()
            .filter(|w| resume_work_keys.contains(&w.work_key()))
            .map(|w| w.id)
            .collect();
        let resume_ids_json = serde_json::to_string(&resume_novel_ids).unwrap();
        let sql = format!(
            "{requested_chapters_sql} \
             UNION SELECT {columns} FROM chapter c \
             WHERE c.novel_id IN (SELECT value FROM json_each(?2)) AND c.read_at IS NOT NULL"
        );
        sqlx::query(&sql)
            .bind(&chapter_refs_json)
            .bind(&resume_ids_json)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state current: load requested chapters: {err}"))?
    } else {
        let positive = "c.progress > 0 OR c.unread = 0 OR c.read_at IS NOT NULL OR c.bookmark = 1 \
                        OR EXISTS(SELECT 1 FROM user_state_private p \
                                  WHERE p.entity_key = json_array('reading', \
                                          (CASE WHEN n.source_novel_id IS NULL \
                                                THEN json_array(n.plugin_id, 'path', n.path) \
                                                ELSE json_array(n.plugin_id, 'id', lower(n.source_novel_id)) END) || '', \
                                          c.path) \
                                     OR p.entity_key = json_array('reading', \
                                          json_array(n.plugin_id, 'path', n.path) || '', c.path))";
        let sql = format!(
            "SELECT {columns} FROM chapter c JOIN novel n ON n.id = c.novel_id \
             WHERE n.plugin_id <> 'local' AND n.is_local = 0 AND ({positive}) \
             UNION {requested_chapters_sql}"
        );
        sqlx::query(&sql)
            .bind(&chapter_refs_json)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state current: load positive chapters: {err}"))?
    };

    let chapters: Vec<CurrentChapter> = ch_rows
        .into_iter()
        .map(|r| CurrentChapter {
            id: r.get("id"),
            novel_id: r.get("novelId"),
            path: r.get("path"),
            name: r.get("name"),
            progress: crate::db::decode_sqlite_f64(&r, "progress"),
            unread: r.get("unread"),
            read_at: r.get("readAt"),
            bookmark: r.get("bookmark"),
            chapter_number: r.get("chapterNumber"),
            position: r.get("position"),
        })
        .collect();

    let mut data = CurrentData {
        works,
        held_sources,
        chapters,
        categories,
        memberships,
        category_identities,
        private_values,
        compositions,
        resumes,
        applied_resumes,
        stored_chapter_paths: HashMap::new(),
        composition_entry_ids,
        stored_chapter_index: HashMap::new(),
    };
    load_stored_chapter_paths_in_tx(
        root,
        conn,
        &mut data,
        &stored_requests,
        skipped_chapter_ids,
    )
    .await?;
    Ok(data)
}

async fn load_stored_chapter_paths_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    data: &mut CurrentData,
    requested: &HashSet<(String, Option<String>, String)>,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<(), String> {
    let Some(root_path) = root else {
        return Ok(());
    };
    let works_by_id: HashMap<i64, &CurrentWork> = data.works.iter().map(|w| (w.id, w)).collect();
    let mut candidates: Vec<(CurrentChapter, CurrentWork, String)> = Vec::new();
    for chapter in &data.chapters {
        let Some(&work) = works_by_id.get(&chapter.novel_id) else {
            continue;
        };
        let Some(ref source_novel_id) = work.source_novel_id else {
            continue;
        };
        let Some(number) = stored_chapter_number(chapter.chapter_number.as_deref()) else {
            continue;
        };
        if work.plugin_id == "local"
            || data.compositions.contains_key(&work.id)
            || chapter.path.starts_with("local-folder:")
            || chapter.path.starts_with("norea-composed:")
            || chapter.path.starts_with("norea-source:")
            || chapter.path.starts_with("norea-stored:")
            || is_current_work_held(&data.held_sources, &work.work_ref())
        {
            continue;
        }
        if let Some(raw_folder_num) = chapter.path.strip_prefix("norea-folder:") {
            if stored_chapter_number(Some(raw_folder_num)).as_deref() != Some(number.as_str()) {
                continue;
            }
        } else if !requested.contains(&(
            work.plugin_id.clone(),
            Some(fold_ascii(source_novel_id)),
            number.clone(),
        )) {
            continue;
        }
        candidates.push((chapter.clone(), work.clone(), number));
    }
    if candidates.is_empty() {
        return Ok(());
    }

    let mut targets_map: HashMap<(i64, String), JsonValue> = HashMap::new();
    for (_, work, number) in &candidates {
        targets_map.insert(
            (work.id, number.clone()),
            json!({ "novelId": work.id, "number": number }),
        );
    }
    let targets_vec: Vec<JsonValue> = targets_map.into_values().collect();
    let targets_json = serde_json::to_string(&targets_vec).unwrap();
    let counts = sqlx::query(
        "SELECT json_extract(t.value, '$.novelId') AS novelId, \
                json_extract(t.value, '$.number') AS number, \
                COUNT(*) AS cnt \
         FROM json_each(?1) t \
         JOIN chapter c ON c.novel_id = json_extract(t.value, '$.novelId') \
           AND CAST(c.chapter_number AS REAL) = CAST(json_extract(t.value, '$.number') AS REAL) \
         GROUP BY t.value",
    )
    .bind(&targets_json)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: check unique stored chapter numbers: {err}"))?;

    let mut unique: HashSet<(i64, String)> = HashSet::new();
    for r in counts {
        let cnt: i64 = r.get("cnt");
        if cnt == 1 {
            unique.insert((r.get("novelId"), r.get("number")));
        }
    }

    for (chapter, work, number) in candidates {
        if !unique.contains(&(work.id, number.clone()))
            || skipped_chapter_ids.contains(&chapter.id)
        {
            continue;
        }
        let Ok(chapter_dir) = verified_chapter_storage_dir_in_tx(
            conn,
            chapter.id,
            &work.plugin_id,
            work.source_novel_id.as_deref(),
            chapter.chapter_number.as_deref(),
            chapter.position,
        )
        .await
        else {
            continue;
        };
        let Ok(inventory) =
            crate::chapter_media::inspect_payload_inventory_at(root_path, &chapter_dir)
        else {
            continue;
        };
        let Some(digest) = stored_chapter_digest(&inventory) else {
            continue;
        };
        if let Some(path) = stored_chapter_path(Some(&number), &digest) {
            let key = (chapter.novel_id, path.clone());
            match data.stored_chapter_index.get(&key) {
                None => {
                    data.stored_chapter_index.insert(key, Some(chapter.clone()));
                }
                Some(_) => {
                    data.stored_chapter_index.insert(key, None);
                }
            }
            data.stored_chapter_paths.insert(chapter.id, path);
        }
    }
    Ok(())
}

pub fn private_value_for_chapter<'a>(
    data: &'a CurrentData,
    work: &CurrentWork,
    chapter: &CurrentChapter,
) -> Option<(&'a str, &'a JsonValue)> {
    let w_ref = work.work_ref();
    let k1 = user_state_entity_key(&json!({
        "kind": "reading",
        "work": serde_json::to_value(&w_ref).unwrap(),
        "chapter": { "chapterPath": chapter.path },
    }))
    .ok()?;
    if let Some((stored_k, v)) = data.private_values.get_key_value(&k1) {
        return Some((stored_k.as_str(), v));
    }
    let mut null_ref = w_ref;
    null_ref.source_novel_id = None;
    let k2 = user_state_entity_key(&json!({
        "kind": "reading",
        "work": serde_json::to_value(&null_ref).unwrap(),
        "chapter": { "chapterPath": chapter.path },
    }))
    .ok()?;
    data.private_values
        .get_key_value(&k2)
        .map(|(k, v)| (k.as_str(), v))
}

fn current_reading_value(
    data: &CurrentData,
    work: &CurrentWork,
    chapter: &CurrentChapter,
) -> Result<JsonValue, String> {
    if let Some((_, val)) = private_value_for_chapter(data, work, chapter) {
        return Ok(val.clone());
    }
    parse_user_state_value(
        "reading",
        &json!({
            "progress": chapter.progress,
            "unread": chapter.unread != 0,
            "readAt": chapter.read_at,
        }),
    )
}

pub fn current_chapter_reference(
    data: &CurrentData,
    chapter: &CurrentChapter,
) -> Option<UserStateChapterReferenceDto> {
    if chapter.path.starts_with("local-folder:") {
        return None;
    }
    if chapter.path.starts_with("norea-folder:") {
        let stored_path = data.stored_chapter_paths.get(&chapter.id)?;
        return Some(UserStateChapterReferenceDto {
            chapter_path: stored_path.clone(),
            composition_entry_id: None,
            name: Some(chapter.name.clone()),
        });
    }
    if chapter.path.starts_with("norea-composed:") || chapter.path.starts_with("norea-source:") {
        let entry_id = data
            .composition_entry_ids
            .get(&(chapter.novel_id, chapter.path.clone()))?;
        return Some(UserStateChapterReferenceDto {
            chapter_path: chapter.path.clone(),
            composition_entry_id: Some(entry_id.clone()),
            name: Some(chapter.name.clone()),
        });
    }
    Some(UserStateChapterReferenceDto {
        chapter_path: chapter.path.clone(),
        composition_entry_id: None,
        name: Some(chapter.name.clone()),
    })
}

pub fn matching_current_chapter<'a>(
    data: &'a CurrentData,
    work: &CurrentWork,
    reference: &UserStateChapterReferenceDto,
    chapters_by_path: &HashMap<(i64, String), &'a CurrentChapter>,
) -> Option<&'a CurrentChapter> {
    if parse_stored_chapter_path(&reference.chapter_path).is_some() {
        return data
            .stored_chapter_index
            .get(&(work.id, reference.chapter_path.clone()))
            .and_then(|opt| opt.as_ref());
    }
    let ch = *chapters_by_path.get(&(work.id, reference.chapter_path.clone()))?;
    let local = current_chapter_reference(data, ch)?;
    if local.composition_entry_id.is_none()
        || local.composition_entry_id == reference.composition_entry_id
    {
        Some(ch)
    } else {
        None
    }
}

pub fn current_resume_value(
    data: &CurrentData,
    work: &CurrentWork,
    value: &JsonValue,
    chapters_by_path: &HashMap<(i64, String), &CurrentChapter>,
) -> JsonValue {
    let Some(raw_ch) = value.get("chapter").filter(|v| !v.is_null()) else {
        return value.clone();
    };
    let Ok(ch_ref) = parse_chapter_reference(raw_ch) else {
        return value.clone();
    };
    let Some(chapter) = matching_current_chapter(data, work, &ch_ref, chapters_by_path) else {
        return value.clone();
    };
    let Some(next_ref) = current_chapter_reference(data, chapter) else {
        return value.clone();
    };
    if next_ref.chapter_path != ch_ref.chapter_path {
        let mut cloned = value.clone();
        cloned["chapter"] = serde_json::to_value(next_ref).unwrap();
        cloned
    } else {
        value.clone()
    }
}

pub fn current_resume_values(
    resumes: &[(JsonValue, JsonValue)],
    applied_resumes: &[(JsonValue, JsonValue)],
) -> Result<HashMap<String, (JsonValue, JsonValue)>, String> {
    let mut result: HashMap<String, (JsonValue, JsonValue)> = HashMap::new();
    for (ent, val) in applied_resumes.iter().chain(resumes.iter()) {
        if ent["kind"].as_str() != Some("resume") {
            continue;
        }
        let work = parse_work_reference(&ent["work"])?;
        let key = user_state_work_key(&work);
        if val.get("chapter").is_none_or(JsonValue::is_null) {
            result.insert(key, (ent.clone(), val.clone()));
            continue;
        }
        let merged = match result.get(&key) {
            Some((_, prev_val)) => merge_user_state_current_resume(prev_val, val)?,
            None => val.clone(),
        };
        result.insert(key, (ent.clone(), merged));
    }
    Ok(result)
}

pub fn current_public_resume_values(
    data: &CurrentData,
) -> Result<HashMap<String, (JsonValue, JsonValue)>, String> {
    let chapters_by_path: HashMap<(i64, String), &CurrentChapter> = data
        .chapters
        .iter()
        .map(|c| ((c.novel_id, c.path.clone()), c))
        .collect();
    let works_by_key: HashMap<String, &CurrentWork> =
        data.works.iter().map(|w| (w.work_key(), w)).collect();

    let normalize = |item: &(JsonValue, JsonValue)| -> Result<(JsonValue, JsonValue), String> {
        if item.0["kind"].as_str() != Some("resume") {
            return Ok(item.clone());
        }
        let w_ref = parse_work_reference(&item.0["work"])?;
        if let Some(&work) = works_by_key.get(&user_state_work_key(&w_ref)) {
            Ok((
                item.0.clone(),
                current_resume_value(data, work, &item.1, &chapters_by_path),
            ))
        } else {
            Ok(item.clone())
        }
    };
    let norm_resumes: Vec<(JsonValue, JsonValue)> = data
        .resumes
        .iter()
        .map(normalize)
        .collect::<Result<Vec<_>, _>>()?;
    let norm_applied: Vec<(JsonValue, JsonValue)> = data
        .applied_resumes
        .iter()
        .map(normalize)
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = current_resume_values(&norm_resumes, &norm_applied)?;

    let works_by_id: HashMap<i64, &CurrentWork> = data.works.iter().map(|w| (w.id, w)).collect();
    for chapter in &data.chapters {
        let Some(&work) = works_by_id.get(&chapter.novel_id) else {
            continue;
        };
        let Some(read_at) = chapter.read_at else {
            continue;
        };
        if work.source_novel_id.is_none()
            || is_current_work_held(&data.held_sources, &work.work_ref())
            || private_value_for_chapter(data, work, chapter).is_some()
        {
            continue;
        }
        let Some(ch_ref) = current_chapter_reference(data, chapter) else {
            continue;
        };
        let key = work.work_key();
        if let Some((_, prev_val)) = result.get(&key) {
            if prev_val.get("chapter").is_none_or(JsonValue::is_null) {
                continue;
            }
        }
        let next_val = json!({
            "chapter": serde_json::to_value(ch_ref).unwrap(),
            "anchor": null,
            "openedAt": read_at,
        });
        let merged = match result.get(&key) {
            Some((_, prev_val)) => merge_user_state_current_resume(prev_val, &next_val)?,
            None => next_val,
        };
        result.insert(
            key,
            (
                json!({ "kind": "resume", "work": serde_json::to_value(work.work_ref()).unwrap() }),
                merged,
            ),
        );
    }
    Ok(result)
}

pub fn same_current_resume_position(left: &JsonValue, right: &JsonValue) -> Result<bool, String> {
    let strip_pos = |val: &JsonValue| -> JsonValue {
        let mut cloned = val.clone();
        if let Some(ch) = val.get("chapter").filter(|v| !v.is_null()) {
            let path = ch["chapterPath"].as_str().unwrap_or("");
            let mut ch_map = serde_json::Map::new();
            ch_map.insert("chapterPath".into(), JsonValue::String(path.to_string()));
            if (path.starts_with("norea-composed:") || path.starts_with("norea-source:"))
                && ch.get("compositionEntryId").is_some()
            {
                ch_map.insert(
                    "compositionEntryId".into(),
                    ch["compositionEntryId"].clone(),
                );
            }
            cloned["chapter"] = JsonValue::Object(ch_map);
        }
        cloned
    };
    same_current_value(&strip_pos(left), &strip_pos(right))
}

fn add_snapshot_item(
    held_sources: &CurrentHeldSources,
    ordered_keys: &mut Vec<String>,
    items: &mut HashMap<String, JsonValue>,
    missing: &mut HashSet<String>,
    raw_item: JsonValue,
) -> Result<(), String> {
    let key = user_state_entity_key(&raw_item["entity"])?;
    if let Some(work_val) = raw_item["entity"].get("work") {
        let w_ref = parse_work_reference(work_val)?;
        if w_ref.source_novel_id.is_none() || is_current_work_held(held_sources, &w_ref) {
            missing.insert(key);
            return Ok(());
        }
    }
    let (ent, val) = parse_user_state_current_item(&raw_item)?;
    if !items.contains_key(&key) {
        ordered_keys.push(key.clone());
    }
    items.insert(key, json!({ "entity": ent, "value": val }));
    Ok(())
}

pub async fn build_current_snapshot_in_tx(
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
    data: &CurrentData,
) -> Result<(JsonValue, usize), String> {
    let mut ordered_keys: Vec<String> = Vec::new();
    let mut items: HashMap<String, JsonValue> = HashMap::new();
    let mut missing: HashSet<String> = HashSet::new();

    let by_id: HashMap<i64, &CurrentWork> = data.works.iter().map(|w| (w.id, w)).collect();
    let by_key: HashMap<String, &CurrentWork> = data
        .works
        .iter()
        .filter(|w| w.source_novel_id.is_some())
        .map(|w| (w.work_key(), w))
        .collect();
    let mut category_ids: HashMap<i64, String> = HashMap::new();
    let mut category_mappings: Vec<(String, i64)> = Vec::new();

    for category in &data.categories {
        if category.is_system != 0 || category.name.trim().is_empty() {
            continue;
        }
        let cat_id = current_category_id(&category.name);
        category_ids.insert(category.id, cat_id.clone());
        category_mappings.push((cat_id.clone(), category.id));
        let cat_key = user_state_entity_key(&json!({ "kind": "category", "categoryId": cat_id }))?;
        let sort = items
            .get(&cat_key)
            .and_then(|it| it["value"]["sort"].as_i64())
            .map_or(category.sort, |prev_sort| prev_sort.min(category.sort));
        add_snapshot_item(
            &data.held_sources,
            &mut ordered_keys,
            &mut items,
            &mut missing,
            json!({
                "entity": { "kind": "category", "categoryId": cat_id },
                "value": { "name": category.name.trim(), "sort": sort, "deleted": false },
            }),
        )?;
    }

    let known_mappings: HashSet<(String, i64)> = data
        .category_identities
        .iter()
        .filter_map(|(cid, lid)| lid.map(|id| (cid.clone(), id)))
        .collect();
    let new_mappings: Vec<JsonValue> = category_mappings
        .into_iter()
        .filter(|pair| !known_mappings.contains(pair))
        .map(|(cid, lid)| json!({ "categoryId": cid, "localId": lid }))
        .collect();
    if !new_mappings.is_empty() {
        let encoded = serde_json::to_string(&new_mappings).unwrap();
        sqlx::query(
            "INSERT INTO user_state_category(category_id, local_id) \
             SELECT json_extract(value, '$.categoryId'), json_extract(value, '$.localId') \
             FROM json_each(?1) WHERE true \
             ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: save category mappings: {err}"))?;
    }

    for &(novel_id, cat_local_id) in &data.memberships {
        if let (Some(&work), Some(cat_id)) = (by_id.get(&novel_id), category_ids.get(&cat_local_id))
        {
            add_snapshot_item(
                &data.held_sources,
                &mut ordered_keys,
                &mut items,
                &mut missing,
                json!({
                    "entity": {
                        "kind": "membership",
                        "work": serde_json::to_value(work.work_ref()).unwrap(),
                        "categoryId": cat_id,
                    },
                    "value": { "included": true },
                }),
            )?;
        }
    }

    let mut comp_novel_ids: Vec<i64> = data.compositions.keys().copied().collect();
    comp_novel_ids.sort_unstable();
    for novel_id in comp_novel_ids {
        if let (Some(&work), Some(comp)) = (by_id.get(&novel_id), data.compositions.get(&novel_id))
        {
            add_snapshot_item(
                &data.held_sources,
                &mut ordered_keys,
                &mut items,
                &mut missing,
                json!({
                    "entity": { "kind": "composition", "work": serde_json::to_value(work.work_ref()).unwrap() },
                    "value": { "composition": serde_json::to_value(comp).unwrap() },
                }),
            )?;
        }
    }

    let resume_values = current_public_resume_values(data)?;
    let chapters_by_path: HashMap<(i64, String), &CurrentChapter> = data
        .chapters
        .iter()
        .map(|c| ((c.novel_id, c.path.clone()), c))
        .collect();

    for chapter in &data.chapters {
        let Some(&work) = by_id.get(&chapter.novel_id) else {
            continue;
        };
        let value = current_reading_value(data, work, chapter)?;
        let positive_reading = value["progress"].as_f64().unwrap_or(0.0) > 0.0
            || !value["unread"].as_bool().unwrap_or(true)
            || !value["readAt"].is_null();
        let ch_ref = current_chapter_reference(data, chapter);
        if ch_ref.is_none() || work.source_novel_id.is_none() {
            let work_json = serde_json::to_value(work.work_ref()).unwrap();
            if positive_reading {
                missing.insert(user_state_entity_key(&json!({
                    "kind": "reading",
                    "work": work_json,
                    "chapter": { "chapterPath": chapter.path },
                }))?);
            }
            if chapter.bookmark != 0 {
                missing.insert(user_state_entity_key(&json!({
                    "kind": "bookmark",
                    "work": work_json,
                    "chapter": { "chapterPath": chapter.path },
                }))?);
            }
            continue;
        }
        let ch_ref_json = serde_json::to_value(ch_ref.unwrap()).unwrap();
        let portable_work = serde_json::to_value(work.work_ref()).unwrap();
        if positive_reading {
            add_snapshot_item(
                &data.held_sources,
                &mut ordered_keys,
                &mut items,
                &mut missing,
                json!({
                    "entity": { "kind": "reading", "work": portable_work, "chapter": ch_ref_json },
                    "value": value,
                }),
            )?;
        }
        if chapter.bookmark != 0 {
            add_snapshot_item(
                &data.held_sources,
                &mut ordered_keys,
                &mut items,
                &mut missing,
                json!({
                    "entity": { "kind": "bookmark", "work": portable_work, "chapter": ch_ref_json },
                    "value": { "bookmarked": true },
                }),
            )?;
        }
    }

    for (ent, val) in resume_values.values() {
        if ent["kind"].as_str() != Some("resume") {
            continue;
        }
        let Some(raw_ch) = val.get("chapter").filter(|v| !v.is_null()) else {
            continue;
        };
        let ch_ref = parse_chapter_reference(raw_ch)?;
        let w_ref = parse_work_reference(&ent["work"])?;
        let Some(&work) = by_key.get(&user_state_work_key(&w_ref)) else {
            missing.insert(user_state_entity_key(ent)?);
            continue;
        };
        if matching_current_chapter(data, work, &ch_ref, &chapters_by_path).is_none() {
            missing.insert(user_state_entity_key(ent)?);
            continue;
        }
        add_snapshot_item(
            &data.held_sources,
            &mut ordered_keys,
            &mut items,
            &mut missing,
            json!({
                "entity": { "kind": "resume", "work": serde_json::to_value(work.work_ref()).unwrap() },
                "value": val,
            }),
        )?;
    }

    let final_items: Vec<JsonValue> = ordered_keys
        .into_iter()
        .filter_map(|k| items.remove(&k))
        .collect();
    let snapshot = json!({
        "version": 2,
        "workspaceId": binding.workspace_id,
        "epoch": binding.epoch,
        "items": final_items,
    });
    let _ = parse_user_state_current_snapshot(&snapshot)?;
    Ok((snapshot, missing.len()))
}

pub async fn bind_current_workspace_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    binding: &UserStateBindingDto,
) -> Result<(), String> {
    assert_user_state_available_in_tx(conn).await?;
    if binding.server_url.is_empty() || binding.workspace_id.is_empty() || binding.epoch.is_empty()
    {
        return Err("A complete personal state workspace is required.".to_string());
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT namespace FROM user_state_workspace WHERE server_url = ?1",
    )
    .bind(&binding.server_url)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: lookup workspace: {err}"))?;
    if existing.is_some() {
        require_binding_in_tx(conn, binding).await?;
    } else {
        sqlx::query(
            "INSERT INTO user_state_workspace(server_url, namespace, workspace_id, epoch) \
             VALUES (?1, ?2, ?3, ?4)",
        )
        .bind(&binding.server_url)
        .bind(namespace_for(binding))
        .bind(&binding.workspace_id)
        .bind(&binding.epoch)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: insert workspace: {err}"))?;
    }
    ctx.record_user_state_ledger_change();
    Ok(())
}

pub async fn get_current_status_in_tx(
    conn: &mut SqliteConnection,
    server_url: Option<&str>,
) -> Result<UserStateCurrentStatusDto, String> {
    let empty = UserStateCurrentStatusDto {
        workspace_id: None,
        epoch: None,
        last_success_at: None,
        paused_after_restore: false,
        missing_metadata_count: 0,
    };
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(empty);
    }
    let row = sqlx::query(
        "SELECT w.workspace_id AS workspaceId, w.epoch, w.last_success_at AS lastSuccessAt, \
                r.paused, \
                COALESCE(json_extract(c.payload, '$.missingMetadataCount'), 0) + \
                COALESCE(json_extract(e.payload, '$.missingMetadataCount'), 0) AS missingMetadataCount \
         FROM user_state_restore_state r \
         LEFT JOIN user_state_workspace w ON w.server_url = ?1 \
         LEFT JOIN content_sync_cache c ON c.cache_key = 'user-state-current-status:' || w.namespace \
         LEFT JOIN content_sync_cache e ON e.cache_key = 'user-state-current-export:' || w.namespace \
         WHERE r.id = 1",
    )
    .bind(server_url)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: query status: {err}"))?;

    Ok(match row {
        Some(r) => UserStateCurrentStatusDto {
            workspace_id: r.get("workspaceId"),
            epoch: r.get("epoch"),
            last_success_at: r.get("lastSuccessAt"),
            paused_after_restore: r.get::<i64, _>("paused") != 0,
            missing_metadata_count: r.get("missingMetadataCount"),
        },
        None => empty,
    })
}

pub async fn export_current_snapshot_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<JsonValue, String> {
    assert_user_state_available_in_tx(conn).await?;
    require_binding_in_tx(conn, binding).await?;
    let data = load_current_data_in_tx(root, conn, binding, skipped_chapter_ids, None).await?;
    let (snapshot, missing_metadata_count) = build_current_snapshot_in_tx(conn, binding, &data).await?;
    sqlx::query(
        "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2) \
         ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
    )
    .bind(current_export_key(binding))
    .bind(json!({ "missingMetadataCount": missing_metadata_count }).to_string())
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: save export status: {err}"))?;
    Ok(snapshot)
}

pub async fn prepare_deferred_current_retry_in_tx(
    conn: &mut SqliteConnection,
    server_url: &str,
    novel_ids: &[i64],
) -> Result<Option<(UserStateBindingDto, PreparedDeferredCurrentRetryDto)>, String> {
    if novel_ids.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(None);
    }
    let ws = sqlx::query(
        "SELECT server_url, workspace_id, epoch FROM user_state_workspace WHERE server_url = ?1",
    )
    .bind(server_url)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: lookup retry workspace: {err}"))?;
    let Some(ws) = ws else {
        return Ok(None);
    };
    let binding = UserStateBindingDto {
        server_url: ws.get("server_url"),
        workspace_id: ws.get("workspace_id"),
        epoch: ws.get("epoch"),
    };
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM content_sync_cache WHERE cache_key = ?1",
    )
    .bind(current_cache_key(&binding))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: load cached snapshot: {err}"))?;
    let Some(payload) = payload else {
        return Ok(None);
    };
    let cached: JsonValue = serde_json::from_str(&payload)
        .map_err(|err| format!("db user state current: parse cached snapshot: {err}"))?;
    let snapshot = cached
        .get("snapshot")
        .cloned()
        .ok_or_else(|| "db user state current: missing cached snapshot".to_string())?;
    let _ = parse_user_state_current_snapshot(&snapshot)?;
    let missing_keys: Vec<String> = cached
        .get("missingKeys")
        .and_then(JsonValue::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(JsonValue::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let ids_json = serde_json::to_string(novel_ids).unwrap();
    let work_rows = sqlx::query(
        "SELECT plugin_id, source_novel_id, path FROM novel \
         WHERE id IN (SELECT value FROM json_each(?1))",
    )
    .bind(&ids_json)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state current: load retry works: {err}"))?;
    let mut work_keys: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in work_rows {
        let source_novel_id = super::core::non_empty_source_id(r.get("source_novel_id"));
        if let Some(ref sid) = source_novel_id {
            let pid: String = r.get("plugin_id");
            let path: String = r.get("path");
            let wk = user_state_work_key_parts(&pid, Some(sid), &path);
            if seen.insert(wk.clone()) {
                work_keys.push(wk);
            }
        }
    }
    Ok(Some((
        binding,
        PreparedDeferredCurrentRetryDto {
            snapshot,
            missing_keys,
            work_keys,
        },
    )))
}

async fn load_current_categories_in_tx(
    conn: &mut SqliteConnection,
) -> Result<Vec<CurrentCategory>, String> {
    let rows = sqlx::query("SELECT id, name, sort, is_system FROM category")
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: load categories: {err}"))?;
    Ok(rows
        .into_iter()
        .map(|r| CurrentCategory {
            id: r.get("id"),
            name: r.get("name"),
            sort: r.get("sort"),
            is_system: r.get("is_system"),
        })
        .collect())
}

async fn install_current_structure_in_tx(
    conn: &mut SqliteConnection,
    binding: &UserStateBindingDto,
    raw_items: &[(JsonValue, JsonValue)],
) -> Result<(Vec<CurrentWork>, CurrentHeldSources, HashSet<String>, bool), String> {
    require_binding_in_tx(conn, binding).await?;
    assert_user_state_available_in_tx(conn).await?;
    let held_sources = load_current_held_sources_in_tx(conn, &binding.server_url).await?;

    let mut missing: HashSet<String> = HashSet::new();
    let mut items: Vec<&(JsonValue, JsonValue)> = Vec::with_capacity(raw_items.len());
    for item in raw_items {
        if let Some(work_val) = item.0.get("work") {
            let w_ref = parse_work_reference(work_val)?;
            if is_current_work_held(&held_sources, &w_ref) {
                missing.insert(user_state_entity_key(&item.0)?);
                continue;
            }
        }
        items.push(item);
    }

    let works = load_current_works_in_tx(conn).await?;
    let by_key: HashMap<String, CurrentWork> = works
        .iter()
        .filter(|w| w.source_novel_id.is_some())
        .map(|w| (w.work_key(), w.clone()))
        .collect();
    let mut changed = false;

    let mut categories = load_current_categories_in_tx(conn).await?;
    let build_names = |cats: &[CurrentCategory]| -> HashMap<String, CurrentCategory> {
        let mut map = HashMap::new();
        for cat in cats {
            if cat.is_system == 0 {
                let trimmed = cat.name.trim().to_string();
                map.entry(trimmed).or_insert_with(|| cat.clone());
            }
        }
        map
    };
    let mut names = build_names(&categories);
    let exact_names: HashSet<String> = categories.iter().map(|c| c.name.clone()).collect();
    let mut cat_additions_order: Vec<String> = Vec::new();
    let mut cat_additions: HashMap<String, i64> = HashMap::new();
    for (ent, val) in &items {
        if ent["kind"].as_str() == Some("category") {
            let name = val["name"].as_str().unwrap_or("");
            let sort = val["sort"].as_i64().unwrap_or(0);
            if !names.contains_key(name) && !exact_names.contains(name) {
                if !cat_additions.contains_key(name) {
                    cat_additions_order.push(name.to_string());
                }
                cat_additions.insert(name.to_string(), sort);
            }
        }
    }
    if !cat_additions_order.is_empty() {
        let to_insert: Vec<JsonValue> = cat_additions_order
            .into_iter()
            .map(|n| {
                let s = cat_additions[&n];
                json!({ "name": n, "sort": s })
            })
            .collect();
        let encoded = serde_json::to_string(&to_insert).unwrap();
        sqlx::query(
            "INSERT INTO category(name, sort, is_system) \
             SELECT json_extract(value, '$.name'), json_extract(value, '$.sort'), 0 \
             FROM json_each(?1)",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: insert categories: {err}"))?;
        categories = load_current_categories_in_tx(conn).await?;
        names = build_names(&categories);
        changed = true;
    }

    let known_maps = sqlx::query("SELECT category_id, local_id FROM user_state_category")
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: load category maps: {err}"))?;
    let mut local_categories: HashMap<String, i64> = HashMap::new();
    for r in known_maps {
        if let Some(lid) = r.get::<Option<i64>, _>("local_id") {
            local_categories.insert(r.get("category_id"), lid);
        }
    }
    let mut cat_mappings: Vec<JsonValue> = Vec::new();
    let mut sort_updates: Vec<JsonValue> = Vec::new();
    for (ent, val) in &items {
        if ent["kind"].as_str() == Some("category") {
            let name = val["name"].as_str().unwrap_or("");
            let sort = val["sort"].as_i64().unwrap_or(0);
            let cat_id = ent["categoryId"].as_str().unwrap_or("");
            let Some(category) = names.get(name) else {
                missing.insert(user_state_entity_key(ent)?);
                continue;
            };
            if local_categories.get(cat_id) != Some(&category.id) {
                cat_mappings.push(json!({ "categoryId": cat_id, "localId": category.id }));
            }
            local_categories.insert(cat_id.to_string(), category.id);
            if category.sort > sort {
                sort_updates.push(json!({ "id": category.id, "sort": sort }));
            }
        }
    }
    if !cat_mappings.is_empty() {
        let encoded = serde_json::to_string(&cat_mappings).unwrap();
        sqlx::query(
            "INSERT INTO user_state_category(category_id, local_id) \
             SELECT json_extract(value, '$.categoryId'), json_extract(value, '$.localId') \
             FROM json_each(?1) WHERE true \
             ON CONFLICT(category_id) DO UPDATE SET local_id = excluded.local_id",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: upsert category maps: {err}"))?;
    }
    if !sort_updates.is_empty() {
        let encoded = serde_json::to_string(&sort_updates).unwrap();
        sqlx::query(
            "WITH incoming AS ( \
               SELECT json_extract(value, '$.id') AS id, \
                      json_extract(value, '$.sort') AS sort \
               FROM json_each(?1) \
             ) \
             UPDATE category SET sort = MIN(category.sort, incoming.sort) \
             FROM incoming WHERE category.id = incoming.id",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: update category sort: {err}"))?;
        changed = true;
    }

    let mut memberships: Vec<JsonValue> = Vec::new();
    for (ent, _) in &items {
        if ent["kind"].as_str() == Some("membership") {
            let w_ref = parse_work_reference(&ent["work"])?;
            let cat_id = ent["categoryId"].as_str().unwrap_or("");
            let Some(work) = by_key.get(&user_state_work_key(&w_ref)) else {
                missing.insert(user_state_entity_key(ent)?);
                continue;
            };
            let Some(&local_cat_id) = local_categories.get(cat_id) else {
                missing.insert(user_state_entity_key(ent)?);
                continue;
            };
            memberships.push(json!({ "novelId": work.id, "categoryId": local_cat_id }));
        }
    }
    if !memberships.is_empty() {
        let encoded = serde_json::to_string(&memberships).unwrap();
        let res = sqlx::query(
            "INSERT OR IGNORE INTO novel_category(novel_id, category_id) \
             SELECT json_extract(value, '$.novelId'), json_extract(value, '$.categoryId') \
             FROM json_each(?1)",
        )
        .bind(&encoded)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state current: insert memberships: {err}"))?;
        changed |= res.rows_affected() > 0;
    }

    Ok((works, held_sources, missing, changed))
}

#[derive(Debug, Clone)]
struct ResumeBodyOwner {
    plugin_id: String,
    novel_id: String,
    chapter_path: String,
    source_chapter_id: Option<String>,
}

impl From<&ChapterSourceSnapshotDto> for ResumeBodyOwner {
    fn from(value: &ChapterSourceSnapshotDto) -> Self {
        Self {
            plugin_id: value.plugin_id.clone(),
            novel_id: value.novel_id.clone(),
            chapter_path: value.chapter_path.clone(),
            source_chapter_id: value.source_chapter_id.clone(),
        }
    }
}

fn same_resume_body_owner(left: &ResumeBodyOwner, right: &ResumeBodyOwner) -> bool {
    left.plugin_id == right.plugin_id
        && fold_ascii(&left.novel_id) == fold_ascii(&right.novel_id)
        && match (&left.source_chapter_id, &right.source_chapter_id) {
            (Some(l), Some(r)) if !l.is_empty() && !r.is_empty() => l == r,
            _ => left.chapter_path == right.chapter_path,
        }
}

fn merge_mutation_effects(target: &mut DbMutationEffects, next: DbMutationEffects) {
    if let Some(p) = next.user_state_priority {
        target.user_state_priority = Some(match target.user_state_priority {
            Some(prev) => prev.merge(p),
            None => p,
        });
    }
    target.user_state_ledger_changed |= next.user_state_ledger_changed;
    target.user_state_deferred_ready |= next.user_state_deferred_ready;
    for id in next.user_state_deferred_novel_ids {
        if !target.user_state_deferred_novel_ids.contains(&id) {
            target.user_state_deferred_novel_ids.push(id);
        }
    }
    if let Some(seq) = next.content_sync_max_sequence {
        target.content_sync_max_sequence = Some(
            target
                .content_sync_max_sequence
                .map_or(seq, |prev| prev.max(seq)),
        );
    }
    target.work_metadata_changed |= next.work_metadata_changed;
    for id in next.cover_changed_novel_ids {
        if !target.cover_changed_novel_ids.contains(&id) {
            target.cover_changed_novel_ids.push(id);
        }
    }
    target.work_directories.extend(next.work_directories);
    target.chapter_directories.extend(next.chapter_directories);
}

pub async fn apply_current_snapshot_at(
    pool: &SqlitePool,
    metadata_root: MetadataRoot,
    binding: &UserStateBindingDto,
    raw_snapshot: &JsonValue,
    retry: Option<CurrentSnapshotRetryDto>,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<DbMutationEnvelope<UserStateCurrentApplyResultDto>, String> {
    let (workspace_id, epoch, raw_all_items) = parse_user_state_current_snapshot(raw_snapshot)?;
    let all_items: Vec<(JsonValue, JsonValue)> = raw_all_items
        .into_iter()
        .filter(|(ent, val)| !is_local_user_state_entity(ent, Some(val)))
        .collect();
    if workspace_id != binding.workspace_id || epoch != binding.epoch {
        return Err("The current personal state workspace does not match this device.".to_string());
    }
    let normalized_snapshot = json!({
        "version": 2,
        "workspaceId": workspace_id,
        "epoch": epoch,
        "items": all_items.iter().map(|(e, v)| json!({ "entity": e, "value": v })).collect::<Vec<_>>(),
    });

    let retry_work_keys: Option<HashSet<String>> = retry
        .as_ref()
        .map(|r| r.work_keys.iter().cloned().collect());
    let items: Vec<(JsonValue, JsonValue)> = match &retry_work_keys {
        Some(keys) => {
            let mut filtered = Vec::new();
            for (ent, val) in &all_items {
                if ent["kind"].as_str() == Some("category") {
                    filtered.push((ent.clone(), val.clone()));
                } else if let Some(w_val) = ent.get("work") {
                    let w_ref = parse_work_reference(w_val)?;
                    if keys.contains(&user_state_work_key(&w_ref)) {
                        filtered.push((ent.clone(), val.clone()));
                    }
                }
            }
            filtered
        }
        None => all_items,
    };

    let mut composition_keys: HashSet<String> = HashSet::new();
    for (ent, _) in &items {
        if ent["kind"].as_str() == Some("composition") {
            let w_ref = parse_work_reference(&ent["work"])?;
            composition_keys.insert(user_state_work_key(&w_ref));
        }
    }

    let tx_opts = TxOptions {
        remote_content_sync: true,
        notify_content_sync: true,
        publish_metadata: true,
        metadata_root: metadata_root.clone(),
        ..TxOptions::default()
    };

    let binding_c1 = binding.clone();
    let items_c1 = items.clone();
    let comp_keys_c1 = composition_keys.clone();
    let step1 = with_write_tx(pool, tx_opts.clone(), move |conn, _ctx| {
        Box::pin(async move {
            let (works, held_sources, missing, changed) =
                install_current_structure_in_tx(conn, &binding_c1, &items_c1).await?;
            let novel_ids: Vec<i64> = works
                .iter()
                .filter(|w| comp_keys_c1.contains(&w.work_key()))
                .map(|w| w.id)
                .collect();
            let chapters: Vec<(i64, String, i64)> = if novel_ids.is_empty() {
                Vec::new()
            } else {
                let ids_json = serde_json::to_string(&novel_ids).unwrap();
                sqlx::query(
                    "SELECT id, novel_id, path FROM chapter \
                     WHERE novel_id IN (SELECT value FROM json_each(?1))",
                )
                .bind(&ids_json)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db user state current: load pre-composition chapters: {err}"))?
                .into_iter()
                .map(|r| (r.get("novel_id"), r.get("path"), r.get("id")))
                .collect()
            };
            Ok((works, held_sources, missing, changed, chapters))
        })
    })
    .await?;

    let mut combined_effects = DbMutationEffects::default();
    merge_mutation_effects(&mut combined_effects, step1.effects);
    let (structure_works, structure_held, mut missing, mut changed, pre_chapters) = step1.value;
    let previous_chapter_ids: HashMap<(i64, String), i64> = pre_chapters
        .into_iter()
        .map(|(nid, path, cid)| ((nid, path), cid))
        .collect();
    let mut previous_composition_entry_ids: HashMap<(i64, String), String> = HashMap::new();
    let mut previous_composition_owners: HashMap<(i64, String), ResumeBodyOwner> = HashMap::new();
    let mut changed_composition_novels: HashSet<i64> = HashSet::new();
    let by_key: HashMap<String, CurrentWork> = structure_works
        .iter()
        .filter(|w| w.source_novel_id.is_some())
        .map(|w| (w.work_key(), w.clone()))
        .collect();

    let resolved_root = metadata_root.resolve()?;

    for (ent, val) in &items {
        if ent["kind"].as_str() != Some("composition") {
            continue;
        }
        let w_ref = parse_work_reference(&ent["work"])?;
        if is_current_work_held(&structure_held, &w_ref) {
            missing.insert(user_state_entity_key(ent)?);
            continue;
        }
        let Some(work) = by_key.get(&user_state_work_key(&w_ref)).cloned() else {
            missing.insert(user_state_entity_key(ent)?);
            continue;
        };
        let shared_comp = parse_chapter_composition(&val["composition"])?;
        let binding_c2 = binding.clone();
        let work_c2 = work.clone();
        let resolved_root_c2 = resolved_root.clone();
        let step2 = with_write_tx(pool, tx_opts.clone(), move |conn, _ctx| {
            Box::pin(async move {
                require_binding_in_tx(conn, &binding_c2).await?;
                assert_user_state_available_in_tx(conn).await?;
                let live_held =
                    load_current_held_sources_in_tx(conn, &binding_c2.server_url).await?;
                if is_current_work_held(&live_held, &work_c2.work_ref()) {
                    return Err("The source work is held by its saved migration.".to_string());
                }
                let current = get_chapter_composition_in_tx(conn, work_c2.id).await?;
                let incoming_wins = match &current {
                    None => true,
                    Some(cur) => {
                        shared_comp.updated_at > cur.updated_at
                            || (shared_comp.updated_at == cur.updated_at
                                && canonical_user_state_json(
                                    &serde_json::to_value(&shared_comp).unwrap(),
                                )? < canonical_user_state_json(
                                    &serde_json::to_value(cur).unwrap(),
                                )?)
                    }
                };
                if !incoming_wins {
                    return Ok(None);
                }
                let merged = merge_user_state_composition(
                    &shared_comp,
                    current.as_ref(),
                    &work_c2.plugin_id,
                    work_c2.source_novel_id.as_deref().unwrap_or(""),
                )?;
                if let Some(ref cur) = current {
                    if same_current_value(
                        &serde_json::to_value(cur).unwrap(),
                        &serde_json::to_value(&merged).unwrap(),
                    )? {
                        return Ok(None);
                    }
                }
                let mut prev_entries = Vec::new();
                let mut prev_owners = Vec::new();
                if let Some(ref cur) = current {
                    for entry in &cur.entries {
                        prev_entries.push(((work_c2.id, entry.path.clone()), entry.id.clone()));
                        prev_owners.push((
                            (work_c2.id, entry.path.clone()),
                            ResumeBodyOwner::from(&entry.sources[entry.primary_source]),
                        ));
                    }
                }
                materialize_chapter_composition_in_tx(
                    resolved_root_c2.as_deref(),
                    conn,
                    work_c2.id,
                    &merged,
                    &[],
                )
                .await?;
                set_chapter_composition_in_tx(conn, work_c2.id, Some(&merged)).await?;
                Ok(Some((prev_entries, prev_owners)))
            })
        })
        .await;

        match step2 {
            Ok(env) => {
                merge_mutation_effects(&mut combined_effects, env.effects);
                if let Some((prev_entries, prev_owners)) = env.value {
                    changed = true;
                    changed_composition_novels.insert(work.id);
                    previous_composition_entry_ids.extend(prev_entries);
                    previous_composition_owners.extend(prev_owners);
                }
            }
            Err(err) => {
                missing.insert(user_state_entity_key(ent)?);
                log::warn!(
                    "[user-state] current composition is waiting for its original metadata: {err}"
                );
            }
        }
    }

    let binding_c3 = binding.clone();
    let skipped_c3 = skipped_chapter_ids.clone();
    let step3 = with_write_tx(pool, tx_opts, move |conn, ctx| {
        Box::pin(async move {
            require_binding_in_tx(conn, &binding_c3).await?;
            assert_user_state_available_in_tx(conn).await?;
            let mut data = load_current_data_in_tx(
                resolved_root.as_deref(),
                conn,
                &binding_c3,
                &skipped_c3,
                Some(&items),
            )
            .await?;

            let mut changed_body_paths: HashSet<(String, String)> = HashSet::new();
            for &novel_id in &changed_composition_novels {
                let Some(work) = data.works.iter().find(|w| w.id == novel_id) else {
                    continue;
                };
                if let Some(comp) = data.compositions.get(&novel_id) {
                    for entry in &comp.entries {
                        let key = (novel_id, entry.path.clone());
                        let prev_owner = previous_composition_owners
                            .get(&key)
                            .cloned()
                            .unwrap_or_else(|| ResumeBodyOwner {
                                plugin_id: work.plugin_id.clone(),
                                novel_id: work.source_novel_id.clone().unwrap_or_default(),
                                chapter_path: entry.path.clone(),
                                source_chapter_id: None,
                            });
                        let next_owner =
                            ResumeBodyOwner::from(&entry.sources[entry.primary_source]);
                        if !same_resume_body_owner(&prev_owner, &next_owner) {
                            changed_body_paths.insert((work.work_key(), entry.path.clone()));
                        }
                    }
                }
            }

            let mut cleared_resume_refs: HashMap<(String, String), JsonValue> = HashMap::new();
            for item in &mut data.applied_resumes {
                if item.0["kind"].as_str() != Some("resume") {
                    continue;
                }
                let Some(ch_path) = item.1["chapter"]["chapterPath"].as_str().map(String::from)
                else {
                    continue;
                };
                if item.1.get("anchor").is_none_or(JsonValue::is_null) {
                    continue;
                }
                let wk = user_state_work_key(&parse_work_reference(&item.0["work"])?);
                if changed_body_paths.contains(&(wk, ch_path)) {
                    item.1["anchor"] = JsonValue::Null;
                }
            }
            for item in &mut data.resumes {
                if item.0["kind"].as_str() != Some("resume") {
                    continue;
                }
                let Some(ch_path) = item.1["chapter"]["chapterPath"].as_str().map(String::from)
                else {
                    continue;
                };
                if item.1.get("anchor").is_none_or(JsonValue::is_null) {
                    continue;
                }
                let w_ref = parse_work_reference(&item.0["work"])?;
                if changed_body_paths.contains(&(user_state_work_key(&w_ref), ch_path.clone())) {
                    item.1["anchor"] = JsonValue::Null;
                    let k1 = user_state_entity_key(&item.0)?;
                    let mut null_ent = item.0.clone();
                    null_ent["work"]["sourceNovelId"] = JsonValue::Null;
                    let k2 = user_state_entity_key(&null_ent)?;
                    for ek in [k1, k2] {
                        cleared_resume_refs.insert(
                            (ek.clone(), ch_path.clone()),
                            json!({ "entityKey": ek, "chapterPath": ch_path }),
                        );
                    }
                }
            }
            if !cleared_resume_refs.is_empty() {
                let refs_vec: Vec<JsonValue> = cleared_resume_refs.into_values().collect();
                let encoded = serde_json::to_string(&refs_vec).unwrap();
                sqlx::query(
                    "UPDATE user_state_intent SET value_json = json_set(value_json, '$.anchor', NULL) \
                     WHERE json_extract(entity_json, '$.kind') = 'resume' \
                       AND entity_key IN (SELECT json_extract(value, '$.entityKey') FROM json_each(?1)) \
                       AND EXISTS (SELECT 1 FROM json_each(?1) changed \
                                   WHERE user_state_intent.entity_key = json_extract(changed.value, '$.entityKey') \
                                     AND json_extract(user_state_intent.value_json, '$.chapter.chapterPath') = \
                                         json_extract(changed.value, '$.chapterPath'))",
                )
                .bind(&encoded)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state current: clear stale resume anchors: {err}"))?;
            }

            let mut resumes = current_public_resume_values(&data)?;
            let works_by_key: HashMap<String, &CurrentWork> = data
                .works
                .iter()
                .filter(|w| w.source_novel_id.is_some())
                .map(|w| (w.work_key(), w))
                .collect();
            let chapters_by_path: HashMap<(i64, String), &CurrentChapter> = data
                .chapters
                .iter()
                .map(|c| ((c.novel_id, c.path.clone()), c))
                .collect();

            #[derive(Clone)]
            struct ChapterUpdate {
                id: i64,
                progress: f64,
                unread: i64,
                read_at: Option<i64>,
                bookmark: i64,
            }
            let mut updates: HashMap<i64, ChapterUpdate> = HashMap::new();
            let mut private_updates: HashMap<String, JsonValue> = HashMap::new();
            let mut affected_novels: HashSet<i64> = HashSet::new();
            let mut result = UserStateCurrentApplyResultDto {
                resumes: Vec::new(),
                missing_metadata_count: 0,
                changed,
            };

            for (ent, val) in &items {
                let kind = ent["kind"].as_str().unwrap_or("");
                if !matches!(kind, "reading" | "bookmark" | "resume") {
                    continue;
                }
                let w_ref = parse_work_reference(&ent["work"])?;
                if is_current_work_held(&data.held_sources, &w_ref) {
                    missing.insert(user_state_entity_key(ent)?);
                    continue;
                }
                let Some(&work) = works_by_key.get(&user_state_work_key(&w_ref)) else {
                    missing.insert(user_state_entity_key(ent)?);
                    continue;
                };
                let raw_ch_ref = if matches!(kind, "reading" | "bookmark") {
                    ent.get("chapter")
                } else {
                    val.get("chapter").filter(|v| !v.is_null())
                };
                let Some(raw_ch_ref) = raw_ch_ref else {
                    missing.insert(user_state_entity_key(ent)?);
                    continue;
                };
                let ch_ref = parse_chapter_reference(raw_ch_ref)?;
                let Some(chapter) =
                    matching_current_chapter(&data, work, &ch_ref, &chapters_by_path)
                else {
                    missing.insert(user_state_entity_key(ent)?);
                    continue;
                };

                if kind == "resume" {
                    let key = work.work_key();
                    let incoming = current_resume_value(&data, work, val, &chapters_by_path);
                    let merged_val = match resumes.get(&key) {
                        Some((_, prev_val)) => merge_user_state_current_resume(prev_val, &incoming)?,
                        None => incoming,
                    };
                    let target = match merged_val.get("chapter").filter(|v| !v.is_null()) {
                        Some(raw_target_ch) => {
                            let target_ref = parse_chapter_reference(raw_target_ch)?;
                            matching_current_chapter(&data, work, &target_ref, &chapters_by_path)
                        }
                        None => None,
                    };
                    let retargeted = if let Some(target_ch) =
                        target.filter(|_| changed_composition_novels.contains(&work.id))
                    {
                        let target_key = (work.id, target_ch.path.clone());
                        let next_entry = data
                            .compositions
                            .get(&work.id)
                            .and_then(|c| c.entries.iter().find(|e| e.path == target_ch.path));
                        let prev_owner = previous_composition_owners
                            .get(&target_key)
                            .cloned()
                            .unwrap_or_else(|| ResumeBodyOwner {
                                plugin_id: work.plugin_id.clone(),
                                novel_id: work.source_novel_id.clone().unwrap_or_default(),
                                chapter_path: target_ch.path.clone(),
                                source_chapter_id: None,
                            });
                        let merged_entry_id = merged_val
                            .get("chapter")
                            .and_then(|c| c.get("compositionEntryId"))
                            .and_then(JsonValue::as_str);
                        previous_chapter_ids.get(&target_key) != Some(&target_ch.id)
                            || ((target_ch.path.starts_with("norea-composed:")
                                || target_ch.path.starts_with("norea-source:"))
                                && previous_composition_entry_ids
                                    .get(&target_key)
                                    .map(String::as_str)
                                    != merged_entry_id)
                            || next_entry.is_some_and(|ne| {
                                !same_resume_body_owner(
                                    &prev_owner,
                                    &ResumeBodyOwner::from(&ne.sources[ne.primary_source]),
                                )
                            })
                    } else {
                        false
                    };

                    let pos_changed = match resumes.get(&key) {
                        None => true,
                        Some((_, prev_val)) => !same_current_resume_position(prev_val, &merged_val)?,
                    };
                    if pos_changed || retargeted {
                        let Some(target_ch) = target else {
                            missing.insert(user_state_entity_key(ent)?);
                            continue;
                        };
                        let anchor = match merged_val.get("anchor").filter(|v| !v.is_null()) {
                            Some(raw_a) => Some(parse_portable_reader_anchor(raw_a)?),
                            None => None,
                        };
                        let opened_at = merged_val.get("openedAt").and_then(JsonValue::as_i64);
                        result.resumes.push(UserStateResumeEffectDto {
                            novel_id: work.id,
                            chapter_id: Some(target_ch.id),
                            anchor,
                            opened_at,
                        });
                        result.changed = true;
                    }
                    resumes.insert(
                        key,
                        (
                            json!({ "kind": "resume", "work": serde_json::to_value(work.work_ref()).unwrap() }),
                            merged_val,
                        ),
                    );
                    continue;
                }

                let mut update = updates.get(&chapter.id).cloned().unwrap_or(ChapterUpdate {
                    id: chapter.id,
                    progress: chapter.progress,
                    unread: chapter.unread,
                    read_at: chapter.read_at,
                    bookmark: chapter.bookmark,
                });
                if kind == "bookmark" {
                    if update.bookmark == 0 {
                        update.bookmark = 1;
                        updates.insert(chapter.id, update);
                    }
                } else {
                    let priv_entry = private_value_for_chapter(&data, work, chapter);
                    let local_val = if let Some((pk, pv)) = priv_entry {
                        private_updates.get(pk).cloned().unwrap_or_else(|| pv.clone())
                    } else {
                        parse_user_state_value(
                            "reading",
                            &json!({
                                "progress": update.progress,
                                "unread": update.unread != 0,
                                "readAt": update.read_at,
                            }),
                        )?
                    };
                    let merged_reading = merge_user_state_current_reading(&local_val, val)?;
                    if !same_current_value(&local_val, &merged_reading)? {
                        if let Some((pk, _)) = priv_entry {
                            private_updates.insert(pk.to_string(), merged_reading);
                        } else {
                            update.progress = merged_reading["progress"].as_f64().unwrap_or(0.0);
                            update.unread = if merged_reading["unread"].as_bool().unwrap_or(true) {
                                1
                            } else {
                                0
                            };
                            update.read_at = merged_reading.get("readAt").and_then(JsonValue::as_i64);
                            updates.insert(chapter.id, update);
                            affected_novels.insert(work.id);
                        }
                    }
                }
            }

            if !updates.is_empty() {
                let upd_json: Vec<JsonValue> = updates
                    .values()
                    .map(|u| {
                        json!({
                            "id": u.id,
                            "progress": u.progress,
                            "unread": u.unread,
                            "readAt": u.read_at,
                            "bookmark": u.bookmark,
                        })
                    })
                    .collect();
                let encoded = serde_json::to_string(&upd_json).unwrap();
                sqlx::query(
                    "WITH incoming AS ( \
                       SELECT json_extract(value, '$.id') AS id, \
                              json_extract(value, '$.progress') AS progress, \
                              json_extract(value, '$.unread') AS unread, \
                              json_extract(value, '$.readAt') AS read_at, \
                              json_extract(value, '$.bookmark') AS bookmark \
                       FROM json_each(?1) \
                     ) \
                     UPDATE chapter \
                     SET progress = incoming.progress, unread = incoming.unread, \
                         read_at = incoming.read_at, bookmark = incoming.bookmark \
                     FROM incoming WHERE chapter.id = incoming.id",
                )
                .bind(&encoded)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state current: update chapters: {err}"))?;
                result.changed = true;
            }

            if !private_updates.is_empty() {
                let priv_json: Vec<JsonValue> = private_updates
                    .into_iter()
                    .map(|(k, v)| json!({ "key": k, "value": v }))
                    .collect();
                let encoded = serde_json::to_string(&priv_json).unwrap();
                sqlx::query(
                    "WITH incoming AS ( \
                       SELECT json_extract(value, '$.key') AS entity_key, \
                              json_extract(value, '$.value') AS payload \
                       FROM json_each(?1) \
                     ) \
                     UPDATE user_state_private SET public_value_json = incoming.payload \
                     FROM incoming WHERE user_state_private.entity_key = incoming.entity_key",
                )
                .bind(&encoded)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state current: update private values: {err}"))?;
                result.changed = true;
            }

            if !affected_novels.is_empty() {
                let ids_vec: Vec<i64> = affected_novels.into_iter().collect();
                let encoded = serde_json::to_string(&ids_vec).unwrap();
                sqlx::query(
                    "UPDATE novel \
                     SET last_read_at = (SELECT MAX(read_at) FROM chapter WHERE novel_id = novel.id) \
                     WHERE id IN (SELECT value FROM json_each(?1))",
                )
                .bind(&encoded)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state current: update novel last_read_at: {err}"))?;
            }

            let mut handled: HashSet<String> = HashSet::with_capacity(items.len());
            for (ent, _) in &items {
                handled.insert(user_state_entity_key(ent)?);
            }

            let mut current_resumes: Vec<JsonValue> = Vec::new();
            for (ent, val) in resumes.into_values() {
                if val.get("chapter").is_none_or(JsonValue::is_null) {
                    continue;
                }
                let candidate = json!({ "entity": ent, "value": val });
                match parse_user_state_current_item(&candidate) {
                    Ok((pe, pv)) => current_resumes.push(json!({ "entity": pe, "value": pv })),
                    Err(_) => {
                        missing.insert(user_state_entity_key(&candidate["entity"])?);
                    }
                }
            }

            let mut missing_keys: Vec<String> = Vec::new();
            let mut missing_seen: HashSet<String> = HashSet::new();
            if let Some(ref r) = retry {
                for key in &r.previous_missing {
                    if !handled.contains(key) && missing_seen.insert(key.clone()) {
                        missing_keys.push(key.clone());
                    }
                }
            }
            for key in missing {
                if missing_seen.insert(key.clone()) {
                    missing_keys.push(key);
                }
            }
            result.missing_metadata_count = missing_keys.len();

            sqlx::query(
                "INSERT INTO content_sync_cache(cache_key, payload) VALUES (?1, ?2), (?3, ?4) \
                 ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload",
            )
            .bind(current_cache_key(&binding_c3))
            .bind(
                json!({
                    "snapshot": normalized_snapshot,
                    "missingKeys": missing_keys,
                })
                .to_string(),
            )
            .bind(current_status_key(&binding_c3))
            .bind(
                json!({
                    "resumes": current_resumes,
                    "missingMetadataCount": result.missing_metadata_count,
                })
                .to_string(),
            )
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state current: save current cache: {err}"))?;

            if retry.is_none() {
                sqlx::query(
                    "UPDATE user_state_workspace SET last_success_at = ?2 WHERE server_url = ?1",
                )
                .bind(&binding_c3.server_url)
                .bind(now_ms())
                .execute(&mut *conn)
                .await
                .map_err(|err| {
                    format!("db user state current: touch workspace last_success_at: {err}")
                })?;
            }

            ctx.record_user_state_ledger_change();
            Ok(result)
        })
    })
    .await?;

    merge_mutation_effects(&mut combined_effects, step3.effects);
    Ok(DbMutationEnvelope {
        value: step3.value,
        effects: combined_effects,
    })
}
