//! User-set work metadata (`override.json`), stored apart from source metadata so
//! neither a source refresh nor a metadata install can change it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;

use super::novel::LOCAL_PLUGIN_ID;
use super::tx::{with_write_tx, TxContext, TxOptions};
use super::work_metadata::WorkMetadataIdentityDto;
use super::{DbMutationEnvelope, ReadMode, WorkDirectoryUpdateDto};

pub const MAX_WORK_OVERRIDE_BYTES: usize = 256 * 1024;
const MAX_FIELDS: usize = 64;
const MAX_FIELD_NAME_LENGTH: usize = 64;
const MAX_TEXT_UNITS: usize = 8192;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const OVERRIDE_FILE_NAME: &str = "override.json";
const COMPLETED_FIELD: &str = "completed";

pub type WorkOverrideFields = BTreeMap<String, WorkOverrideFieldDto>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkOverrideFieldDto {
    pub value: JsonValue,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkOverrideV1Dto {
    pub schema_version: i64,
    pub identity: WorkMetadataIdentityDto,
    pub fields: WorkOverrideFields,
}

/// The stored `novel_override.payload` and the per-novel `override` value of a portable backup.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkOverridePayloadDto {
    pub fields: WorkOverrideFields,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNovelOverrideDto {
    pub novel_id: i64,
    pub is_local: bool,
    pub document: WorkOverrideV1Dto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelOverrideMergeResultDto {
    pub document: Option<WorkOverrideV1Dto>,
    pub changed: bool,
}

struct OverrideWork {
    identity: WorkMetadataIdentityDto,
    directory: Option<String>,
}

fn is_field_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= MAX_FIELD_NAME_LENGTH
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_alphanumeric())
}

fn validate_override_field(name: &str, field: &WorkOverrideFieldDto) -> Result<(), String> {
    let valid_value = match &field.value {
        JsonValue::Null | JsonValue::Bool(_) => true,
        JsonValue::Number(number) => {
            name != COMPLETED_FIELD && number.as_f64().is_some_and(f64::is_finite)
        }
        JsonValue::String(text) => {
            name != COMPLETED_FIELD && text.encode_utf16().count() <= MAX_TEXT_UNITS
        }
        JsonValue::Array(_) | JsonValue::Object(_) => false,
    };
    if !is_field_name(name)
        || !valid_value
        || field.updated_at <= 0
        || field.updated_at > MAX_SAFE_INTEGER
    {
        return Err(format!("work override: field '{name}' is invalid"));
    }
    Ok(())
}

pub fn validate_override_fields(fields: &WorkOverrideFields) -> Result<(), String> {
    if fields.len() > MAX_FIELDS {
        return Err("work override: too many fields".to_string());
    }
    fields
        .iter()
        .try_for_each(|(name, field)| validate_override_field(name, field))
}

fn validate_override_identity(identity: &WorkMetadataIdentityDto) -> Result<(), String> {
    let valid = [
        &identity.plugin_id,
        &identity.novel_id,
        &identity.novel_path,
    ]
    .into_iter()
    .all(|text| !text.is_empty() && text.encode_utf16().count() <= MAX_TEXT_UNITS);
    if !valid {
        return Err("work override: identity is invalid".to_string());
    }
    Ok(())
}

pub fn parse_work_override_bytes(bytes: &[u8]) -> Result<WorkOverrideV1Dto, String> {
    if bytes.len() > MAX_WORK_OVERRIDE_BYTES {
        return Err("work override: document exceeds size limit".to_string());
    }
    let document: WorkOverrideV1Dto = serde_json::from_slice(bytes)
        .map_err(|err| format!("work override: invalid JSON: {err}"))?;
    if document.schema_version != 1 {
        return Err("work override: unsupported version".to_string());
    }
    validate_override_identity(&document.identity)?;
    validate_override_fields(&document.fields)?;
    Ok(document)
}

/// Per field, the strictly newer edit wins and an equal time keeps `base`.
pub fn merge_override_fields(
    base: &WorkOverrideFields,
    incoming: &WorkOverrideFields,
) -> WorkOverrideFields {
    let mut merged = base.clone();
    for (name, next) in incoming {
        if merged
            .get(name)
            .is_none_or(|kept| next.updated_at > kept.updated_at)
        {
            merged.insert(name.clone(), next.clone());
        }
    }
    merged
}

fn encode_work_override(
    identity: &WorkMetadataIdentityDto,
    fields: &WorkOverrideFields,
) -> Result<(WorkOverrideV1Dto, Vec<u8>), String> {
    validate_override_fields(fields)?;
    let document = WorkOverrideV1Dto {
        schema_version: 1,
        identity: identity.clone(),
        fields: fields.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|err| format!("work override: encode document: {err}"))?;
    if bytes.len() > MAX_WORK_OVERRIDE_BYTES {
        return Err("work override: document exceeds size limit".to_string());
    }
    Ok((document, bytes))
}

fn decode_override_payload(payload: &str) -> Result<WorkOverrideFields, String> {
    serde_json::from_str::<WorkOverridePayloadDto>(payload)
        .map(|stored| stored.fields)
        .map_err(|err| format!("work override: invalid stored JSON: {err}"))
}

