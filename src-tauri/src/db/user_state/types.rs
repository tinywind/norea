use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

use crate::chapter_media::ChapterPayloadSnapshot;
use crate::db::chapter_composition::{
    parse_chapter_composition, ChapterCompositionEntryDto, ChapterCompositionV1Dto,
    ChapterSourceSnapshotDto,
};

pub const USER_STATE_VERSION: i64 = 1;
pub const USER_STATE_CLIENT_BATCH_BYTES: usize = 30 * 1024 * 1024;
pub const USER_STATE_PRELINK_BASE_REVISION: i64 = -1;
pub const STORED_CHAPTER_PREFIX: &str = "norea-stored:";
const MAX_SAFE_INT_I64: i64 = 9_007_199_254_740_991;
const MAX_SAFE_INT_F64: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserStateRebindMode {
    Reseed,
    StartFresh,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateBindingDto {
    pub server_url: String,
    pub workspace_id: String,
    pub epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateWorkReferenceDto {
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub novel_path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateChapterReferenceDto {
    pub chapter_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composition_entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableReaderAnchorDto {
    pub segment_index: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_ordinal: Option<i64>,
    pub offset: f64,
    pub segment_count: i64,
    pub progress: f64,
    pub saved_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateResumeEffectDto {
    pub novel_id: i64,
    pub chapter_id: Option<i64>,
    pub anchor: Option<PortableReaderAnchorDto>,
    pub opened_at: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateApplyEffectsDto {
    pub resumes: Vec<UserStateResumeEffectDto>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_entity_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_finished_reading: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateLedgerStatusDto {
    pub cursor: i64,
    pub through: Option<i64>,
    pub pending: i64,
    pub sendable_pending: i64,
    pub conflicts: usize,
    pub deferred: i64,
    pub projection_pending: i64,
    pub projection_failed: i64,
    pub last_success_at: Option<i64>,
    pub paused_after_restore: bool,
}

pub fn is_local_user_state_entity(entity: &JsonValue, value: Option<&JsonValue>) -> bool {
    // Library membership is device-local; adding or removing a work on one device must never
    // mutate another device's library shelf or download goals.
    if entity.get("kind").and_then(JsonValue::as_str) == Some("library") {
        return true;
    }
    if entity
        .get("work")
        .and_then(|w| w.get("pluginId"))
        .and_then(JsonValue::as_str)
        == Some("local")
    {
        return true;
    }
    if entity.get("kind").and_then(JsonValue::as_str) == Some("composition") {
        if let Some(entries) = value
            .and_then(|v| v.get("composition"))
            .and_then(|c| c.get("entries"))
            .and_then(JsonValue::as_array)
        {
            if entries.iter().any(|entry| {
                entry
                    .get("sources")
                    .and_then(JsonValue::as_array)
                    .is_some_and(|sources| {
                        sources.iter().any(|src| {
                            src.get("pluginId").and_then(JsonValue::as_str) == Some("local")
                        })
                    })
            }) {
                return true;
            }
        }
    }
    false
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateConflictDto {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
    pub entity: JsonValue,
    pub local: JsonValue,
    pub shared: Option<JsonValue>,
    pub reason: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserStateDeferredDto {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_name: Option<String>,
    pub entity: JsonValue,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveUserStateLedgerConflictInputDto {
    pub id: String,
    pub version: String,
    pub choice: String,
    #[serde(default)]
    pub category_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedStoredChapterPath {
    pub folder_path: String,
    pub chapter_number: String,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct ParsedUserStateOperation {
    pub operation_id: String,
    pub entity: JsonValue,
    pub base_revision: i64,
    pub value: JsonValue,
    pub seed: bool,
}

impl ParsedUserStateOperation {
    pub fn to_json(&self) -> JsonValue {
        let mut map = JsonMap::new();
        map.insert("operationId".into(), JsonValue::String(self.operation_id.clone()));
        map.insert("entity".into(), self.entity.clone());
        map.insert("baseRevision".into(), JsonValue::Number(self.base_revision.into()));
        map.insert("value".into(), self.value.clone());
        if self.seed {
            map.insert("seed".into(), JsonValue::Bool(true));
        }
        JsonValue::Object(map)
    }
}

#[derive(Debug, Clone)]
pub struct ParsedUserStateRecord {
    pub entity: JsonValue,
    pub value: JsonValue,
    pub revision: i64,
    pub operation_id: String,
    pub updated_at: i64,
    pub device_id: String,
    pub device_name: String,
}

impl ParsedUserStateRecord {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "entity": self.entity,
            "value": self.value,
            "revision": self.revision,
            "operationId": self.operation_id,
            "updatedAt": self.updated_at,
            "deviceId": self.device_id,
            "deviceName": self.device_name,
        })
    }
}

#[derive(Debug, Clone)]
pub struct ParsedUserStateReadResponse {
    pub workspace_id: String,
    pub epoch: String,
    pub head_revision: i64,
    pub through: i64,
    pub next_cursor: i64,
    pub has_more: bool,
    pub records: Vec<ParsedUserStateRecord>,
}

#[derive(Debug, Clone)]
pub struct ParsedUserStateRetentionResponse {
    pub workspace_id: String,
    pub epoch: String,
    pub head_revision: i64,
    pub compacted_through: i64,
    pub seed_allowed: bool,
    pub seed_cutoff_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ParsedUserStateSnapshotResponse {
    pub workspace_id: String,
    pub epoch: String,
    pub head_revision: i64,
    pub snapshot_revision: i64,
    pub next_entity_key: Option<String>,
    pub has_more: bool,
    pub seed_allowed: bool,
    pub seed_cutoff_at: Option<i64>,
    pub records: Vec<ParsedUserStateRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryAliasPair {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone)]
pub struct ParsedUserStateMergeResult {
    pub operation_id: String,
    pub status: String,
    pub current: Option<ParsedUserStateRecord>,
    pub reason: Option<String>,
    pub category_alias: Option<CategoryAliasPair>,
}

impl ParsedUserStateMergeResult {
    pub fn to_json(&self) -> JsonValue {
        let mut map = JsonMap::new();
        map.insert("operationId".into(), JsonValue::String(self.operation_id.clone()));
        map.insert("status".into(), JsonValue::String(self.status.clone()));
        map.insert(
            "current".into(),
            match &self.current {
                Some(record) => record.to_json(),
                None => JsonValue::Null,
            },
        );
        if let Some(ref reason) = self.reason {
            map.insert("reason".into(), JsonValue::String(reason.clone()));
        }
        if let Some(ref alias) = self.category_alias {
            map.insert(
                "categoryAlias".into(),
                json!({ "from": alias.from, "to": alias.to }),
            );
        }
        JsonValue::Object(map)
    }
}

pub fn protocol_err(message: impl AsRef<str>) -> String {
    format!("User state: {}", message.as_ref())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

pub fn random_uuid_v4() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    fill_random_bytes(&mut bytes)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    ))
}

#[cfg(any(target_os = "android", target_os = "windows", test))]
fn fill_random_bytes(buf: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buf).map_err(|err| format!("random bytes failed: {err}"))
}

#[cfg(all(unix, not(target_os = "android"), not(test)))]
fn fill_random_bytes(buf: &mut [u8]) -> Result<(), String> {
    use std::io::Read as _;
    let mut file = std::fs::File::open("/dev/urandom")
        .map_err(|err| format!("open /dev/urandom: {err}"))?;
    file.read_exact(buf)
        .map_err(|err| format!("read /dev/urandom: {err}"))
}

pub fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(byte as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(&mut out, "%{byte:02X}");
        }
    }
    out
}

pub fn decode_uri_component(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut idx = 0;
    while idx < bytes.len() {
        if bytes[idx] == b'%' {
            if idx + 2 >= bytes.len() {
                return Err("incomplete percent escape".into());
            }
            let hi = (bytes[idx + 1] as char)
                .to_digit(16)
                .ok_or_else(|| "invalid hex digit".to_string())?;
            let lo = (bytes[idx + 2] as char)
                .to_digit(16)
                .ok_or_else(|| "invalid hex digit".to_string())?;
            out.push(((hi << 4) | lo) as u8);
            idx += 3;
        } else {
            out.push(bytes[idx]);
            idx += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "invalid UTF-8 percent escape".into())
}

pub fn normalize_js_numbers(value: &JsonValue) -> Result<JsonValue, String> {
    match value {
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::String(_) => Ok(value.clone()),
        JsonValue::Number(num) => {
            if let Some(i) = num.as_i64() {
                return Ok(JsonValue::Number(i.into()));
            }
            if let Some(u) = num.as_u64() {
                if u <= MAX_SAFE_INT_I64 as u64 {
                    return Ok(JsonValue::Number((u as i64).into()));
                }
            }
            let Some(f) = num.as_f64() else {
                return Err(protocol_err("value is not portable JSON"));
            };
            if !f.is_finite() {
                return Err(protocol_err("value is not portable JSON"));
            }
            if f.fract() == 0.0 && (-MAX_SAFE_INT_F64..=MAX_SAFE_INT_F64).contains(&f) {
                return Ok(JsonValue::Number((f as i64).into()));
            }
            serde_json::Number::from_f64(f)
                .map(JsonValue::Number)
                .ok_or_else(|| protocol_err("value is not portable JSON"))
        }
        JsonValue::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(normalize_js_numbers(item)?);
            }
            Ok(JsonValue::Array(out))
        }
        JsonValue::Object(map) => {
            let mut out = JsonMap::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), normalize_js_numbers(v)?);
            }
            Ok(JsonValue::Object(out))
        }
    }
}

pub fn canonical_user_state_json(value: &JsonValue) -> Result<String, String> {
    match value {
        JsonValue::Null => Ok("null".to_string()),
        JsonValue::Bool(b) => Ok(if *b { "true" } else { "false" }.to_string()),
        JsonValue::String(s) => {
            serde_json::to_string(s).map_err(|_| protocol_err("value is not portable JSON"))
        }
        JsonValue::Number(num) => {
            if let Some(i) = num.as_i64() {
                return Ok(i.to_string());
            }
            if let Some(u) = num.as_u64() {
                return Ok(u.to_string());
            }
            let Some(f) = num.as_f64() else {
                return Err(protocol_err("value is not portable JSON"));
            };
            if !f.is_finite() {
                return Err(protocol_err("value is not portable JSON"));
            }
            if f.fract() == 0.0 && (-MAX_SAFE_INT_F64..=MAX_SAFE_INT_F64).contains(&f) {
                return Ok(if f == 0.0 {
                    "0".to_string()
                } else {
                    (f as i64).to_string()
                });
            }
            serde_json::to_string(&f).map_err(|_| protocol_err("value is not portable JSON"))
        }
        JsonValue::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(canonical_user_state_json(item)?);
            }
            Ok(format!("[{}]", parts.join(",")))
        }
        JsonValue::Object(map) => {
            let mut entries: Vec<(&String, &JsonValue)> = map.iter().collect();
            entries.sort_by(|(lhs, _), (rhs, _)| lhs.encode_utf16().cmp(rhs.encode_utf16()));
            let mut parts = Vec::with_capacity(entries.len());
            for (k, v) in entries {
                let key_json = serde_json::to_string(k)
                    .map_err(|_| protocol_err("value is not portable JSON"))?;
                let val_json = canonical_user_state_json(v)?;
                parts.push(format!("{key_json}:{val_json}"));
            }
            Ok(format!("{{{}}}", parts.join(",")))
        }
    }
}

