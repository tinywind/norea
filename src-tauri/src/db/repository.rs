use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use tauri::State;

use crate::database::AppDatabase;
use crate::db::tx::{with_write_tx, TxOptions};
use crate::db::{DbMutationEffects, DbMutationEnvelope, ReadMode};

fn repo_tx_options() -> TxOptions {
    TxOptions {
        remote_content_sync: false,
        notify_content_sync: false,
        busy_begin_retries: 0,
        ..TxOptions::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRepositoryDto {
    pub id: i64,
    pub url: String,
    pub name: Option<String>,
    pub added_at: i64,
    pub priority: i64,
    pub enabled: bool,
}

#[derive(Debug, FromRow)]
struct RawRepositoryRow {
    id: i64,
    url: String,
    name: Option<String>,
    added_at: i64,
    priority: i64,
    enabled: i64,
}

impl From<RawRepositoryRow> for PluginRepositoryDto {
    fn from(row: RawRepositoryRow) -> Self {
        Self {
            id: row.id,
            url: row.url,
            name: row.name,
            added_at: row.added_at,
            priority: row.priority,
            enabled: row.enabled != 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRepositoryInput {
    pub url: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginDto {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub version: String,
    pub icon_url: String,
    pub source_url: String,
    pub source_code: String,
    pub installed_at: i64,
    pub repository_url: Option<String>,
}

#[derive(Debug, FromRow)]
struct RawInstalledPluginRow {
    id: String,
    name: String,
    lang: String,
    version: String,
    icon_url: String,
    source_url: String,
    source_code: String,
    installed_at: i64,
    repository_url: Option<String>,
}

impl From<RawInstalledPluginRow> for InstalledPluginDto {
    fn from(row: RawInstalledPluginRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            lang: row.lang,
            version: row.version,
            icon_url: row.icon_url,
            source_url: row.source_url,
            source_code: row.source_code,
            installed_at: row.installed_at,
            repository_url: row.repository_url,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertInstalledPluginInput {
    pub id: String,
    pub name: String,
    pub lang: String,
    pub version: String,
    pub icon_url: String,
    pub source_url: String,
    pub source_code: String,
    #[serde(default)]
    pub repository_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRepoIndexDto {
    pub repo_url: String,
    pub fetched_at: i64,
    pub items: Vec<Value>,
}

#[derive(Debug, FromRow)]
struct RawCachedRepoIndexRow {
    repo_url: String,
    fetched_at: i64,
    items_json: String,
}

impl From<RawCachedRepoIndexRow> for CachedRepoIndexDto {
    fn from(row: RawCachedRepoIndexRow) -> Self {
        let items = match serde_json::from_str::<Value>(&row.items_json) {
            Ok(Value::Array(items)) => items,
            _ => Vec::new(),
        };
        Self {
            repo_url: row.repo_url,
            fetched_at: row.fetched_at,
            items,
        }
    }
}

pub async fn list_repositories(
    db: &AppDatabase,
    read_mode: ReadMode,
) -> Result<Vec<PluginRepositoryDto>, String> {
    let rows = sqlx::query_as::<_, RawRepositoryRow>(
        "SELECT id, url, name, added_at, priority, enabled
         FROM repository
         ORDER BY priority, id",
    )
    .fetch_all(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_repo_list: {err}"))?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn add_repository(
    db: &AppDatabase,
    input: AddRepositoryInput,
) -> Result<DbMutationEnvelope<bool>, String> {
    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let result = sqlx::query(
                "INSERT INTO repository (url, name, priority, enabled)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(priority), 0) + 1 FROM repository), 1)
                 ON CONFLICT(url) DO NOTHING",
            )
            .bind(&input.url)
            .bind(&input.name)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db_repo_add: {err}"))?;
            Ok(result.rows_affected() > 0)
        })
    })
    .await
}

pub async fn set_repository_enabled(
    db: &AppDatabase,
    id: i64,
    enabled: bool,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            sqlx::query("UPDATE repository SET enabled = ?1 WHERE id = ?2")
                .bind(if enabled { 1_i64 } else { 0_i64 })
                .bind(id)
                .execute(&mut *conn)
                .await
                .map(|_| ())
                .map_err(|err| format!("db_repo_set_enabled: {err}"))
        })
    })
    .await
}

pub async fn reorder_repositories(
    db: &AppDatabase,
    ordered_ids: Vec<i64>,
) -> Result<DbMutationEnvelope<()>, String> {
    if ordered_ids.is_empty() {
        return Ok(DbMutationEnvelope {
            value: (),
            effects: DbMutationEffects::default(),
        });
    }

    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            let mut seen = HashSet::with_capacity(ordered_ids.len());
            for (index, id) in ordered_ids.into_iter().enumerate() {
                if !seen.insert(id) {
                    continue;
                }
                let priority = i64::try_from(index + 1)
                    .map_err(|_| "db_repo_reorder: priority overflow".to_string())?;
                sqlx::query("UPDATE repository SET priority = ?1 WHERE id = ?2")
                    .bind(priority)
                    .bind(id)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db_repo_reorder: {err}"))?;
            }
            Ok(())
        })
    })
    .await
}