async fn load_override_work_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<OverrideWork>, String> {
    let row = sqlx::query(
        "SELECT n.plugin_id, n.source_novel_id, n.path, f.directory \
         FROM novel n \
         LEFT JOIN work_metadata_file_cache f \
           ON f.plugin_id = n.plugin_id AND f.path = n.path AND f.novel_id = n.id \
         WHERE n.id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db novel override: load novel: {err}"))?;
    Ok(row.map(|row| {
        let source_novel_id: Option<String> = row.get("source_novel_id");
        let directory: Option<String> = row.get("directory");
        OverrideWork {
            directory: directory
                .filter(|_| source_novel_id.as_deref().is_some_and(|id| !id.is_empty())),
            identity: WorkMetadataIdentityDto {
                plugin_id: row.get("plugin_id"),
                novel_id: source_novel_id.unwrap_or_default(),
                novel_path: row.get("path"),
            },
        }
    }))
}

pub async fn load_novel_override_fields_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<WorkOverrideFields, String> {
    let payload: Option<String> =
        sqlx::query_scalar("SELECT payload FROM novel_override WHERE novel_id = ?1")
            .bind(novel_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db novel override: load override: {err}"))?;
    payload
        .as_deref()
        .map(decode_override_payload)
        .transpose()
        .map(Option::unwrap_or_default)
}

/// Replaces a novel's stored fields without touching files; an empty set removes the row.
pub async fn save_novel_override_fields_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
    fields: &WorkOverrideFields,
) -> Result<(), String> {
    validate_override_fields(fields)?;
    if fields.is_empty() {
        sqlx::query("DELETE FROM novel_override WHERE novel_id = ?1")
            .bind(novel_id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel override: delete override: {err}"))?;
        return Ok(());
    }
    let payload = serde_json::to_string(&WorkOverridePayloadDto {
        fields: fields.clone(),
    })
    .map_err(|err| format!("work override: encode stored JSON: {err}"))?;
    sqlx::query(
        "INSERT INTO novel_override(novel_id, payload) VALUES (?1, ?2) \
         ON CONFLICT(novel_id) DO UPDATE SET payload = excluded.payload",
    )
    .bind(novel_id)
    .bind(payload)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db novel override: save override: {err}"))?;
    Ok(())
}

const SELECT_STORED_OVERRIDES: &str = "\
  SELECT n.id, n.plugin_id, n.source_novel_id, n.path, n.is_local, o.payload \
  FROM novel_override o \
  JOIN novel n ON n.id = o.novel_id";

fn map_stored_override_row(row: sqlx::sqlite::SqliteRow) -> Result<StoredNovelOverrideDto, String> {
    let plugin_id: String = row.get("plugin_id");
    let payload: String = row.get("payload");
    Ok(StoredNovelOverrideDto {
        novel_id: row.get("id"),
        is_local: plugin_id == LOCAL_PLUGIN_ID && row.get::<i64, _>("is_local") != 0,
        document: WorkOverrideV1Dto {
            schema_version: 1,
            identity: WorkMetadataIdentityDto {
                plugin_id,
                novel_id: row
                    .get::<Option<String>, _>("source_novel_id")
                    .unwrap_or_default(),
                novel_path: row.get("path"),
            },
            fields: decode_override_payload(&payload)?,
        },
    })
}

pub async fn get_novel_override_in_conn(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<WorkOverrideV1Dto>, String> {
    let sql = format!("{SELECT_STORED_OVERRIDES} WHERE o.novel_id = ?1");
    sqlx::query(&sql)
        .bind(novel_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db novel override: get override: {err}"))?
        .map(|row| map_stored_override_row(row).map(|stored| stored.document))
        .transpose()
}

pub async fn list_novel_overrides_in_conn(
    conn: &mut SqliteConnection,
) -> Result<Vec<StoredNovelOverrideDto>, String> {
    let sql = format!("{SELECT_STORED_OVERRIDES} ORDER BY n.id");
    sqlx::query(&sql)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel override: list overrides: {err}"))?
        .into_iter()
        .map(map_stored_override_row)
        .collect()
}

/// Stores a novel's override and mirrors it to `override.json` in the work's known metadata
/// directory: written while fields exist, removed once they are empty. A work without a
/// published `novel.json` gets its file when that directory is first published.
pub async fn store_novel_override_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    fields: &WorkOverrideFields,
) -> Result<WorkOverrideV1Dto, String> {
    let work = load_override_work_in_conn(&mut *conn, novel_id)
        .await?
        .ok_or_else(|| "work override: novel not found".to_string())?;
    let (document, bytes) = encode_work_override(&work.identity, fields)?;
    save_novel_override_fields_in_conn(&mut *conn, novel_id, fields).await?;

    if let (Some(root), Some(directory)) = (root, work.directory.as_deref()) {
        let relative = format!("{directory}/{OVERRIDE_FILE_NAME}");
        ctx.snapshot_work_metadata_file(root, &relative)?;
        if fields.is_empty() {
            crate::chapter_media::remove_work_metadata_file_at(root, &relative)?;
        } else {
            crate::chapter_media::write_work_metadata_bytes_at(root, &relative, &bytes)?;
        }
    }
    if let Some(directory) = work.directory {
        ctx.record_work_directory(WorkDirectoryUpdateDto {
            novel_id,
            plugin_id: work.identity.plugin_id,
            novel_path: work.identity.novel_path,
            directory: Some(directory),
            fingerprint: None,
        });
    }
    ctx.mark_work_metadata_changed();
    Ok(document)
}

/// A local user edit: the new entry always outlives the entry it replaces.
pub async fn set_novel_override_field_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    field: &str,
    value: JsonValue,
    updated_at: i64,
) -> Result<WorkOverrideV1Dto, String> {
    let mut entry = WorkOverrideFieldDto { value, updated_at };
    validate_override_field(field, &entry)?;
    let mut fields = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    if let Some(existing) = fields.get(field) {
        entry.updated_at = updated_at.max(existing.updated_at.saturating_add(1));
        validate_override_field(field, &entry)?;
    }
    fields.insert(field.to_string(), entry);
    store_novel_override_in_tx(root, conn, ctx, novel_id, &fields).await
}

/// Stores `merge(stored, incoming)` under the novel's own identity.
pub async fn merge_novel_override_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    incoming: &WorkOverrideFields,
) -> Result<NovelOverrideMergeResultDto, String> {
    validate_override_fields(incoming)?;
    let current = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    let merged = merge_override_fields(&current, incoming);
    let changed = merged != current;
    let document = if changed {
        store_novel_override_in_tx(root, conn, ctx, novel_id, &merged).await?
    } else {
        let work = load_override_work_in_conn(&mut *conn, novel_id)
            .await?
            .ok_or_else(|| "work override: novel not found".to_string())?;
        WorkOverrideV1Dto {
            schema_version: 1,
            identity: work.identity,
            fields: merged,
        }
    };
    Ok(NovelOverrideMergeResultDto {
        document: (!document.fields.is_empty()).then_some(document),
        changed,
    })
}