pub fn user_state_json_bytes(value: &JsonValue) -> Result<usize, String> {
    let normalized = normalize_js_numbers(value)?;
    let encoded = serde_json::to_string(&normalized)
        .map_err(|_| protocol_err("value is not portable JSON"))?;
    Ok(encoded.len())
}

pub fn namespace_for(binding: &UserStateBindingDto) -> String {
    canonical_user_state_json(&json!([
        binding.server_url,
        binding.workspace_id,
        binding.epoch
    ]))
    .expect("binding strings are valid JSON")
}

pub fn fold_ascii(value: &str) -> String {
    value.to_ascii_lowercase()
}

pub fn user_state_work_key(work: &UserStateWorkReferenceDto) -> String {
    user_state_work_key_parts(
        &work.plugin_id,
        work.source_novel_id.as_deref(),
        &work.novel_path,
    )
}

pub fn user_state_work_key_parts(
    plugin_id: &str,
    source_novel_id: Option<&str>,
    novel_path: &str,
) -> String {
    match source_novel_id {
        None => serde_json::to_string(&(plugin_id, "path", novel_path)).unwrap_or_default(),
        Some(id) => serde_json::to_string(&(plugin_id, "id", fold_ascii(id))).unwrap_or_default(),
    }
}

pub fn user_state_entity_key(entity: &JsonValue) -> Result<String, String> {
    let kind = entity
        .get("kind")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| protocol_err("invalid entity"))?;
    if kind == "category" {
        let category_id = entity
            .get("categoryId")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| protocol_err("invalid category ID"))?;
        return serde_json::to_string(&("category", category_id))
            .map_err(|err| protocol_err(err.to_string()));
    }
    let work = entity
        .get("work")
        .and_then(JsonValue::as_object)
        .ok_or_else(|| protocol_err("invalid work reference"))?;
    let plugin_id = work
        .get("pluginId")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| protocol_err("invalid plugin ID"))?;
    let novel_path = work
        .get("novelPath")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| protocol_err("invalid source work path"))?;
    let source_novel_id = work.get("sourceNovelId").and_then(JsonValue::as_str);
    let work_key = user_state_work_key_parts(plugin_id, source_novel_id, novel_path);
    match kind {
        "membership" => {
            let category_id = entity
                .get("categoryId")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| protocol_err("invalid category ID"))?;
            serde_json::to_string(&("membership", work_key, category_id))
                .map_err(|err| protocol_err(err.to_string()))
        }
        "reading" | "bookmark" => {
            let chapter_path = entity
                .get("chapter")
                .and_then(|c| c.get("chapterPath"))
                .and_then(JsonValue::as_str)
                .ok_or_else(|| protocol_err("invalid source chapter path"))?;
            serde_json::to_string(&(kind, work_key, chapter_path))
                .map_err(|err| protocol_err(err.to_string()))
        }
        "library" | "resume" | "composition" => serde_json::to_string(&(kind, work_key))
            .map_err(|err| protocol_err(err.to_string())),
        _ => Err(protocol_err("unknown entity kind")),
    }
}