pub async fn remove_repository(
    db: &AppDatabase,
    id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            sqlx::query(
                "DELETE FROM repository_index_cache
                 WHERE repo_url = (SELECT url FROM repository WHERE id = ?1)",
            )
            .bind(id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db_repo_remove cache: {err}"))?;

            sqlx::query("DELETE FROM repository WHERE id = ?1")
                .bind(id)
                .execute(&mut *conn)
                .await
                .map(|_| ())
                .map_err(|err| format!("db_repo_remove repository: {err}"))
        })
    })
    .await
}

pub async fn list_installed_plugins(
    db: &AppDatabase,
    read_mode: ReadMode,
) -> Result<Vec<InstalledPluginDto>, String> {
    let rows = sqlx::query_as::<_, RawInstalledPluginRow>(
        "SELECT
           id,
           name,
           lang,
           version,
           icon_url,
           source_url,
           source_code,
           installed_at,
           repository_url
         FROM installed_plugin
         ORDER BY installed_at DESC, id ASC",
    )
    .fetch_all(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_plugin_list_installed: {err}"))?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn upsert_installed_plugin(
    db: &AppDatabase,
    input: UpsertInstalledPluginInput,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO installed_plugin (
                   id, name, lang, version, icon_url, source_url, source_code, repository_url
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   lang = excluded.lang,
                   version = excluded.version,
                   icon_url = excluded.icon_url,
                   source_url = excluded.source_url,
                   source_code = excluded.source_code,
                   repository_url = excluded.repository_url,
                   installed_at = unixepoch()",
            )
            .bind(&input.id)
            .bind(&input.name)
            .bind(&input.lang)
            .bind(&input.version)
            .bind(&input.icon_url)
            .bind(&input.source_url)
            .bind(&input.source_code)
            .bind(&input.repository_url)
            .execute(&mut *conn)
            .await
            .map(|_| ())
            .map_err(|err| format!("db_plugin_upsert_installed: {err}"))
        })
    })
    .await
}

pub async fn delete_installed_plugin(
    db: &AppDatabase,
    id: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            sqlx::query("DELETE FROM installed_plugin WHERE id = ?1")
                .bind(&id)
                .execute(&mut *conn)
                .await
                .map(|_| ())
                .map_err(|err| format!("db_plugin_delete_installed: {err}"))
        })
    })
    .await
}

pub async fn get_cached_repo_index(
    db: &AppDatabase,
    repo_url: &str,
    read_mode: ReadMode,
) -> Result<Option<CachedRepoIndexDto>, String> {
    let row = sqlx::query_as::<_, RawCachedRepoIndexRow>(
        "SELECT repo_url, fetched_at, items_json
         FROM repository_index_cache
         WHERE repo_url = ?1",
    )
    .bind(repo_url)
    .fetch_optional(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_repo_cache_get: {err}"))?;
    Ok(row.map(Into::into))
}

pub async fn list_all_cached_repo_indexes(
    db: &AppDatabase,
    read_mode: ReadMode,
) -> Result<Vec<CachedRepoIndexDto>, String> {
    let rows = sqlx::query_as::<_, RawCachedRepoIndexRow>(
        "SELECT repo_url, fetched_at, items_json
         FROM repository_index_cache
         ORDER BY repo_url",
    )
    .fetch_all(db.pool_for(read_mode))
    .await
    .map_err(|err| format!("db_repo_cache_list_all: {err}"))?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn set_cached_repo_index(
    db: &AppDatabase,
    repo_url: String,
    items: Vec<Value>,
) -> Result<DbMutationEnvelope<()>, String> {
    let items_json =
        serde_json::to_string(&items).map_err(|err| format!("db_repo_cache_set json: {err}"))?;

    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            sqlx::query(
                "INSERT INTO repository_index_cache (repo_url, items_json)
                 VALUES (?1, ?2)
                 ON CONFLICT(repo_url) DO UPDATE SET
                   items_json = excluded.items_json,
                   fetched_at = unixepoch()",
            )
            .bind(&repo_url)
            .bind(&items_json)
            .execute(&mut *conn)
            .await
            .map(|_| ())
            .map_err(|err| format!("db_repo_cache_set: {err}"))
        })
    })
    .await
}