/// Merges the `override.json` found in a work directory into the stored override. The file
/// only supplies fields: a missing, unreadable, invalid or foreign file is skipped so user
/// settings can never block recovery, and reading back never rewrites the file.
pub async fn adopt_stored_novel_override_in_tx(
    root: &Path,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    directory: &str,
) -> Result<(), String> {
    let relative = format!("{directory}/{OVERRIDE_FILE_NAME}");
    let stored = match crate::chapter_media::read_work_metadata_bytes_at(root, &relative) {
        Ok(None) => return Ok(()),
        Ok(Some(bytes)) => parse_work_override_bytes(&bytes),
        Err(error) => Err(error),
    };
    let Some(work) = load_override_work_in_conn(&mut *conn, novel_id).await? else {
        return Ok(());
    };
    let incoming = match stored {
        Ok(document) if document.identity == work.identity => document.fields,
        Ok(_) => {
            log::warn!("[work-override] skipped {relative}: it belongs to another work");
            return Ok(());
        }
        Err(error) => {
            log::warn!("[work-override] skipped {relative}: {error}");
            return Ok(());
        }
    };
    let current = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    let merged = merge_override_fields(&current, &incoming);
    if merged == current {
        return Ok(());
    }
    if let Err(error) = encode_work_override(&work.identity, &merged) {
        log::warn!("[work-override] skipped {relative}: {error}");
        return Ok(());
    }
    store_novel_override_in_tx(None, conn, ctx, novel_id, &merged).await?;
    Ok(())
}

/// Writes a stored override beside a `novel.json` that is being published when the work
/// directory has no `override.json`; an existing file is left for the next edit or recovery.
pub(super) async fn publish_missing_override_file_in_tx(
    root: &Path,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    directory: &str,
) -> Result<(), String> {
    let fields = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    if fields.is_empty() {
        return Ok(());
    }
    let relative = format!("{directory}/{OVERRIDE_FILE_NAME}");
    if !matches!(
        crate::chapter_media::read_work_metadata_bytes_at(root, &relative),
        Ok(None)
    ) {
        return Ok(());
    }
    let Some(work) = load_override_work_in_conn(&mut *conn, novel_id).await? else {
        return Ok(());
    };
    let (_, bytes) = encode_work_override(&work.identity, &fields)?;
    ctx.snapshot_work_metadata_file(root, &relative)?;
    crate::chapter_media::write_work_metadata_bytes_at(root, &relative, &bytes)?;
    Ok(())
}

/// Removes the `override.json` of a work whose novel row is gone.
pub(super) fn remove_stored_override_file_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
) -> Result<(), String> {
    let relative = format!("{directory}/{OVERRIDE_FILE_NAME}");
    ctx.snapshot_work_metadata_file(root, &relative)?;
    crate::chapter_media::remove_work_metadata_file_at(root, &relative)
}

#[tauri::command]
pub async fn db_novel_override_get(
    db: State<'_, AppDatabase>,
    novel_id: i64,
    mode: Option<ReadMode>,
) -> Result<Option<WorkOverrideV1Dto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel override: acquire connection: {err}"))?;
    get_novel_override_in_conn(&mut conn, novel_id).await
}

#[tauri::command]
pub async fn db_novel_override_list(
    db: State<'_, AppDatabase>,
    mode: Option<ReadMode>,
) -> Result<Vec<StoredNovelOverrideDto>, String> {
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel override: acquire connection: {err}"))?;
    list_novel_overrides_in_conn(&mut conn).await
}

