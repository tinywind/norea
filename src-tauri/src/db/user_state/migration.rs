use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::{AssertSqlSafe, Row, SqliteConnection};

use crate::db::tx::TxContext;

use super::core::{
    chapter_reference_json, chapter_work_json, has_user_state_schema_in_tx, intent_from_row,
    load_user_chapter_rows_by_ids_in_tx, map_user_chapter_row,
    populate_user_chapter_composition_ids_in_tx, record_resume_cleared_in_tx,
    record_user_state_changes_in_tx, work_reference_in_tx, IntentRow, UserChapterRow,
    USER_CHAPTER_SELECT,
};
use super::materialize::{materialize_user_state_record_in_tx, MaterializeError};
use super::types::{
    merge_user_state_resume, parse_user_state_record, parse_user_state_value,
    parse_work_reference, user_state_entity_key, user_state_work_key, ParsedUserStateRecord,
    UserStateApplyEffectsDto, UserStateResumeEffectDto,
};

const MAX_SAFE_INT_I64: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateChapterPathBefore {
    pub id: i64,
    pub novel_id: i64,
    pub path: String,
}

pub(crate) async fn pending_intents_for_works_in_tx(
    conn: &mut SqliteConnection,
    work_keys: &[&str],
) -> Result<Vec<IntentRow>, String> {
    let mut unique_work_keys: Vec<&str> = Vec::with_capacity(work_keys.len());
    for &work_key in work_keys {
        if !unique_work_keys.contains(&work_key) {
            unique_work_keys.push(work_key);
        }
    }
    if unique_work_keys.is_empty() {
        return Ok(Vec::new());
    }

    let has_workspace: bool =
        sqlx::query_scalar::<_, i64>("SELECT EXISTS(SELECT 1 FROM user_state_workspace)")
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db user state migration: check workspace existence: {err}"))?
            != 0;

    let mut exact_keys: Vec<String> = Vec::with_capacity(unique_work_keys.len() * 2);
    let mut range_bounds: Vec<(String, String)> = Vec::with_capacity(unique_work_keys.len() * 3);
    for work_key in unique_work_keys {
        for kind in ["library", "resume"] {
            exact_keys.push(
                serde_json::to_string(&(kind, work_key))
                    .map_err(|err| format!("db user state migration: encode work intent key: {err}"))?,
            );
        }
        let encoded_work = serde_json::to_string(work_key)
            .map_err(|err| format!("db user state migration: encode work key: {err}"))?;
        for kind in ["reading", "bookmark", "membership"] {
            range_bounds.push((
                format!(r#"["{kind}",{encoded_work},"#),
                format!(r#"["{kind}",{encoded_work}-"#),
            ));
        }
    }

    let pending_predicate = if has_workspace {
        " AND EXISTS(SELECT 1 FROM user_state_workspace w \
                     CROSS JOIN user_state_progress p \
                       ON p.namespace = w.namespace \
                      AND p.entity_key = i.entity_key \
                     WHERE i.sequence > p.acknowledged_sequence)"
    } else {
        ""
    };

    let mut rows: Vec<IntentRow> = Vec::new();
    let mut seen_sequences: HashSet<i64> = HashSet::new();

    if !exact_keys.is_empty() {
        let placeholders = (1..=exact_keys.len())
            .map(|idx| format!("?{idx}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
             FROM user_state_intent i \
             WHERE i.entity_key IN ({placeholders}) \
               AND i.seed = 0{pending_predicate}"
        );
        let mut query = sqlx::query(AssertSqlSafe(sql));
        for key in &exact_keys {
            query = query.bind(key);
        }
        let fetched = query
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state migration: load pending work intents: {err}"))?;
        for r in fetched {
            let sequence: i64 = r.get("sequence");
            if seen_sequences.insert(sequence) {
                rows.push(IntentRow {
                    sequence,
                    entity_key: r.get("entity_key"),
                    entity_json: r.get("entity_json"),
                    value_json: r.get("value_json"),
                    seed: r.get("seed"),
                });
            }
        }
    }

    let range_sql = format!(
        "SELECT i.sequence, i.entity_key, i.entity_json, i.value_json, i.seed \
         FROM user_state_intent i \
         WHERE i.entity_key >= ?1 AND i.entity_key < ?2 \
           AND i.seed = 0{pending_predicate}"
    );
    for (lower, upper) in &range_bounds {
        let fetched = sqlx::query(AssertSqlSafe(range_sql.as_str()))
            .bind(lower)
            .bind(upper)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state migration: load pending chapter intents: {err}"))?;
        for r in fetched {
            let sequence: i64 = r.get("sequence");
            if seen_sequences.insert(sequence) {
                rows.push(IntentRow {
                    sequence,
                    entity_key: r.get("entity_key"),
                    entity_json: r.get("entity_json"),
                    value_json: r.get("value_json"),
                    seed: r.get("seed"),
                });
            }
        }
    }

    rows.sort_by_key(|row| row.sequence);
    Ok(rows)
}

pub async fn remap_pending_user_state_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    source_novel_id: i64,
    target_novel_id: i64,
    chapter_id_map: &HashMap<i64, i64>,
    target_path_sources: &HashMap<String, String>,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<UserStateApplyEffectsDto, String> {
    let mut effects = UserStateApplyEffectsDto::default();
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(effects);
    }
    let Some(source) = work_reference_in_tx(conn, source_novel_id).await? else {
        return Ok(effects);
    };
    let Some(target) = work_reference_in_tx(conn, target_novel_id).await? else {
        return Ok(effects);
    };
    let target_work_json = serde_json::to_value(&target).unwrap();

    let ch_sql = format!("{USER_CHAPTER_SELECT} WHERE c.novel_id IN (?1, ?2)");
    let mut chapters: Vec<UserChapterRow> = sqlx::query(AssertSqlSafe(ch_sql))
        .bind(source_novel_id)
        .bind(target_novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: load chapters: {err}"))?
        .iter()
        .map(map_user_chapter_row)
        .collect();
    populate_user_chapter_composition_ids_in_tx(conn, &mut chapters).await?;

    let by_id: HashMap<i64, &UserChapterRow> = chapters.iter().map(|r| (r.id, r)).collect();
    let by_source_path: HashMap<&str, &UserChapterRow> = chapters
        .iter()
        .filter(|r| r.novel_id == source_novel_id)
        .map(|r| (r.chapter_path.as_str(), r))
        .collect();
    let target_by_path: HashMap<&str, &UserChapterRow> = chapters
        .iter()
        .filter(|r| r.novel_id == target_novel_id)
        .map(|r| (r.chapter_path.as_str(), r))
        .collect();
    let remap_chapter = |path: &str| -> Option<&UserChapterRow> {
        let orig = by_source_path.get(path)?;
        let target_id = chapter_id_map.get(&orig.id)?;
        by_id.get(target_id).copied()
    };

    for (&src_id, &tgt_id) in chapter_id_map {
        let (Some(&from), Some(&to)) = (by_id.get(&src_id), by_id.get(&tgt_id)) else {
            continue;
        };
        let from_key = user_state_entity_key(&json!({
            "kind": "reading",
            "work": chapter_work_json(from),
            "chapter": chapter_reference_json(from),
        }))?;
        let to_key = user_state_entity_key(&json!({
            "kind": "reading",
            "work": chapter_work_json(to),
            "chapter": chapter_reference_json(to),
        }))?;
        sqlx::query(
            "INSERT OR IGNORE INTO user_state_private(entity_key, public_value_json) \
             SELECT ?2, public_value_json FROM user_state_private WHERE entity_key = ?1",
        )
        .bind(&from_key)
        .bind(&to_key)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: copy private marker: {err}"))?;
    }

    let mut target_paths_by_old_path: HashMap<String, String> = HashMap::new();
    for (next_path, old_path) in target_path_sources {
        if let Some(prev_next) = target_paths_by_old_path.get(old_path) {
            if prev_next != next_path {
                return Err("The target chapter mapping is ambiguous.".to_string());
            }
        }
        let Some(&next_ch) = target_by_path.get(next_path.as_str()) else {
            return Err("The approved target chapter mapping no longer exists.".to_string());
        };
        target_paths_by_old_path.insert(old_path.clone(), next_path.clone());
        let old_key = user_state_entity_key(&json!({
            "kind": "reading",
            "work": target_work_json,
            "chapter": { "chapterPath": old_path },
        }))?;
        let new_key = user_state_entity_key(&json!({
            "kind": "reading",
            "work": target_work_json,
            "chapter": chapter_reference_json(next_ch),
        }))?;
        sqlx::query(
            "INSERT OR IGNORE INTO user_state_private(entity_key, public_value_json) \
             SELECT ?2, public_value_json FROM user_state_private WHERE entity_key = ?1",
        )
        .bind(&old_key)
        .bind(&new_key)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: remap target private marker: {err}"))?;
    }

    let source_key = user_state_work_key(&source);
    let target_key = user_state_work_key(&target);

    struct PendingRemap {
        entity: JsonValue,
        value: JsonValue,
        sequence: i64,
        from_source: bool,
        from_keys: Vec<String>,
        rewrite: bool,
    }

    let mut ordered_keys: Vec<String> = Vec::new();
    let mut latest: HashMap<String, PendingRemap> = HashMap::new();

    for row in pending_intents_for_works_in_tx(conn, &[&source_key, &target_key]).await? {
        let (entity, value) = intent_from_row(&row)?;
        let Some(work_obj) = entity.get("work") else {
            continue;
        };
        let work_key = user_state_work_key(&parse_work_reference(work_obj)?);
        if work_key != source_key && work_key != target_key {
            continue;
        }
        let kind = entity["kind"].as_str().unwrap_or("");
        if kind == "composition" {
            continue;
        }
        let from_source = work_key == source_key;
        let mut mapped_ent = entity.clone();
        let mut mapped_val = value.clone();
        let mut did_remap = false;

        if from_source {
            if matches!(kind, "reading" | "bookmark") {
                let ch_path = entity["chapter"]["chapterPath"].as_str().unwrap_or("");
                let Some(ch) = remap_chapter(ch_path) else {
                    continue;
                };
                mapped_ent["work"] = target_work_json.clone();
                mapped_ent["chapter"] = chapter_reference_json(ch);
                did_remap = true;
            } else if kind == "resume" {
                let ch = match value.get("chapter").filter(|v| !v.is_null()) {
                    Some(raw_ch) => {
                        let ch_path = raw_ch["chapterPath"].as_str().unwrap_or("");
                        let Some(found) = remap_chapter(ch_path) else {
                            continue;
                        };
                        Some(found)
                    }
                    None => None,
                };
                mapped_ent = json!({ "kind": "resume", "work": target_work_json });
                mapped_val["chapter"] = match ch {
                    Some(c) => chapter_reference_json(c),
                    None => JsonValue::Null,
                };
                mapped_val["anchor"] = JsonValue::Null;
                did_remap = true;
            } else {
                mapped_ent["work"] = target_work_json.clone();
                did_remap = true;
            }
        } else if matches!(kind, "reading" | "bookmark") {
            let ch_path = entity["chapter"]["chapterPath"].as_str().unwrap_or("");
            if let Some(new_path) = target_paths_by_old_path.get(ch_path) {
                if let Some(&next_ch) = target_by_path.get(new_path.as_str()) {
                    mapped_ent["chapter"] = chapter_reference_json(next_ch);
                    did_remap = true;
                }
            }
        } else if kind == "resume" {
            if let Some(ch_path) = value
                .get("chapter")
                .and_then(|c| c.get("chapterPath"))
                .and_then(JsonValue::as_str)
            {
                if let Some(new_path) = target_paths_by_old_path.get(ch_path) {
                    if let Some(&next_ch) = target_by_path.get(new_path.as_str()) {
                        mapped_val["chapter"] = chapter_reference_json(next_ch);
                        did_remap = true;
                    }
                }
            }
        }

        let key = user_state_entity_key(&mapped_ent)?;
        if !latest.contains_key(&key) {
            ordered_keys.push(key.clone());
        }
        let mut from_keys = latest
            .get(&key)
            .map(|p| p.from_keys.clone())
            .unwrap_or_default();
        if key != row.entity_key && !from_keys.contains(&row.entity_key) {
            from_keys.push(row.entity_key.clone());
        }

        if let Some(prev) = latest.get(&key) {
            if prev.from_source && from_source {
                let mut merged_val = mapped_val.clone();
                if kind == "reading" {
                    let lp = prev.value["progress"].as_f64().unwrap_or(0.0);
                    let rp = mapped_val["progress"].as_f64().unwrap_or(0.0);
                    let lr = prev.value.get("readAt").and_then(JsonValue::as_i64);
                    let rr = mapped_val.get("readAt").and_then(JsonValue::as_i64);
                    let any_positive = lp > 0.0 || lr.is_some() || rp > 0.0 || rr.is_some();
                    merged_val = if any_positive {
                        let max_read = match (lr, rr) {
                            (None, r) => r,
                            (l, None) => l,
                            (Some(l), Some(r)) => Some(l.max(r)),
                        };
                        parse_user_state_value(
                            "reading",
                            &json!({
                                "progress": lp.max(rp),
                                "readAt": max_read,
                            }),
                        )?
                    } else {
                        json!({ "progress": 0, "readAt": null })
                    };
                } else if kind == "bookmark" {
                    let lb = prev.value["bookmarked"].as_bool().unwrap_or(false);
                    let rb = mapped_val["bookmarked"].as_bool().unwrap_or(false);
                    merged_val = json!({ "bookmarked": lb || rb });
                }
                let seq = prev.sequence.max(row.sequence);
                latest.insert(
                    key,
                    PendingRemap {
                        entity: mapped_ent,
                        value: merged_val,
                        sequence: seq,
                        from_source: true,
                        from_keys,
                        rewrite: true,
                    },
                );
                continue;
            }
            if prev.sequence < row.sequence {
                latest.insert(
                    key,
                    PendingRemap {
                        entity: mapped_ent,
                        value: mapped_val,
                        sequence: row.sequence,
                        from_source,
                        from_keys,
                        rewrite: true,
                    },
                );
            } else if let Some(existing) = latest.get_mut(&key) {
                existing.from_keys = from_keys;
            }
        } else {
            latest.insert(
                key,
                PendingRemap {
                    entity: mapped_ent,
                    value: mapped_val,
                    sequence: row.sequence,
                    from_source,
                    from_keys,
                    rewrite: did_remap,
                },
            );
        }
    }

    for key in ordered_keys {
        let Some(item) = latest.remove(&key) else {
            continue;
        };
        let local_rec = ParsedUserStateRecord {
            entity: item.entity.clone(),
            value: item.value.clone(),
            revision: MAX_SAFE_INT_I64,
            operation_id: "local-migration".to_string(),
            updated_at: 0,
            device_id: "local".to_string(),
            device_name: String::new(),
        };
        match materialize_user_state_record_in_tx(root, conn, "", &local_rec, skipped_chapter_ids)
            .await
        {
            Ok(res) => {
                effects.resumes.extend(res.resumes);
                effects.has_finished_reading |= res.has_finished_reading;
            }
            Err(MaterializeError::Deferred(_)) => {}
            Err(MaterializeError::Fatal(err)) => return Err(err),
        }
        if item.entity["kind"].as_str() == Some("reading") {
            let ek = user_state_entity_key(&item.entity)?;
            sqlx::query("DELETE FROM user_state_private WHERE entity_key = ?1")
                .bind(&ek)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state migration: clear private reading: {err}"))?;
        }
        if item.rewrite {
            record_user_state_changes_in_tx(conn, ctx, &[(item.entity, item.value)], false).await?;
        }
        for from_key in item.from_keys {
            sqlx::query("DELETE FROM user_state_intent WHERE entity_key = ?1")
                .bind(&from_key)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db user state migration: delete old intent: {err}"))?;
        }
    }

    Ok(effects)
}

pub async fn transfer_settled_novel_merge_resume_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    source_novel_id: i64,
    target_novel_id: i64,
    chapter_id_map: &HashMap<i64, i64>,
    already_transferred_resume: bool,
) -> Result<Option<UserStateResumeEffectDto>, String> {
    if !has_user_state_schema_in_tx(conn).await? {
        return Ok(None);
    }
    let Some(source) = work_reference_in_tx(conn, source_novel_id).await? else {
        return Ok(None);
    };
    let Some(target) = work_reference_in_tx(conn, target_novel_id).await? else {
        return Ok(None);
    };
    let source_resume_key = user_state_entity_key(&json!({
        "kind": "resume",
        "work": serde_json::to_value(&source).unwrap(),
    }))?;
    let target_resume_key = user_state_entity_key(&json!({
        "kind": "resume",
        "work": serde_json::to_value(&target).unwrap(),
    }))?;

    async fn read_latest_resume(
        conn: &mut SqliteConnection,
        resume_key: &str,
    ) -> Result<Option<JsonValue>, String> {
        let intent_row = sqlx::query(
            "SELECT sequence, entity_key, entity_json, value_json, seed \
             FROM user_state_intent WHERE entity_key = ?1",
        )
        .bind(resume_key)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: lookup latest resume intent: {err}"))?
        .map(|r| IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        });

        if let Some(ref ir) = intent_row {
            if ir.seed == 0 {
                let (_, val) = intent_from_row(ir)?;
                return Ok(Some(val));
            }
        }
        let rec_payloads: Vec<String> = sqlx::query_scalar(
            "SELECT payload FROM user_state_record WHERE entity_key = ?1 ORDER BY revision DESC",
        )
        .bind(resume_key)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: lookup latest resume record: {err}"))?;
        for payload in rec_payloads {
            let raw: JsonValue = serde_json::from_str(&payload)
                .map_err(|err| format!("db user state migration: parse resume record: {err}"))?;
            let parsed = parse_user_state_record(&raw)?;
            if parsed.entity["kind"].as_str() == Some("resume") {
                return Ok(Some(parsed.value));
            }
        }
        if let Some(ref ir) = intent_row {
            let (_, val) = intent_from_row(ir)?;
            return Ok(Some(val));
        }
        Ok(None)
    }

    let source_resume = read_latest_resume(conn, &source_resume_key).await?;
    let has_source_chapter = source_resume
        .as_ref()
        .and_then(|v| v.get("chapter"))
        .is_some_and(|c| !c.is_null());
    if has_source_chapter {
        record_resume_cleared_in_tx(conn, ctx, Some(&[source_novel_id])).await?;
    }
    if already_transferred_resume || !has_source_chapter {
        return Ok(None);
    }
    let source_resume = source_resume.unwrap();
    let src_ch_path = source_resume["chapter"]["chapterPath"]
        .as_str()
        .unwrap_or("");
    let src_entry_id = source_resume["chapter"]
        .get("compositionEntryId")
        .and_then(JsonValue::as_str);

    let ch_sql = format!("{USER_CHAPTER_SELECT} WHERE c.novel_id IN (?1, ?2)");
    let mut chapters: Vec<UserChapterRow> = sqlx::query(AssertSqlSafe(ch_sql))
        .bind(source_novel_id)
        .bind(target_novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: load merge chapters: {err}"))?
        .iter()
        .map(map_user_chapter_row)
        .collect();
    populate_user_chapter_composition_ids_in_tx(conn, &mut chapters).await?;

    let by_id: HashMap<i64, &UserChapterRow> = chapters.iter().map(|r| (r.id, r)).collect();
    let Some(original) = chapters
        .iter()
        .find(|r| r.novel_id == source_novel_id && r.chapter_path == src_ch_path)
    else {
        return Ok(None);
    };
    let orig_ref = chapter_reference_json(original);
    let orig_entry_id = orig_ref
        .get("compositionEntryId")
        .and_then(JsonValue::as_str);
    if orig_entry_id.is_some() && orig_entry_id != src_entry_id {
        return Ok(None);
    }
    let Some(mapped_id) = chapter_id_map.get(&original.id) else {
        return Ok(None);
    };
    let Some(&mapped) = by_id.get(mapped_id) else {
        return Ok(None);
    };

    let opened_at = source_resume.get("openedAt").and_then(JsonValue::as_i64);
    let next_val = json!({
        "chapter": chapter_reference_json(mapped),
        "anchor": null,
        "openedAt": opened_at,
    });
    if let Some(target_resume) = read_latest_resume(conn, &target_resume_key).await? {
        if target_resume.get("chapter").is_some_and(|c| !c.is_null())
            && merge_user_state_resume(&target_resume, &next_val)? != next_val
        {
            return Ok(None);
        }
    }

    record_user_state_changes_in_tx(
        conn,
        ctx,
        &[(
            json!({ "kind": "resume", "work": serde_json::to_value(&target).unwrap() }),
            next_val,
        )],
        false,
    )
    .await?;
    Ok(Some(UserStateResumeEffectDto {
        novel_id: target_novel_id,
        chapter_id: Some(mapped.id),
        anchor: None,
        opened_at,
    }))
}

pub async fn remap_unattempted_chapter_paths_in_tx(
    conn: &mut SqliteConnection,
    before: &[UserStateChapterPathBefore],
) -> Result<(), String> {
    if before.is_empty() || !has_user_state_schema_in_tx(conn).await? {
        return Ok(());
    }
    let previous: HashMap<i64, &UserStateChapterPathBefore> =
        before.iter().map(|r| (r.id, r)).collect();
    let ids: Vec<i64> = before.iter().map(|r| r.id).collect();
    let rows = load_user_chapter_rows_by_ids_in_tx(conn, &ids).await?;

    let old_paths: Vec<String> = before
        .iter()
        .map(|r| r.path.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let mut intents: Vec<IntentRow> = Vec::new();
    for chunk in old_paths.chunks(400) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{i}")).collect();
        let in_clause = placeholders.join(",");
        let sql = format!(
            "SELECT sequence, entity_key, entity_json, value_json, seed \
             FROM user_state_intent \
             WHERE json_extract(entity_json, '$.chapter.chapterPath') IN ({in_clause}) \
                OR json_extract(value_json, '$.chapter.chapterPath') IN ({in_clause})"
        );
        let mut q = sqlx::query(AssertSqlSafe(sql));
        for p in chunk {
            q = q.bind(p);
        }
        let fetched = q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state migration: load path-matched intents: {err}"))?;
        intents.extend(fetched.into_iter().map(|r| IntentRow {
            sequence: r.get("sequence"),
            entity_key: r.get("entity_key"),
            entity_json: r.get("entity_json"),
            value_json: r.get("value_json"),
            seed: r.get("seed"),
        }));
    }

    for chapter in rows {
        let Some(prev) = previous.get(&chapter.id) else {
            continue;
        };
        let old_path = &prev.path;
        if old_path == &chapter.chapter_path {
            continue;
        }
        let work_json = chapter_work_json(&chapter);
        let work_dto = parse_work_reference(&work_json)?;
        let work_key = user_state_work_key(&work_dto);
        let old_reading_key = user_state_entity_key(&json!({
            "kind": "reading",
            "work": work_json,
            "chapter": { "chapterPath": old_path },
        }))?;
        let new_reading_key = user_state_entity_key(&json!({
            "kind": "reading",
            "work": work_json,
            "chapter": chapter_reference_json(&chapter),
        }))?;
        sqlx::query(
            "INSERT OR IGNORE INTO user_state_private(entity_key, public_value_json) \
             SELECT ?2, public_value_json FROM user_state_private WHERE entity_key = ?1",
        )
        .bind(&old_reading_key)
        .bind(&new_reading_key)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db user state migration: copy chapter private marker: {err}"))?;

        for row in &intents {
            let (ent, val) = intent_from_row(row)?;
            let Some(ent_work) = ent.get("work") else {
                continue;
            };
            if user_state_work_key(&parse_work_reference(ent_work)?) != work_key {
                continue;
            }
            let kind = ent["kind"].as_str().unwrap_or("");
            let mut next_pair: Option<(JsonValue, JsonValue)> = None;
            if matches!(kind, "reading" | "bookmark")
                && ent["chapter"]["chapterPath"].as_str() == Some(old_path.as_str())
            {
                let mut next_ent = ent.clone();
                next_ent["chapter"] = chapter_reference_json(&chapter);
                next_pair = Some((next_ent, val));
            } else if kind == "resume"
                && val
                    .get("chapter")
                    .and_then(|c| c.get("chapterPath"))
                    .and_then(JsonValue::as_str)
                    == Some(old_path.as_str())
            {
                let mut next_val = val.clone();
                next_val["chapter"] = chapter_reference_json(&chapter);
                next_pair = Some((ent, next_val));
            }
            let Some((next_ent, next_val)) = next_pair else {
                continue;
            };

            let attempt: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM user_state_operation \
                 WHERE entity_key = ?1 AND intent_sequence = ?2 \
                 UNION ALL \
                 SELECT 1 FROM user_state_progress \
                 WHERE entity_key = ?1 AND acknowledged_sequence >= ?2 \
                 LIMIT 1",
            )
            .bind(&row.entity_key)
            .bind(row.sequence)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db user state migration: check operation attempt: {err}"))?;
            if attempt.is_some() {
                continue;
            }

            let next_key = user_state_entity_key(&next_ent)?;
            let ent_str = serde_json::to_string(&next_ent).unwrap();
            let val_str = serde_json::to_string(&next_val).unwrap();
            sqlx::query(
                "UPDATE user_state_intent SET entity_json = ?2, value_json = ?3 \
                 WHERE entity_key = ?1",
            )
            .bind(&row.entity_key)
            .bind(&ent_str)
            .bind(&val_str)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db user state migration: update intent json: {err}"))?;

            if next_key != row.entity_key {
                let collision_seq: Option<i64> = sqlx::query_scalar(
                    "SELECT sequence FROM user_state_intent WHERE entity_key = ?1",
                )
                .bind(&next_key)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db user state migration: check key collision: {err}"))?;
                if let Some(col_seq) = collision_seq {
                    if col_seq >= row.sequence {
                        sqlx::query("DELETE FROM user_state_intent WHERE entity_key = ?1")
                            .bind(&row.entity_key)
                            .execute(&mut *conn)
                            .await
                            .map_err(|err| {
                                format!("db user state migration: drop superseded intent: {err}")
                            })?;
                        continue;
                    }
                    sqlx::query("DELETE FROM user_state_intent WHERE entity_key = ?1")
                        .bind(&next_key)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| {
                            format!("db user state migration: drop older colliding intent: {err}")
                        })?;
                }
                sqlx::query("UPDATE user_state_intent SET entity_key = ?2 WHERE entity_key = ?1")
                    .bind(&row.entity_key)
                    .bind(&next_key)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| {
                        format!("db user state migration: rename intent entity_key: {err}")
                    })?;
                sqlx::query(
                    "UPDATE OR REPLACE user_state_progress \
                     SET entity_key = ?2, base_revision = 0, acknowledged_sequence = 0 \
                     WHERE entity_key = ?1",
                )
                .bind(&row.entity_key)
                .bind(&next_key)
                .execute(&mut *conn)
                .await
                .map_err(|err| {
                    format!("db user state migration: rename progress entity_key: {err}")
                })?;
            }
        }
    }
    Ok(())
}
