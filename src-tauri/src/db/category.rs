use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;

use super::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use super::user_state::core::{
    has_user_state_schema_in_tx, record_category_in_tx, record_chapter_unread_flags_in_tx,
    record_library_in_tx, record_membership_in_tx, record_novel_chapters_in_tx,
    record_resume_cleared_in_tx, stable_category_id_in_tx, RecordCategoryOptions,
};
use super::{DbMutationEffects, DbMutationEnvelope, ReadMode};

pub const UNCATEGORIZED_CATEGORY_ID: i64 = -1;
const CATEGORY_BUSY_RETRIES: u32 = 3;
const CATEGORY_MEMBERSHIP_CHUNK: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCategoryDto {
    pub id: i64,
    pub name: String,
    pub sort: i64,
    pub is_system: bool,
    pub novel_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCategoryCountsDto {
    pub total: i64,
    pub uncategorized: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertCategoryInputDto {
    pub name: String,
    #[serde(default)]
    pub sort: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCategoryInputDto {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryNovelCountDto {
    pub category_id: i64,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResultDto {
    pub rows_affected: u64,
}

fn category_tx_options() -> TxOptions {
    TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: CATEGORY_BUSY_RETRIES,
        publish_metadata: false,
        metadata_root: MetadataRoot::None,
    }
}

fn normalize_category_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Category name is required.".to_string());
    }
    Ok(trimmed.to_string())
}

fn assert_manual_category_id(id: i64) -> Result<(), String> {
    if id <= 0 {
        return Err("Select a manual category.".to_string());
    }
    Ok(())
}

fn dedupe_positive_ids(ids: &[i64]) -> Vec<i64> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for &id in ids {
        if id > 0 && seen.insert(id) {
            out.push(id);
        }
    }
    out
}

pub async fn list_categories_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<LibraryCategoryDto>, String> {
    let rows = sqlx::query(
        "SELECT \
           c.id, \
           c.name, \
           c.sort, \
           c.is_system AS is_system, \
           COUNT(DISTINCT n.id) AS novel_count \
         FROM category c \
         LEFT JOIN novel_category nc ON nc.category_id = c.id \
         LEFT JOIN novel n ON n.id = nc.novel_id AND n.in_library = 1 \
         GROUP BY c.id, c.name, c.sort, c.is_system \
         ORDER BY c.sort, c.name",
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db category: list categories: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|row| LibraryCategoryDto {
            id: row.get("id"),
            name: row.get("name"),
            sort: row.get("sort"),
            is_system: row.get::<i64, _>("is_system") != 0,
            novel_count: row.get("novel_count"),
        })
        .collect())
}

pub async fn get_library_category_counts_in_conn(
    conn: &mut SqliteConnection,
) -> Result<LibraryCategoryCountsDto, String> {
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel WHERE in_library = 1")
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| format!("db category: count library novels: {err}"))?;
    let uncategorized: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) \
         FROM novel n \
         WHERE n.in_library = 1 \
           AND NOT EXISTS ( \
             SELECT 1 FROM novel_category nc WHERE nc.novel_id = n.id \
           )",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db category: count uncategorized novels: {err}"))?;

    Ok(LibraryCategoryCountsDto {
        total,
        uncategorized,
    })
}

pub async fn insert_category_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    input: &InsertCategoryInputDto,
) -> Result<(), String> {
    let name = normalize_category_name(&input.name)?;
    sqlx::query(
        "INSERT INTO category (name, sort, is_system) \
         VALUES ( \
           ?1, \
           COALESCE(?2, (SELECT COALESCE(MAX(sort), -1) + 1 FROM category)), \
           0 \
         )",
    )
    .bind(&name)
    .bind(input.sort)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db category: insert category: {err}"))?;

    if has_user_state_schema_in_tx(conn).await? {
        let created_id: Option<i64> =
            sqlx::query_scalar("SELECT id FROM category WHERE name = ?1")
                .bind(&name)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db category: lookup inserted category: {err}"))?;
        if let Some(id) = created_id {
            record_category_in_tx(
                conn,
                ctx,
                id,
                RecordCategoryOptions {
                    create: true,
                    ..RecordCategoryOptions::default()
                },
            )
            .await?;
        }
    }
    Ok(())
}

