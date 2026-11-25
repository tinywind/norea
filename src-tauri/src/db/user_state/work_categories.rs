use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};

use super::core::{has_user_state_schema_in_tx, resolve_category_alias_in_tx, workspace_rows_in_tx};
use super::types::user_state_work_key_parts;

const LOCAL_PLUGIN_ID: &str = "local";
const MEMBERSHIP_KEY_FIRST: &str = r#"["membership","#;
const MEMBERSHIP_KEY_AFTER: &str = r#"["membership"-"#;
pub const MAX_WORK_CATEGORY_LOOKUPS: usize = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCategoryLookupDto {
    pub plugin_id: String,
    pub novel_id: String,
    pub novel_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkCategoriesDto {
    pub plugin_id: String,
    pub novel_path: String,
    pub categories: Vec<String>,
}

struct SharedCategory {
    name: String,
    sort: i64,
    deleted: bool,
    deletion_revision: i64,
}

type MembershipEntry = (String, bool, Option<i64>);

struct LocalWorkCategories {
    categories: Vec<String>,
    effective_novel_id: String,
}

/// The user's categories for works identified by their portable identity, whether or not the work is
/// in the library. A work with categories on this device answers from them. Any other work answers
/// from the shared state of `server_url`, so a work that is not installed here, or was installed
/// again after its files were removed, still shows the categories the user set.
pub async fn list_work_categories_in_conn(
    conn: &mut SqliteConnection,
    server_url: &str,
    works: &[WorkCategoryLookupDto],
) -> Result<Vec<WorkCategoriesDto>, String> {
    if works.len() > MAX_WORK_CATEGORY_LOOKUPS {
        return Err(format!(
            "db user state: at most {MAX_WORK_CATEGORY_LOOKUPS} works can be looked up at once"
        ));
    }
    let target = server_url.trim().trim_end_matches('/');
    let namespace = if !target.is_empty() && has_user_state_schema_in_tx(conn).await? {
        workspace_rows_in_tx(conn)
            .await?
            .into_iter()
            .find(|row| row.server_url.trim_end_matches('/') == target)
            .map(|row| row.namespace)
    } else {
        None
    };

    let mut local_results = Vec::with_capacity(works.len());
    for work in works {
        local_results.push(local_categories_in_conn(conn, work).await?);
    }

    let path_only_memberships = match namespace.as_deref() {
        Some(namespace) => {
            let path_only_targets: Vec<(&str, &str)> = works
                .iter()
                .zip(local_results.iter())
                .filter(|(work, local)| {
                    local.categories.is_empty()
                        && work.plugin_id != LOCAL_PLUGIN_ID
                        && local.effective_novel_id.is_empty()
                })
                .map(|(work, _)| (work.plugin_id.as_str(), work.novel_path.as_str()))
                .collect();
            if path_only_targets.is_empty() {
                HashMap::new()
            } else {
                load_path_only_shared_memberships_in_conn(conn, namespace, &path_only_targets)
                    .await?
            }
        }
        None => HashMap::new(),
    };

    let mut shared_categories: HashMap<String, Option<SharedCategory>> = HashMap::new();
    let mut result = Vec::with_capacity(works.len());
    for (work, local) in works.iter().zip(local_results) {
        let categories = match namespace.as_deref() {
            Some(namespace) if local.categories.is_empty() && work.plugin_id != LOCAL_PLUGIN_ID => {
                if local.effective_novel_id.is_empty() {
                    let key = (work.plugin_id.clone(), work.novel_path.clone());
                    let memberships = path_only_memberships.get(&key).map(Vec::as_slice).unwrap_or(&[]);
                    resolve_membership_categories_in_conn(
                        conn,
                        namespace,
                        memberships,
                        &mut shared_categories,
                    )
                    .await?
                } else {
                    let lookup = WorkCategoryLookupDto {
                        plugin_id: work.plugin_id.clone(),
                        novel_id: local.effective_novel_id,
                        novel_path: work.novel_path.clone(),
                    };
                    shared_categories_in_conn(conn, namespace, &lookup, &mut shared_categories)
                        .await?
                }
            }
            _ => local.categories,
        };
        result.push(WorkCategoriesDto {
            plugin_id: work.plugin_id.clone(),
            novel_path: work.novel_path.clone(),
            categories,
        });
    }
    Ok(result)
}

async fn local_categories_in_conn(
    conn: &mut SqliteConnection,
    work: &WorkCategoryLookupDto,
) -> Result<LocalWorkCategories, String> {
    let by_source_id: Option<(i64, Option<String>)> = if work.novel_id.is_empty() {
        None
    } else {
        sqlx::query_as(
            "SELECT id, source_novel_id FROM novel \
             WHERE plugin_id = ?1 AND lower(source_novel_id) = lower(?2)",
        )
        .bind(&work.plugin_id)
        .bind(&work.novel_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: find work by source id: {err}"))?
    };
    let found = match by_source_id {
        Some(row) => Some(row),
        None => sqlx::query_as(
            "SELECT id, source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(&work.plugin_id)
        .bind(&work.novel_path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: find work by path: {err}"))?,
    };
    let Some((novel_id, local_source_novel_id)) = found else {
        return Ok(LocalWorkCategories {
            categories: Vec::new(),
            effective_novel_id: work.novel_id.clone(),
        });
    };
    let effective_novel_id = if !work.novel_id.is_empty() {
        work.novel_id.clone()
    } else {
        local_source_novel_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT c.name FROM novel_category nc \
         JOIN category c ON c.id = nc.category_id AND c.is_system = 0 \
         WHERE nc.novel_id = ?1 ORDER BY c.sort, c.name",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: list local work categories: {err}"))?;
    Ok(LocalWorkCategories {
        categories: names,
        effective_novel_id,
    })
}

/// Resolves shared/pending membership rows for source-search lookups that only know `(plugin_id, novel_path)`
/// because search results omit `sourceNovelId` while synced records are usually keyed by it.
async fn load_path_only_shared_memberships_in_conn(
    conn: &mut SqliteConnection,
    namespace: &str,
    targets: &[(&str, &str)],
) -> Result<HashMap<(String, String), Vec<MembershipEntry>>, String> {
    let mut unique = HashSet::with_capacity(targets.len());
    let mut encoded_targets = Vec::with_capacity(targets.len());
    for &(plugin_id, novel_path) in targets {
        if unique.insert((plugin_id, novel_path)) {
            encoded_targets.push(json!({ "pluginId": plugin_id, "novelPath": novel_path }));
        }
    }
    let targets_json = serde_json::to_string(&encoded_targets)
        .map_err(|err| format!("db user state: encode work path targets: {err}"))?;

    let received = sqlx::query(
        "SELECT revision, \
                json_extract(payload, '$.entity.work.pluginId') AS plugin_id, \
                json_extract(payload, '$.entity.work.novelPath') AS novel_path, \
                json_extract(payload, '$.entity.categoryId') AS category_id, \
                json_extract(payload, '$.value.included') AS included \
         FROM user_state_record \
         WHERE namespace = ?1 \
           AND entity_key >= ?2 AND entity_key < ?3 \
           AND (json_extract(payload, '$.entity.work.pluginId'), \
                json_extract(payload, '$.entity.work.novelPath')) IN ( \
               SELECT json_extract(t.value, '$.pluginId'), json_extract(t.value, '$.novelPath') \
               FROM json_each(?4) t \
           ) \
         ORDER BY revision ASC",
    )
    .bind(namespace)
    .bind(MEMBERSHIP_KEY_FIRST)
    .bind(MEMBERSHIP_KEY_AFTER)
    .bind(&targets_json)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: list path-matched shared work memberships: {err}"))?;

    let pending = sqlx::query(
        "SELECT NULL AS revision, \
                json_extract(i.entity_json, '$.work.pluginId') AS plugin_id, \
                json_extract(i.entity_json, '$.work.novelPath') AS novel_path, \
                json_extract(i.entity_json, '$.categoryId') AS category_id, \
                json_extract(i.value_json, '$.included') AS included \
         FROM user_state_intent i \
         LEFT JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
         WHERE i.entity_key >= ?2 AND i.entity_key < ?3 \
           AND (p.entity_key IS NULL OR i.sequence > p.acknowledged_sequence) \
           AND (json_extract(i.entity_json, '$.work.pluginId'), \
                json_extract(i.entity_json, '$.work.novelPath')) IN ( \
               SELECT json_extract(t.value, '$.pluginId'), json_extract(t.value, '$.novelPath') \
               FROM json_each(?4) t \
           ) \
         ORDER BY i.sequence ASC",
    )
    .bind(namespace)
    .bind(MEMBERSHIP_KEY_FIRST)
    .bind(MEMBERSHIP_KEY_AFTER)
    .bind(&targets_json)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db user state: list path-matched pending work memberships: {err}"))?;

    let mut by_work: HashMap<(String, String), Vec<MembershipEntry>> = HashMap::new();
    for row in received.into_iter().chain(pending) {
        let Some(plugin_id) = row.get::<Option<String>, _>("plugin_id") else {
            continue;
        };
        let Some(novel_path) = row.get::<Option<String>, _>("novel_path") else {
            continue;
        };
        let Some(category_id) = row.get::<Option<String>, _>("category_id") else {
            continue;
        };
        let category_id = resolve_category_alias_in_tx(conn, namespace, &category_id).await?;
        let included = row.get::<Option<i64>, _>("included") == Some(1);
        let revision: Option<i64> = row.get("revision");
        let entries = by_work.entry((plugin_id, novel_path)).or_default();
        entries.retain(|(id, _, _)| id != &category_id);
        entries.push((category_id, included, revision));
    }
    Ok(by_work)
}

async fn shared_categories_in_conn(
    conn: &mut SqliteConnection,
    namespace: &str,
    work: &WorkCategoryLookupDto,
    shared_categories: &mut HashMap<String, Option<SharedCategory>>,
) -> Result<Vec<String>, String> {
    // Received records are keyed by the source id when the sender knew it, and by the path otherwise.
    let mut work_keys = vec![user_state_work_key_parts(&work.plugin_id, None, &work.novel_path)];
    if !work.novel_id.is_empty() {
        work_keys.insert(
            0,
            user_state_work_key_parts(&work.plugin_id, Some(&work.novel_id), &work.novel_path),
        );
    }

    // Per category: whether the work is in it, and the received revision (none for an unsent edit).
    let mut memberships: Vec<MembershipEntry> = Vec::new();
    for work_key in &work_keys {
        // Every membership key of a work is `["membership","<work key>","<category id>"]`.
        let first = serde_json::to_string(&("membership", work_key))
            .map_err(|err| format!("db user state: encode membership key: {err}"))?;
        let first = format!("{},", first.trim_end_matches(']'));
        let after = format!("{}-", first.trim_end_matches(','));
        let received = sqlx::query(
            "SELECT revision, json_extract(payload, '$.entity.categoryId') AS category_id, \
                    json_extract(payload, '$.value.included') AS included \
             FROM user_state_record \
             WHERE namespace = ?1 AND entity_key >= ?2 AND entity_key < ?3",
        )
        .bind(namespace)
        .bind(&first)
        .bind(&after)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: list shared work memberships: {err}"))?;
        // An unsent local edit is newer than the received record.
        let pending = sqlx::query(
            "SELECT NULL AS revision, json_extract(i.entity_json, '$.categoryId') AS category_id, \
                    json_extract(i.value_json, '$.included') AS included \
             FROM user_state_intent i \
             LEFT JOIN user_state_progress p ON p.entity_key = i.entity_key AND p.namespace = ?1 \
             WHERE i.entity_key >= ?2 AND i.entity_key < ?3 \
               AND (p.entity_key IS NULL OR i.sequence > p.acknowledged_sequence)",
        )
        .bind(namespace)
        .bind(&first)
        .bind(&after)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: list pending work memberships: {err}"))?;
        for row in received.into_iter().chain(pending) {
            let Some(category_id) = row.get::<Option<String>, _>("category_id") else {
                continue;
            };
            let category_id = resolve_category_alias_in_tx(conn, namespace, &category_id).await?;
            let included = row.get::<Option<i64>, _>("included") == Some(1);
            let revision: Option<i64> = row.get("revision");
            memberships.retain(|(id, _, _)| id != &category_id);
            memberships.push((category_id, included, revision));
        }
    }

    resolve_membership_categories_in_conn(conn, namespace, &memberships, shared_categories).await
}

async fn resolve_membership_categories_in_conn(
    conn: &mut SqliteConnection,
    namespace: &str,
    memberships: &[MembershipEntry],
    shared_categories: &mut HashMap<String, Option<SharedCategory>>,
) -> Result<Vec<String>, String> {
    let mut categories: Vec<(i64, String)> = Vec::new();
    for (category_id, included, revision) in memberships {
        if !included {
            continue;
        }
        if !shared_categories.contains_key(category_id) {
            let loaded = load_shared_category_in_conn(conn, namespace, category_id).await?;
            shared_categories.insert(category_id.clone(), loaded);
        }
        let Some(category) = shared_categories[category_id].as_ref() else {
            continue;
        };
        // A received membership set before its category was deleted does not outlive the deletion.
        if category.deleted || revision.is_some_and(|revision| category.deletion_revision >= revision) {
            continue;
        }
        if !categories.iter().any(|(_, name)| name == &category.name) {
            categories.push((category.sort, category.name.clone()));
        }
    }
    categories.sort();
    Ok(categories.into_iter().map(|(_, name)| name).collect())
}

async fn load_shared_category_in_conn(
    conn: &mut SqliteConnection,
    namespace: &str,
    category_id: &str,
) -> Result<Option<SharedCategory>, String> {
    let category_key = serde_json::to_string(&("category", category_id))
        .map_err(|err| format!("db user state: encode category key: {err}"))?;
    let record = sqlx::query(
        "SELECT json_extract(payload, '$.value') AS value, deletion_revision \
         FROM user_state_record WHERE namespace = ?1 AND entity_key = ?2",
    )
    .bind(namespace)
    .bind(&category_key)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: read shared category: {err}"))?;
    if let Some(record) = record {
        let value: String = record.get("value");
        let value: JsonValue = serde_json::from_str(&value)
            .map_err(|err| format!("db user state: parse shared category: {err}"))?;
        return Ok(value["name"].as_str().map(|name| SharedCategory {
            name: name.to_string(),
            sort: value["sort"].as_i64().unwrap_or(0),
            deleted: value["deleted"].as_bool().unwrap_or(false),
            deletion_revision: record.get("deletion_revision"),
        }));
    }
    // A category created here and not yet sent has no received record.
    let local = sqlx::query(
        "SELECT c.name, c.sort FROM user_state_category m \
         JOIN category c ON c.id = m.local_id AND c.is_system = 0 WHERE m.category_id = ?1",
    )
    .bind(category_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: read local shared category: {err}"))?;
    Ok(local.map(|row| SharedCategory {
        name: row.get("name"),
        sort: row.get("sort"),
        deleted: false,
        deletion_revision: 0,
    }))
}