pub fn is_decimal_number_str(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(int_part) = parts.next() else {
        return false;
    };
    if int_part.is_empty() || !int_part.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(frac_part) => {
            !frac_part.is_empty()
                && frac_part.bytes().all(|b| b.is_ascii_digit())
                && parts.next().is_none()
        }
    }
}

pub fn stored_chapter_number(value: Option<&str>) -> Option<String> {
    let raw = value?;
    if !is_decimal_number_str(raw) {
        return None;
    }
    let parsed: f64 = raw.parse().ok()?;
    if !parsed.is_finite() || parsed < 0.0 || parsed >= 1e21 || (parsed > 0.0 && parsed < 1e-6) {
        return None;
    }
    let formatted = if parsed == 0.0 {
        "0".to_string()
    } else if parsed.fract() == 0.0 && parsed <= MAX_SAFE_INT_F64 {
        (parsed as i64).to_string()
    } else {
        serde_json::to_string(&parsed).ok()?
    };
    is_decimal_number_str(&formatted).then_some(formatted)
}

pub fn stored_chapter_digest(inventory: &ChapterPayloadSnapshot) -> Option<String> {
    let body = inventory.body.as_ref()?;
    if body.bytes == 0
        || body.sha256.len() != 64
        || !body
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut assets = HashMap::with_capacity(inventory.stored_assets.len());
    for asset in &inventory.stored_assets {
        if asset.key.is_empty()
            || asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return None;
        }
        assets.insert(asset.key.as_str(), asset);
    }
    let declared: Vec<String> = match &inventory.expected_asset_keys {
        None => {
            if inventory.media_complete && inventory.stored_assets.is_empty() {
                Vec::new()
            } else {
                return None;
            }
        }
        Some(keys) => {
            if keys.iter().any(String::is_empty) {
                return None;
            }
            let mut sorted = keys.clone();
            sorted.sort();
            sorted
        }
    };
    if declared.iter().any(|k| !assets.contains_key(k.as_str())) {
        return None;
    }
    if declared.is_empty() {
        return Some(body.sha256.clone());
    }
    let asset_rows: Vec<JsonValue> = declared
        .iter()
        .map(|key| {
            let asset = assets[key.as_str()];
            json!([key, asset.sha256, asset.bytes])
        })
        .collect();
    let content = serde_json::to_string(&json!([
        "norea-stored-v1",
        [body.sha256, body.bytes],
        asset_rows
    ]))
    .ok()?;
    Some(sha256_hex(content.as_bytes()))
}

pub fn stored_chapter_path(chapter_number: Option<&str>, content_sha256: &str) -> Option<String> {
    let number = stored_chapter_number(chapter_number)?;
    if content_sha256.len() != 64
        || !content_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let encoded_folder = encode_uri_component(&format!("norea-folder:{number}"));
    Some(format!("{STORED_CHAPTER_PREFIX}{content_sha256}:{encoded_folder}"))
}

pub fn parse_stored_chapter_path(path: &str) -> Option<ParsedStoredChapterPath> {
    let rest = path.strip_prefix(STORED_CHAPTER_PREFIX)?;
    let (sha256, encoded_folder) = rest.split_once(':')?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || encoded_folder.is_empty()
    {
        return None;
    }
    let folder_path = decode_uri_component(encoded_folder).ok()?;
    let raw_number = folder_path.strip_prefix("norea-folder:")?;
    let chapter_number = stored_chapter_number(Some(raw_number))?;
    if stored_chapter_path(Some(&chapter_number), sha256)?.as_str() != path {
        return None;
    }
    Some(ParsedStoredChapterPath {
        folder_path,
        chapter_number,
        sha256: sha256.to_string(),
    })
}

fn expect_object_keys<'a>(
    value: &'a JsonValue,
    allowed: &[&str],
    label: &str,
) -> Result<&'a JsonMap<String, JsonValue>, String> {
    let Some(map) = value.as_object() else {
        return Err(protocol_err(format!("invalid {label}")));
    };
    if map.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(protocol_err(format!("unexpected field in {label}")));
    }
    Ok(map)
}

