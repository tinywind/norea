use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sqlx::{
    sqlite::{SqliteArguments, SqliteValueRef},
    Column, Row, Sqlite, SqlitePool, Transaction, TypeInfo, Value as SqlxValue, ValueRef,
};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};
use tokio::sync::Mutex;

const DB_URL: &str = "sqlite:norea.db";
const MAX_TRANSACTION_ID_LEN: usize = 128;

struct TransactionSession {
    id: String,
    tx: Transaction<'static, Sqlite>,
}

#[derive(Default)]
pub struct DatabaseTransactionState {
    session: Mutex<Option<TransactionSession>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseTransactionExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_TRANSACTION_ID_LEN
        || !id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
    {
        return Err("database transaction: invalid transaction id".into());
    }
    Ok(())
}

async fn writer_pool(instances: &DbInstances) -> Result<SqlitePool, String> {
    let databases = instances.0.read().await;
    match databases.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("database transaction: application database is not initialized".into()),
    }
}

fn bind_query<'q>(
    sql: &'q str,
    values: Vec<JsonValue>,
) -> sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>> {
    let mut query = sqlx::query(sql);
    for value in values {
        if value.is_null() {
            query = query.bind(None::<JsonValue>);
        } else if let Some(text) = value.as_str() {
            query = query.bind(text.to_owned());
        } else if let Some(number) = value.as_number() {
            query = query.bind(number.as_f64().unwrap_or_default());
        } else {
            query = query.bind(value);
        }
    }
    query
}

fn sqlite_json(value: SqliteValueRef<'_>) -> Result<JsonValue, String> {
    if value.is_null() {
        return Ok(JsonValue::Null);
    }
    let type_info = value.type_info();
    let kind = type_info.name();
    let result = match kind {
        "TEXT" => value
            .to_owned()
            .try_decode::<String>()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
        "REAL" => value
            .to_owned()
            .try_decode::<f64>()
            .ok()
            .and_then(serde_json::Number::from_f64)
            .map(JsonValue::Number)
            .unwrap_or(JsonValue::Null),
        "INTEGER" | "NUMERIC" => value
            .to_owned()
            .try_decode::<i64>()
            .map(|number| JsonValue::Number(number.into()))
            .unwrap_or(JsonValue::Null),
        "BOOLEAN" => value
            .to_owned()
            .try_decode::<bool>()
            .map(JsonValue::Bool)
            .unwrap_or(JsonValue::Null),
        "BLOB" => value
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|bytes| {
                JsonValue::Array(
                    bytes
                        .into_iter()
                        .map(|byte| JsonValue::Number(byte.into()))
                        .collect(),
                )
            })
            .unwrap_or(JsonValue::Null),
        "NULL" => JsonValue::Null,
        unsupported => {
            return Err(format!(
                "database transaction: unsupported SQLite value type {unsupported}"
            ))
        }
    };
    Ok(result)
}