#[tauri::command]
pub async fn db_novel_override_set_field(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    field: String,
    value: JsonValue,
    updated_at: i64,
) -> Result<DbMutationEnvelope<WorkOverrideV1Dto>, String> {
    let root = crate::chapter_media::media_root(&app).ok();
    let mut opts = TxOptions::with_app_metadata(app);
    opts.busy_begin_retries = 3;
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move {
            set_novel_override_field_in_tx(
                root.as_deref(),
                conn,
                ctx,
                novel_id,
                &field,
                value,
                updated_at,
            )
            .await
        })
    })
    .await
}

#[tauri::command]
pub async fn db_novel_override_merge(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    document: WorkOverrideV1Dto,
) -> Result<DbMutationEnvelope<NovelOverrideMergeResultDto>, String> {
    if document.schema_version != 1 {
        return Err("work override: unsupported version".to_string());
    }
    let root = crate::chapter_media::media_root(&app).ok();
    let mut opts = TxOptions::with_app_metadata(app);
    opts.busy_begin_retries = 3;
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move {
            merge_novel_override_in_tx(root.as_deref(), conn, ctx, novel_id, &document.fields).await
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::novel::{get_novel_by_id_in_conn, list_check_candidates_in_conn};
    use crate::db::test_support::{open_test_db, TestDb};
    use crate::db::tx::MetadataRoot;
    use crate::db::work_metadata::{recover_work_metadata_at, WorkMetadataRecoveryState};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    const OVERRIDE_PATH: &str = "contents/source/book/override.json";

    fn entry(value: JsonValue, updated_at: i64) -> WorkOverrideFieldDto {
        WorkOverrideFieldDto { value, updated_at }
    }

    fn fields(entries: &[(&str, JsonValue, i64)]) -> WorkOverrideFields {
        entries
            .iter()
            .map(|(name, value, updated_at)| (name.to_string(), entry(value.clone(), *updated_at)))
            .collect()
    }

    fn publishing(root: &Path) -> TxOptions {
        TxOptions {
            metadata_root: MetadataRoot::Path(root.to_path_buf()),
            ..TxOptions::default()
        }
    }

    async fn seed_novels(test_db: &TestDb, options: TxOptions) {
        with_write_tx(test_db.db.writer(), options, |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, status, in_library, is_local) \
                     VALUES (1, 'source', 'book', '/book', 'Book', 'Ongoing', 1, 0), \
                            (2, 'local', 'shelf', 'local', 'Shelf', NULL, 1, 1), \
                            (3, 'source', NULL, '/unpublished', 'Unpublished', NULL, 1, 0)",
                )
                .execute(&mut *conn)
                .await
                .map_err(|err| err.to_string())?;
                Ok(())
            })
        })
        .await
        .expect("seed novels");
    }

    async fn published_root(test_db: &TestDb) -> PathBuf {
        let root = test_db.dir.path().join("media");
        fs::create_dir_all(&root).unwrap();
        with_write_tx(test_db.db.writer(), publishing(&root), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library) \
                     VALUES (1, 'source', 'book', '/book', 'Book', 1)",
                )
                .execute(&mut *conn)
                .await
                .map_err(|err| err.to_string())?;
                Ok(())
            })
        })
        .await
        .expect("publish novel.json");
        assert!(root.join("contents/source/book/novel.json").is_file());
        root
    }

    async fn stored_payload(test_db: &TestDb, novel_id: i64) -> Option<String> {
        sqlx::query_scalar("SELECT payload FROM novel_override WHERE novel_id = ?1")
            .bind(novel_id)
            .fetch_optional(test_db.db.writer())
            .await
            .unwrap()
    }

    async fn set_field(
        test_db: &TestDb,
        options: TxOptions,
        root: Option<PathBuf>,
        novel_id: i64,
        field: &'static str,
        value: JsonValue,
        updated_at: i64,
    ) -> Result<DbMutationEnvelope<WorkOverrideV1Dto>, String> {
        with_write_tx(test_db.db.writer(), options, move |conn, ctx| {
            Box::pin(async move {
                set_novel_override_field_in_tx(
                    root.as_deref(),
                    conn,
                    ctx,
                    novel_id,
                    field,
                    value,
                    updated_at,
                )
                .await
            })
        })
        .await
    }

    async fn completed_override(conn: &mut SqliteConnection, novel_id: i64) -> Option<bool> {
        get_novel_by_id_in_conn(conn, novel_id)
            .await
            .unwrap()
            .unwrap()
            .completed_override
    }

    #[test]
    fn validates_field_names_values_and_edit_times() {
        for (name, value, updated_at) in [
            ("completed", json!(true), 1),
            ("completed", json!(false), MAX_SAFE_INTEGER),
            ("completed", JsonValue::Null, 1_763_350_000_000),
            ("title", json!("Custom title"), 5),
            ("t", json!("x".repeat(MAX_TEXT_UNITS)), 5),
            ("volumeCount2", json!(12.5), 5),
            (&"a".repeat(MAX_FIELD_NAME_LENGTH), JsonValue::Null, 5),
        ] {
            assert!(
                validate_override_field(name, &entry(value.clone(), updated_at)).is_ok(),
                "{name}={value}@{updated_at}"
            );
        }
        for (name, value, updated_at) in [
            ("completed", json!("yes"), 5),
            ("completed", json!(1), 5),
            ("completed", json!(true), 0),
            ("completed", json!(true), -1),
            ("completed", json!(true), MAX_SAFE_INTEGER + 1),
            ("title", json!(["a"]), 5),
            ("title", json!({ "text": "a" }), 5),
            ("title", json!("x".repeat(MAX_TEXT_UNITS + 1)), 5),
            ("", JsonValue::Null, 5),
            ("Title", JsonValue::Null, 5),
            ("1st", JsonValue::Null, 5),
            ("sub_title", JsonValue::Null, 5),
            ("제목", JsonValue::Null, 5),
            (&"a".repeat(MAX_FIELD_NAME_LENGTH + 1), JsonValue::Null, 5),
        ] {
            assert!(
                validate_override_field(name, &entry(value.clone(), updated_at)).is_err(),
                "{name}={value}@{updated_at}"
            );
        }

        let mut many: WorkOverrideFields = (0..MAX_FIELDS)
            .map(|index| (format!("field{index}"), entry(JsonValue::Null, 1)))
            .collect();
        assert!(validate_override_fields(&many).is_ok());
        many.insert("oneTooMany".to_string(), entry(JsonValue::Null, 1));
        assert!(validate_override_fields(&many).is_err());
    }

    #[test]
    fn parses_documents_and_keeps_unknown_fields() {
        let document = json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
            "fields": {
                "futureField": { "value": "kept", "updatedAt": 9 },
                "completed": { "value": null, "updatedAt": 1763350000000_i64 }
            },
            "futureSection": true
        });
        let parsed = parse_work_override_bytes(document.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.identity.novel_id, "book");
        assert_eq!(
            parsed.fields,
            fields(&[
                ("completed", JsonValue::Null, 1_763_350_000_000),
                ("futureField", json!("kept"), 9),
            ])
        );
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            r#"{"schemaVersion":1,"identity":{"pluginId":"source","novelId":"book","novelPath":"/book"},"fields":{"completed":{"value":null,"updatedAt":1763350000000},"futureField":{"value":"kept","updatedAt":9}}}"#
        );

        let rejected = |mutate: fn(&mut JsonValue)| {
            let mut changed = document.clone();
            mutate(&mut changed);
            parse_work_override_bytes(changed.to_string().as_bytes()).is_err()
        };
        assert!(rejected(|value| value["schemaVersion"] = json!(2)));
        assert!(rejected(|value| {
            value.as_object_mut().unwrap().remove("schemaVersion");
        }));
        assert!(rejected(|value| value["identity"]["novelId"] = json!("")));
        assert!(rejected(|value| {
            value["identity"]
                .as_object_mut()
                .unwrap()
                .remove("novelPath");
        }));
        assert!(rejected(|value| value["fields"] = json!([])));
        assert!(rejected(
            |value| value["fields"]["completed"]["value"] = json!("done")
        ));
        assert!(rejected(
            |value| value["fields"]["completed"]["extra"] = json!(1)
        ));
        assert!(rejected(|value| {
            value["fields"]["completed"]
                .as_object_mut()
                .unwrap()
                .remove("value");
        }));
        assert!(rejected(
            |value| value["fields"]["completed"]["updatedAt"] = json!("9")
        ));
        assert!(rejected(
            |value| value["fields"]["bad name"] = json!({ "value": 1, "updatedAt": 9 })
        ));
        assert!(parse_work_override_bytes(b"not json").is_err());

        let mut oversized = document.to_string().into_bytes();
        oversized.resize(MAX_WORK_OVERRIDE_BYTES + 1, b' ');
        assert!(parse_work_override_bytes(&oversized)
            .unwrap_err()
            .contains("size limit"));
    }

    #[test]
    fn merge_takes_strictly_newer_entries_and_keeps_base_on_equal_times() {
        let base = fields(&[
            ("completed", json!(true), 10),
            ("note", json!("base"), 5),
            ("baseOnly", json!(1), 1),
        ]);
        let incoming = fields(&[
            ("completed", json!(false), 11),
            ("note", json!("incoming"), 5),
            ("incomingOnly", JsonValue::Null, 1),
        ]);
        let merged = merge_override_fields(&base, &incoming);
        assert_eq!(
            merged,
            fields(&[
                ("baseOnly", json!(1), 1),
                ("completed", json!(false), 11),
                ("incomingOnly", JsonValue::Null, 1),
                ("note", json!("base"), 5),
            ])
        );
        assert_eq!(merge_override_fields(&merged, &incoming), merged);
        assert_eq!(merge_override_fields(&merged, &base), merged);
        assert_eq!(
            merge_override_fields(&base, &WorkOverrideFields::new()),
            base
        );
        assert_eq!(
            merge_override_fields(&WorkOverrideFields::new(), &incoming),
            incoming
        );
    }

    #[tokio::test]
    async fn a_local_edit_always_outlives_the_entry_it_replaces() {
        let test_db = open_test_db().await;
        seed_novels(&test_db, TxOptions::default()).await;

        let first = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "completed",
            json!(true),
            100,
        )
        .await
        .unwrap();
        assert!(first.effects.work_metadata_changed);
        assert_eq!(
            first.value,
            WorkOverrideV1Dto {
                schema_version: 1,
                identity: WorkMetadataIdentityDto {
                    plugin_id: "source".to_string(),
                    novel_id: "book".to_string(),
                    novel_path: "/book".to_string(),
                },
                fields: fields(&[("completed", json!(true), 100)]),
            }
        );
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(r#"{"fields":{"completed":{"value":true,"updatedAt":100}}}"#)
        );

        let earlier_clock = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "completed",
            json!(false),
            50,
        )
        .await
        .unwrap();
        assert_eq!(
            earlier_clock.value.fields,
            fields(&[("completed", json!(false), 101)])
        );
        let same_clock = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "completed",
            json!(true),
            101,
        )
        .await
        .unwrap();
        assert_eq!(
            same_clock.value.fields,
            fields(&[("completed", json!(true), 102)])
        );
        let cleared = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "completed",
            JsonValue::Null,
            500,
        )
        .await
        .unwrap();
        assert_eq!(
            cleared.value.fields,
            fields(&[("completed", JsonValue::Null, 500)])
        );
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(r#"{"fields":{"completed":{"value":null,"updatedAt":500}}}"#)
        );

        for (novel_id, field, value, updated_at) in [
            (1, "completed", json!("yes"), 600),
            (1, "Completed", json!(true), 600),
            (1, "completed", json!(true), 0),
            (99, "completed", json!(true), 600),
        ] {
            assert!(
                set_field(
                    &test_db,
                    TxOptions::default(),
                    None,
                    novel_id,
                    field,
                    value,
                    updated_at
                )
                .await
                .is_err(),
                "{novel_id} {field}"
            );
        }
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(r#"{"fields":{"completed":{"value":null,"updatedAt":500}}}"#)
        );
        assert_eq!(stored_payload(&test_db, 99).await, None);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn reads_overrides_with_each_novels_identity_and_exposes_the_completed_flag() {
        let test_db = open_test_db().await;
        seed_novels(&test_db, TxOptions::default()).await;
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            2,
            "completed",
            json!(false),
            10,
        )
        .await
        .unwrap();
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            3,
            "completed",
            json!(true),
            10,
        )
        .await
        .unwrap();
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "completed",
            json!(true),
            10,
        )
        .await
        .unwrap();
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "futureField",
            json!("kept"),
            20,
        )
        .await
        .unwrap();

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        let listed = list_novel_overrides_in_conn(&mut conn).await.unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|stored| (stored.novel_id, stored.is_local))
                .collect::<Vec<_>>(),
            [(1, false), (2, true), (3, false)]
        );
        assert_eq!(
            listed[0].document.fields,
            fields(&[
                ("completed", json!(true), 10),
                ("futureField", json!("kept"), 20)
            ])
        );
        assert_eq!(listed[1].document.identity.plugin_id, "local");
        assert_eq!(listed[2].document.identity.novel_id, "");
        assert_eq!(
            get_novel_override_in_conn(&mut conn, 1).await.unwrap(),
            Some(listed[0].document.clone())
        );
        assert_eq!(
            get_novel_override_in_conn(&mut conn, 99).await.unwrap(),
            None
        );

        assert_eq!(completed_override(&mut conn, 1).await, Some(true));
        assert_eq!(completed_override(&mut conn, 2).await, Some(false));
        let candidates = list_check_candidates_in_conn(&mut conn, None)
            .await
            .unwrap();
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| (
                    candidate.novel_id,
                    candidate.status.as_deref(),
                    candidate.completed_override
                ))
                .collect::<Vec<_>>(),
            [(1, Some("Ongoing"), Some(true)), (3, None, Some(true))]
        );
        drop(conn);

        set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "completed",
            JsonValue::Null,
            30,
        )
        .await
        .unwrap();
        sqlx::query("DELETE FROM novel_override WHERE novel_id = 3")
            .execute(test_db.db.writer())
            .await
            .unwrap();
        let mut conn = test_db.db.writer().acquire().await.unwrap();
        assert_eq!(completed_override(&mut conn, 1).await, None);
        assert_eq!(completed_override(&mut conn, 3).await, None);
        let candidates = list_check_candidates_in_conn(&mut conn, None)
            .await
            .unwrap();
        assert!(candidates
            .iter()
            .all(|candidate| candidate.completed_override.is_none()));
        drop(conn);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn merge_reports_whether_the_stored_override_changed() {
        let test_db = open_test_db().await;
        seed_novels(&test_db, TxOptions::default()).await;
        let merge = |incoming: WorkOverrideFields, novel_id: i64| {
            with_write_tx(
                test_db.db.writer(),
                TxOptions::default(),
                move |conn, ctx| {
                    Box::pin(async move {
                        merge_novel_override_in_tx(None, conn, ctx, novel_id, &incoming).await
                    })
                },
            )
        };

        let empty = merge(WorkOverrideFields::new(), 1).await.unwrap();
        assert_eq!(
            empty.value,
            NovelOverrideMergeResultDto {
                document: None,
                changed: false
            }
        );
        assert!(!empty.effects.work_metadata_changed);
        assert_eq!(stored_payload(&test_db, 1).await, None);

        let created = merge(
            fields(&[("completed", json!(true), 10), ("note", json!("a"), 5)]),
            1,
        )
        .await
        .unwrap();
        assert!(created.value.changed);
        assert!(created.effects.work_metadata_changed);
        let document = created.value.document.unwrap();
        assert_eq!(document.identity.novel_path, "/book");

        let stale = merge(
            fields(&[("completed", json!(false), 10), ("note", json!("b"), 4)]),
            1,
        )
        .await
        .unwrap();
        assert_eq!(
            stale.value,
            NovelOverrideMergeResultDto {
                document: Some(document),
                changed: false
            }
        );
        assert!(!stale.effects.work_metadata_changed);

        let newer = merge(fields(&[("completed", JsonValue::Null, 11)]), 1)
            .await
            .unwrap();
        assert!(newer.value.changed);
        assert_eq!(
            newer.value.document.unwrap().fields,
            fields(&[("completed", JsonValue::Null, 11), ("note", json!("a"), 5)])
        );
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(
                r#"{"fields":{"completed":{"value":null,"updatedAt":11},"note":{"value":"a","updatedAt":5}}}"#
            )
        );

        assert!(merge(fields(&[("completed", json!("yes"), 12)]), 1)
            .await
            .is_err());
        assert!(merge(fields(&[("completed", json!(true), 12)]), 99)
            .await
            .is_err());
        assert!(merge(WorkOverrideFields::new(), 99).await.is_err());
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn the_file_follows_the_stored_override_and_rolls_back_with_the_transaction() {
        let test_db = open_test_db().await;
        let root = published_root(&test_db).await;
        let file = root.join(OVERRIDE_PATH);

        let failed_create = with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    set_novel_override_field_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        "completed",
                        json!(true),
                        100,
                    )
                    .await?;
                    assert!(root.join(OVERRIDE_PATH).is_file());
                    Err::<(), String>("abort after override write".to_string())
                })
            }
        })
        .await;
        assert_eq!(failed_create.unwrap_err(), "abort after override write");
        assert!(!file.exists());
        assert_eq!(stored_payload(&test_db, 1).await, None);

        let written = set_field(
            &test_db,
            publishing(&root),
            Some(root.clone()),
            1,
            "completed",
            json!(true),
            100,
        )
        .await
        .unwrap();
        assert_eq!(
            written
                .effects
                .work_directories
                .iter()
                .map(|work| work.directory.as_deref())
                .collect::<Vec<_>>(),
            [Some("contents/source/book")]
        );
        let published = fs::read(&file).unwrap();
        assert_eq!(
            parse_work_override_bytes(&published).unwrap(),
            written.value
        );
        assert_eq!(
            serde_json::from_slice::<JsonValue>(&published).unwrap(),
            json!({
                "schemaVersion": 1,
                "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
                "fields": { "completed": { "value": true, "updatedAt": 100 } }
            })
        );

        let failed_update = with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    set_novel_override_field_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        "completed",
                        json!(false),
                        200,
                    )
                    .await?;
                    store_novel_override_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        &WorkOverrideFields::new(),
                    )
                    .await?;
                    assert!(!root.join(OVERRIDE_PATH).exists());
                    Err::<(), String>("abort after override removal".to_string())
                })
            }
        })
        .await;
        assert_eq!(failed_update.unwrap_err(), "abort after override removal");
        assert_eq!(fs::read(&file).unwrap(), published);
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(r#"{"fields":{"completed":{"value":true,"updatedAt":100}}}"#)
        );

        with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    store_novel_override_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        &WorkOverrideFields::new(),
                    )
                    .await
                })
            }
        })
        .await
        .unwrap();
        assert!(!file.exists());
        assert_eq!(stored_payload(&test_db, 1).await, None);
        assert!(root.join("contents/source/book/novel.json").is_file());
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn no_file_is_written_without_a_published_work_directory_until_metadata_is_published() {
        let test_db = open_test_db().await;
        let root = test_db.dir.path().join("media");
        fs::create_dir_all(&root).unwrap();
        seed_novels(&test_db, TxOptions::default()).await;
        sqlx::query("DELETE FROM novel WHERE id = 3")
            .execute(test_db.db.writer())
            .await
            .unwrap();

        set_field(
            &test_db,
            TxOptions::default(),
            Some(root.clone()),
            1,
            "completed",
            json!(true),
            100,
        )
        .await
        .unwrap();
        assert!(!root.join("contents").exists());

        with_write_tx(test_db.db.writer(), publishing(&root), |_conn, _ctx| {
            Box::pin(async move { Ok(()) })
        })
        .await
        .unwrap();
        assert!(root.join("contents/source/book/novel.json").is_file());
        assert_eq!(
            parse_work_override_bytes(&fs::read(root.join(OVERRIDE_PATH)).unwrap())
                .unwrap()
                .fields,
            fields(&[("completed", json!(true), 100)])
        );
        assert!(!root.join("contents/local/shelf/override.json").exists());

        let kept = br#"{"schemaVersion":1,"identity":{"pluginId":"source","novelId":"book","novelPath":"/book"},"fields":{"completed":{"value":false,"updatedAt":900}}}"#;
        fs::write(root.join(OVERRIDE_PATH), kept).unwrap();
        with_write_tx(test_db.db.writer(), publishing(&root), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query("UPDATE novel SET name = 'Renamed' WHERE id = 1")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                Ok(())
            })
        })
        .await
        .unwrap();
        assert_eq!(fs::read(root.join(OVERRIDE_PATH)).unwrap(), kept);

        let failed_delete = with_write_tx(test_db.db.writer(), publishing(&root), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query("DELETE FROM novel WHERE id = 1")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                sqlx::query("INSERT INTO missing_table VALUES (1)")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                Ok(())
            })
        })
        .await;
        assert!(failed_delete.is_err());
        assert_eq!(fs::read(root.join(OVERRIDE_PATH)).unwrap(), kept);

        with_write_tx(test_db.db.writer(), publishing(&root), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query("DELETE FROM novel WHERE id = 1")
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| err.to_string())?;
                Ok(())
            })
        })
        .await
        .unwrap();
        assert!(!root.join(OVERRIDE_PATH).exists());
        assert!(!root.join("contents/source/book/novel.json").exists());
        assert_eq!(stored_payload(&test_db, 1).await, None);
        test_db.db.close().await;
    }

    fn write_work(root: &Path, novel_id: &str, path: &str, stored_override: Option<&[u8]>) {
        let directory = root.join("contents/source").join(novel_id);
        fs::create_dir_all(&directory).unwrap();
        let metadata = json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": novel_id, "novelPath": path },
            "novel": { "name": novel_id, "isLocal": false },
            "cover": null,
            "chapters": {}
        });
        fs::write(
            directory.join("novel.json"),
            serde_json::to_vec_pretty(&metadata).unwrap(),
        )
        .unwrap();
        if let Some(bytes) = stored_override {
            fs::write(directory.join("override.json"), bytes).unwrap();
        }
    }

    fn override_bytes(novel_id: &str, path: &str, stored: JsonValue) -> Vec<u8> {
        json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": novel_id, "novelPath": path },
            "fields": stored
        })
        .to_string()
        .into_bytes()
    }

    async fn recover(test_db: &TestDb, root: &Path, rebuild: bool) {
        let state = WorkMetadataRecoveryState::default();
        let token = state.start_generation();
        let result = recover_work_metadata_at(
            test_db.db.writer(),
            Some(root.to_path_buf()),
            rebuild,
            &state,
            token,
            |_| {},
        )
        .await
        .expect("recovery succeeds");
        assert_eq!(result.value.recovered_works, result.value.total_works);
    }

    #[tokio::test]
    async fn recovery_merges_stored_override_files_and_ignores_unusable_ones() {
        let test_db = open_test_db().await;
        let root = test_db.dir.path().join("media");
        write_work(
            &root,
            "book",
            "/book",
            Some(&override_bytes(
                "book",
                "/book",
                json!({ "completed": { "value": true, "updatedAt": 100 }, "note": { "value": "disk", "updatedAt": 5 } }),
            )),
        );
        write_work(
            &root,
            "foreign",
            "/foreign",
            Some(&override_bytes(
                "book",
                "/book",
                json!({ "completed": { "value": true, "updatedAt": 100 } }),
            )),
        );
        write_work(&root, "broken", "/broken", Some(b"{ not json"));
        write_work(
            &root,
            "invalid",
            "/invalid",
            Some(&override_bytes(
                "invalid",
                "/invalid",
                json!({ "completed": { "value": "yes", "updatedAt": 100 } }),
            )),
        );
        write_work(&root, "plain", "/plain", None);

        recover(&test_db, &root, false).await;
        let recovered: Vec<(String, String)> = sqlx::query_as(
            "SELECT n.path, o.payload FROM novel_override o JOIN novel n ON n.id = o.novel_id",
        )
        .fetch_all(test_db.db.writer())
        .await
        .unwrap();
        assert_eq!(
            recovered,
            [(
                "/book".to_string(),
                r#"{"fields":{"completed":{"value":true,"updatedAt":100},"note":{"value":"disk","updatedAt":5}}}"#.to_string()
            )]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM novel")
                .fetch_one(test_db.db.writer())
                .await
                .unwrap(),
            5
        );

        let book_id: i64 = sqlx::query_scalar("SELECT id FROM novel WHERE path = '/book'")
            .fetch_one(test_db.db.writer())
            .await
            .unwrap();
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            book_id,
            "completed",
            json!(false),
            300,
        )
        .await
        .unwrap();
        let disk = override_bytes(
            "book",
            "/book",
            json!({
                "completed": { "value": true, "updatedAt": 200 },
                "note": { "value": "newer disk", "updatedAt": 6 },
                "diskOnly": { "value": 1, "updatedAt": 1 }
            }),
        );
        fs::write(root.join(OVERRIDE_PATH), &disk).unwrap();
        recover(&test_db, &root, true).await;
        assert_eq!(
            stored_payload(&test_db, book_id).await.as_deref(),
            Some(
                r#"{"fields":{"completed":{"value":false,"updatedAt":300},"diskOnly":{"value":1,"updatedAt":1},"note":{"value":"newer disk","updatedAt":6}}}"#
            )
        );
        assert_eq!(fs::read(root.join(OVERRIDE_PATH)).unwrap(), disk);
        assert_eq!(
            fs::read(root.join("contents/source/broken/override.json")).unwrap(),
            b"{ not json"
        );
        test_db.db.close().await;
    }
}