fn parse_text_value(
    value: Option<&JsonValue>,
    label: &str,
    maximum: usize,
    allow_empty: bool,
    identity: bool,
) -> Result<String, String> {
    let Some(s) = value.and_then(JsonValue::as_str) else {
        return Err(protocol_err(format!("invalid {label}")));
    };
    let utf16_len = s.encode_utf16().count();
    if utf16_len > maximum
        || (!allow_empty && s.trim().is_empty())
        || (identity
            && s.chars()
                .any(|c| (c as u32) <= 0x1f || (c as u32) == 0x7f))
        || (!identity && s.contains('\0'))
    {
        return Err(protocol_err(format!("invalid {label}")));
    }
    Ok(s.to_string())
}

fn parse_identifier(value: Option<&JsonValue>, label: &str) -> Result<String, String> {
    let s = parse_text_value(value, label, 128, false, true)?;
    if !s
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        return Err(protocol_err(format!("invalid {label}")));
    }
    Ok(s)
}

fn parse_safe_integer(
    value: Option<&JsonValue>,
    label: &str,
    minimum: i64,
) -> Result<i64, String> {
    let Some(num) = value.and_then(JsonValue::as_number) else {
        return Err(protocol_err(format!("invalid {label}")));
    };
    let parsed = if let Some(i) = num.as_i64() {
        i
    } else if let Some(f) = num.as_f64() {
        if !f.is_finite() || f.fract() != 0.0 || !(-MAX_SAFE_INT_F64..=MAX_SAFE_INT_F64).contains(&f)
        {
            return Err(protocol_err(format!("invalid {label}")));
        }
        f as i64
    } else {
        return Err(protocol_err(format!("invalid {label}")));
    };
    if !(-MAX_SAFE_INT_I64..=MAX_SAFE_INT_I64).contains(&parsed) || parsed < minimum {
        return Err(protocol_err(format!("invalid {label}")));
    }
    Ok(parsed)
}

fn parse_number_range(
    value: Option<&JsonValue>,
    label: &str,
    minimum: f64,
    maximum: f64,
) -> Result<f64, String> {
    let Some(f) = value.and_then(JsonValue::as_f64) else {
        return Err(protocol_err(format!("invalid {label}")));
    };
    if !f.is_finite() || f < minimum || f > maximum {
        return Err(protocol_err(format!("invalid {label}")));
    }
    Ok(f)
}

fn parse_bool(value: Option<&JsonValue>, label: &str) -> Result<bool, String> {
    value
        .and_then(JsonValue::as_bool)
        .ok_or_else(|| protocol_err(format!("invalid {label}")))
}

fn parse_nullable_time(value: Option<&JsonValue>, label: &str) -> Result<Option<i64>, String> {
    match value {
        Some(JsonValue::Null) => Ok(None),
        other => parse_safe_integer(other, label, 0).map(Some),
    }
}

pub fn parse_work_reference(value: &JsonValue) -> Result<UserStateWorkReferenceDto, String> {
    let row = expect_object_keys(
        value,
        &["pluginId", "sourceNovelId", "novelPath", "name"],
        "work reference",
    )?;
    let source_novel_id = match row.get("sourceNovelId") {
        Some(JsonValue::Null) => None,
        other => Some(parse_text_value(other, "source work ID", 1024, false, true)?),
    };
    Ok(UserStateWorkReferenceDto {
        plugin_id: parse_text_value(row.get("pluginId"), "plugin ID", 160, false, true)?,
        source_novel_id,
        novel_path: parse_text_value(row.get("novelPath"), "source work path", 8192, false, true)?,
        name: parse_text_value(row.get("name"), "work name", 4096, true, false)?,
    })
}

pub fn parse_chapter_reference(value: &JsonValue) -> Result<UserStateChapterReferenceDto, String> {
    let row = expect_object_keys(
        value,
        &["chapterPath", "compositionEntryId", "name"],
        "chapter reference",
    )?;
    let composition_entry_id = match row.get("compositionEntryId") {
        None => None,
        some => Some(parse_identifier(some, "composition entry ID")?),
    };
    let name = match row.get("name") {
        None => None,
        some => Some(parse_text_value(some, "chapter name", 4096, true, false)?),
    };
    Ok(UserStateChapterReferenceDto {
        chapter_path: parse_text_value(
            row.get("chapterPath"),
            "source chapter path",
            8192,
            false,
            true,
        )?,
        composition_entry_id,
        name,
    })
}

pub fn parse_portable_reader_anchor(value: &JsonValue) -> Result<PortableReaderAnchorDto, String> {
    let row = expect_object_keys(
        value,
        &[
            "segmentIndex",
            "mediaOrdinal",
            "offset",
            "segmentCount",
            "progress",
            "savedAt",
        ],
        "reader anchor",
    )?;
    let segment_count = parse_safe_integer(row.get("segmentCount"), "reader segment count", 1)?;
    let segment_index = parse_safe_integer(row.get("segmentIndex"), "reader segment index", 0)?;
    if segment_count > 1_000_000 || segment_index >= segment_count {
        return Err(protocol_err("reader anchor is outside its document"));
    }
    let media_ordinal = match row.get("mediaOrdinal") {
        None => None,
        some => {
            let ordinal = parse_safe_integer(some, "reader media ordinal", 0)?;
            if ordinal > 1_000_000 {
                return Err(protocol_err("reader media ordinal exceeds the limit"));
            }
            Some(ordinal)
        }
    };
    Ok(PortableReaderAnchorDto {
        segment_index,
        media_ordinal,
        offset: parse_number_range(row.get("offset"), "reader offset fraction", 0.0, 1.0)?,
        segment_count,
        progress: parse_number_range(row.get("progress"), "reader progress", 0.0, 100.0)?,
        saved_at: parse_safe_integer(row.get("savedAt"), "reader anchor time", 0)?,
    })
}

fn number_value_js(value: f64) -> Result<JsonValue, String> {
    if value.fract() == 0.0 && (-MAX_SAFE_INT_F64..=MAX_SAFE_INT_F64).contains(&value) {
        Ok(JsonValue::Number((value as i64).into()))
    } else {
        serde_json::Number::from_f64(value)
            .map(JsonValue::Number)
            .ok_or_else(|| protocol_err("value is not portable JSON"))
    }
}

