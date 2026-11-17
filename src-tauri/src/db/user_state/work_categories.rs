use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Row, SqliteConnection};

use super::core::{has_user_state_schema_in_tx, resolve_category_alias_in_tx, workspace_rows_in_tx};
use super::types::user_state_work_key_parts;

const LOCAL_PLUGIN_ID: &str = "local";
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
    let namespace = if has_user_state_schema_in_tx(conn).await? {
        let target = server_url.trim_end_matches('/');
        workspace_rows_in_tx(conn)
            .await?
            .into_iter()
            .find(|row| row.server_url.trim_end_matches('/') == target)
            .map(|row| row.namespace)
    } else {
        None
    };
    let mut shared_categories: HashMap<String, Option<SharedCategory>> = HashMap::new();
    let mut result = Vec::with_capacity(works.len());
    for work in works {
        let local = local_categories_in_conn(conn, work).await?;
        let categories = match namespace.as_deref() {
            Some(namespace) if local.is_empty() && work.plugin_id != LOCAL_PLUGIN_ID => {
                shared_categories_in_conn(conn, namespace, work, &mut shared_categories).await?
            }
            _ => local,
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
) -> Result<Vec<String>, String> {
    let by_source_id: Option<i64> = if work.novel_id.is_empty() {
        None
    } else {
        sqlx::query_scalar(
            "SELECT id FROM novel \
             WHERE plugin_id = ?1 AND lower(source_novel_id) = lower(?2)",
        )
        .bind(&work.plugin_id)
        .bind(&work.novel_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: find work by source id: {err}"))?
    };
    let novel_id = match by_source_id {
        Some(id) => Some(id),
        None => sqlx::query_scalar("SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2")
        .bind(&work.plugin_id)
        .bind(&work.novel_path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db user state: find work by path: {err}"))?,
    };
    let Some(novel_id) = novel_id else {
        return Ok(Vec::new());
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
    Ok(names)
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
    let mut memberships: Vec<(String, bool, Option<i64>)> = Vec::new();
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

    let mut categories: Vec<(i64, String)> = Vec::new();
    for (category_id, included, revision) in memberships {
        if !included {
            continue;
        }
        if !shared_categories.contains_key(&category_id) {
            let loaded = load_shared_category_in_conn(conn, namespace, &category_id).await?;
            shared_categories.insert(category_id.clone(), loaded);
        }
        let Some(category) = shared_categories[&category_id].as_ref() else {
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
