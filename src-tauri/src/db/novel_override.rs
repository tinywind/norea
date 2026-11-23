//! User-set work metadata (`override.json`), stored apart from source metadata so
//! neither a source refresh nor a metadata install can change it.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{AssertSqlSafe, Row, SqliteConnection};
use tauri::{AppHandle, State};

use crate::database::AppDatabase;

use super::novel::{is_novel_status, LOCAL_PLUGIN_ID};
use super::tx::{with_write_tx, TxContext, TxOptions};
use super::work_metadata::WorkMetadataIdentityDto;
use super::{DbMutationEnvelope, ReadMode, WorkDirectoryUpdateDto};

pub const MAX_WORK_OVERRIDE_BYTES: usize = 256 * 1024;
const MAX_FIELDS: usize = 64;
const MAX_FIELD_NAME_LENGTH: usize = 64;
const MAX_TEXT_UNITS: usize = 8192;
const MAX_SUMMARY_TEXT_UNITS: usize = 65536;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const OVERRIDE_FILE_NAME: &str = "override.json";
const COMPLETED_FIELD: &str = "completed";
const STATUS_FIELD: &str = "status";
const COVER_FIELD: &str = "cover";
const NAME_FIELD: &str = "name";
const SUMMARY_FIELD: &str = "summary";

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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum NovelOverrideCoverActionDto {
    Keep,
    Clear,
    Set {
        #[serde(rename = "fileName")]
        file_name: String,
        bytes: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelOverrideCoverBytesDto {
    pub file_name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

struct OverrideWork {
    identity: WorkMetadataIdentityDto,
    directory: Option<String>,
}

fn override_cover_content_type(file_name: &str) -> &'static str {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("gif") => "image/gif",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn is_field_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= MAX_FIELD_NAME_LENGTH
        && bytes.next().is_some_and(|byte| byte.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_alphanumeric())
}

fn validate_override_field(name: &str, field: &WorkOverrideFieldDto) -> Result<(), String> {
    let valid_value = match name {
        COMPLETED_FIELD => matches!(&field.value, JsonValue::Null | JsonValue::Bool(_)),
        STATUS_FIELD => match &field.value {
            JsonValue::Null => true,
            JsonValue::String(text) => is_novel_status(text),
            _ => false,
        },
        COVER_FIELD => match &field.value {
            JsonValue::Null => true,
            JsonValue::String(text) => crate::chapter_media::is_override_cover_file(text),
            _ => false,
        },
        NAME_FIELD => match &field.value {
            JsonValue::Null => true,
            JsonValue::String(text) => {
                !text.trim().is_empty() && text.encode_utf16().count() <= MAX_TEXT_UNITS
            }
            _ => false,
        },
        SUMMARY_FIELD => match &field.value {
            JsonValue::Null => true,
            JsonValue::String(text) => text.encode_utf16().count() <= MAX_SUMMARY_TEXT_UNITS,
            _ => false,
        },
        _ => match &field.value {
            JsonValue::Null | JsonValue::Bool(_) => true,
            JsonValue::Number(number) => number.as_f64().is_some_and(f64::is_finite),
            JsonValue::String(text) => text.encode_utf16().count() <= MAX_TEXT_UNITS,
            JsonValue::Array(_) | JsonValue::Object(_) => false,
        },
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

pub fn normalize_override_fields(fields: &WorkOverrideFields) -> Result<WorkOverrideFields, String> {
    validate_override_fields(fields)?;
    let mut normalized = WorkOverrideFields::new();
    let mut legacy_completed: Option<WorkOverrideFieldDto> = None;
    for (name, field) in fields {
        if name == COMPLETED_FIELD {
            let status_value = match &field.value {
                JsonValue::Bool(true) => JsonValue::String("Completed".to_string()),
                JsonValue::Bool(false) => JsonValue::String("Ongoing".to_string()),
                JsonValue::Null => JsonValue::Null,
                _ => unreachable!("validated completed value"),
            };
            legacy_completed = Some(WorkOverrideFieldDto {
                value: status_value,
                updated_at: field.updated_at,
            });
            continue;
        }
        let mut entry = field.clone();
        if name == NAME_FIELD {
            if let JsonValue::String(ref text) = entry.value {
                entry.value = JsonValue::String(text.trim().to_string());
            }
        }
        normalized.insert(name.clone(), entry);
    }
    if let Some(legacy) = legacy_completed {
        if normalized
            .get(STATUS_FIELD)
            .is_none_or(|kept| legacy.updated_at > kept.updated_at)
        {
            normalized.insert(STATUS_FIELD.to_string(), legacy);
        }
    }
    Ok(normalized)
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
    let mut document: WorkOverrideV1Dto = serde_json::from_slice(bytes)
        .map_err(|err| format!("work override: invalid JSON: {err}"))?;
    if document.schema_version != 1 {
        return Err("work override: unsupported version".to_string());
    }
    validate_override_identity(&document.identity)?;
    document.fields = normalize_override_fields(&document.fields)?;
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
    let stored = serde_json::from_str::<WorkOverridePayloadDto>(payload)
        .map_err(|err| format!("work override: invalid stored JSON: {err}"))?;
    normalize_override_fields(&stored.fields)
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
    let normalized = normalize_override_fields(fields)?;
    if normalized.is_empty() {
        sqlx::query("DELETE FROM novel_override WHERE novel_id = ?1")
            .bind(novel_id)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db novel override: delete override: {err}"))?;
        return Ok(());
    }
    let payload = serde_json::to_string(&WorkOverridePayloadDto { fields: normalized })
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
    sqlx::query(AssertSqlSafe(sql))
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
    sqlx::query(AssertSqlSafe(sql))
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db novel override: list overrides: {err}"))?
        .into_iter()
        .map(map_stored_override_row)
        .collect()
}

fn remove_override_cover_files_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
    keep_file: Option<&str>,
) -> Result<bool, String> {
    let entries = match fs::read_dir(root.join(directory)) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(format!("work override: list override covers: {err}")),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("work override: read override cover entry: {err}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if crate::chapter_media::is_override_cover_file(&name) && keep_file != Some(name.as_str()) {
            names.push(name);
        }
    }
    names.sort();
    let removed_any = !names.is_empty();
    for name in names {
        let relative = format!("{directory}/{name}");
        ctx.snapshot_work_metadata_file(root, &relative)?;
        crate::chapter_media::remove_work_metadata_file_at(root, &relative)?;
    }
    Ok(removed_any)
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
    let normalized = normalize_override_fields(fields)?;
    let (document, bytes) = encode_work_override(&work.identity, &normalized)?;
    save_novel_override_fields_in_conn(&mut *conn, novel_id, &normalized).await?;

    if let (Some(root), Some(directory)) = (root, work.directory.as_deref()) {
        let active_cover = normalized
            .get(COVER_FIELD)
            .and_then(|entry| entry.value.as_str())
            .filter(|name| crate::chapter_media::is_override_cover_file(name));
        if remove_override_cover_files_in_tx(root, ctx, directory, active_cover)? {
            ctx.record_cover_changed(novel_id);
        }
        let relative = format!("{directory}/{OVERRIDE_FILE_NAME}");
        ctx.snapshot_work_metadata_file(root, &relative)?;
        if normalized.is_empty() {
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
    if field == COMPLETED_FIELD || field == COVER_FIELD {
        return Err(format!(
            "work override: field '{field}' cannot be updated directly"
        ));
    }
    let normalized_value = if field == NAME_FIELD {
        match value {
            JsonValue::String(text) => JsonValue::String(text.trim().to_string()),
            other => other,
        }
    } else {
        value
    };
    let mut entry = WorkOverrideFieldDto {
        value: normalized_value,
        updated_at,
    };
    validate_override_field(field, &entry)?;
    let mut fields = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    if let Some(existing) = fields.get(field) {
        entry.updated_at = updated_at.max(existing.updated_at.saturating_add(1));
        validate_override_field(field, &entry)?;
    }
    fields.insert(field.to_string(), entry);
    store_novel_override_in_tx(root, conn, ctx, novel_id, &fields).await
}

/// Applies multiple user field edits and an optional cover override update in one transaction.
pub async fn update_novel_override_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    updates: &BTreeMap<String, JsonValue>,
    cover: NovelOverrideCoverActionDto,
    updated_at: i64,
) -> Result<WorkOverrideV1Dto, String> {
    if updated_at <= 0 || updated_at > MAX_SAFE_INTEGER {
        return Err("work override: updatedAt is invalid".to_string());
    }
    let mut work = load_override_work_in_conn(&mut *conn, novel_id)
        .await?
        .ok_or_else(|| "work override: novel not found".to_string())?;
    let mut fields = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    let mut mutated = false;

    for (name, raw_value) in updates {
        if name == COMPLETED_FIELD || name == COVER_FIELD {
            return Err(format!(
                "work override: field '{name}' cannot be passed in fields map"
            ));
        }
        let value = if name == NAME_FIELD {
            match raw_value {
                JsonValue::String(text) => JsonValue::String(text.trim().to_string()),
                other => other.clone(),
            }
        } else {
            raw_value.clone()
        };
        let entry_updated_at = match fields.get(name) {
            Some(existing) => updated_at.max(existing.updated_at.saturating_add(1)),
            None => updated_at,
        };
        let entry = WorkOverrideFieldDto {
            value,
            updated_at: entry_updated_at,
        };
        validate_override_field(name, &entry)?;
        fields.insert(name.clone(), entry);
        mutated = true;
    }

    match cover {
        NovelOverrideCoverActionDto::Keep => {}
        NovelOverrideCoverActionDto::Clear => {
            let had_cover_value = fields
                .get(COVER_FIELD)
                .is_some_and(|existing| !existing.value.is_null());
            let mut removed_cover_file = false;
            if let (Some(root), Some(directory)) = (root, work.directory.as_deref()) {
                removed_cover_file = remove_override_cover_files_in_tx(root, ctx, directory, None)?;
            }
            if had_cover_value {
                let entry_updated_at = match fields.get(COVER_FIELD) {
                    Some(existing) => updated_at.max(existing.updated_at.saturating_add(1)),
                    None => updated_at,
                };
                let entry = WorkOverrideFieldDto {
                    value: JsonValue::Null,
                    updated_at: entry_updated_at,
                };
                validate_override_field(COVER_FIELD, &entry)?;
                fields.insert(COVER_FIELD.to_string(), entry);
                mutated = true;
            }
            if had_cover_value || removed_cover_file {
                ctx.record_cover_changed(novel_id);
            }
        }
        NovelOverrideCoverActionDto::Set { file_name, bytes } => {
            if !crate::chapter_media::is_override_cover_file(&file_name) {
                return Err("work override: invalid override cover filename".to_string());
            }
            if bytes.is_empty() || bytes.len() > crate::chapter_media::MAX_COVER_BYTES {
                return Err("work override: invalid override cover size".to_string());
            }
            let Some(root) = root else {
                return Err("work override: storage root is unavailable".to_string());
            };
            if work.directory.is_none()
                && !work.identity.novel_id.is_empty()
                && work.identity.plugin_id != LOCAL_PLUGIN_ID
            {
                let in_library: i64 =
                    sqlx::query_scalar("SELECT in_library FROM novel WHERE id = ?1")
                        .bind(novel_id)
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(|err| format!("db novel override: check in_library: {err}"))?
                        .unwrap_or(0);
                if in_library != 0 {
                    let other_dirty: Vec<(String, String)> = sqlx::query_as(
                        "SELECT plugin_id, path FROM work_metadata_dirty \
                         WHERE NOT (plugin_id = ?1 AND path = ?2)",
                    )
                    .bind(&work.identity.plugin_id)
                    .bind(&work.identity.novel_path)
                    .fetch_all(&mut *conn)
                    .await
                    .map_err(|err| format!("db novel override: stash dirty rows: {err}"))?;
                    sqlx::query("DELETE FROM work_metadata_dirty")
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db novel override: clear dirty rows: {err}"))?;
                    sqlx::query(
                        "INSERT INTO work_metadata_dirty(plugin_id, path) VALUES (?1, ?2) \
                         ON CONFLICT(plugin_id, path) DO NOTHING",
                    )
                    .bind(&work.identity.plugin_id)
                    .bind(&work.identity.novel_path)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db novel override: mark work dirty: {err}"))?;
                    let metadata_root = crate::db::tx::MetadataRoot::Path(root.to_path_buf());
                    super::work_metadata::flush_dirty_in_tx(&metadata_root, &mut *conn, ctx, None)
                        .await?;
                    for (dirty_plugin, dirty_path) in other_dirty {
                        sqlx::query(
                            "INSERT INTO work_metadata_dirty(plugin_id, path) VALUES (?1, ?2) \
                             ON CONFLICT(plugin_id, path) DO NOTHING",
                        )
                        .bind(dirty_plugin)
                        .bind(dirty_path)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db novel override: restore dirty rows: {err}"))?;
                    }
                    work = load_override_work_in_conn(&mut *conn, novel_id)
                        .await?
                        .ok_or_else(|| "work override: novel not found".to_string())?;
                }
            }
            let Some(directory) = work.directory.as_deref() else {
                return Err(
                    "work override: cover override requires a stored library work directory"
                        .to_string(),
                );
            };
            remove_override_cover_files_in_tx(root, ctx, directory, Some(&file_name))?;
            let relative = format!("{directory}/{file_name}");
            ctx.snapshot_work_metadata_file(root, &relative)?;
            crate::chapter_media::write_work_metadata_bytes_at(root, &relative, &bytes)?;
            let entry_updated_at = match fields.get(COVER_FIELD) {
                Some(existing) => updated_at.max(existing.updated_at.saturating_add(1)),
                None => updated_at,
            };
            let entry = WorkOverrideFieldDto {
                value: JsonValue::String(file_name),
                updated_at: entry_updated_at,
            };
            validate_override_field(COVER_FIELD, &entry)?;
            fields.insert(COVER_FIELD.to_string(), entry);
            ctx.record_cover_changed(novel_id);
            mutated = true;
        }
    }

    if !mutated {
        let normalized = normalize_override_fields(&fields)?;
        let (document, _) = encode_work_override(&work.identity, &normalized)?;
        return Ok(document);
    }
    store_novel_override_in_tx(root, conn, ctx, novel_id, &fields).await
}

/// Stores `merge(stored, incoming)` under the novel's own identity, updating or clearing
/// any `cover.override.<ext>` sibling file when the merged override changes `cover`.
pub async fn merge_novel_override_with_cover_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    incoming: &WorkOverrideFields,
    cover_bytes: Option<&[u8]>,
) -> Result<NovelOverrideMergeResultDto, String> {
    let normalized_incoming = normalize_override_fields(incoming)?;
    let current = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    let work = load_override_work_in_conn(&mut *conn, novel_id)
        .await?
        .ok_or_else(|| "work override: novel not found".to_string())?;
    let mut merged = merge_override_fields(&current, &normalized_incoming);
    let prev_cover = current
        .get(COVER_FIELD)
        .and_then(|entry| entry.value.as_str())
        .filter(|name| crate::chapter_media::is_override_cover_file(name));
    let next_cover = merged
        .get(COVER_FIELD)
        .and_then(|entry| entry.value.as_str())
        .filter(|name| crate::chapter_media::is_override_cover_file(name));
    let cover_field_changed = merged.get(COVER_FIELD) != current.get(COVER_FIELD);
    let incoming_won_cover = next_cover.is_some()
        && merged.get(COVER_FIELD) == normalized_incoming.get(COVER_FIELD)
        && (cover_field_changed || cover_bytes.is_some());

    let mut cover_file_changed = false;
    if incoming_won_cover {
        let target_file = next_cover.expect("checked next_cover");
        if let Some(bytes) = cover_bytes {
            if bytes.is_empty() || bytes.len() > crate::chapter_media::MAX_COVER_BYTES {
                return Err("work override: invalid override cover size".to_string());
            }
        }
        match (root, work.directory.as_deref(), cover_bytes) {
            (Some(root), Some(directory), Some(bytes)) => {
                if remove_override_cover_files_in_tx(root, ctx, directory, Some(target_file))? {
                    cover_file_changed = true;
                }
                let relative = format!("{directory}/{target_file}");
                ctx.snapshot_work_metadata_file(root, &relative)?;
                if crate::chapter_media::write_work_metadata_bytes_at(root, &relative, bytes)? {
                    cover_file_changed = true;
                }
                if cover_field_changed || cover_file_changed {
                    ctx.record_cover_changed(novel_id);
                }
            }
            (Some(root), Some(directory), None) if cover_field_changed => {
                let relative = format!("{directory}/{target_file}");
                let backed = matches!(
                    crate::chapter_media::read_work_metadata_bytes_at(root, &relative)?,
                    Some(existing) if !existing.is_empty()
                );
                if !backed {
                    return Err(
                        "work override: cover bytes are required for cover override".to_string()
                    );
                }
                ctx.record_cover_changed(novel_id);
            }
            (None, _, _) | (_, None, _) => {
                if let Some(prev) = current.get(COVER_FIELD) {
                    merged.insert(COVER_FIELD.to_string(), prev.clone());
                } else {
                    merged.remove(COVER_FIELD);
                }
            }
            _ => {}
        }
    } else if next_cover.is_none() && prev_cover.is_some() {
        if let (Some(root), Some(directory)) = (root, work.directory.as_deref()) {
            if remove_override_cover_files_in_tx(root, ctx, directory, None)? {
                cover_file_changed = true;
            }
        }
        ctx.record_cover_changed(novel_id);
    }

    let changed = merged != current || cover_file_changed;
    let document = if changed {
        store_novel_override_in_tx(root, conn, ctx, novel_id, &merged).await?
    } else {
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

/// Stores `merge(stored, incoming)` under the novel's own identity.
pub async fn merge_novel_override_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    incoming: &WorkOverrideFields,
) -> Result<NovelOverrideMergeResultDto, String> {
    merge_novel_override_with_cover_in_tx(root, conn, ctx, novel_id, incoming, None).await
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
    let mut incoming = match stored {
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
    if let Some(cover_file) = incoming
        .get(COVER_FIELD)
        .and_then(|entry| entry.value.as_str())
        .map(str::to_owned)
    {
        let cover_relative = format!("{directory}/{cover_file}");
        let backed = matches!(
            crate::chapter_media::read_work_metadata_bytes_at(root, &cover_relative),
            Ok(Some(bytes)) if !bytes.is_empty()
        );
        if !backed {
            log::warn!("[work-override] skipped missing cover file {cover_relative}");
            incoming.remove(COVER_FIELD);
        }
    }
    let current = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    let merged = merge_override_fields(&current, &incoming);
    if merged == current {
        return Ok(());
    }
    if let Err(error) = encode_work_override(&work.identity, &merged) {
        log::warn!("[work-override] skipped {relative}: {error}");
        return Ok(());
    }
    if merged.get(COVER_FIELD) != current.get(COVER_FIELD) {
        ctx.record_cover_changed(novel_id);
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

/// Removes `override.json` and any `cover.override.*` files of a work whose novel row is gone.
pub(super) fn remove_stored_override_file_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
) -> Result<(), String> {
    remove_override_cover_files_in_tx(root, ctx, directory, None)?;
    let relative = format!("{directory}/{OVERRIDE_FILE_NAME}");
    ctx.snapshot_work_metadata_file(root, &relative)?;
    crate::chapter_media::remove_work_metadata_file_at(root, &relative)
}

pub async fn read_novel_override_cover_in_conn(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<NovelOverrideCoverBytesDto>, String> {
    let work = load_override_work_in_conn(&mut *conn, novel_id)
        .await?
        .ok_or_else(|| "work override: novel not found".to_string())?;
    let fields = load_novel_override_fields_in_conn(&mut *conn, novel_id).await?;
    let Some(file_name) = fields
        .get(COVER_FIELD)
        .and_then(|entry| entry.value.as_str())
        .filter(|name| crate::chapter_media::is_override_cover_file(name))
        .map(str::to_owned)
    else {
        return Ok(None);
    };
    let (Some(root), Some(directory)) = (root, work.directory.as_deref()) else {
        return Ok(None);
    };
    let relative = format!("{directory}/{file_name}");
    let Some(bytes) = crate::chapter_media::read_work_metadata_bytes_at(root, &relative)? else {
        return Ok(None);
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(NovelOverrideCoverBytesDto {
        content_type: override_cover_content_type(&file_name).to_string(),
        file_name,
        bytes,
    }))
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
pub async fn db_novel_override_read_cover(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    mode: Option<ReadMode>,
) -> Result<Option<NovelOverrideCoverBytesDto>, String> {
    let root = crate::chapter_media::media_root(&app).ok();
    let mut conn = db
        .pool_for(mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db novel override: acquire connection: {err}"))?;
    read_novel_override_cover_in_conn(root.as_deref(), &mut conn, novel_id).await
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
pub async fn db_novel_override_update(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    novel_id: i64,
    fields: BTreeMap<String, JsonValue>,
    cover: Option<NovelOverrideCoverActionDto>,
    updated_at: i64,
) -> Result<DbMutationEnvelope<WorkOverrideV1Dto>, String> {
    let root = crate::chapter_media::media_root(&app).ok();
    let mut opts = TxOptions::with_app_metadata(app);
    opts.busy_begin_retries = 3;
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move {
            update_novel_override_in_tx(
                root.as_deref(),
                conn,
                ctx,
                novel_id,
                &fields,
                cover.unwrap_or(NovelOverrideCoverActionDto::Keep),
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
    cover_bytes: Option<Vec<u8>>,
) -> Result<DbMutationEnvelope<NovelOverrideMergeResultDto>, String> {
    if document.schema_version != 1 {
        return Err("work override: unsupported version".to_string());
    }
    let root = crate::chapter_media::media_root(&app).ok();
    let mut opts = TxOptions::with_app_metadata(app);
    opts.busy_begin_retries = 3;
    with_write_tx(db.pool_for(ReadMode::Queued), opts, move |conn, ctx| {
        Box::pin(async move {
            merge_novel_override_with_cover_in_tx(
                root.as_deref(),
                conn,
                ctx,
                novel_id,
                &document.fields,
                cover_bytes.as_deref(),
            )
            .await
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

    async fn status_override(conn: &mut SqliteConnection, novel_id: i64) -> Option<String> {
        get_novel_by_id_in_conn(conn, novel_id)
            .await
            .unwrap()
            .unwrap()
            .status_override
    }

    #[test]
    fn validates_field_names_values_and_edit_times() {
        for (name, value, updated_at) in [
            ("status", json!("Completed"), 1),
            ("status", json!("On Hiatus"), MAX_SAFE_INTEGER),
            ("status", JsonValue::Null, 1_763_350_000_000),
            ("completed", json!(true), 1),
            ("cover", json!("cover.override.png"), 5),
            ("cover", JsonValue::Null, 5),
            ("name", json!("Custom title"), 5),
            ("summary", json!("x".repeat(MAX_SUMMARY_TEXT_UNITS)), 5),
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
            ("status", json!("InvalidStatus"), 5),
            ("status", json!(true), 5),
            ("cover", json!("cover.png"), 5),
            ("cover", json!("../cover.override.png"), 5),
            ("cover", json!("cover.override.exe"), 5),
            ("name", json!("   "), 5),
            ("name", json!(123), 5),
            ("summary", json!("x".repeat(MAX_SUMMARY_TEXT_UNITS + 1)), 5),
            ("status", json!("Completed"), 0),
            ("status", json!("Completed"), -1),
            ("status", json!("Completed"), MAX_SAFE_INTEGER + 1),
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
    fn parses_documents_upgrades_legacy_completed_and_keeps_unknown_fields() {
        let document = json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
            "fields": {
                "futureField": { "value": "kept", "updatedAt": 9 },
                "completed": { "value": true, "updatedAt": 1763350000000_i64 },
                "name": { "value": "  Trimmed  ", "updatedAt": 12 }
            },
            "futureSection": true
        });
        let parsed = parse_work_override_bytes(document.to_string().as_bytes()).unwrap();
        assert_eq!(parsed.identity.novel_id, "book");
        assert_eq!(
            parsed.fields,
            fields(&[
                ("futureField", json!("kept"), 9),
                ("name", json!("Trimmed"), 12),
                ("status", json!("Completed"), 1_763_350_000_000),
            ])
        );
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            r#"{"schemaVersion":1,"identity":{"pluginId":"source","novelId":"book","novelPath":"/book"},"fields":{"futureField":{"value":"kept","updatedAt":9},"name":{"value":"Trimmed","updatedAt":12},"status":{"value":"Completed","updatedAt":1763350000000}}}"#
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
            ("status", json!("Completed"), 10),
            ("note", json!("base"), 5),
            ("baseOnly", json!(1), 1),
        ]);
        let incoming = fields(&[
            ("status", json!("Ongoing"), 11),
            ("note", json!("incoming"), 5),
            ("incomingOnly", JsonValue::Null, 1),
        ]);
        let merged = merge_override_fields(&base, &incoming);
        assert_eq!(
            merged,
            fields(&[
                ("baseOnly", json!(1), 1),
                ("incomingOnly", JsonValue::Null, 1),
                ("note", json!("base"), 5),
                ("status", json!("Ongoing"), 11),
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
            "status",
            json!("Completed"),
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
                fields: fields(&[("status", json!("Completed"), 100)]),
            }
        );
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(r#"{"fields":{"status":{"value":"Completed","updatedAt":100}}}"#)
        );

        let earlier_clock = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "status",
            json!("On Hiatus"),
            50,
        )
        .await
        .unwrap();
        assert_eq!(
            earlier_clock.value.fields,
            fields(&[("status", json!("On Hiatus"), 101)])
        );
        let same_clock = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "status",
            json!("Licensed"),
            101,
        )
        .await
        .unwrap();
        assert_eq!(
            same_clock.value.fields,
            fields(&[("status", json!("Licensed"), 102)])
        );
        let cleared = set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "status",
            JsonValue::Null,
            500,
        )
        .await
        .unwrap();
        assert_eq!(
            cleared.value.fields,
            fields(&[("status", JsonValue::Null, 500)])
        );
        assert_eq!(
            stored_payload(&test_db, 1).await.as_deref(),
            Some(r#"{"fields":{"status":{"value":null,"updatedAt":500}}}"#)
        );

        for (novel_id, field, value, updated_at) in [
            (1, "completed", json!(true), 600),
            (1, "cover", json!("cover.override.png"), 600),
            (1, "status", json!("yes"), 600),
            (1, "Status", json!("Completed"), 600),
            (1, "status", json!("Completed"), 0),
            (99, "status", json!("Completed"), 600),
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
            Some(r#"{"fields":{"status":{"value":null,"updatedAt":500}}}"#)
        );
        assert_eq!(stored_payload(&test_db, 99).await, None);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn reads_overrides_with_each_novels_identity_and_exposes_status_override() {
        let test_db = open_test_db().await;
        seed_novels(&test_db, TxOptions::default()).await;
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            2,
            "status",
            json!("Ongoing"),
            10,
        )
        .await
        .unwrap();
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            3,
            "status",
            json!("Completed"),
            10,
        )
        .await
        .unwrap();
        set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "status",
            json!("Completed"),
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
                ("futureField", json!("kept"), 20),
                ("status", json!("Completed"), 10),
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

        assert_eq!(
            status_override(&mut conn, 1).await.as_deref(),
            Some("Completed")
        );
        assert_eq!(
            status_override(&mut conn, 2).await.as_deref(),
            Some("Ongoing")
        );
        let candidates = list_check_candidates_in_conn(&mut conn, None)
            .await
            .unwrap();
        assert_eq!(
            candidates
                .iter()
                .map(|candidate| (
                    candidate.novel_id,
                    candidate.status.as_deref(),
                    candidate.status_override.as_deref(),
                ))
                .collect::<Vec<_>>(),
            [(1, Some("Ongoing"), Some("Completed")), (3, None, Some("Completed"))]
        );
        drop(conn);

        set_field(
            &test_db,
            TxOptions::default(),
            None,
            1,
            "status",
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
        assert_eq!(status_override(&mut conn, 1).await, None);
        assert_eq!(status_override(&mut conn, 3).await, None);
        let candidates = list_check_candidates_in_conn(&mut conn, None)
            .await
            .unwrap();
        assert!(candidates
            .iter()
            .all(|candidate| candidate.status_override.is_none()));
        drop(conn);
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn merge_reports_whether_the_stored_override_changed_and_handles_cover_bytes() {
        let test_db = open_test_db().await;
        let root = published_root(&test_db).await;
        let source_cover = root.join("contents/source/book/cover.jpg");
        fs::write(&source_cover, b"source-cover").unwrap();

        let merge = |incoming: WorkOverrideFields, novel_id: i64, cover: Option<Vec<u8>>| {
            let root = root.clone();
            with_write_tx(test_db.db.writer(), publishing(&root), move |conn, ctx| {
                Box::pin(async move {
                    merge_novel_override_with_cover_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        novel_id,
                        &incoming,
                        cover.as_deref(),
                    )
                    .await
                })
            })
        };

        let empty = merge(WorkOverrideFields::new(), 1, None).await.unwrap();
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
            fields(&[
                ("status", json!("Completed"), 10),
                ("note", json!("a"), 5),
                ("cover", json!("cover.override.png"), 10),
            ]),
            1,
            Some(b"override-png".to_vec()),
        )
        .await
        .unwrap();
        assert!(created.value.changed);
        assert!(created.effects.work_metadata_changed);
        let document = created.value.document.unwrap();
        assert_eq!(document.identity.novel_path, "/book");
        assert_eq!(
            fs::read(root.join("contents/source/book/cover.override.png")).unwrap(),
            b"override-png"
        );
        assert_eq!(fs::read(&source_cover).unwrap(), b"source-cover");

        let stale = merge(
            fields(&[("status", json!("Ongoing"), 10), ("note", json!("b"), 4)]),
            1,
            None,
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

        let newer = merge(
            fields(&[
                ("status", JsonValue::Null, 11),
                ("cover", JsonValue::Null, 11),
            ]),
            1,
            None,
        )
        .await
        .unwrap();
        assert!(newer.value.changed);
        assert_eq!(
            newer.value.document.unwrap().fields,
            fields(&[
                ("cover", JsonValue::Null, 11),
                ("note", json!("a"), 5),
                ("status", JsonValue::Null, 11),
            ])
        );
        assert!(!root.join("contents/source/book/cover.override.png").exists());
        assert_eq!(fs::read(&source_cover).unwrap(), b"source-cover");

        assert!(merge(fields(&[("cover", json!("cover.override.jpg"), 20)]), 1, None)
            .await
            .is_err());
        assert!(merge(fields(&[("status", json!("yes"), 12)]), 1, None)
            .await
            .is_err());
        assert!(merge(fields(&[("status", json!("Completed"), 12)]), 99, None)
            .await
            .is_err());
        assert!(merge(WorkOverrideFields::new(), 99, None).await.is_err());
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn update_writes_override_cover_without_deleting_source_cover_and_rolls_back() {
        let test_db = open_test_db().await;
        let root = published_root(&test_db).await;
        let source_cover = root.join("contents/source/book/cover.jpg");
        fs::write(&source_cover, b"original-source-cover").unwrap();

        let first_updates = BTreeMap::from([
            ("name".to_string(), json!("  Custom Name  ")),
            ("author".to_string(), json!("Override Author")),
            ("artist".to_string(), json!("Override Artist")),
            ("genres".to_string(), json!("Fantasy, Action")),
            ("summary".to_string(), json!("Edited summary")),
            ("status".to_string(), json!("On Hiatus")),
        ]);
        let first = with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    update_novel_override_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        &first_updates,
                        NovelOverrideCoverActionDto::Set {
                            file_name: "cover.override.png".to_string(),
                            bytes: b"png-bytes".to_vec(),
                        },
                        100,
                    )
                    .await
                })
            }
        })
        .await
        .unwrap();

        assert_eq!(first.value.fields["name"].value, json!("Custom Name"));
        assert_eq!(first.value.fields["status"].value, json!("On Hiatus"));
        assert_eq!(
            first.value.fields["cover"].value,
            json!("cover.override.png")
        );
        assert_eq!(
            fs::read(root.join("contents/source/book/cover.override.png")).unwrap(),
            b"png-bytes"
        );
        assert_eq!(fs::read(&source_cover).unwrap(), b"original-source-cover");

        let mut conn = test_db.db.writer().acquire().await.unwrap();
        let detail = get_novel_by_id_in_conn(&mut conn, 1).await.unwrap().unwrap();
        assert_eq!(detail.name, "Custom Name");
        assert_eq!(detail.author.as_deref(), Some("Override Author"));
        assert_eq!(detail.artist.as_deref(), Some("Override Artist"));
        assert_eq!(detail.genres.as_deref(), Some("Fantasy, Action"));
        assert_eq!(detail.summary.as_deref(), Some("Edited summary"));
        assert_eq!(detail.status.as_deref(), Some("On Hiatus"));
        assert_eq!(detail.status_override.as_deref(), Some("On Hiatus"));
        assert_eq!(detail.cover_override.as_deref(), Some("cover.override.png"));
        assert_eq!(detail.source_metadata.name, "Book");
        assert_eq!(
            read_novel_override_cover_in_conn(Some(&root), &mut conn, 1)
                .await
                .unwrap(),
            Some(NovelOverrideCoverBytesDto {
                file_name: "cover.override.png".to_string(),
                content_type: "image/png".to_string(),
                bytes: b"png-bytes".to_vec(),
            })
        );
        drop(conn);

        let aborted = with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    update_novel_override_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        &BTreeMap::new(),
                        NovelOverrideCoverActionDto::Set {
                            file_name: "cover.override.webp".to_string(),
                            bytes: b"webp-bytes".to_vec(),
                        },
                        200,
                    )
                    .await?;
                    assert!(!root.join("contents/source/book/cover.override.png").exists());
                    assert!(root.join("contents/source/book/cover.override.webp").is_file());
                    Err::<(), String>("abort cover swap".to_string())
                })
            }
        })
        .await;
        assert_eq!(aborted.unwrap_err(), "abort cover swap");
        assert_eq!(
            fs::read(root.join("contents/source/book/cover.override.png")).unwrap(),
            b"png-bytes"
        );
        assert!(!root.join("contents/source/book/cover.override.webp").exists());
        assert_eq!(fs::read(&source_cover).unwrap(), b"original-source-cover");

        let cleared = with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    update_novel_override_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        &BTreeMap::from([("status".to_string(), JsonValue::Null)]),
                        NovelOverrideCoverActionDto::Clear,
                        300,
                    )
                    .await
                })
            }
        })
        .await
        .unwrap();
        assert_eq!(cleared.value.fields["cover"].value, JsonValue::Null);
        assert_eq!(cleared.value.fields["status"].value, JsonValue::Null);
        assert!(!root.join("contents/source/book/cover.override.png").exists());
        assert_eq!(fs::read(&source_cover).unwrap(), b"original-source-cover");
        test_db.db.close().await;
    }

    #[tokio::test]
    async fn update_initializes_directory_for_shelved_novel_missing_file_cache_and_merge_defers_unshelved_cover() {
        let test_db = open_test_db().await;
        let root = test_db.dir.path().join("media");
        fs::create_dir_all(&root).unwrap();

        with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, _ctx| {
            Box::pin(async move {
                sqlx::query(
                    "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, in_library) \
                     VALUES (1, 'source', 'book', '/book', 'Book', 1), \
                            (2, 'source', 'browsed', '/browsed', 'Browsed', 0)",
                )
                .execute(&mut *conn)
                .await
                .map_err(|err| err.to_string())?;
                Ok(())
            })
        })
        .await
        .unwrap();

        let saved = with_write_tx(test_db.db.writer(), publishing(&root), {
            let root = root.clone();
            move |conn, ctx| {
                Box::pin(async move {
                    update_novel_override_in_tx(
                        Some(&root),
                        conn,
                        ctx,
                        1,
                        &BTreeMap::from([("status".to_string(), json!("Completed"))]),
                        NovelOverrideCoverActionDto::Set {
                            file_name: "cover.override.png".to_string(),
                            bytes: b"png-bytes".to_vec(),
                        },
                        100,
                    )
                    .await
                })
            }
        })
        .await
        .unwrap();
        assert_eq!(
            saved.value.fields["cover"].value,
            json!("cover.override.png")
        );
        assert!(root.join("contents/source/book/novel.json").is_file());
        assert!(root.join("contents/source/book/override.json").is_file());
        assert_eq!(
            fs::read(root.join("contents/source/book/cover.override.png")).unwrap(),
            b"png-bytes"
        );
        let cached_dir: Option<String> = sqlx::query_scalar(
            "SELECT directory FROM work_metadata_file_cache WHERE novel_id = 1",
        )
        .fetch_optional(test_db.db.writer())
        .await
        .unwrap();
        assert_eq!(cached_dir.as_deref(), Some("contents/source/book"));

        // Unshelved novel with no work directory yet keeps text/status overrides while deferring cover.
        let merged = with_write_tx(test_db.db.writer(), TxOptions::default(), |conn, ctx| {
            Box::pin(async move {
                let incoming = fields(&[
                    ("name", json!("Custom Browsed"), 20),
                    ("status", json!("On Hiatus"), 20),
                    ("cover", json!("cover.override.png"), 20),
                ]);
                merge_novel_override_with_cover_in_tx(
                    None,
                    conn,
                    ctx,
                    2,
                    &incoming,
                    Some(b"png-bytes"),
                )
                .await
            })
        })
        .await
        .unwrap();
        assert!(merged.value.changed);
        let merged_doc = merged.value.document.unwrap();
        assert_eq!(merged_doc.fields["name"].value, json!("Custom Browsed"));
        assert_eq!(merged_doc.fields["status"].value, json!("On Hiatus"));
        assert!(!merged_doc.fields.contains_key("cover"));
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
                        "status",
                        json!("Completed"),
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
            "status",
            json!("Completed"),
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
                "fields": { "status": { "value": "Completed", "updatedAt": 100 } }
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
                        "status",
                        json!("Ongoing"),
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
            Some(r#"{"fields":{"status":{"value":"Completed","updatedAt":100}}}"#)
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
            "status",
            json!("Completed"),
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
            fields(&[("status", json!("Completed"), 100)])
        );
        assert!(!root.join("contents/local/shelf/override.json").exists());

        let kept = br#"{"schemaVersion":1,"identity":{"pluginId":"source","novelId":"book","novelPath":"/book"},"fields":{"status":{"value":"Ongoing","updatedAt":900}}}"#;
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

        fs::write(
            root.join("contents/source/book/cover.override.png"),
            b"delete-with-work",
        )
        .unwrap();
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
        assert_eq!(
            fs::read(root.join("contents/source/book/cover.override.png")).unwrap(),
            b"delete-with-work"
        );

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
        assert!(!root.join("contents/source/book/cover.override.png").exists());
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
                json!({
                    "completed": { "value": true, "updatedAt": 100 },
                    "cover": { "value": "cover.override.png", "updatedAt": 15 },
                    "note": { "value": "disk", "updatedAt": 5 }
                }),
            )),
        );
        fs::write(root.join("contents/source/book/cover.override.png"), b"override-img").unwrap();
        write_work(
            &root,
            "missing-cover",
            "/missing-cover",
            Some(&override_bytes(
                "missing-cover",
                "/missing-cover",
                json!({
                    "status": { "value": "Licensed", "updatedAt": 20 },
                    "cover": { "value": "cover.override.jpg", "updatedAt": 20 }
                }),
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
                json!({ "status": { "value": "yes", "updatedAt": 100 } }),
            )),
        );
        write_work(&root, "plain", "/plain", None);

        recover(&test_db, &root, false).await;
        let mut recovered: Vec<(String, String)> = sqlx::query_as(
            "SELECT n.path, o.payload FROM novel_override o JOIN novel n ON n.id = o.novel_id ORDER BY n.path",
        )
        .fetch_all(test_db.db.writer())
        .await
        .unwrap();
        recovered.sort();
        assert_eq!(
            recovered,
            [
                (
                    "/book".to_string(),
                    r#"{"fields":{"cover":{"value":"cover.override.png","updatedAt":15},"note":{"value":"disk","updatedAt":5},"status":{"value":"Completed","updatedAt":100}}}"#.to_string()
                ),
                (
                    "/missing-cover".to_string(),
                    r#"{"fields":{"status":{"value":"Licensed","updatedAt":20}}}"#.to_string()
                ),
            ]
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM novel")
                .fetch_one(test_db.db.writer())
                .await
                .unwrap(),
            6
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
            "status",
            json!("Ongoing"),
            300,
        )
        .await
        .unwrap();
        let disk = override_bytes(
            "book",
            "/book",
            json!({
                "status": { "value": "Completed", "updatedAt": 200 },
                "note": { "value": "newer disk", "updatedAt": 6 },
                "diskOnly": { "value": 1, "updatedAt": 1 }
            }),
        );
        fs::write(root.join(OVERRIDE_PATH), &disk).unwrap();
        recover(&test_db, &root, true).await;
        assert_eq!(
            stored_payload(&test_db, book_id).await.as_deref(),
            Some(
                r#"{"fields":{"cover":{"value":"cover.override.png","updatedAt":15},"diskOnly":{"value":1,"updatedAt":1},"note":{"value":"newer disk","updatedAt":6},"status":{"value":"Ongoing","updatedAt":300}}}"#
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