pub fn anchor_to_json(anchor: &PortableReaderAnchorDto) -> Result<JsonValue, String> {
    let mut map = JsonMap::new();
    map.insert("segmentIndex".into(), JsonValue::Number(anchor.segment_index.into()));
    map.insert("segmentCount".into(), JsonValue::Number(anchor.segment_count.into()));
    if let Some(ordinal) = anchor.media_ordinal {
        map.insert("mediaOrdinal".into(), JsonValue::Number(ordinal.into()));
    }
    map.insert("offset".into(), number_value_js(anchor.offset)?);
    map.insert("progress".into(), number_value_js(anchor.progress)?);
    map.insert("savedAt".into(), JsonValue::Number(anchor.saved_at.into()));
    Ok(JsonValue::Object(map))
}

pub fn parse_user_state_entity(value: &JsonValue) -> Result<JsonValue, String> {
    let Some(obj) = value.as_object() else {
        return Err(protocol_err("invalid entity"));
    };
    let Some(kind) = obj.get("kind").and_then(JsonValue::as_str) else {
        return Err(protocol_err("unknown entity kind"));
    };
    match kind {
        "category" => {
            let row = expect_object_keys(value, &["kind", "categoryId"], "category entity")?;
            let category_id = parse_identifier(row.get("categoryId"), "category ID")?;
            Ok(json!({ "kind": "category", "categoryId": category_id }))
        }
        "membership" => {
            let row =
                expect_object_keys(value, &["kind", "work", "categoryId"], "membership entity")?;
            let work = parse_work_reference(
                row.get("work")
                    .ok_or_else(|| protocol_err("invalid work reference"))?,
            )?;
            let category_id = parse_identifier(row.get("categoryId"), "category ID")?;
            Ok(json!({
                "kind": "membership",
                "work": serde_json::to_value(work).unwrap(),
                "categoryId": category_id,
            }))
        }
        "reading" | "bookmark" => {
            let row = expect_object_keys(value, &["kind", "work", "chapter"], "chapter entity")?;
            let work = parse_work_reference(
                row.get("work")
                    .ok_or_else(|| protocol_err("invalid work reference"))?,
            )?;
            let chapter = parse_chapter_reference(
                row.get("chapter")
                    .ok_or_else(|| protocol_err("invalid chapter reference"))?,
            )?;
            Ok(json!({
                "kind": kind,
                "work": serde_json::to_value(work).unwrap(),
                "chapter": serde_json::to_value(chapter).unwrap(),
            }))
        }
        "library" | "resume" | "composition" => {
            let row = expect_object_keys(value, &["kind", "work"], "work entity")?;
            let work = parse_work_reference(
                row.get("work")
                    .ok_or_else(|| protocol_err("invalid work reference"))?,
            )?;
            Ok(json!({
                "kind": kind,
                "work": serde_json::to_value(work).unwrap(),
            }))
        }
        _ => Err(protocol_err("unknown entity kind")),
    }
}

pub fn parse_user_state_value(kind: &str, value: &JsonValue) -> Result<JsonValue, String> {
    match kind {
        "library" => {
            let row = expect_object_keys(value, &["inLibrary", "addedAt"], "library value")?;
            let in_library = parse_bool(row.get("inLibrary"), "library membership")?;
            let added_at = parse_nullable_time(row.get("addedAt"), "library added time")?;
            Ok(json!({ "inLibrary": in_library, "addedAt": added_at }))
        }
        "category" => {
            let row = expect_object_keys(value, &["name", "sort", "deleted"], "category value")?;
            let name = parse_text_value(row.get("name"), "category name", 512, false, false)?;
            let sort = parse_safe_integer(
                row.get("sort"),
                "category order",
                -MAX_SAFE_INT_I64,
            )?;
            let deleted = parse_bool(row.get("deleted"), "category deletion")?;
            Ok(json!({ "name": name, "sort": sort, "deleted": deleted }))
        }
        "membership" => {
            let row = expect_object_keys(value, &["included"], "membership value")?;
            let included = parse_bool(row.get("included"), "category membership")?;
            Ok(json!({ "included": included }))
        }
        "reading" => {
            let row = expect_object_keys(value, &["progress", "readAt"], "reading value")?;
            let progress =
                parse_number_range(row.get("progress"), "reading progress", 0.0, 100.0)?;
            let read_at = parse_nullable_time(row.get("readAt"), "read time")?;
            Ok(json!({
                "progress": number_value_js(progress)?,
                "readAt": read_at,
            }))
        }
        "bookmark" => {
            let row = expect_object_keys(value, &["bookmarked"], "bookmark value")?;
            let bookmarked = parse_bool(row.get("bookmarked"), "bookmark flag")?;
            Ok(json!({ "bookmarked": bookmarked }))
        }
        "resume" => {
            let row =
                expect_object_keys(value, &["chapter", "anchor", "openedAt"], "resume value")?;
            let chapter = match row.get("chapter") {
                Some(JsonValue::Null) => None,
                Some(raw) => Some(parse_chapter_reference(raw)?),
                None => return Err(protocol_err("invalid chapter reference")),
            };
            let anchor = match row.get("anchor") {
                Some(JsonValue::Null) => None,
                Some(raw) => Some(parse_portable_reader_anchor(raw)?),
                None => return Err(protocol_err("invalid reader anchor")),
            };
            if chapter.is_none() && anchor.is_some() {
                return Err(protocol_err("an empty resume cannot contain an anchor"));
            }
            let opened_at = parse_nullable_time(row.get("openedAt"), "resume opened time")?;
            Ok(json!({
                "chapter": chapter,
                "anchor": match anchor {
                    Some(ref a) => anchor_to_json(a)?,
                    None => JsonValue::Null,
                },
                "openedAt": opened_at,
            }))
        }
        "composition" => {
            let row = expect_object_keys(value, &["composition"], "composition value")?;
            let raw_comp = row
                .get("composition")
                .ok_or_else(|| protocol_err("invalid composition value"))?;
            let comp = parse_chapter_composition(raw_comp)?;
            Ok(json!({ "composition": serde_json::to_value(comp).unwrap() }))
        }
        _ => Err(protocol_err("unknown entity kind")),
    }
}