pub async fn update_category_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    id: i64,
    input: &UpdateCategoryInputDto,
) -> Result<(), String> {
    assert_manual_category_id(id)?;
    let name = normalize_category_name(&input.name)?;
    stable_category_id_in_tx(conn, id, false).await?;
    sqlx::query("UPDATE category SET name = ?2 WHERE id = ?1 AND is_system = 0")
        .bind(id)
        .bind(&name)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db category: update category: {err}"))?;
    record_category_in_tx(conn, ctx, id, RecordCategoryOptions::default()).await
}

pub async fn delete_category_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    id: i64,
) -> Result<(), String> {
    assert_manual_category_id(id)?;
    record_category_in_tx(
        conn,
        ctx,
        id,
        RecordCategoryOptions {
            deleted: true,
            ..RecordCategoryOptions::default()
        },
    )
    .await?;
    if has_user_state_schema_in_tx(conn).await? {
        let members: Vec<i64> =
            sqlx::query_scalar("SELECT novel_id FROM novel_category WHERE category_id = ?1")
                .bind(id)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db category: load category members: {err}"))?;
        record_membership_in_tx(conn, ctx, &members, id, false, false).await?;
    }
    sqlx::query("DELETE FROM category WHERE id = ?1 AND is_system = 0")
        .bind(id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db category: delete category: {err}"))?;
    Ok(())
}

pub async fn add_novels_to_category_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: &[i64],
    category_id: i64,
) -> Result<(), String> {
    assert_manual_category_id(category_id)?;
    let unique_novel_ids = dedupe_positive_ids(novel_ids);
    if unique_novel_ids.is_empty() {
        return Ok(());
    }
    for chunk in unique_novel_ids.chunks(400) {
        let values_sql: Vec<String> = (0..chunk.len())
            .map(|idx| format!("(?{}, ?{})", idx * 2 + 1, idx * 2 + 2))
            .collect();
        let sql = format!(
            "INSERT OR IGNORE INTO novel_category (novel_id, category_id) VALUES {}",
            values_sql.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for &novel_id in chunk {
            q = q.bind(novel_id).bind(category_id);
        }
        q.execute(&mut *conn)
            .await
            .map_err(|err| format!("db category: add novels to category: {err}"))?;
    }
    record_membership_in_tx(conn, ctx, &unique_novel_ids, category_id, true, false).await
}

pub async fn remove_novels_from_category_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_ids: &[i64],
    category_id: i64,
) -> Result<(), String> {
    assert_manual_category_id(category_id)?;
    let unique_novel_ids = dedupe_positive_ids(novel_ids);
    if unique_novel_ids.is_empty() {
        return Ok(());
    }
    for chunk in unique_novel_ids.chunks(400) {
        let placeholders: Vec<String> = (0..chunk.len()).map(|idx| format!("?{}", idx + 2)).collect();
        let sql = format!(
            "DELETE FROM novel_category WHERE category_id = ?1 AND novel_id IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql).bind(category_id);
        for &novel_id in chunk {
            q = q.bind(novel_id);
        }
        q.execute(&mut *conn)
            .await
            .map_err(|err| format!("db category: remove novels from category: {err}"))?;
    }
    record_membership_in_tx(conn, ctx, &unique_novel_ids, category_id, false, false).await
}

pub async fn count_novels_by_category_in_conn(
    conn: &mut SqliteConnection,
    novel_ids: &[i64],
) -> Result<Vec<CategoryNovelCountDto>, String> {
    let unique_novel_ids = dedupe_positive_ids(novel_ids);
    if unique_novel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut totals: BTreeMap<i64, i64> = BTreeMap::new();
    for chunk in unique_novel_ids.chunks(CATEGORY_MEMBERSHIP_CHUNK) {
        let placeholders: Vec<String> = (1..=chunk.len()).map(|idx| format!("?{idx}")).collect();
        let sql = format!(
            "SELECT nc.category_id AS category_id, COUNT(*) AS count \
             FROM novel_category nc \
             JOIN category c ON c.id = nc.category_id \
             WHERE nc.novel_id IN ({}) \
             GROUP BY nc.category_id",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for &id in chunk {
            q = q.bind(id);
        }
        let rows = q
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db category: count novels by category: {err}"))?;
        for row in rows {
            let category_id: i64 = row.get("category_id");
            let count: i64 = row.get("count");
            *totals.entry(category_id).or_insert(0) += count;
        }
    }
    Ok(totals
        .into_iter()
        .map(|(category_id, count)| CategoryNovelCountDto { category_id, count })
        .collect())
}

pub async fn get_novel_category_ids_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Vec<i64>, String> {
    sqlx::query_scalar(
        "SELECT nc.category_id \
         FROM novel_category nc \
         JOIN category c ON c.id = nc.category_id AND c.is_system = 0 \
         WHERE nc.novel_id = ?1 \
         ORDER BY c.sort, c.name",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db category: get novel category ids: {err}"))
}

pub async fn set_novel_categories_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    category_ids: &[i64],
) -> Result<(), String> {
    if novel_id <= 0 {
        return Err("novel-category:work-not-found".to_string());
    }
    let mut unique_category_ids = Vec::new();
    let mut seen_categories = HashSet::new();
    for &cat_id in category_ids {
        assert_manual_category_id(cat_id)?;
        if seen_categories.insert(cat_id) {
            unique_category_ids.push(cat_id);
        }
    }

    let work_exists: Option<i64> =
        sqlx::query_scalar("SELECT id FROM novel WHERE id = ?1 AND in_library = 1")
            .bind(novel_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db category: check library work: {err}"))?;
    if work_exists.is_none() {
        return Err("novel-category:work-not-found".to_string());
    }

    if !unique_category_ids.is_empty() {
        let placeholders: Vec<String> = (1..=unique_category_ids.len())
            .map(|idx| format!("?{idx}"))
            .collect();
        let sql = format!(
            "SELECT COUNT(*) FROM category WHERE is_system = 0 AND id IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query_scalar::<_, i64>(&sql);
        for &cat_id in &unique_category_ids {
            q = q.bind(cat_id);
        }
        let valid_count = q
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("db category: check selected categories: {err}"))?;
        if valid_count as usize != unique_category_ids.len() {
            return Err("novel-category:category-not-found".to_string());
        }
    }

    let current_rows: Vec<i64> = sqlx::query_scalar(
        "SELECT nc.category_id \
         FROM novel_category nc \
         JOIN category c ON c.id = nc.category_id \
         WHERE nc.novel_id = ?1 AND c.is_system = 0",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db category: load current novel categories: {err}"))?;

    let current_set: HashSet<i64> = current_rows.iter().copied().collect();
    let target_set: HashSet<i64> = unique_category_ids.iter().copied().collect();
    let removed: Vec<i64> = current_rows
        .into_iter()
        .filter(|id| !target_set.contains(id))
        .collect();
    let added: Vec<i64> = unique_category_ids
        .into_iter()
        .filter(|id| !current_set.contains(id))
        .collect();

    if has_user_state_schema_in_tx(conn).await? {
        for &id in &removed {
            record_membership_in_tx(conn, ctx, &[novel_id], id, false, false).await?;
        }
        for &id in &added {
            record_membership_in_tx(conn, ctx, &[novel_id], id, true, false).await?;
        }
    }

    if !removed.is_empty() {
        let placeholders: Vec<String> = (0..removed.len())
            .map(|idx| format!("?{}", idx + 2))
            .collect();
        let sql = format!(
            "DELETE FROM novel_category WHERE novel_id = ?1 AND category_id IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql).bind(novel_id);
        for &id in &removed {
            q = q.bind(id);
        }
        q.execute(&mut *conn)
            .await
            .map_err(|err| format!("db category: delete removed novel categories: {err}"))?;
    }

    if !added.is_empty() {
        let values: Vec<String> = (0..added.len())
            .map(|idx| format!("(?1, ?{})", idx + 2))
            .collect();
        let sql = format!(
            "INSERT OR IGNORE INTO novel_category (novel_id, category_id) VALUES {}",
            values.join(", ")
        );
        let mut q = sqlx::query(&sql).bind(novel_id);
        for &id in &added {
            q = q.bind(id);
        }
        q.execute(&mut *conn)
            .await
            .map_err(|err| format!("db category: insert added novel categories: {err}"))?;
    }

    Ok(())
}

pub async fn clear_library_membership_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
) -> Result<MaintenanceResultDto, String> {
    sqlx::query(
        "DELETE FROM novel_download_goal WHERE novel_id IN (SELECT id FROM novel WHERE in_library = 1)",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db maintenance: clear library download goals: {err}"))?;

    let res = sqlx::query(
        "UPDATE novel \
         SET in_library = 0, library_added_at = NULL, updated_at = unixepoch() \
         WHERE in_library = 1 OR library_added_at IS NOT NULL",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db maintenance: clear library membership: {err}"))?;

    record_library_in_tx(conn, ctx, None, false).await?;
    Ok(MaintenanceResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn clear_downloaded_chapter_content_in_tx(
    conn: &mut SqliteConnection,
) -> Result<MaintenanceResultDto, String> {
    let res = sqlx::query(
        "UPDATE chapter \
         SET \
           content_bytes = 0, \
           media_bytes = 0, \
           media_repair_needed = 0, \
           media_bytes_checked_at = NULL, \
           is_downloaded = 0, \
           updated_at = unixepoch() \
         WHERE ( \
             content_bytes > 0 \
             OR media_bytes > 0 \
             OR media_repair_needed = 1 \
             OR is_downloaded = 1 \
           ) \
           AND EXISTS ( \
             SELECT 1 FROM novel n \
             WHERE n.id = chapter.novel_id \
               AND n.is_local = 0 \
           )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db maintenance: clear downloaded chapter content: {err}"))?;

    Ok(MaintenanceResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn clear_updates_tab_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
) -> Result<MaintenanceResultDto, String> {
    let res = sqlx::query(
        "UPDATE chapter \
         SET unread = 0, updated_at = unixepoch() \
         WHERE unread = 1 \
           AND novel_id IN (SELECT id FROM novel WHERE in_library = 1) \
           AND COALESCE(created_at, updated_at) >= ( \
             SELECT COALESCE(library_added_at, updated_at, created_at) \
             FROM novel \
             WHERE novel.id = chapter.novel_id \
           )",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db maintenance: clear updates tab: {err}"))?;

    if has_user_state_schema_in_tx(conn).await? {
        let ids: Vec<i64> = sqlx::query_scalar(
            "SELECT c.id FROM chapter c JOIN novel n ON n.id = c.novel_id \
             WHERE n.in_library = 1 \
               AND COALESCE(c.created_at, c.updated_at) >= COALESCE(n.library_added_at, n.updated_at, n.created_at)",
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db maintenance: load cleared update chapter ids: {err}"))?;
        record_chapter_unread_flags_in_tx(conn, ctx, &ids, false).await?;
    }

    Ok(MaintenanceResultDto {
        rows_affected: res.rows_affected(),
    })
}

pub async fn clear_reading_progress_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
) -> Result<MaintenanceResultDto, String> {
    let res = sqlx::query(
        "UPDATE chapter \
         SET progress = 0, unread = 1, read_at = NULL, updated_at = unixepoch() \
         WHERE progress <> 0 OR unread = 0 OR read_at IS NOT NULL",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db maintenance: clear chapter reading progress: {err}"))?;

    sqlx::query(
        "UPDATE novel \
         SET last_read_at = NULL, updated_at = unixepoch() \
         WHERE last_read_at IS NOT NULL",
    )
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db maintenance: clear novel last_read_at: {err}"))?;

    record_novel_chapters_in_tx(conn, ctx, None).await?;
    record_resume_cleared_in_tx(conn, ctx, None).await?;

    Ok(MaintenanceResultDto {
        rows_affected: res.rows_affected(),
    })
}

#[tauri::command]
pub async fn db_category_list(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<Vec<LibraryCategoryDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db category: acquire read connection: {err}"))?;
    list_categories_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_category_get_library_counts(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<LibraryCategoryCountsDto, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db category: acquire read connection: {err}"))?;
    get_library_category_counts_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_category_insert(
    db: State<'_, AppDatabase>,
    input: InsertCategoryInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    normalize_category_name(&input.name)?;
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        category_tx_options(),
        move |conn, ctx| Box::pin(async move { insert_category_in_tx(conn, ctx, &input).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_category_update(
    db: State<'_, AppDatabase>,
    id: i64,
    input: UpdateCategoryInputDto,
) -> Result<DbMutationEnvelope<()>, String> {
    assert_manual_category_id(id)?;
    normalize_category_name(&input.name)?;
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        category_tx_options(),
        move |conn, ctx| {
            Box::pin(async move { update_category_in_tx(conn, ctx, id, &input).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_category_delete(
    db: State<'_, AppDatabase>,
    id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    assert_manual_category_id(id)?;
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        category_tx_options(),
        move |conn, ctx| Box::pin(async move { delete_category_in_tx(conn, ctx, id).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_category_add_novels(
    db: State<'_, AppDatabase>,
    novel_ids: Vec<i64>,
    category_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    assert_manual_category_id(category_id)?;
    let unique = dedupe_positive_ids(&novel_ids);
    if unique.is_empty() {
        return Ok(DbMutationEnvelope {
            value: (),
            effects: DbMutationEffects::default(),
        });
    }
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        category_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                add_novels_to_category_in_tx(conn, ctx, &unique, category_id).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_category_remove_novels(
    db: State<'_, AppDatabase>,
    novel_ids: Vec<i64>,
    category_id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    assert_manual_category_id(category_id)?;
    let unique = dedupe_positive_ids(&novel_ids);
    if unique.is_empty() {
        return Ok(DbMutationEnvelope {
            value: (),
            effects: DbMutationEffects::default(),
        });
    }
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        category_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                remove_novels_from_category_in_tx(conn, ctx, &unique, category_id).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_category_count_novels_by_category(
    db: State<'_, AppDatabase>,
    novel_ids: Vec<i64>,
    mode: Option<ReadMode>,
) -> Result<Vec<CategoryNovelCountDto>, String> {
    let unique = dedupe_positive_ids(&novel_ids);
    if unique.is_empty() {
        return Ok(Vec::new());
    }
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db category: acquire read connection: {err}"))?;
    count_novels_by_category_in_conn(&mut conn, &unique).await
}

#[tauri::command]
pub async fn db_category_get_novel_ids(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    mode: Option<ReadMode>,
) -> Result<Vec<i64>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db category: acquire read connection: {err}"))?;
    get_novel_category_ids_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_category_set_for_novel(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    category_ids: Vec<i64>,
) -> Result<DbMutationEnvelope<()>, String> {
    if novel_id <= 0 {
        return Err("novel-category:work-not-found".to_string());
    }
    for &cat_id in &category_ids {
        assert_manual_category_id(cat_id)?;
    }
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        category_tx_options(),
        move |conn, ctx| {
            Box::pin(async move {
                set_novel_categories_in_tx(conn, ctx, novel_id, &category_ids).await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_maintenance_clear_library_membership(
    app: AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<MaintenanceResultDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { clear_library_membership_in_tx(conn, ctx).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_maintenance_clear_downloaded_chapter_content(
    app: AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<MaintenanceResultDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, _ctx| {
            Box::pin(async move { clear_downloaded_chapter_content_in_tx(conn).await })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_maintenance_clear_updates_tab(
    app: AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<MaintenanceResultDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { clear_updates_tab_in_tx(conn, ctx).await }),
    )
    .await
}

#[tauri::command]
pub async fn db_maintenance_clear_reading_progress(
    app: AppHandle,
    db: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<MaintenanceResultDto>, String> {
    with_write_tx(
        db.pool_for(ReadMode::Queued),
        TxOptions::with_app_metadata(app),
        move |conn, ctx| Box::pin(async move { clear_reading_progress_in_tx(conn, ctx).await }),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;
    use crate::db::tx::{with_write_tx, MetadataRoot};
    use crate::db::UserStateCommitPriority;

    #[tokio::test]
    async fn category_crud_and_membership_delta_journaling_work() {
        let harness = open_test_db().await;
        let pool = harness.db.writer();

        sqlx::query(
            "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library) \
             VALUES (1, 'src', 'n1', '/n1', 'First', 1), (2, 'src', 'n2', '/n2', 'Second', 1)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO user_state_workspace (server_url, namespace, workspace_id, epoch) \
             VALUES ('https://state.example', 'ns', 'ws', 'ep')",
        )
        .execute(pool)
        .await
        .unwrap();

        let env = with_write_tx(pool, category_tx_options(), |conn, ctx| {
            Box::pin(async move {
                insert_category_in_tx(
                    conn,
                    ctx,
                    &InsertCategoryInputDto {
                        name: " Reading ".to_string(),
                        sort: Some(1),
                    },
                )
                .await?;
                insert_category_in_tx(
                    conn,
                    ctx,
                    &InsertCategoryInputDto {
                        name: "Later".to_string(),
                        sort: Some(0),
                    },
                )
                .await?;
                insert_category_in_tx(
                    conn,
                    ctx,
                    &InsertCategoryInputDto {
                        name: "Favorites".to_string(),
                        sort: None,
                    },
                )
                .await
            })
        })
        .await
        .unwrap();
        assert_eq!(
            env.effects.user_state_priority,
            Some(UserStateCommitPriority::Normal)
        );

        let mut conn = pool.acquire().await.unwrap();
        let cats = list_categories_in_conn(&mut conn).await.unwrap();
        let manual: Vec<&LibraryCategoryDto> = cats.iter().filter(|c| !c.is_system).collect();
        assert_eq!(manual.len(), 3);
        let later_id = manual[0].id;
        let reading_id = manual[1].id;
        let fav_id = manual[2].id;
        assert_eq!(manual[0].name, "Later");
        assert_eq!(manual[1].name, "Reading");
        assert_eq!(manual[2].name, "Favorites");
        assert_eq!(manual[2].sort, 2);

        let counts = get_library_category_counts_in_conn(&mut conn).await.unwrap();
        assert_eq!(
            counts,
            LibraryCategoryCountsDto {
                total: 2,
                uncategorized: 2,
            }
        );
        drop(conn);

        with_write_tx(pool, category_tx_options(), move |conn, ctx| {
            Box::pin(async move {
                add_novels_to_category_in_tx(conn, ctx, &[1, 2], reading_id).await?;
                add_novels_to_category_in_tx(conn, ctx, &[1], later_id).await
            })
        })
        .await
        .unwrap();

        sqlx::query("DELETE FROM user_state_intent")
            .execute(pool)
            .await
            .unwrap();

        with_write_tx(pool, category_tx_options(), move |conn, ctx| {
            Box::pin(async move {
                set_novel_categories_in_tx(conn, ctx, 1, &[reading_id, fav_id]).await
            })
        })
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(
            get_novel_category_ids_in_conn(&mut conn, 1).await.unwrap(),
            vec![reading_id, fav_id]
        );
        let by_cat = count_novels_by_category_in_conn(&mut conn, &[1, 2])
            .await
            .unwrap();
        assert!(by_cat.contains(&CategoryNovelCountDto {
            category_id: reading_id,
            count: 2
        }));
        assert!(by_cat.contains(&CategoryNovelCountDto {
            category_id: fav_id,
            count: 1
        }));

        let membership_deltas: Vec<(i64, i64)> = sqlx::query(
            "SELECT m.local_id AS local_id, json_extract(i.value_json, '$.included') AS included \
             FROM user_state_intent i \
             JOIN user_state_category m ON m.category_id = json_extract(i.entity_json, '$.categoryId') \
             WHERE json_extract(i.entity_json, '$.kind') = 'membership' \
             ORDER BY m.local_id",
        )
        .fetch_all(&mut *conn)
        .await
        .unwrap()
        .into_iter()
        .map(|r| (r.get("local_id"), r.get("included")))
        .collect();
        assert_eq!(membership_deltas, vec![(later_id, 0), (fav_id, 1)]);
        drop(conn);

        let missing_cat = with_write_tx(pool, category_tx_options(), |conn, ctx| {
            Box::pin(async move { set_novel_categories_in_tx(conn, ctx, 1, &[999]).await })
        })
        .await
        .unwrap_err();
        assert_eq!(missing_cat, "novel-category:category-not-found");

        with_write_tx(pool, category_tx_options(), move |conn, ctx| {
            Box::pin(async move {
                update_category_in_tx(
                    conn,
                    ctx,
                    fav_id,
                    &UpdateCategoryInputDto {
                        name: " Starred ".to_string(),
                    },
                )
                .await?;
                remove_novels_from_category_in_tx(conn, ctx, &[2], reading_id).await?;
                delete_category_in_tx(conn, ctx, later_id).await
            })
        })
        .await
        .unwrap();

        let mut conn = pool.acquire().await.unwrap();
        let after = list_categories_in_conn(&mut conn).await.unwrap();
        assert!(after.iter().any(|c| c.id == fav_id && c.name == "Starred"));
        assert!(!after.iter().any(|c| c.id == later_id));
    }

    #[tokio::test]
    async fn maintenance_commands_reset_expected_rows_and_preserve_local_downloads() {
        let harness = open_test_db().await;
        let pool = harness.db.writer();
        let dir = tempfile::tempdir().unwrap();

        sqlx::query(
            "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library, is_local, library_added_at, last_read_at) \
             VALUES \
               (1, 'src', 'n1', '/n1', 'Remote', 1, 0, 100, 500), \
               (2, 'local', 'local-l1', 'local-l1', 'Local', 1, 1, 100, 500)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO novel_download_goal (novel_id, kind, count, updated_at) \
             VALUES (1, 'keep_ahead', 5, 100)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter (id, novel_id, path, name, position, is_downloaded, content_bytes, progress, unread, read_at, created_at, updated_at) \
             VALUES \
               (10, 1, '/c1', 'Ch 1', 1, 1, 200, 80, 1, 500, 200, 200), \
               (20, 2, '/lc1', 'Local Ch 1', 1, 1, 300, 50, 0, 500, 200, 200)",
        )
        .execute(pool)
        .await
        .unwrap();

        let opts = || TxOptions {
            remote_content_sync: false,
            notify_content_sync: true,
            busy_begin_retries: 3,
            publish_metadata: true,
            metadata_root: MetadataRoot::Path(dir.path().to_path_buf()),
        };

        let dl_cleared = with_write_tx(pool, opts(), |conn, _ctx| {
            Box::pin(async move { clear_downloaded_chapter_content_in_tx(conn).await })
        })
        .await
        .unwrap();
        assert_eq!(dl_cleared.value.rows_affected, 1);

        let local_still_downloaded: i64 =
            sqlx::query_scalar("SELECT is_downloaded FROM chapter WHERE id = 20")
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(local_still_downloaded, 1);

        let updates_cleared = with_write_tx(pool, opts(), |conn, ctx| {
            Box::pin(async move { clear_updates_tab_in_tx(conn, ctx).await })
        })
        .await
        .unwrap();
        assert_eq!(updates_cleared.value.rows_affected, 1);

        let progress_cleared = with_write_tx(pool, opts(), |conn, ctx| {
            Box::pin(async move { clear_reading_progress_in_tx(conn, ctx).await })
        })
        .await
        .unwrap();
        assert_eq!(progress_cleared.value.rows_affected, 2);

        let lib_cleared = with_write_tx(pool, opts(), |conn, ctx| {
            Box::pin(async move { clear_library_membership_in_tx(conn, ctx).await })
        })
        .await
        .unwrap();
        assert_eq!(lib_cleared.value.rows_affected, 2);

        let goal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM novel_download_goal")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(goal_count, 0);
    }
}