pub async fn delete_cached_repo_index(
    db: &AppDatabase,
    repo_url: String,
) -> Result<DbMutationEnvelope<()>, String> {
    with_write_tx(db.writer(), repo_tx_options(), move |conn, _ctx| {
        Box::pin(async move {
            sqlx::query("DELETE FROM repository_index_cache WHERE repo_url = ?1")
                .bind(&repo_url)
                .execute(&mut *conn)
                .await
                .map(|_| ())
                .map_err(|err| format!("db_repo_cache_delete: {err}"))
        })
    })
    .await
}

#[tauri::command]
pub async fn db_repo_list(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<PluginRepositoryDto>, String> {
    list_repositories(db.inner(), read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_repo_add(
    db: State<'_, AppDatabase>,
    input: AddRepositoryInput,
) -> Result<DbMutationEnvelope<bool>, String> {
    add_repository(db.inner(), input).await
}

#[tauri::command]
pub async fn db_repo_set_enabled(
    db: State<'_, AppDatabase>,
    id: i64,
    enabled: bool,
) -> Result<DbMutationEnvelope<()>, String> {
    set_repository_enabled(db.inner(), id, enabled).await
}

#[tauri::command]
pub async fn db_repo_reorder(
    db: State<'_, AppDatabase>,
    ordered_ids: Vec<i64>,
) -> Result<DbMutationEnvelope<()>, String> {
    reorder_repositories(db.inner(), ordered_ids).await
}

#[tauri::command]
pub async fn db_repo_remove(
    db: State<'_, AppDatabase>,
    id: i64,
) -> Result<DbMutationEnvelope<()>, String> {
    remove_repository(db.inner(), id).await
}

#[tauri::command]
pub async fn db_plugin_list_installed(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<InstalledPluginDto>, String> {
    list_installed_plugins(db.inner(), read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_plugin_upsert_installed(
    db: State<'_, AppDatabase>,
    input: UpsertInstalledPluginInput,
) -> Result<DbMutationEnvelope<()>, String> {
    upsert_installed_plugin(db.inner(), input).await
}

#[tauri::command]
pub async fn db_plugin_delete_installed(
    db: State<'_, AppDatabase>,
    id: String,
) -> Result<DbMutationEnvelope<()>, String> {
    delete_installed_plugin(db.inner(), id).await
}

#[tauri::command]
pub async fn db_repo_cache_get(
    db: State<'_, AppDatabase>,
    repo_url: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<CachedRepoIndexDto>, String> {
    get_cached_repo_index(db.inner(), &repo_url, read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_repo_cache_list_all(
    db: State<'_, AppDatabase>,
    read_mode: Option<ReadMode>,
) -> Result<Vec<CachedRepoIndexDto>, String> {
    list_all_cached_repo_indexes(db.inner(), read_mode.unwrap_or(ReadMode::Committed)).await
}

#[tauri::command]
pub async fn db_repo_cache_set(
    db: State<'_, AppDatabase>,
    repo_url: String,
    items: Vec<Value>,
) -> Result<DbMutationEnvelope<()>, String> {
    set_cached_repo_index(db.inner(), repo_url, items).await
}

#[tauri::command]
pub async fn db_repo_cache_delete(
    db: State<'_, AppDatabase>,
    repo_url: String,
) -> Result<DbMutationEnvelope<()>, String> {
    delete_cached_repo_index(db.inner(), repo_url).await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::db::test_support::open_test_db;

    #[tokio::test]
    async fn repository_crud_priority_reorder_and_atomic_cache_removal() {
        let test_db = open_test_db().await;
        let db = &test_db.db;

        assert_eq!(list_repositories(db, ReadMode::Committed).await.unwrap(), vec![]);

        let first = add_repository(
            db,
            AddRepositoryInput {
                url: "https://a.example/plugins.json".to_string(),
                name: Some("Alpha".to_string()),
            },
        )
        .await
        .unwrap();
        assert!(first.value);

        let duplicate = add_repository(
            db,
            AddRepositoryInput {
                url: "https://a.example/plugins.json".to_string(),
                name: Some("Duplicate".to_string()),
            },
        )
        .await
        .unwrap();
        assert!(!duplicate.value);

        let second = add_repository(
            db,
            AddRepositoryInput {
                url: "https://b.example/plugins.json".to_string(),
                name: None,
            },
        )
        .await
        .unwrap();
        assert!(second.value);

        let third = add_repository(
            db,
            AddRepositoryInput {
                url: "https://c.example/plugins.json".to_string(),
                name: Some("Charlie".to_string()),
            },
        )
        .await
        .unwrap();
        assert!(third.value);

        let listed = list_repositories(db, ReadMode::Committed).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|repo| (&repo.url[..], repo.name.as_deref(), repo.priority, repo.enabled))
                .collect::<Vec<_>>(),
            vec![
                ("https://a.example/plugins.json", Some("Alpha"), 1, true),
                ("https://b.example/plugins.json", None, 2, true),
                ("https://c.example/plugins.json", Some("Charlie"), 3, true),
            ]
        );

        set_repository_enabled(db, listed[1].id, false).await.unwrap();
        reorder_repositories(db, vec![listed[2].id, listed[0].id, listed[1].id])
            .await
            .unwrap();
        // Empty reorder is a no-op.
        reorder_repositories(db, vec![]).await.unwrap();

        let reordered = list_repositories(db, ReadMode::Committed).await.unwrap();
        assert_eq!(
            reordered
                .iter()
                .map(|repo| (repo.id, repo.priority, repo.enabled))
                .collect::<Vec<_>>(),
            vec![
                (listed[2].id, 1, true),
                (listed[0].id, 2, true),
                (listed[1].id, 3, false),
            ]
        );

        // Seed cache entries for two repositories and verify remove_repository cleans only the target's cache.
        set_cached_repo_index(
            db,
            "https://a.example/plugins.json".to_string(),
            vec![json!({ "id": "p1", "name": "Plugin 1" })],
        )
        .await
        .unwrap();
        set_cached_repo_index(
            db,
            "https://b.example/plugins.json".to_string(),
            vec![json!({ "id": "p2", "name": "Plugin 2" })],
        )
        .await
        .unwrap();

        remove_repository(db, listed[0].id).await.unwrap();

        let remaining = list_repositories(db, ReadMode::Committed).await.unwrap();
        assert_eq!(
            remaining.iter().map(|repo| repo.id).collect::<Vec<_>>(),
            vec![listed[2].id, listed[1].id]
        );
        assert_eq!(
            get_cached_repo_index(db, "https://a.example/plugins.json", ReadMode::Committed)
                .await
                .unwrap(),
            None
        );
        assert!(
            get_cached_repo_index(db, "https://b.example/plugins.json", ReadMode::Committed)
                .await
                .unwrap()
                .is_some()
        );

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn installed_plugins_upsert_orders_and_deletes() {
        let test_db = open_test_db().await;
        let db = &test_db.db;

        upsert_installed_plugin(
            db,
            UpsertInstalledPluginInput {
                id: "beta".to_string(),
                name: "Beta Source".to_string(),
                lang: "en".to_string(),
                version: "1.0.0".to_string(),
                icon_url: "https://example.test/beta.png".to_string(),
                source_url: "https://example.test/beta.js".to_string(),
                source_code: "module.exports = 1;".to_string(),
                repository_url: Some("https://repo.example/index.json".to_string()),
            },
        )
        .await
        .unwrap();

        upsert_installed_plugin(
            db,
            UpsertInstalledPluginInput {
                id: "alpha".to_string(),
                name: "Alpha Source".to_string(),
                lang: "ko".to_string(),
                version: "0.9.0".to_string(),
                icon_url: "https://example.test/alpha.png".to_string(),
                source_url: "https://example.test/alpha.js".to_string(),
                source_code: "module.exports = 0;".to_string(),
                repository_url: None,
            },
        )
        .await
        .unwrap();

        // Force distinct installed_at timestamps to verify ORDER BY installed_at DESC, id ASC.
        sqlx::query("UPDATE installed_plugin SET installed_at = 100 WHERE id = 'beta'")
            .execute(db.writer())
            .await
            .unwrap();
        sqlx::query("UPDATE installed_plugin SET installed_at = 100 WHERE id = 'alpha'")
            .execute(db.writer())
            .await
            .unwrap();

        let tied = list_installed_plugins(db, ReadMode::Committed).await.unwrap();
        assert_eq!(
            tied.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "beta"]
        );

        // Reinstall alpha with updated version and code; installed_at advances above 100.
        upsert_installed_plugin(
            db,
            UpsertInstalledPluginInput {
                id: "alpha".to_string(),
                name: "Alpha Source Updated".to_string(),
                lang: "ko".to_string(),
                version: "2.0.0".to_string(),
                icon_url: "https://example.test/alpha-v2.png".to_string(),
                source_url: "https://example.test/alpha-v2.js".to_string(),
                source_code: "module.exports = 2;".to_string(),
                repository_url: Some("https://repo.example/index.json".to_string()),
            },
        )
        .await
        .unwrap();

        let updated = list_installed_plugins(db, ReadMode::Committed).await.unwrap();
        assert_eq!(updated[0].id, "alpha");
        assert_eq!(updated[0].name, "Alpha Source Updated");
        assert_eq!(updated[0].version, "2.0.0");
        assert_eq!(updated[0].source_code, "module.exports = 2;");
        assert_eq!(
            updated[0].repository_url.as_deref(),
            Some("https://repo.example/index.json")
        );
        assert!(updated[0].installed_at > 100);

        delete_installed_plugin(db, "alpha".to_string()).await.unwrap();
        let after_delete = list_installed_plugins(db, ReadMode::Committed).await.unwrap();
        assert_eq!(
            after_delete.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["beta"]
        );

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn repo_index_cache_handles_corrupt_json_and_reader_stays_nonblocking_during_write_tx() {
        let test_db = open_test_db().await;
        let db = &test_db.db;

        set_cached_repo_index(
            db,
            "https://b.repo/index.json".to_string(),
            vec![json!({ "id": "s1", "version": "1.2.3" })],
        )
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO repository_index_cache (repo_url, fetched_at, items_json)
             VALUES ('https://a.repo/corrupt.json', 50, '{not-json'),
                    ('https://c.repo/object.json', 60, '{\"not\":\"an-array\"}')",
        )
        .execute(db.writer())
        .await
        .unwrap();

        let all = list_all_cached_repo_indexes(db, ReadMode::Committed)
            .await
            .unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].repo_url, "https://a.repo/corrupt.json");
        assert!(all[0].items.is_empty());
        assert_eq!(all[1].repo_url, "https://b.repo/index.json");
        assert_eq!(all[1].items, vec![json!({ "id": "s1", "version": "1.2.3" })]);
        assert_eq!(all[2].repo_url, "https://c.repo/object.json");
        assert!(all[2].items.is_empty());

        // Hold an active BEGIN IMMEDIATE transaction on writer and verify Committed reads do not block.
        let mut active_tx = db.writer().begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query(
            "INSERT INTO repository (url, name, priority, enabled) VALUES ('https://uncommitted.test', 'Pending', 99, 1)",
        )
        .execute(&mut *active_tx)
        .await
        .unwrap();

        let committed_repos = tokio::time::timeout(
            Duration::from_millis(500),
            list_repositories(db, ReadMode::Committed),
        )
        .await
        .expect("reader pool must not block behind writer BEGIN IMMEDIATE")
        .unwrap();
        assert!(committed_repos.is_empty());

        let committed_cache = tokio::time::timeout(
            Duration::from_millis(500),
            get_cached_repo_index(db, "https://b.repo/index.json", ReadMode::Committed),
        )
        .await
        .expect("reader pool cache read must not block behind writer BEGIN IMMEDIATE")
        .unwrap();
        assert!(committed_cache.is_some());

        active_tx.rollback().await.unwrap();

        delete_cached_repo_index(db, "https://b.repo/index.json".to_string())
            .await
            .unwrap();
        assert_eq!(
            get_cached_repo_index(db, "https://b.repo/index.json", ReadMode::Committed)
                .await
                .unwrap(),
            None
        );

        test_db.db.close().await;
    }
}