pub fn parse_user_state_operation(value: &JsonValue) -> Result<ParsedUserStateOperation, String> {
    let row = expect_object_keys(
        value,
        &["operationId", "entity", "baseRevision", "value", "seed"],
        "operation",
    )?;
    let entity = parse_user_state_entity(
        row.get("entity")
            .ok_or_else(|| protocol_err("invalid entity"))?,
    )?;
    let kind = entity["kind"].as_str().unwrap();
    let seed = match row.get("seed") {
        None => false,
        Some(JsonValue::Bool(true)) => true,
        _ => return Err(protocol_err("invalid seed flag")),
    };
    let base_revision = parse_safe_integer(row.get("baseRevision"), "base revision", 0)?;
    if seed && base_revision != 0 {
        return Err(protocol_err("a seed must have no prior revision"));
    }
    let val = parse_user_state_value(
        kind,
        row.get("value")
            .ok_or_else(|| protocol_err("invalid value"))?,
    )?;
    Ok(ParsedUserStateOperation {
        operation_id: parse_identifier(row.get("operationId"), "operation ID")?,
        entity,
        base_revision,
        value: val,
        seed,
    })
}

pub fn parse_user_state_record(value: &JsonValue) -> Result<ParsedUserStateRecord, String> {
    let row = expect_object_keys(
        value,
        &[
            "entity",
            "value",
            "revision",
            "operationId",
            "updatedAt",
            "deviceId",
            "deviceName",
        ],
        "record",
    )?;
    let entity = parse_user_state_entity(
        row.get("entity")
            .ok_or_else(|| protocol_err("invalid entity"))?,
    )?;
    let kind = entity["kind"].as_str().unwrap();
    let val = parse_user_state_value(
        kind,
        row.get("value")
            .ok_or_else(|| protocol_err("invalid value"))?,
    )?;
    Ok(ParsedUserStateRecord {
        entity,
        value: val,
        revision: parse_safe_integer(row.get("revision"), "record revision", 1)?,
        operation_id: parse_identifier(row.get("operationId"), "operation ID")?,
        updated_at: parse_safe_integer(row.get("updatedAt"), "server update time", 0)?,
        device_id: parse_text_value(row.get("deviceId"), "author device ID", 256, false, true)?,
        device_name: parse_text_value(
            row.get("deviceName"),
            "author device name",
            256,
            true,
            false,
        )?,
    })
}

pub fn parse_user_state_read_response(
    value: &JsonValue,
) -> Result<ParsedUserStateReadResponse, String> {
    let row = expect_object_keys(
        value,
        &[
            "version",
            "workspaceId",
            "epoch",
            "headRevision",
            "through",
            "nextCursor",
            "hasMore",
            "records",
        ],
        "read response",
    )?;
    let version = parse_safe_integer(row.get("version"), "protocol version", 0)?;
    if version != USER_STATE_VERSION {
        return Err(protocol_err("unsupported protocol version"));
    }
    let workspace_id = parse_identifier(row.get("workspaceId"), "workspace ID")?;
    let epoch = parse_identifier(row.get("epoch"), "workspace epoch")?;
    let head_revision = parse_safe_integer(row.get("headRevision"), "head revision", 0)?;
    let through = parse_safe_integer(row.get("through"), "read boundary", 0)?;
    let next_cursor = parse_safe_integer(row.get("nextCursor"), "next cursor", 0)?;
    let has_more = parse_bool(row.get("hasMore"), "has more flag")?;
    if through > head_revision || next_cursor > through || (!has_more && next_cursor != through) {
        return Err(protocol_err("inconsistent read cursors"));
    }
    let Some(raw_records) = row.get("records").and_then(JsonValue::as_array) else {
        return Err(protocol_err("invalid record page"));
    };
    let mut records = Vec::with_capacity(raw_records.len());
    for raw in raw_records {
        records.push(parse_user_state_record(raw)?);
    }
    if has_more && (records.is_empty() || next_cursor >= through) {
        return Err(protocol_err("a continuing page must make progress"));
    }
    for (idx, record) in records.iter().enumerate() {
        if record.revision > next_cursor || (idx > 0 && record.revision <= records[idx - 1].revision)
        {
            return Err(protocol_err("records are not in revision order"));
        }
    }
    if has_more && records.last().map(|r| r.revision) != Some(next_cursor) {
        return Err(protocol_err("continuing page does not end at its cursor"));
    }
    Ok(ParsedUserStateReadResponse {
        workspace_id,
        epoch,
        head_revision,
        through,
        next_cursor,
        has_more,
        records,
    })
}

pub fn parse_user_state_merge_result(
    value: &JsonValue,
) -> Result<ParsedUserStateMergeResult, String> {
    let row = expect_object_keys(
        value,
        &["operationId", "status", "current", "reason", "categoryAlias"],
        "merge result",
    )?;
    let Some(status) = row.get("status").and_then(JsonValue::as_str) else {
        return Err(protocol_err("invalid merge result status"));
    };
    if !matches!(
        status,
        "applied" | "unchanged" | "seed-skipped" | "conflict" | "aliased"
    ) {
        return Err(protocol_err("invalid merge result status"));
    }
    let current = match row.get("current") {
        Some(JsonValue::Null) => None,
        Some(raw) => Some(parse_user_state_record(raw)?),
        None => return Err(protocol_err("invalid record")),
    };
    if status != "conflict" && status != "seed-skipped" && current.is_none() {
        return Err(protocol_err("an acknowledged change must include its record"));
    }
    let category_alias = match row.get("categoryAlias") {
        None => None,
        Some(raw_alias) => {
            let alias_obj = expect_object_keys(raw_alias, &["from", "to"], "category alias")?;
            let from = parse_identifier(alias_obj.get("from"), "alias source")?;
            let to = parse_identifier(alias_obj.get("to"), "alias target")?;
            if from == to {
                return Err(protocol_err("invalid category alias target"));
            }
            if let Some(ref record) = current {
                let kind = record.entity["kind"].as_str().unwrap_or("");
                let record_cat_id = record.entity.get("categoryId").and_then(JsonValue::as_str);
                if !matches!(kind, "category" | "membership") || record_cat_id != Some(to.as_str())
                {
                    return Err(protocol_err("invalid category alias target"));
                }
            }
            Some(CategoryAliasPair { from, to })
        }
    };
    if status == "aliased" && category_alias.is_none() {
        return Err(protocol_err(
            "an aliased result must identify the shared category",
        ));
    }
    let reason = match row.get("reason") {
        None => None,
        some => Some(parse_text_value(some, "conflict reason", 256, false, true)?),
    };
    Ok(ParsedUserStateMergeResult {
        operation_id: parse_identifier(row.get("operationId"), "operation ID")?,
        status: status.to_string(),
        current,
        reason,
        category_alias,
    })
}