impl DatabaseTransactionState {
    async fn begin(&self, pool: &SqlitePool, id: String) -> Result<(), String> {
        validate_id(&id)?;
        let mut session = self.session.lock().await;
        if session.is_some() {
            return Err("database transaction: another frontend transaction is active".into());
        }
        let tx = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| format!("database transaction: begin: {error}"))?;
        *session = Some(TransactionSession { id, tx });
        Ok(())
    }

    async fn execute(
        &self,
        id: &str,
        query: String,
        values: Vec<JsonValue>,
    ) -> Result<DatabaseTransactionExecuteResult, String> {
        let mut session = self.session.lock().await;
        let active = session
            .as_mut()
            .filter(|active| active.id == id)
            .ok_or_else(|| "database transaction: transaction is not active".to_string())?;
        let result = bind_query(&query, values)
            .execute(&mut *active.tx)
            .await
            .map_err(|error| format!("database transaction: execute: {error}"))?;
        Ok(DatabaseTransactionExecuteResult {
            rows_affected: result.rows_affected(),
            last_insert_id: result.last_insert_rowid(),
        })
    }

    async fn select(
        &self,
        id: &str,
        query: String,
        values: Vec<JsonValue>,
    ) -> Result<Vec<Map<String, JsonValue>>, String> {
        let mut session = self.session.lock().await;
        let active = session
            .as_mut()
            .filter(|active| active.id == id)
            .ok_or_else(|| "database transaction: transaction is not active".to_string())?;
        let rows = bind_query(&query, values)
            .fetch_all(&mut *active.tx)
            .await
            .map_err(|error| format!("database transaction: select: {error}"))?;
        let mut output = Vec::with_capacity(rows.len());
        for row in rows {
            let mut item = Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                let raw = row
                    .try_get_raw(index)
                    .map_err(|error| format!("database transaction: read column: {error}"))?;
                item.insert(column.name().to_string(), sqlite_json(raw)?);
            }
            output.push(item);
        }
        Ok(output)
    }

    async fn finish(&self, id: &str, commit: bool) -> Result<(), String> {
        let active = {
            let mut session = self.session.lock().await;
            if session.as_ref().map(|active| active.id.as_str()) != Some(id) {
                return Err("database transaction: transaction is not active".into());
            }
            session.take().expect("checked transaction session")
        };
        if commit {
            active
                .tx
                .commit()
                .await
                .map_err(|error| format!("database transaction: commit: {error}"))
        } else {
            active
                .tx
                .rollback()
                .await
                .map_err(|error| format!("database transaction: rollback: {error}"))
        }
    }

    async fn reset(&self) -> Result<(), String> {
        let active = self.session.lock().await.take();
        if let Some(active) = active {
            active
                .tx
                .rollback()
                .await
                .map_err(|error| format!("database transaction: reset rollback: {error}"))?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn database_transaction_begin(
    databases: State<'_, DbInstances>,
    state: State<'_, DatabaseTransactionState>,
    transaction_id: String,
) -> Result<(), String> {
    let pool = writer_pool(databases.inner()).await?;
    state.begin(&pool, transaction_id).await
}

#[tauri::command]
pub async fn database_transaction_execute(
    state: State<'_, DatabaseTransactionState>,
    transaction_id: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<DatabaseTransactionExecuteResult, String> {
    state.execute(&transaction_id, query, values).await
}

#[tauri::command]
pub async fn database_transaction_select(
    state: State<'_, DatabaseTransactionState>,
    transaction_id: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    state.select(&transaction_id, query, values).await
}

#[tauri::command]
pub async fn database_transaction_commit(
    state: State<'_, DatabaseTransactionState>,
    transaction_id: String,
) -> Result<(), String> {
    state.finish(&transaction_id, true).await
}

#[tauri::command]
pub async fn database_transaction_rollback(
    state: State<'_, DatabaseTransactionState>,
    transaction_id: String,
) -> Result<(), String> {
    state.finish(&transaction_id, false).await
}

#[tauri::command]
pub async fn database_transaction_reset(
    state: State<'_, DatabaseTransactionState>,
) -> Result<(), String> {
    state.reset().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::time::Duration;

    #[tokio::test]
    async fn session_keeps_the_physical_connection_until_commit() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        let state = DatabaseTransactionState::default();

        state.begin(&pool, "frontend-1".into()).await.unwrap();
        state
            .execute(
                "frontend-1",
                "INSERT INTO sample(value) VALUES($1)".into(),
                vec![JsonValue::String("inside".into())],
            )
            .await
            .unwrap();
        let selected = state
            .select("frontend-1", "SELECT value FROM sample".into(), Vec::new())
            .await
            .unwrap();
        assert_eq!(
            selected[0].get("value"),
            Some(&JsonValue::String("inside".into()))
        );

        let waiting = tokio::spawn({
            let pool = pool.clone();
            async move {
                let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
                sqlx::query("INSERT INTO sample(value) VALUES('native')")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                tx.commit().await.unwrap();
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiting.is_finished(),
            "native writer must wait for the frontend transaction"
        );

        state.finish("frontend-1", true).await.unwrap();
        waiting.await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sample")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2,
        );
    }

    #[tokio::test]
    async fn reset_rolls_back_an_abandoned_frontend_transaction() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE sample(value INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        let state = DatabaseTransactionState::default();
        state.begin(&pool, "frontend-1".into()).await.unwrap();
        state
            .execute(
                "frontend-1",
                "INSERT INTO sample(value) VALUES(1)".into(),
                Vec::new(),
            )
            .await
            .unwrap();
        state.reset().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sample")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0,
        );
    }
}
