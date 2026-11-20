use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Row, SqliteConnection};

const MAX_COMPOSITION_BYTES: usize = 16 * 1024 * 1024;
const CONTENT_TYPES: &[&str] = &["html", "text", "pdf", "markdown", "epub"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSourceSnapshotDto {
    pub plugin_id: String,
    pub novel_id: String,
    pub novel_path: String,
    pub chapter_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_chapter_id: Option<String>,
    pub chapter_number: Option<String>,
    pub name: String,
    pub position: i64,
    pub page: String,
    pub content_type: String,
    pub release_time: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCompositionUserDto {
    pub included: bool,
    pub order: i64,
    pub name: Option<String>,
    pub chapter_number: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCompositionEntryDto {
    pub id: String,
    pub path: String,
    pub storage_chapter_number: String,
    pub sources: Vec<ChapterSourceSnapshotDto>,
    pub primary_source: usize,
    pub user: ChapterCompositionUserDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCompositionV1Dto {
    pub version: u32,
    pub updated_at: i64,
    pub entries: Vec<ChapterCompositionEntryDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStorageTransferPreparedEntryRefDto {
    pub outcome: String,
    pub replaced_target: bool,
    pub target_relative_dir: String,
    pub content_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterCompositionPreparedCopyDto {
    pub entry: ChapterCompositionEntryDto,
    pub transfer: ChapterStorageTransferPreparedEntryRefDto,
}

pub fn canonical_chapter_number_str(value: &str) -> Option<String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.is_empty()
        || parts.len() > 2
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    let number: f64 = value.parse().ok()?;
    if !number.is_finite() || number < 0.0 || number >= 1e21 || (number > 0.0 && number < 1e-6) {
        return None;
    }
    let formatted = if number == 0.0 {
        "0".to_string()
    } else {
        number.to_string()
    };
    let check_parts: Vec<_> = formatted.split('.').collect();
    if check_parts.len() <= 2
        && check_parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        Some(formatted)
    } else {
        None
    }
}

pub fn canonical_chapter_number_i64(value: i64) -> Option<String> {
    if value < 0 {
        return None;
    }
    Some(value.to_string())
}

pub fn is_composition_storage_number(value: &str) -> bool {
    canonical_chapter_number_str(value).as_deref() == Some(value)
}

fn expect_object(value: &JsonValue) -> Result<&serde_json::Map<String, JsonValue>, String> {
    value
        .as_object()
        .ok_or_else(|| "Chapter composition: expected an object".to_string())
}

fn validate_text_utf16_len_le(text: &str, max_units: usize) -> bool {
    text.encode_utf16().count() <= max_units
}

fn parse_text(value: Option<&JsonValue>, nullable: bool) -> Result<Option<String>, String> {
    match value {
        Some(JsonValue::Null) if nullable => Ok(None),
        Some(JsonValue::String(text))
            if !text.trim().is_empty() && validate_text_utf16_len_le(text, 4096) =>
        {
            Ok(Some(text.clone()))
        }
        _ => Err("Chapter composition: invalid text".to_string()),
    }
}

fn parse_non_negative_safe_int(value: Option<&JsonValue>) -> Result<i64, String> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    let Some(num) = value.and_then(JsonValue::as_number) else {
        return Err("Chapter composition: invalid integer".to_string());
    };
    let int_val = if let Some(i) = num.as_i64() {
        i
    } else if let Some(f) = num.as_f64() {
        if !f.is_finite() || f.fract() != 0.0 || f < 0.0 || f > MAX_SAFE_INTEGER as f64 {
            return Err("Chapter composition: invalid integer".to_string());
        }
        f as i64
    } else {
        return Err("Chapter composition: invalid integer".to_string());
    };
    if !(0..=MAX_SAFE_INTEGER).contains(&int_val) {
        return Err("Chapter composition: invalid integer".to_string());
    }
    Ok(int_val)
}

fn is_source_url_prefix(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//")
}

fn parse_source(raw: &JsonValue) -> Result<ChapterSourceSnapshotDto, String> {
    let value = expect_object(raw)?;
    let Some(plugin_id) = value.get("pluginId").and_then(JsonValue::as_str) else {
        return Err("Chapter composition: invalid source storage identity".to_string());
    };
    let Some(novel_id) = value.get("novelId").and_then(JsonValue::as_str) else {
        return Err("Chapter composition: invalid source storage identity".to_string());
    };
    if !crate::chapter_media::is_plugin_storage_id(plugin_id)
        || !crate::chapter_media::is_storage_id(novel_id)
    {
        return Err("Chapter composition: invalid source storage identity".to_string());
    }
    let novel_path = parse_text(value.get("novelPath"), false)?.unwrap();
    if is_source_url_prefix(&novel_path) || novel_path.starts_with("norea-folder:") {
        return Err("Chapter composition: expected a source work path".to_string());
    }
    let Some(content_type) = value.get("contentType").and_then(JsonValue::as_str) else {
        return Err("Chapter composition: invalid source content type".to_string());
    };
    if !CONTENT_TYPES.contains(&content_type) {
        return Err("Chapter composition: invalid source content type".to_string());
    }
    let chapter_path = parse_text(value.get("chapterPath"), false)?.unwrap();
    let source_chapter_id = match value.get("sourceChapterId") {
        None => None,
        Some(raw_id) => Some(parse_text(Some(raw_id), false)?.unwrap()),
    };
    let chapter_number = parse_text(value.get("chapterNumber"), true)?;
    let name = parse_text(value.get("name"), false)?.unwrap();
    let position = parse_non_negative_safe_int(value.get("position"))?;
    let page = parse_text(value.get("page"), false)?.unwrap();
    let release_time = parse_text(value.get("releaseTime"), true)?;

    Ok(ChapterSourceSnapshotDto {
        plugin_id: plugin_id.to_string(),
        novel_id: novel_id.to_string(),
        novel_path,
        chapter_path,
        source_chapter_id,
        chapter_number,
        name,
        position,
        page,
        content_type: content_type.to_string(),
        release_time,
    })
}

pub fn parse_chapter_composition(raw: &JsonValue) -> Result<ChapterCompositionV1Dto, String> {
    let value = expect_object(raw)?;
    if parse_non_negative_safe_int(value.get("version")).ok() != Some(1) {
        return Err("Chapter composition: unsupported version".to_string());
    }
    let updated_at = parse_non_negative_safe_int(value.get("updatedAt"))?;
    let Some(raw_entries) = value.get("entries").and_then(JsonValue::as_array) else {
        return Err("Chapter composition: invalid entries".to_string());
    };
    if raw_entries.len() > 100_000 {
        return Err("Chapter composition: invalid entries".to_string());
    }
    let encoded_len = serde_json::to_vec(raw)
        .map_err(|err| format!("Chapter composition: encode check: {err}"))?
        .len();
    if encoded_len > MAX_COMPOSITION_BYTES {
        return Err("Chapter composition: document exceeds size limit".to_string());
    }

    let mut ids = HashSet::with_capacity(raw_entries.len());
    let mut paths = HashSet::with_capacity(raw_entries.len());
    let mut storage_numbers = HashSet::with_capacity(raw_entries.len());
    let mut orders = HashSet::new();
    let mut entries = Vec::with_capacity(raw_entries.len());

    for raw_entry in raw_entries {
        let input = expect_object(raw_entry)?;
        let id = parse_text(input.get("id"), false)?.unwrap();
        let path = parse_text(input.get("path"), false)?.unwrap();
        let Some(storage_chapter_number) = input
            .get("storageChapterNumber")
            .and_then(JsonValue::as_str)
            .filter(|val| is_composition_storage_number(val))
            .map(str::to_owned)
        else {
            return Err("Chapter composition: invalid storage chapter number".to_string());
        };

        if !ids.insert(id.clone())
            || !paths.insert(path.clone())
            || !storage_numbers.insert(storage_chapter_number.clone())
        {
            return Err(
                "Chapter composition: duplicate entry identity or storage chapter number"
                    .to_string(),
            );
        }

        let Some(raw_sources) = input.get("sources").and_then(JsonValue::as_array) else {
            return Err("Chapter composition: missing source snapshots".to_string());
        };
        if raw_sources.is_empty() || raw_sources.len() > 1000 {
            return Err("Chapter composition: missing source snapshots".to_string());
        }
        let sources = raw_sources
            .iter()
            .map(parse_source)
            .collect::<Result<Vec<_>, _>>()?;
        let primary_source_i64 = parse_non_negative_safe_int(input.get("primarySource"))?;
        let primary_source = usize::try_from(primary_source_i64)
            .map_err(|_| "Chapter composition: invalid primary source".to_string())?;
        if primary_source >= sources.len() {
            return Err("Chapter composition: invalid primary source".to_string());
        }

        let input_user = expect_object(
            input
                .get("user")
                .ok_or_else(|| "Chapter composition: expected an object".to_string())?,
        )?;
        let Some(included) = input_user.get("included").and_then(JsonValue::as_bool) else {
            return Err("Chapter composition: invalid inclusion flag".to_string());
        };
        let order = parse_non_negative_safe_int(input_user.get("order"))?;
        if included && (order == 0 || !orders.insert(order)) {
            return Err("Chapter composition: invalid final order".to_string());
        }

        entries.push(ChapterCompositionEntryDto {
            id,
            path,
            storage_chapter_number,
            sources,
            primary_source,
            user: ChapterCompositionUserDto {
                included,
                order,
                name: parse_text(input_user.get("name"), true)?,
                chapter_number: parse_text(input_user.get("chapterNumber"), true)?,
            },
        });
    }

    for order in 1..=(orders.len() as i64) {
        if !orders.contains(&order) {
            return Err("Chapter composition: final order must be consecutive".to_string());
        }
    }

    Ok(ChapterCompositionV1Dto {
        version: 1,
        updated_at,
        entries,
    })
}

pub fn included_chapter_composition_entries(
    composition: &ChapterCompositionV1Dto,
) -> Vec<&ChapterCompositionEntryDto> {
    let mut included: Vec<_> = composition
        .entries
        .iter()
        .filter(|entry| entry.user.included)
        .collect();
    included.sort_by_key(|entry| entry.user.order);
    included
}

pub fn chapter_composition_catalog(
    composition: &ChapterCompositionV1Dto,
) -> Vec<(String, String)> {
    included_chapter_composition_entries(composition)
        .into_iter()
        .map(|entry| {
            let title = entry
                .user
                .name
                .clone()
                .unwrap_or_else(|| entry.sources[entry.primary_source].name.clone());
            (entry.storage_chapter_number.clone(), title)
        })
        .collect()
}

pub async fn get_chapter_composition_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<Option<ChapterCompositionV1Dto>, String> {
    let payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM novel_chapter_composition WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(conn)
    .await
    .map_err(|err| format!("db chapter composition: get: {err}"))?;

    let Some(payload) = payload else {
        return Ok(None);
    };
    let parsed_json: JsonValue = serde_json::from_str(&payload)
        .map_err(|err| format!("Chapter composition: invalid stored JSON: {err}"))?;
    parse_chapter_composition(&parsed_json).map(Some)
}

pub async fn set_chapter_composition_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
    composition: Option<&ChapterCompositionV1Dto>,
) -> Result<(), String> {
    let Some(composition) = composition else {
        sqlx::query("DELETE FROM novel_chapter_composition WHERE novel_id = ?1")
            .bind(novel_id)
            .execute(conn)
            .await
            .map_err(|err| format!("db chapter composition: delete: {err}"))?;
        return Ok(());
    };
    let value = serde_json::to_value(composition)
        .map_err(|err| format!("Chapter composition: serialize: {err}"))?;
    let validated = parse_chapter_composition(&value)?;
    let payload = serde_json::to_string(&validated)
        .map_err(|err| format!("Chapter composition: encode: {err}"))?;
    sqlx::query(
        "INSERT INTO novel_chapter_composition(novel_id, payload) VALUES (?1, ?2) \
         ON CONFLICT(novel_id) DO UPDATE SET payload = excluded.payload \
         WHERE payload IS NOT excluded.payload",
    )
    .bind(novel_id)
    .bind(payload)
    .execute(conn)
    .await
    .map_err(|err| format!("db chapter composition: upsert: {err}"))?;
    Ok(())
}

fn same_source(left: &ChapterSourceSnapshotDto, right: &ChapterSourceSnapshotDto) -> bool {
    left.plugin_id == right.plugin_id
        && left.novel_id.eq_ignore_ascii_case(&right.novel_id)
        && match (&left.source_chapter_id, &right.source_chapter_id) {
            (Some(lhs), Some(rhs)) => lhs == rhs,
            _ => left.chapter_path == right.chapter_path,
        }
}

fn same_owner(
    previous: Option<&ChapterCompositionEntryDto>,
    entry: &ChapterCompositionEntryDto,
) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    previous.id == entry.id
        && previous.path == entry.path
        && previous.storage_chapter_number == entry.storage_chapter_number
        && same_source(
            &previous.sources[previous.primary_source],
            &entry.sources[entry.primary_source],
        )
}

fn is_synthetic_chapter_path(path: &str) -> bool {
    path.starts_with("norea-folder:")
        || path.starts_with("local-folder:")
        || path.starts_with("norea-composed:")
        || path.starts_with("norea-source:")
}

fn same_stored_owner(
    previous: Option<&ChapterCompositionEntryDto>,
    entry: &ChapterCompositionEntryDto,
    plugin_id: &str,
    source_novel_id: Option<&str>,
) -> bool {
    if same_owner(previous, entry) {
        return true;
    }
    let Some(previous) = previous else {
        return false;
    };
    if previous.path != entry.path
        || previous.storage_chapter_number != entry.storage_chapter_number
        || is_synthetic_chapter_path(&entry.path)
    {
        return false;
    }
    let Some(source_novel_id) = source_novel_id else {
        return false;
    };
    let source = &entry.sources[entry.primary_source];
    source.plugin_id == plugin_id
        && source.novel_id.eq_ignore_ascii_case(source_novel_id)
        && source.chapter_path == entry.path
        && same_source(&previous.sources[previous.primary_source], source)
}

#[derive(Clone)]
struct ExistingChapterRow {
    path: String,
    chapter_number: Option<String>,
    position: i64,
    progress: f64,
    bookmark: i64,
    read_at: Option<i64>,
    is_downloaded: i64,
    content_bytes: i64,
    media_bytes: i64,
    media_repair_needed: i64,
    excluded_at: Option<i64>,
}

fn assert_chapter_composition_storage_ownership(
    root: &Path,
    plugin_id: &str,
    source_novel_id: Option<&str>,
    novel_path: &str,
    directory_override: Option<&str>,
    composition: &ChapterCompositionV1Dto,
    previous_composition: Option<&ChapterCompositionV1Dto>,
    existing: &[ExistingChapterRow],
    prepared_copies: &[ChapterCompositionPreparedCopyDto],
) -> Result<(), String> {
    let directory = match directory_override {
        Some(dir) => dir.to_string(),
        None => {
            if !crate::chapter_media::is_plugin_storage_id(plugin_id) {
                return Err("Plugin ID is required for storage.".to_string());
            }
            let Some(source_id) = source_novel_id.filter(|id| crate::chapter_media::is_storage_id(id))
            else {
                return Err("Plugin-owned novel ID is required for storage.".to_string());
            };
            format!("contents/{plugin_id}/{source_id}")
        }
    };

    let paths = crate::chapter_media::list_work_chapter_files_at(
        root,
        &format!("{directory}/novel.json"),
        &HashSet::new(),
    )?;
    let mut occupied = HashSet::new();
    let prefix = format!("{directory}/");
    for path in paths {
        let Some(rest) = path.strip_prefix(&prefix) else {
            return Err("Chapter composition: invalid stored chapter location".to_string());
        };
        let parts: Vec<_> = rest.split('/').collect();
        if parts.len() != 2
            || !matches!(
                parts[1],
                "content.html" | "content.pdf" | ".chapter-content.partial"
            )
        {
            return Err("Chapter composition: invalid stored chapter file".to_string());
        }
        if canonical_chapter_number_str(parts[0]).as_deref() == Some(parts[0]) {
            occupied.insert(parts[0].to_string());
        }
    }

    if !composition
        .entries
        .iter()
        .any(|entry| occupied.contains(&entry.storage_chapter_number))
    {
        return Ok(());
    }

    let stored = super::work_metadata::read_stored_novel_metadata_at(root, &directory)?;
    if let Some(ref stored) = stored {
        if stored.metadata.identity.plugin_id != plugin_id
            || Some(stored.metadata.identity.novel_id.as_str()) != source_novel_id
            || stored.metadata.identity.novel_path != novel_path
        {
            return Err(
                "Chapter composition: stored work identity changed; existing files were retained"
                    .to_string(),
            );
        }
    }

    let stored_owners: HashMap<&str, &ChapterCompositionEntryDto> = stored
        .as_ref()
        .and_then(|item| item.metadata.chapter_composition.as_ref())
        .map(|comp| {
            comp.entries
                .iter()
                .map(|entry| (entry.storage_chapter_number.as_str(), entry))
                .collect()
        })
        .unwrap_or_default();
    let previous_owners: HashMap<&str, &ChapterCompositionEntryDto> = previous_composition
        .map(|comp| {
            comp.entries
                .iter()
                .map(|entry| (entry.storage_chapter_number.as_str(), entry))
                .collect()
        })
        .unwrap_or_default();
    let existing_by_path: HashMap<&str, &ExistingChapterRow> = existing
        .iter()
        .map(|chapter| (chapter.path.as_str(), chapter))
        .collect();
    let copies: HashMap<&str, &ChapterCompositionPreparedCopyDto> = prepared_copies
        .iter()
        .map(|copy| (copy.entry.path.as_str(), copy))
        .collect();

    for entry in &composition.entries {
        if !occupied.contains(&entry.storage_chapter_number) {
            continue;
        }
        let stored_owner = stored_owners
            .get(entry.storage_chapter_number.as_str())
            .copied();
        let previous_owner = previous_owners
            .get(entry.storage_chapter_number.as_str())
            .copied();
        let chapter = existing_by_path.get(entry.path.as_str()).copied();
        let source = &entry.sources[entry.primary_source];
        let existing_number = chapter.and_then(|row| match &row.chapter_number {
            Some(num) => canonical_chapter_number_str(num),
            None => canonical_chapter_number_i64(row.position),
        });
        let original_row = chapter.is_some_and(|row| {
            !is_synthetic_chapter_path(&row.path)
                && existing_number.as_deref() == Some(entry.storage_chapter_number.as_str())
                && source.plugin_id == plugin_id
                && Some(source.novel_id.as_str()) == source_novel_id
                && source.chapter_path == row.path
        });
        let target_directory = format!("{directory}/{}", entry.storage_chapter_number);
        let prepared_copy = copies.get(entry.path.as_str()).is_some_and(|copy| {
            same_owner(Some(&copy.entry), entry)
                && matches!(copy.transfer.outcome.as_str(), "copiedSource" | "movedSource")
                && !copy.transfer.replaced_target
                && copy.transfer.target_relative_dir == target_directory
                && matches!(
                    copy.transfer.content_file.as_deref(),
                    Some(file)
                        if file == format!("{target_directory}/content.html")
                            || file == format!("{target_directory}/content.pdf")
                )
        });
        let stored_matches =
            same_stored_owner(stored_owner, entry, plugin_id, source_novel_id);
        let previous_matches =
            same_stored_owner(previous_owner, entry, plugin_id, source_novel_id);
        if (stored_owner.is_some() && !stored_matches)
            || (previous_owner.is_some() && !previous_matches)
            || !(stored_matches || previous_matches || original_row || prepared_copy)
        {
            return Err(
                "Chapter composition: existing chapter files have no matching source ownership; existing files were retained"
                    .to_string(),
            );
        }
    }

    Ok(())
}

pub async fn materialize_chapter_composition_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    novel_id: i64,
    raw: &ChapterCompositionV1Dto,
    prepared_copies: &[ChapterCompositionPreparedCopyDto],
) -> Result<(), String> {
    let raw_value = serde_json::to_value(raw)
        .map_err(|err| format!("Chapter composition: encode input: {err}"))?;
    let composition = parse_chapter_composition(&raw_value)?;

    let novel_row = sqlx::query(
        "SELECT n.plugin_id, n.source_novel_id, n.path, f.directory \
         FROM novel n LEFT JOIN work_metadata_file_cache f ON f.novel_id = n.id \
         WHERE n.id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db chapter composition: load novel: {err}"))?
    .ok_or_else(|| "Chapter composition: target work no longer exists".to_string())?;

    let plugin_id: String = novel_row.get("plugin_id");
    let source_novel_id: Option<String> = novel_row.get("source_novel_id");
    let novel_path: String = novel_row.get("path");
    let cached_directory: Option<String> = novel_row.get("directory");

    let previous_composition = get_chapter_composition_in_tx(&mut *conn, novel_id).await?;

    let raw_existing = sqlx::query(
        "SELECT path, chapter_number, position, progress, bookmark, read_at, \
                is_downloaded, content_bytes, media_bytes, media_repair_needed, \
                (SELECT created_at FROM chapter_download_goal_exclusion WHERE chapter_id = chapter.id) AS excluded_at \
         FROM chapter WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db chapter composition: load existing chapters: {err}"))?;

    let mut existing: Vec<ExistingChapterRow> = raw_existing
        .into_iter()
        .map(|row| ExistingChapterRow {
            path: row.get("path"),
            chapter_number: row.get("chapter_number"),
            position: row.get("position"),
            progress: crate::db::decode_sqlite_f64(&row, "progress"),
            bookmark: row.get("bookmark"),
            read_at: row.get("read_at"),
            is_downloaded: row.get("is_downloaded"),
            content_bytes: row.get("content_bytes"),
            media_bytes: row.get("media_bytes"),
            media_repair_needed: row.get("media_repair_needed"),
            excluded_at: row.get("excluded_at"),
        })
        .collect();
    let original_existing = existing.clone();

    let mut aliases: Vec<(String, String)> = Vec::new();
    let mut paths: HashSet<String> = existing.iter().map(|row| row.path.clone()).collect();
    let mut counts: HashMap<Option<String>, usize> = HashMap::new();
    for row in &existing {
        let number = match &row.chapter_number {
            Some(num) => canonical_chapter_number_str(num),
            None => canonical_chapter_number_i64(row.position),
        };
        *counts.entry(number).or_insert(0) += 1;
    }

    let entries_by_number: HashMap<&str, &ChapterCompositionEntryDto> = composition
        .entries
        .iter()
        .map(|entry| (entry.storage_chapter_number.as_str(), entry))
        .collect();

    for row in &mut existing {
        let number = match &row.chapter_number {
            Some(num) => canonical_chapter_number_str(num),
            None => canonical_chapter_number_i64(row.position),
        };
        let Some(ref num_str) = number else {
            continue;
        };
        if row.path != format!("norea-folder:{num_str}")
            || row.is_downloaded != 0
            || row.content_bytes != 0
            || row.media_bytes != 0
            || row.media_repair_needed != 0
        {
            continue;
        }
        if counts.get(&number).copied().unwrap_or(0) != 1 {
            continue;
        }
        let Some(entry) = entries_by_number.get(num_str.as_str()).copied() else {
            continue;
        };
        if paths.contains(&entry.path) {
            continue;
        }
        let source = &entry.sources[entry.primary_source];
        let source_number = source
            .chapter_number
            .as_deref()
            .and_then(canonical_chapter_number_str);
        if source.plugin_id != plugin_id
            || Some(source.novel_id.as_str()) != source_novel_id.as_deref()
            || source.chapter_path != entry.path
            || source_number.as_deref() != Some(num_str.as_str())
        {
            continue;
        }
        aliases.push((row.path.clone(), entry.path.clone()));
        paths.insert(entry.path.clone());
        row.path = entry.path.clone();
    }

    let by_path: HashMap<String, ExistingChapterRow> = existing
        .iter()
        .cloned()
        .map(|row| (row.path.clone(), row))
        .collect();

    let mut storage_owners: HashMap<String, HashSet<String>> = HashMap::new();
    let mut remember_owner = |number: Option<String>, path: &str| {
        if let Some(num) = number {
            storage_owners
                .entry(num)
                .or_default()
                .insert(path.to_string());
        }
    };
    for chapter in &existing {
        let number = match &chapter.chapter_number {
            Some(num) => canonical_chapter_number_str(num),
            None => canonical_chapter_number_i64(chapter.position),
        };
        remember_owner(number, &chapter.path);
    }
    if let Some(ref prev) = previous_composition {
        for entry in &prev.entries {
            remember_owner(Some(entry.storage_chapter_number.clone()), &entry.path);
        }
    }

    for entry in &composition.entries {
        if let Some(current) = by_path.get(&entry.path) {
            if let Some(ref current_num) = current.chapter_number {
                if canonical_chapter_number_str(current_num).as_deref()
                    != Some(entry.storage_chapter_number.as_str())
                {
                    return Err(
                        "Chapter composition: an existing storage chapter number cannot change"
                            .to_string(),
                    );
                }
            }
        }
        if storage_owners
            .get(&entry.storage_chapter_number)
            .is_some_and(|owners| owners.iter().any(|owner| owner != &entry.path))
        {
            return Err(
                "Chapter composition: the storage chapter number belongs to another chapter; existing files were retained"
                    .to_string(),
            );
        }
    }

    if let Some(root) = root {
        assert_chapter_composition_storage_ownership(
            root,
            &plugin_id,
            source_novel_id.as_deref(),
            &novel_path,
            cached_directory.as_deref(),
            &composition,
            previous_composition.as_ref(),
            &original_existing,
            prepared_copies,
        )?;
    }

    for chunk in aliases.chunks(100) {
        let aliases_json = serde_json::to_string(chunk)
            .map_err(|err| format!("db chapter composition: encode aliases: {err}"))?;
        sqlx::query(
            "WITH aliases AS ( \
                SELECT json_extract(value, '$[0]') AS old_path, \
                       json_extract(value, '$[1]') AS new_path \
                FROM json_each(?1) \
             ) UPDATE chapter \
               SET path = (SELECT new_path FROM aliases WHERE old_path = chapter.path) \
               WHERE novel_id = ?2 AND path IN (SELECT old_path FROM aliases)",
        )
        .bind(aliases_json)
        .bind(novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db chapter composition: apply aliases: {err}"))?;
    }

    #[derive(Clone, Copy)]
    struct ReadingState {
        progress: f64,
        bookmark: i64,
        read_at: Option<i64>,
        excluded_at: Option<i64>,
    }

    let reading_rows = sqlx::query(
        "SELECT chapter_path, progress, bookmark, read_at \
         FROM work_metadata_reading_state WHERE plugin_id = ?1 AND novel_path = ?2",
    )
    .bind(&plugin_id)
    .bind(&novel_path)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db chapter composition: load reading state: {err}"))?;

    let mut reading_by_path: HashMap<String, ReadingState> =
        HashMap::with_capacity(reading_rows.len());
    for row in reading_rows {
        let path: String = row.get("chapter_path");
        reading_by_path.insert(
            path,
            ReadingState {
                progress: crate::db::decode_sqlite_f64(&row, "progress"),
                bookmark: row.get("bookmark"),
                read_at: row.get("read_at"),
                excluded_at: None,
            },
        );
    }

    let mut previous_paths_by_origin: HashMap<(String, String, String), Vec<String>> =
        HashMap::new();
    if let Some(ref prev) = previous_composition {
        for entry in &prev.entries {
            for source in &entry.sources {
                let list = previous_paths_by_origin
                    .entry((
                        source.plugin_id.clone(),
                        source.novel_id.clone(),
                        source.chapter_path.clone(),
                    ))
                    .or_default();
                if !list.contains(&entry.path) {
                    list.push(entry.path.clone());
                }
            }
        }
    }

    let entries = included_chapter_composition_entries(&composition);
    let mut inherited_state_by_path: HashMap<String, ReadingState> = HashMap::new();
    for entry in &entries {
        if by_path.contains_key(&entry.path) {
            continue;
        }
        let mut candidate_paths = vec![entry.path.clone()];
        let mut push_unique = |candidate: &str| {
            if !candidate_paths.iter().any(|existing| existing == candidate) {
                candidate_paths.push(candidate.to_string());
            }
        };
        for source in &entry.sources {
            if source.plugin_id == plugin_id
                && Some(source.novel_id.as_str()) == source_novel_id.as_deref()
            {
                push_unique(&source.chapter_path);
            }
            if let Some(prev_paths) = previous_paths_by_origin.get(&(
                source.plugin_id.clone(),
                source.novel_id.clone(),
                source.chapter_path.clone(),
            )) {
                for prev_path in prev_paths {
                    push_unique(prev_path);
                }
            }
        }

        let mut state = ReadingState {
            progress: 0.0,
            bookmark: 0,
            read_at: None,
            excluded_at: None,
        };
        for candidate in &candidate_paths {
            if let Some(prev) = by_path.get(candidate) {
                state.progress = state.progress.max(prev.progress);
                state.bookmark = i64::from(state.bookmark != 0 || prev.bookmark != 0);
                if let Some(read_at) = prev.read_at {
                    state.read_at = Some(state.read_at.unwrap_or(0).max(read_at));
                }
                if let Some(excluded_at) = prev.excluded_at {
                    state.excluded_at =
                        Some(state.excluded_at.unwrap_or(excluded_at).min(excluded_at));
                }
            }
            if let Some(prev) = reading_by_path.get(candidate) {
                state.progress = state.progress.max(prev.progress);
                state.bookmark = i64::from(state.bookmark != 0 || prev.bookmark != 0);
                if let Some(read_at) = prev.read_at {
                    state.read_at = Some(state.read_at.unwrap_or(0).max(read_at));
                }
            }
        }
        inherited_state_by_path.insert(entry.path.clone(), state);
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);

    for chunk in entries.chunks(50) {
        let mut placeholders = Vec::with_capacity(chunk.len());
        for idx in 0..chunk.len() {
            let base = idx * 12;
            let tuple: Vec<String> = (1..=12).map(|col| format!("?{}", base + col)).collect();
            placeholders.push(format!("({})", tuple.join(",")));
        }
        let sql = format!(
            "INSERT INTO chapter(novel_id, path, name, chapter_number, position, page, content_type, \
                                 release_time, progress, bookmark, read_at, found_at) \
             VALUES {} \
             ON CONFLICT(novel_id, path) DO UPDATE SET \
               name = excluded.name, \
               chapter_number = excluded.chapter_number, \
               position = excluded.position, \
               page = excluded.page, \
               content_type = excluded.content_type, \
               release_time = excluded.release_time \
             WHERE chapter.name IS NOT excluded.name \
                OR chapter.chapter_number IS NOT excluded.chapter_number \
                OR chapter.position IS NOT excluded.position \
                OR chapter.page IS NOT excluded.page \
                OR chapter.content_type IS NOT excluded.content_type \
                OR chapter.release_time IS NOT excluded.release_time",
            placeholders.join(",")
        );
        let mut query = sqlx::query(&sql);
        for entry in chunk {
            let source = &entry.sources[entry.primary_source];
            let state = inherited_state_by_path
                .get(&entry.path)
                .or_else(|| reading_by_path.get(&entry.path))
                .copied();
            let display_name = entry
                .user
                .name
                .as_deref()
                .unwrap_or(source.name.as_str());
            query = query
                .bind(novel_id)
                .bind(&entry.path)
                .bind(display_name)
                .bind(&entry.storage_chapter_number)
                .bind(entry.user.order)
                .bind(&source.page)
                .bind(&source.content_type)
                .bind(&source.release_time)
                .bind(state.map_or(0.0, |s| s.progress))
                .bind(state.map_or(0, |s| s.bookmark))
                .bind(state.and_then(|s| s.read_at))
                .bind(now);
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter composition: upsert chapters: {err}"))?;

        let exclusions: Vec<(&str, i64)> = chunk
            .iter()
            .filter_map(|entry| {
                let excluded_at = inherited_state_by_path.get(&entry.path)?.excluded_at?;
                Some((entry.path.as_str(), excluded_at))
            })
            .collect();
        if !exclusions.is_empty() {
            let values: Vec<String> = (0..exclusions.len())
                .map(|idx| format!("(?{}, ?{})", idx * 2 + 2, idx * 2 + 3))
                .collect();
            let exclusion_sql = format!(
                "WITH inherited(path, created_at) AS (VALUES {}) \
                 INSERT OR IGNORE INTO chapter_download_goal_exclusion(chapter_id, created_at) \
                 SELECT c.id, i.created_at FROM chapter c \
                 JOIN inherited i ON i.path = c.path WHERE c.novel_id = ?1",
                values.join(",")
            );
            let mut ex_query = sqlx::query(&exclusion_sql).bind(novel_id);
            for (path, excluded_at) in exclusions {
                ex_query = ex_query.bind(path).bind(excluded_at);
            }
            ex_query
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db chapter composition: inherit exclusions: {err}"))?;
        }
    }

    let included_paths: HashSet<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    let removed_paths: Vec<&str> = existing
        .iter()
        .filter(|chapter| !included_paths.contains(chapter.path.as_str()))
        .map(|chapter| chapter.path.as_str())
        .collect();

    for chunk in removed_paths.chunks(400) {
        let placeholders: Vec<String> = (0..chunk.len()).map(|idx| format!("?{}", idx + 2)).collect();
        let in_clause = placeholders.join(",");
        let delete_queue_sql = format!(
            "DELETE FROM chapter_download_queue WHERE chapter_id IN \
             (SELECT id FROM chapter WHERE novel_id = ?1 AND path IN ({in_clause}))"
        );
        let mut queue_query = sqlx::query(&delete_queue_sql).bind(novel_id);
        for path in chunk {
            queue_query = queue_query.bind(*path);
        }
        queue_query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter composition: delete excluded queue rows: {err}"))?;

        let delete_chapter_sql =
            format!("DELETE FROM chapter WHERE novel_id = ?1 AND path IN ({in_clause})");
        let mut chapter_query = sqlx::query(&delete_chapter_sql).bind(novel_id);
        for path in chunk {
            chapter_query = chapter_query.bind(*path);
        }
        chapter_query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db chapter composition: delete excluded chapters: {err}"))?;
    }

    Ok(())
}