pub fn parse_user_state_retention_response(
    value: &JsonValue,
) -> Result<ParsedUserStateRetentionResponse, String> {
    let row = expect_object_keys(
        value,
        &[
            "version",
            "workspaceId",
            "epoch",
            "headRevision",
            "compactedThrough",
            "seedAllowed",
            "seedCutoffAt",
        ],
        "retention response",
    )?;
    let version = parse_safe_integer(row.get("version"), "protocol version", 0)?;
    if version != USER_STATE_VERSION {
        return Err(protocol_err("unsupported protocol version"));
    }
    let workspace_id = parse_identifier(row.get("workspaceId"), "workspace ID")?;
    let epoch = parse_identifier(row.get("epoch"), "workspace epoch")?;
    let head_revision = parse_safe_integer(row.get("headRevision"), "head revision", 0)?;
    let compacted_through = parse_safe_integer(row.get("compactedThrough"), "compacted through", 0)?;
    if compacted_through > head_revision {
        return Err(protocol_err("compacted through exceeds the head revision"));
    }
    let seed_allowed = parse_bool(row.get("seedAllowed"), "seed allowed flag")?;
    let seed_cutoff_at = parse_nullable_time(row.get("seedCutoffAt"), "seed cutoff time")?;
    Ok(ParsedUserStateRetentionResponse {
        workspace_id,
        epoch,
        head_revision,
        compacted_through,
        seed_allowed,
        seed_cutoff_at,
    })
}

pub fn parse_user_state_snapshot_response(
    value: &JsonValue,
) -> Result<ParsedUserStateSnapshotResponse, String> {
    let row = expect_object_keys(
        value,
        &[
            "version",
            "workspaceId",
            "epoch",
            "headRevision",
            "snapshotRevision",
            "nextEntityKey",
            "hasMore",
            "seedAllowed",
            "seedCutoffAt",
            "records",
        ],
        "snapshot response",
    )?;
    let version = parse_safe_integer(row.get("version"), "protocol version", 0)?;
    if version != USER_STATE_VERSION {
        return Err(protocol_err("unsupported protocol version"));
    }
    let workspace_id = parse_identifier(row.get("workspaceId"), "workspace ID")?;
    let epoch = parse_identifier(row.get("epoch"), "workspace epoch")?;
    let head_revision = parse_safe_integer(row.get("headRevision"), "head revision", 0)?;
    let snapshot_revision = parse_safe_integer(row.get("snapshotRevision"), "snapshot revision", 0)?;
    if snapshot_revision > head_revision {
        return Err(protocol_err(
            "snapshot revision exceeds the head revision",
        ));
    }
    let next_entity_key = match row.get("nextEntityKey") {
        Some(JsonValue::Null) => None,
        other => Some(parse_text_value(
            other,
            "next entity key",
            131_072,
            false,
            false,
        )?),
    };
    if next_entity_key.as_ref().is_some_and(|key| key.len() > 131_072) {
        return Err(protocol_err("invalid next entity key"));
    }
    let has_more = parse_bool(row.get("hasMore"), "has more flag")?;
    if has_more && next_entity_key.is_none() {
        return Err(protocol_err(
            "a continuing snapshot page must include a next entity key",
        ));
    }
    if !has_more && next_entity_key.is_some() {
        return Err(protocol_err(
            "a final snapshot page must not include a next entity key",
        ));
    }
    let seed_allowed = parse_bool(row.get("seedAllowed"), "seed allowed flag")?;
    let seed_cutoff_at = parse_nullable_time(row.get("seedCutoffAt"), "seed cutoff time")?;
    let Some(raw_records) = row.get("records").and_then(JsonValue::as_array) else {
        return Err(protocol_err("invalid snapshot record page"));
    };
    let mut records = Vec::with_capacity(raw_records.len());
    for raw in raw_records {
        records.push(parse_user_state_record(raw)?);
    }
    if records
        .iter()
        .any(|record| record.revision > snapshot_revision)
    {
        return Err(protocol_err("record exceeds the snapshot revision"));
    }
    if has_more && records.is_empty() {
        return Err(protocol_err("a continuing snapshot page must make progress"));
    }
    Ok(ParsedUserStateSnapshotResponse {
        workspace_id,
        epoch,
        head_revision,
        snapshot_revision,
        next_entity_key,
        has_more,
        seed_allowed,
        seed_cutoff_at,
        records,
    })
}

pub fn merge_user_state_resume(
    left: &JsonValue,
    right: &JsonValue,
) -> Result<JsonValue, String> {
    if left.get("chapter").is_none_or(JsonValue::is_null) {
        return Ok(right.clone());
    }
    if right.get("chapter").is_none_or(JsonValue::is_null) {
        return Ok(left.clone());
    }
    let left_time = left
        .get("openedAt")
        .and_then(JsonValue::as_i64)
        .unwrap_or(-1);
    let right_time = right
        .get("openedAt")
        .and_then(JsonValue::as_i64)
        .unwrap_or(-1);
    if left_time != right_time {
        return Ok(if left_time > right_time {
            left.clone()
        } else {
            right.clone()
        });
    }
    let left_anchor = left
        .get("anchor")
        .and_then(|a| a.get("savedAt"))
        .and_then(JsonValue::as_i64)
        .unwrap_or(-1);
    let right_anchor = right
        .get("anchor")
        .and_then(|a| a.get("savedAt"))
        .and_then(JsonValue::as_i64)
        .unwrap_or(-1);
    if left_anchor != right_anchor {
        return Ok(if left_anchor > right_anchor {
            left.clone()
        } else {
            right.clone()
        });
    }
    Ok(
        if canonical_user_state_json(left)? <= canonical_user_state_json(right)? {
            left.clone()
        } else {
            right.clone()
        },
    )
}

fn comp_work_key(source: &ChapterSourceSnapshotDto) -> String {
    serde_json::to_string(&(&source.plugin_id, fold_ascii(&source.novel_id))).unwrap_or_default()
}

fn comp_path_key(source: &ChapterSourceSnapshotDto) -> String {
    serde_json::to_string(&(comp_work_key(source), &source.chapter_path)).unwrap_or_default()
}

fn comp_id_key(source: &ChapterSourceSnapshotDto) -> Option<String> {
    source.source_chapter_id.as_ref().map(|id| {
        serde_json::to_string(&(comp_work_key(source), id)).unwrap_or_default()
    })
}

fn comp_same_source(left: &ChapterSourceSnapshotDto, right: &ChapterSourceSnapshotDto) -> bool {
    comp_work_key(left) == comp_work_key(right)
        && match (&left.source_chapter_id, &right.source_chapter_id) {
            (Some(l), Some(r)) if !l.is_empty() && !r.is_empty() => l == r,
            _ => left.chapter_path == right.chapter_path,
        }
}

fn is_provider_addition(
    entry: &ChapterCompositionEntryDto,
    owner_plugin_id: &str,
    owner_source_novel_id: &str,
) -> bool {
    if entry.sources.len() != 1
        || entry.primary_source != 0
        || !entry.user.included
        || entry.user.name.is_some()
        || entry.user.chapter_number.as_deref() != Some(&entry.user.order.to_string())
    {
        return false;
    }
    let source = &entry.sources[0];
    if source.plugin_id != owner_plugin_id
        || fold_ascii(&source.novel_id) != fold_ascii(owner_source_novel_id)
    {
        return false;
    }
    let recovered_path = format!(
        "norea-source:{}:{}:{}",
        encode_uri_component(&source.plugin_id),
        encode_uri_component(&source.novel_id),
        encode_uri_component(&source.chapter_path),
    );
    entry.path == source.chapter_path || entry.path == recovered_path
}

pub fn merge_user_state_composition(
    shared_value: &ChapterCompositionV1Dto,
    current_value: Option<&ChapterCompositionV1Dto>,
    owner_plugin_id: &str,
    owner_source_novel_id: &str,
) -> Result<ChapterCompositionV1Dto, String> {
    let shared_json = serde_json::to_value(shared_value)
        .map_err(|err| format!("Chapter composition: {err}"))?;
    let shared = parse_chapter_composition(&shared_json)?;
    let Some(current_raw) = current_value else {
        return Ok(shared);
    };
    let current_json = serde_json::to_value(current_raw)
        .map_err(|err| format!("Chapter composition: {err}"))?;
    let current = parse_chapter_composition(&current_json)?;
    if current.updated_at <= shared.updated_at {
        return Ok(shared);
    }

    let mut by_id: HashMap<String, Option<ChapterSourceSnapshotDto>> = HashMap::new();
    let mut by_path: HashMap<String, Option<ChapterSourceSnapshotDto>> = HashMap::new();
    let insert_idx = |map: &mut HashMap<String, Option<ChapterSourceSnapshotDto>>,
                      key: String,
                      src: &ChapterSourceSnapshotDto| {
        match map.get(&key) {
            None => {
                map.insert(key, Some(src.clone()));
            }
            Some(Some(prev)) if prev != src => {
                map.insert(key, None);
            }
            _ => {}
        }
    };
    for entry in &current.entries {
        for source in &entry.sources {
            if let Some(id_key) = comp_id_key(source) {
                insert_idx(&mut by_id, id_key, source);
            }
            insert_idx(&mut by_path, comp_path_key(source), source);
        }
    }
    let lookup_current = |source: &ChapterSourceSnapshotDto| -> Option<ChapterSourceSnapshotDto> {
        if let Some(id_key) = comp_id_key(source) {
            if let Some(found) = by_id.get(&id_key) {
                return found.clone();
            }
        }
        let candidate = by_path.get(&comp_path_key(source)).and_then(Clone::clone)?;
        comp_same_source(source, &candidate).then_some(candidate)
    };

    let mut retained_ids: HashSet<String> = HashSet::new();
    let mut retained_paths: HashMap<String, HashSet<Option<String>>> = HashMap::new();
    fn add_origin(
        retained_ids: &mut HashSet<String>,
        retained_paths: &mut HashMap<String, HashSet<Option<String>>>,
        source: &ChapterSourceSnapshotDto,
    ) {
        if let Some(id_key) = comp_id_key(source) {
            retained_ids.insert(id_key);
        }
        retained_paths
            .entry(comp_path_key(source))
            .or_default()
            .insert(source.source_chapter_id.clone());
    }
    for entry in &shared.entries {
        for source in &entry.sources {
            add_origin(&mut retained_ids, &mut retained_paths, source);
        }
    }

    let mut result = shared.clone();
    let mut ids: HashSet<String> = result.entries.iter().map(|e| e.id.clone()).collect();
    let mut paths: HashSet<String> = result.entries.iter().map(|e| e.path.clone()).collect();
    let mut storage: HashSet<String> = result
        .entries
        .iter()
        .map(|e| e.storage_chapter_number.clone())
        .collect();

    for entry in &mut result.entries {
        entry.sources = entry
            .sources
            .iter()
            .map(|src| lookup_current(src).unwrap_or_else(|| src.clone()))
            .collect();
        for src in &entry.sources {
            add_origin(&mut retained_ids, &mut retained_paths, src);
        }
    }

    let mut order = result.entries.iter().filter(|e| e.user.included).count() as i64;
    for entry in &current.entries {
        if !is_provider_addition(entry, owner_plugin_id, owner_source_novel_id) {
            continue;
        }
        let src = &entry.sources[0];
        let already_retained = comp_id_key(src).is_some_and(|k| retained_ids.contains(&k))
            || retained_paths.get(&comp_path_key(src)).is_some_and(|known| {
                src.source_chapter_id.is_none()
                    || known.contains(&None)
                    || known.contains(&src.source_chapter_id)
            });
        if already_retained {
            continue;
        }
        if ids.contains(&entry.id)
            || paths.contains(&entry.path)
            || storage.contains(&entry.storage_chapter_number)
        {
            return Err(protocol_err(
                "a newly discovered chapter conflicts with retained composition storage",
            ));
        }
        let mut added = entry.clone();
        order += 1;
        added.user.order = order;
        added.user.chapter_number = Some(order.to_string());
        for s in &added.sources {
            add_origin(&mut retained_ids, &mut retained_paths, s);
        }
        ids.insert(added.id.clone());
        paths.insert(added.path.clone());
        storage.insert(added.storage_chapter_number.clone());
        result.entries.push(added);
    }

    if result.entries != shared.entries {
        result.updated_at = current.updated_at;
    }
    let result_json =
        serde_json::to_value(&result).map_err(|err| format!("Chapter composition: {err}"))?;
    parse_chapter_composition(&result_json)
}
