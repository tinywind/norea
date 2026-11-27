mod document;

pub use document::{
    cover_content_type, merge_incoming_novel_metadata, normalize_novel_metadata,
    parse_novel_metadata, parse_novel_metadata_bytes, parse_novel_metadata_input,
    stored_novel_metadata_fingerprint,
};

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use sqlx::{AssertSqlSafe, Row, SqliteConnection, SqlitePool};
use tauri::{AppHandle, Emitter, State};

use crate::database::AppDatabase;

use super::chapter_composition::{
    canonical_chapter_number_str, chapter_composition_catalog, get_chapter_composition_in_tx,
    materialize_chapter_composition_in_tx,
    set_chapter_composition_in_tx, ChapterCompositionV1Dto,
};
use super::tx::{with_write_tx, MetadataRoot, TxContext, TxOptions};
use super::{
    ChapterDirectoryUpdateDto, DbMutationEffects, DbMutationEnvelope, ReadMode,
    WorkDirectoryUpdateDto,
};

pub const STORAGE_RECOVERY_PROGRESS_EVENT: &str = "norea:storage-recovery-progress";
const LOCAL_PLUGIN_ID: &str = "local";

pub(super) fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0b0000_0011) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((second & 0b0000_1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(third & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

pub(super) fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    if cleaned.len() % 4 != 0 {
        return Err("invalid base64 length".to_string());
    }
    let val = |byte: u8| -> Result<u8, String> {
        match byte {
            b'A'..=b'Z' => Ok(byte - b'A'),
            b'a'..=b'z' => Ok(byte - b'a' + 26),
            b'0'..=b'9' => Ok(byte - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("invalid base64 character: {}", byte as char)),
        }
    };
    let mut out = Vec::with_capacity((cleaned.len() / 4) * 3);
    for (idx, chunk) in cleaned.chunks_exact(4).enumerate() {
        let last = idx + 1 == cleaned.len() / 4;
        let a = val(chunk[0])?;
        let b = val(chunk[1])?;
        out.push((a << 2) | (b >> 4));
        if chunk[2] == b'=' {
            if !last || chunk[3] != b'=' {
                return Err("invalid base64 padding".to_string());
            }
            break;
        }
        let c = val(chunk[2])?;
        out.push(((b & 0x0f) << 4) | (c >> 2));
        if chunk[3] == b'=' {
            if !last {
                return Err("invalid base64 padding".to_string());
            }
            break;
        }
        let d = val(chunk[3])?;
        out.push(((c & 0x03) << 6) | d);
    }
    Ok(out)
}

#[derive(Default)]
pub struct WorkMetadataRecoveryState {
    generation: AtomicU64,
}

impl WorkMetadataRecoveryState {
    pub fn start_generation(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn ensure_active(&self, token: u64) -> Result<(), String> {
        if self.generation.load(Ordering::SeqCst) == token {
            Ok(())
        } else {
            Err("Storage recovery cancelled.".to_string())
        }
    }
}

/// Preserves insertion order for non-array-index chapter keys while emitting
/// ECMAScript array-index keys (`"0"`..`"4294967294"`) in ascending numeric
/// order first, matching `JSON.stringify` byte-for-byte.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChaptersMap(Vec<(String, String)>);

impl ChaptersMap {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn from_entries(entries: impl IntoIterator<Item = (String, String)>) -> Self {
        let mut map = Self::new();
        for (key, value) in entries {
            map.insert(key, value);
        }
        map
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find_map(|(k, v)| (k == key).then_some(v.as_str()))
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    pub fn insert(&mut self, key: String, value: String) {
        if let Some((_, existing)) = self.0.iter_mut().find(|(k, _)| k == &key) {
            *existing = value;
        } else {
            self.0.push((key, value));
        }
    }

    pub fn remove(&mut self, key: &str) {
        self.0.retain(|(k, _)| k != key);
    }

    pub fn ordered_entries(&self) -> Vec<(&str, &str)> {
        let mut array_indices: Vec<(u32, &str, &str)> = Vec::new();
        let mut string_keys: Vec<(&str, &str)> = Vec::new();
        for (key, value) in &self.0 {
            if let Some(index) = parse_ecmascript_array_index(key) {
                array_indices.push((index, key.as_str(), value.as_str()));
            } else {
                string_keys.push((key.as_str(), value.as_str()));
            }
        }
        array_indices.sort_by_key(|(index, _, _)| *index);
        let mut out = Vec::with_capacity(self.0.len());
        for (_, key, value) in array_indices {
            out.push((key, value));
        }
        out.extend(string_keys);
        out
    }
}

fn parse_ecmascript_array_index(key: &str) -> Option<u32> {
    let parsed: u32 = key.parse().ok()?;
    (parsed < u32::MAX && parsed.to_string() == key).then_some(parsed)
}

impl Serialize for ChaptersMap {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let ordered = self.ordered_entries();
        let mut map = serializer.serialize_map(Some(ordered.len()))?;
        for (key, value) in ordered {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for ChaptersMap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ChaptersVisitor;
        impl<'de> serde::de::Visitor<'de> for ChaptersVisitor {
            type Value = ChaptersMap;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a chapter map")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut access: M,
            ) -> Result<Self::Value, M::Error> {
                let mut entries = Vec::new();
                while let Some((key, value)) = access.next_entry::<String, String>()? {
                    if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| k == &key) {
                        *existing = value;
                    } else {
                        entries.push((key, value));
                    }
                }
                Ok(ChaptersMap(entries))
            }
        }
        deserializer.deserialize_map(ChaptersVisitor)
    }
}

fn serialize_js_rating<S: Serializer>(
    rating: &Option<f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match rating {
        None => serializer.serialize_none(),
        Some(value) if value.fract() == 0.0 && *value >= 0.0 && *value <= 5.0 => {
            serializer.serialize_i64(*value as i64)
        }
        Some(value) => serializer.serialize_f64(*value),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataIdentityDto {
    pub plugin_id: String,
    pub novel_id: String,
    pub novel_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataNovelDto {
    pub name: String,
    pub author: Option<String>,
    pub artist: Option<String>,
    pub summary: Option<String>,
    pub status: Option<String>,
    pub genres: Option<String>,
    #[serde(serialize_with = "serialize_js_rating")]
    pub rating: Option<f64>,
    pub is_local: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataCoverDto {
    pub file_name: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NovelMetadataV1Dto {
    pub schema_version: u32,
    pub identity: WorkMetadataIdentityDto,
    pub novel: WorkMetadataNovelDto,
    pub cover: Option<WorkMetadataCoverDto>,
    pub chapters: ChaptersMap,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapter_composition: Option<ChapterCompositionV1Dto>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNovelMetadataDto {
    pub directory: String,
    pub metadata: NovelMetadataV1Dto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNovelChapterDto {
    pub directory: String,
    pub chapter_number: String,
    pub name: String,
    pub content_type: String,
    pub content_bytes: u64,
    pub media_bytes: u64,
    pub media_complete: bool,
}

fn default_upload_eligible() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataSyncFileDto {
    pub plugin_id: String,
    pub path: String,
    pub directory: String,
    pub fingerprint: String,
    pub revision: i64,
    #[serde(default = "default_upload_eligible")]
    pub upload_eligible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedMetadataFileRowDto {
    pub plugin_id: String,
    pub path: String,
    pub novel_id: i64,
    pub directory: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedChapterDirectoryRowDto {
    pub id: i64,
    pub directory: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredWorkMetadataDirectoriesDto {
    pub files: Vec<CachedMetadataFileRowDto>,
    pub chapters: Vec<CachedChapterDirectoryRowDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataRecoveryProgressDto {
    pub total_works: usize,
    pub completed_works: usize,
    pub recovered_works: usize,
    pub recovered_chapters: usize,
    pub skipped_works: usize,
    pub current_work: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkMetadataRecoveryEventDto {
    pub progress: WorkMetadataRecoveryProgressDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<DbMutationEffects>,
}

#[derive(Debug, Clone)]
pub struct FetchedChapterCatalog {
    pub novel_id: i64,
    pub chapters: ChaptersMap,
    pub replaced_chapter_numbers: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ApplyNovelMetadataOptions {
    pub stored_cover: Option<Option<Vec<u8>>>,
    pub add_to_library: bool,
    pub preserve_missing_metadata: bool,
    pub preserve_cached_novel: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ChapterScanSnapshot {
    pub chapters: Vec<StoredNovelChapterDto>,
    pub skipped_chapter_ids: HashSet<i64>,
    pub defer_native_registration: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistNovelCoverInputDto {
    pub body: Vec<u8>,
    pub file_name: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RawNovelMetadataInput {
    pub raw: JsonValue,
    pub ordered_chapters: Option<Vec<(String, JsonValue)>>,
}

impl<'de> Deserialize<'de> for RawNovelMetadataInput {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        enum MaybeOrderedChapters {
            Map(Vec<(String, JsonValue)>),
            Other(JsonValue),
        }
        impl<'de> Deserialize<'de> for MaybeOrderedChapters {
            fn deserialize<D2: Deserializer<'de>>(d: D2) -> Result<Self, D2::Error> {
                struct V;
                impl<'de> serde::de::Visitor<'de> for V {
                    type Value = MaybeOrderedChapters;
                    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                        f.write_str("any JSON value")
                    }
                    fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::Bool(v)))
                    }
                    fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::from(v)))
                    }
                    fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::from(v)))
                    }
                    fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(
                            serde_json::Number::from_f64(v)
                                .map_or(JsonValue::Null, JsonValue::Number),
                        ))
                    }
                    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::String(v.to_string())))
                    }
                    fn visit_string<E: serde::de::Error>(
                        self,
                        v: String,
                    ) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::String(v)))
                    }
                    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::Null))
                    }
                    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                        Ok(MaybeOrderedChapters::Other(JsonValue::Null))
                    }
                    fn visit_seq<A: serde::de::SeqAccess<'de>>(
                        self,
                        mut seq: A,
                    ) -> Result<Self::Value, A::Error> {
                        let mut vec = Vec::new();
                        while let Some(elem) = seq.next_element::<JsonValue>()? {
                            vec.push(elem);
                        }
                        Ok(MaybeOrderedChapters::Other(JsonValue::Array(vec)))
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(
                        self,
                        mut access: A,
                    ) -> Result<Self::Value, A::Error> {
                        let mut entries = Vec::new();
                        while let Some((k, v)) = access.next_entry::<String, JsonValue>()? {
                            if let Some((_, existing)) = entries.iter_mut().find(|(ek, _)| ek == &k)
                            {
                                *existing = v;
                            } else {
                                entries.push((k, v));
                            }
                        }
                        Ok(MaybeOrderedChapters::Map(entries))
                    }
                }
                d.deserialize_any(V)
            }
        }

        struct RootVisitor;
        impl<'de> serde::de::Visitor<'de> for RootVisitor {
            type Value = RawNovelMetadataInput;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::Bool(v),
                    ordered_chapters: None,
                })
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::from(v),
                    ordered_chapters: None,
                })
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::from(v),
                    ordered_chapters: None,
                })
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: serde_json::Number::from_f64(v)
                        .map_or(JsonValue::Null, JsonValue::Number),
                    ordered_chapters: None,
                })
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::String(v.to_string()),
                    ordered_chapters: None,
                })
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::String(v),
                    ordered_chapters: None,
                })
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::Null,
                    ordered_chapters: None,
                })
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::Null,
                    ordered_chapters: None,
                })
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut vec = Vec::new();
                while let Some(elem) = seq.next_element::<JsonValue>()? {
                    vec.push(elem);
                }
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::Array(vec),
                    ordered_chapters: None,
                })
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut access: A,
            ) -> Result<Self::Value, A::Error> {
                let mut map = serde_json::Map::new();
                let mut ordered_chapters = None;
                while let Some(key) = access.next_key::<String>()? {
                    if key == "chapters" {
                        match access.next_value::<MaybeOrderedChapters>()? {
                            MaybeOrderedChapters::Map(entries) => {
                                let mut obj = serde_json::Map::new();
                                for (k, v) in &entries {
                                    obj.insert(k.clone(), v.clone());
                                }
                                ordered_chapters = Some(entries);
                                map.insert(key, JsonValue::Object(obj));
                            }
                            MaybeOrderedChapters::Other(other) => {
                                ordered_chapters = None;
                                map.insert(key, other);
                            }
                        }
                    } else {
                        let val = access.next_value::<JsonValue>()?;
                        map.insert(key, val);
                    }
                }
                Ok(RawNovelMetadataInput {
                    raw: JsonValue::Object(map),
                    ordered_chapters,
                })
            }
        }
        deserializer.deserialize_any(RootVisitor)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedInstallNovelDto {
    pub id: i64,
    pub novel_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterNumberMappingInputDto {
    pub chapter_path: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNovelNumberReconciliationDto {
    pub mappings: Vec<ChapterNumberMappingInputDto>,
    #[serde(default)]
    pub journal: Option<JsonValue>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStoredNovelMetadataInputDto {
    pub metadata: RawNovelMetadataInput,
    #[serde(default)]
    pub cover_bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub authoritative: bool,
    #[serde(default)]
    pub preserve_local_cover: bool,
    #[serde(default)]
    pub guard_server_url: Option<String>,
    #[serde(default)]
    pub error_on_source_held: bool,
    #[serde(default)]
    pub expected_sync_file_version: Option<Option<String>>,
    #[serde(default)]
    pub expected_existing_digest: Option<Option<String>>,
    #[serde(default)]
    pub expected_novel: Option<ExpectedInstallNovelDto>,
    #[serde(default)]
    pub require_new_work_absent: bool,
    #[serde(default)]
    pub reconciliation: Option<StoredNovelNumberReconciliationDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedInstallNovelDto {
    pub id: i64,
    pub source_novel_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectInstallTargetDto {
    pub directory: String,
    pub existing: Option<StoredNovelMetadataDto>,
    pub existing_cover_bytes: Option<Vec<u8>>,
    pub existing_digest: Option<String>,
    pub sync_file: Option<WorkMetadataSyncFileDto>,
    pub indexed_novel: Option<IndexedInstallNovelDto>,
    pub source_held: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReindexPreservedWorkInputDto {
    pub directory: String,
    pub metadata: RawNovelMetadataInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledNovelMetadataDto {
    pub novel_id: i64,
    pub directory: String,
    pub metadata: NovelMetadataV1Dto,
    pub sync_file: WorkMetadataSyncFileDto,
    pub cover_bytes: Option<Vec<u8>>,
}

pub(super) fn canonical_json_value(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => {
            JsonValue::Array(items.iter().map(canonical_json_value).collect())
        }
        JsonValue::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(lhs, _), (rhs, _)| lhs.cmp(rhs));
            let mut sorted = serde_json::Map::with_capacity(entries.len());
            for (key, val) in entries {
                sorted.insert(key.clone(), canonical_json_value(val));
            }
            JsonValue::Object(sorted)
        }
        _ => value.clone(),
    }
}

pub fn discover_stored_novel_cover_at(
    root: &Path,
    directory: &str,
    preferred: Option<&WorkMetadataCoverDto>,
) -> Result<Option<WorkMetadataCoverDto>, String> {
    let discovered =
        crate::chapter_media::discover_work_cover_at(root, &format!("{directory}/novel.json"))?;
    let Some(cover) = discovered else {
        return Ok(None);
    };
    let content_type = if preferred
        .as_ref()
        .is_some_and(|pref| pref.file_name == cover.file_name)
    {
        preferred.and_then(|pref| pref.content_type.clone())
    } else {
        cover_content_type(&cover.file_name)
    };
    Ok(Some(WorkMetadataCoverDto {
        file_name: cover.file_name,
        content_type,
    }))
}

pub fn read_stored_novel_metadata_at(
    root: &Path,
    directory: &str,
) -> Result<Option<StoredNovelMetadataDto>, String> {
    let Some(bytes) =
        crate::chapter_media::read_work_metadata_bytes_at(root, &format!("{directory}/novel.json"))?
    else {
        return Ok(None);
    };
    let (mut metadata, _) = parse_novel_metadata_bytes(&bytes)?;
    metadata.cover = discover_stored_novel_cover_at(root, directory, metadata.cover.as_ref())?;
    Ok(Some(StoredNovelMetadataDto {
        directory: directory.to_string(),
        metadata,
    }))
}

pub fn read_stored_novel_cover_at(
    root: &Path,
    directory: &str,
    metadata: &NovelMetadataV1Dto,
) -> Result<Option<Vec<u8>>, String> {
    let Some(ref cover) = metadata.cover else {
        return Ok(None);
    };
    let bytes = crate::chapter_media::read_work_metadata_bytes_at(
        root,
        &format!("{directory}/{}", cover.file_name),
    )?;
    if let Some(ref data) = bytes {
        if data.len() > crate::chapter_media::MAX_COVER_BYTES {
            return Err("work metadata: cover exceeds size limit".to_string());
        }
    }
    Ok(bytes)
}

fn has_work_identity(value: &JsonValue, expected: &WorkMetadataIdentityDto) -> bool {
    let Some(identity) = value.get("identity").and_then(JsonValue::as_object) else {
        return false;
    };
    identity.get("pluginId").and_then(JsonValue::as_str) == Some(expected.plugin_id.as_str())
        && identity.get("novelPath").and_then(JsonValue::as_str)
            == Some(expected.novel_path.as_str())
        && identity.get("novelId").and_then(JsonValue::as_str) == Some(expected.novel_id.as_str())
}

fn read_novel_metadata_for_replacement_at(
    root: &Path,
    directory: &str,
    expected: &WorkMetadataIdentityDto,
) -> Result<Option<(NovelMetadataV1Dto, JsonValue)>, String> {
    let Some(bytes) =
        crate::chapter_media::read_work_metadata_bytes_at(root, &format!("{directory}/novel.json"))?
    else {
        return Ok(None);
    };
    let input: RawNovelMetadataInput = serde_json::from_slice(&bytes)
        .map_err(|err| format!("work metadata: invalid JSON: {err}"))?;
    if !has_work_identity(&input.raw, expected) {
        return Err(
            "work metadata: replacement identity does not match the existing file".to_string(),
        );
    }
    let metadata = parse_novel_metadata_input(&input)?;
    Ok(Some((metadata, input.raw)))
}

pub fn available_novel_metadata_directory_at(
    root: &Path,
    identity: &WorkMetadataIdentityDto,
) -> Result<String, String> {
    if !crate::chapter_media::is_plugin_storage_id(&identity.plugin_id) {
        return Err("Plugin ID is required for storage.".to_string());
    }
    if !crate::chapter_media::is_storage_id(&identity.novel_id) {
        return Err("Plugin-owned novel ID is required for storage.".to_string());
    }
    let preferred = format!("contents/{}/{}", identity.plugin_id, identity.novel_id);
    if let Some(bytes) = crate::chapter_media::read_work_metadata_bytes_at(
        root,
        &format!("{preferred}/novel.json"),
    )? {
        let existing: JsonValue = serde_json::from_slice(&bytes)
            .map_err(|err| format!("work metadata: invalid JSON: {err}"))?;
        if !has_work_identity(&existing, identity) {
            return Err(
                "work metadata: plugin-owned novel ID is already assigned to another work"
                    .to_string(),
            );
        }
    }
    Ok(preferred)
}

pub fn write_stored_novel_metadata_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
    input: &NovelMetadataV1Dto,
    notify_changes: bool,
) -> Result<bool, String> {
    let metadata = normalize_novel_metadata(input)?;
    let relative = format!("{directory}/novel.json");
    if let Some((_, raw_doc)) =
        read_novel_metadata_for_replacement_at(root, directory, &metadata.identity)?
    {
        let next_value = serde_json::to_value(&metadata)
            .map_err(|err| format!("work metadata: encode metadata: {err}"))?;
        if canonical_json_value(&raw_doc) == canonical_json_value(&next_value) {
            return Ok(false);
        }
    }
    let pretty = serde_json::to_vec_pretty(&metadata)
        .map_err(|err| format!("work metadata: format metadata JSON: {err}"))?;
    let changed = ctx.write_metadata_file(root, &relative, &pretty)?;
    if notify_changes && changed {
        ctx.mark_work_metadata_changed();
    }
    Ok(changed)
}

pub fn write_stored_novel_cover_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
    metadata: &NovelMetadataV1Dto,
    bytes: &[u8],
    notify_changes: bool,
) -> Result<bool, String> {
    let _ = normalize_novel_metadata(metadata)?;
    let Some(ref cover) = metadata.cover else {
        return Err("work metadata: invalid cover bytes".to_string());
    };
    if bytes.is_empty() || bytes.len() > crate::chapter_media::MAX_COVER_BYTES {
        return Err("work metadata: invalid cover bytes".to_string());
    }
    let relative = format!("{directory}/{}", cover.file_name);
    let changed = ctx.write_metadata_file(root, &relative, bytes)?;
    if notify_changes && changed {
        ctx.record_cover_changed(0);
        ctx.mark_work_metadata_changed();
    }
    Ok(changed)
}

pub fn remove_stored_novel_cover_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
    cover: Option<&WorkMetadataCoverDto>,
    notify_changes: bool,
) -> Result<(), String> {
    if let Some(cover) = cover {
        let relative = format!("{directory}/{}", cover.file_name);
        ctx.remove_metadata_file(root, &relative)?;
    }
    if notify_changes {
        ctx.record_cover_changed(0);
        ctx.mark_work_metadata_changed();
    }
    Ok(())
}

pub fn list_stored_novel_chapters_at(
    root: &Path,
    directory: &str,
) -> Result<Vec<StoredNovelChapterDto>, String> {
    let paths = crate::chapter_media::list_work_chapter_files_at(
        root,
        &format!("{directory}/novel.json"),
        &HashSet::new(),
    )?;
    let prefix = format!("{directory}/");
    let slash_pos = directory
        .rfind('/')
        .ok_or_else(|| "work metadata: invalid storage path".to_string())?;
    let source_dir = &directory[..slash_pos];
    let novel_dir_name = &directory[slash_pos + 1..];

    let mut chapters = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let Some(rest) = path.strip_prefix(&prefix) else {
            return Err("work metadata: invalid chapter location".to_string());
        };
        let parts: Vec<_> = rest.split('/').collect();
        if parts.len() != 2
            || !crate::chapter_media::is_storage_id(parts[0])
            || !matches!(
                parts[1],
                "content.html" | "content.pdf" | ".chapter-content.partial"
            )
        {
            return Err("work metadata: invalid chapter file".to_string());
        }
        let child = parts[0];
        let file_name = parts[1];
        if canonical_chapter_number_str(child).as_deref() != Some(child)
            || !seen.insert(child.to_string())
        {
            continue;
        }
        let artifacts = crate::chapter_media::inspect_chapter_content_mirror_at(
            root,
            &format!("{directory}/{child}"),
            source_dir,
            novel_dir_name,
            child,
            file_name,
        )?;
        if artifacts.status != "present" {
            continue;
        }
        let content_type = if artifacts
            .content_file
            .as_deref()
            .is_some_and(|file| file.ends_with(".pdf"))
        {
            "pdf"
        } else {
            "html"
        };
        chapters.push(StoredNovelChapterDto {
            directory: child.to_string(),
            chapter_number: child.to_string(),
            name: child.to_string(),
            content_type: content_type.to_string(),
            content_bytes: artifacts.content_bytes,
            media_bytes: artifacts.media_bytes,
            media_complete: artifacts.media_complete,
        });
    }

    chapters.sort_by(|lhs, rhs| {
        let left_num = lhs.chapter_number.parse::<f64>().unwrap_or(0.0);
        let right_num = rhs.chapter_number.parse::<f64>().unwrap_or(0.0);
        left_num
            .total_cmp(&right_num)
            .then_with(|| lhs.directory.cmp(&rhs.directory))
    });
    Ok(chapters)
}

pub async fn defer_user_state_for_novel_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
) -> Result<(), String> {
    super::user_state::defer_user_state_for_novel_in_tx(conn, ctx, novel_id).await
}

pub async fn apply_novel_metadata_to_cache_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    raw_metadata: &NovelMetadataV1Dto,
    directory: Option<&str>,
    options: ApplyNovelMetadataOptions,
) -> Result<i64, String> {
    let metadata = normalize_novel_metadata(raw_metadata)?;

    let stored_source_id: Option<Option<String>> = sqlx::query_scalar(
        "SELECT source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&metadata.identity.plugin_id)
    .bind(&metadata.identity.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: check stored novel identity: {err}"))?;

    if let Some(Some(existing_source_id)) = stored_source_id {
        if existing_source_id != metadata.identity.novel_id {
            return Err("work metadata: plugin-owned novel ID changed".to_string());
        }
    }

    let local_cover = match options.stored_cover {
        Some(bytes) => bytes,
        None if metadata.novel.is_local => match (root, directory) {
            (Some(root), Some(dir)) => read_stored_novel_cover_at(root, dir, &metadata)?,
            _ => None,
        },
        None => None,
    };
    let cover_data_uri = match (
        local_cover,
        metadata
            .cover
            .as_ref()
            .and_then(|c| c.content_type.as_deref()),
    ) {
        (Some(bytes), Some(content_type)) => Some(format!(
            "data:{content_type};base64,{}",
            encode_base64(&bytes)
        )),
        _ => None,
    };

    let optional_text = |value: &Option<String>| -> Option<String> {
        if options.preserve_missing_metadata
            && value.as_deref().is_none_or(|text| text.trim().is_empty())
        {
            None
        } else {
            value.clone()
        }
    };

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    sqlx::query(
        "INSERT INTO novel (plugin_id, path, name, cover, author, artist, summary, status, genres, rating, \
                            is_local, in_library, library_added_at, source_novel_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?16) \
         ON CONFLICT(plugin_id, path) DO UPDATE SET \
           name = excluded.name, \
           source_novel_id = excluded.source_novel_id, \
           cover = CASE WHEN excluded.is_local = 1 \
                        THEN CASE WHEN ?14 = 1 THEN COALESCE(excluded.cover, novel.cover) ELSE excluded.cover END \
                        ELSE novel.cover END, \
           author = CASE WHEN ?14 = 1 THEN COALESCE(excluded.author, novel.author) ELSE excluded.author END, \
           artist = CASE WHEN ?14 = 1 THEN COALESCE(excluded.artist, novel.artist) ELSE excluded.artist END, \
           summary = CASE WHEN ?14 = 1 THEN COALESCE(excluded.summary, novel.summary) ELSE excluded.summary END, \
           status = CASE WHEN ?14 = 1 THEN COALESCE(excluded.status, novel.status) ELSE excluded.status END, \
           genres = CASE WHEN ?14 = 1 THEN COALESCE(excluded.genres, novel.genres) ELSE excluded.genres END, \
           rating = CASE WHEN ?14 = 1 THEN COALESCE(excluded.rating, novel.rating) ELSE excluded.rating END, \
           is_local = excluded.is_local \
         WHERE ?15 = 0",
    )
    .bind(&metadata.identity.plugin_id)
    .bind(&metadata.identity.novel_path)
    .bind(&metadata.novel.name)
    .bind(cover_data_uri)
    .bind(optional_text(&metadata.novel.author))
    .bind(optional_text(&metadata.novel.artist))
    .bind(optional_text(&metadata.novel.summary))
    .bind(optional_text(&metadata.novel.status))
    .bind(optional_text(&metadata.novel.genres))
    .bind(metadata.novel.rating)
    .bind(i64::from(metadata.novel.is_local))
    .bind(i64::from(options.add_to_library))
    .bind(options.add_to_library.then_some(now_secs))
    .bind(i64::from(options.preserve_missing_metadata))
    .bind(i64::from(options.preserve_cached_novel))
    .bind(&metadata.identity.novel_id)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: upsert novel cache: {err}"))?;

    let novel_id: i64 =
        sqlx::query_scalar("SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2")
            .bind(&metadata.identity.plugin_id)
            .bind(&metadata.identity.novel_path)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: lookup novel id: {err}"))?
            .ok_or_else(|| "work metadata: cache identity missing".to_string())?;

    let current_composition = get_chapter_composition_in_tx(&mut *conn, novel_id).await?;
    let incoming_composition = if options.preserve_cached_novel {
        None
    } else {
        metadata.chapter_composition.clone()
    };
    let effective_composition = match (&incoming_composition, &current_composition) {
        (Some(inc), Some(curr)) if inc.updated_at > curr.updated_at => Some(inc.clone()),
        (Some(inc), None) => Some(inc.clone()),
        (_, Some(curr)) => Some(curr.clone()),
        (None, None) => None,
    };

    if let Some(ref composition) = effective_composition {
        let recovered = sqlx::query(
            "SELECT id, path, chapter_number FROM chapter WHERE novel_id = ?1",
        )
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: load chapters for composition recovery: {err}"))?;
        let mut paths: HashSet<String> = recovered
            .iter()
            .map(|row| row.get::<String, _>("path"))
            .collect();
        let entries_by_number: HashMap<&str, _> = composition
            .entries
            .iter()
            .map(|entry| (entry.storage_chapter_number.as_str(), entry))
            .collect();
        let prev_entries_by_number: HashMap<&str, _> = current_composition
            .as_ref()
            .map(|comp| {
                comp.entries
                    .iter()
                    .map(|entry| (entry.storage_chapter_number.as_str(), entry))
                    .collect()
            })
            .unwrap_or_default();

        for chapter_row in recovered {
            let chapter_id: i64 = chapter_row.get("id");
            let chapter_path: String = chapter_row.get("path");
            let chapter_number: Option<String> = chapter_row.get("chapter_number");
            let Some(ref ch_num) = chapter_number else {
                continue;
            };
            let Some(entry) = entries_by_number.get(ch_num.as_str()).copied() else {
                continue;
            };
            let Some(previous) = prev_entries_by_number
                .get(entry.storage_chapter_number.as_str())
                .copied()
            else {
                continue;
            };
            let source = &entry.sources[entry.primary_source];
            let prev_source = &previous.sources[previous.primary_source];
            let same_source = source.plugin_id == prev_source.plugin_id
                && source.novel_id == prev_source.novel_id
                && match (&source.source_chapter_id, &prev_source.source_chapter_id) {
                    (Some(lhs), Some(rhs)) => lhs == rhs,
                    _ => source.chapter_path == prev_source.chapter_path,
                };
            let is_folder_placeholder = chapter_path.starts_with("norea-folder:")
                || chapter_path.starts_with("local-folder:");
            if previous.id == entry.id
                && previous.path == entry.path
                && same_source
                && entry.path != chapter_path
                && is_folder_placeholder
                && !paths.contains(&entry.path)
            {
                sqlx::query("UPDATE chapter SET path = ?1 WHERE id = ?2")
                    .bind(&entry.path)
                    .bind(chapter_id)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: upgrade placeholder path: {err}"))?;
                paths.insert(entry.path.clone());
            }
        }

        materialize_chapter_composition_in_tx(root, &mut *conn, novel_id, composition, &[])
            .await?;
        set_chapter_composition_in_tx(&mut *conn, novel_id, Some(composition)).await?;
    } else if !options.preserve_cached_novel && !metadata.chapters.is_empty() {
        let existing_rows =
            sqlx::query("SELECT path, chapter_number FROM chapter WHERE novel_id = ?1")
                .bind(novel_id)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: load existing chapters: {err}"))?;
        let mut paths_by_number: HashMap<String, Vec<String>> = HashMap::new();
        for row in existing_rows {
            let Some(ch_num): Option<String> = row.get("chapter_number") else {
                continue;
            };
            let Some(canonical) = canonical_chapter_number_str(&ch_num) else {
                continue;
            };
            paths_by_number
                .entry(canonical)
                .or_default()
                .push(row.get("path"));
        }

        let mut sorted_entries: Vec<(String, String)> = metadata
            .chapters
            .ordered_entries()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        sorted_entries.sort_by(|(lhs, _), (rhs, _)| {
            let l = lhs.parse::<f64>().unwrap_or(0.0);
            let r = rhs.parse::<f64>().unwrap_or(0.0);
            l.total_cmp(&r)
        });

        let chapters_to_upsert: Vec<(String, String, i64, String)> = sorted_entries
            .into_iter()
            .enumerate()
            .filter_map(|(idx, (number, title))| {
                let candidates = paths_by_number.get(&number).map_or(&[][..], Vec::as_slice);
                if candidates.len() > 1 {
                    return None;
                }
                let path = candidates.first().cloned().unwrap_or_else(|| {
                    let prefix = if metadata.novel.is_local {
                        "local-folder"
                    } else {
                        "norea-folder"
                    };
                    format!("{prefix}:{number}")
                });
                Some((number, title, (idx + 1) as i64, path))
            })
            .collect();

        for batch in chapters_to_upsert.chunks(100) {
            let values: Vec<String> = (0..batch.len())
                .map(|idx| {
                    let base = idx * 5;
                    format!(
                        "(?{}, ?{}, ?{}, ?{}, ?{})",
                        base + 1,
                        base + 2,
                        base + 3,
                        base + 4,
                        base + 5
                    )
                })
                .collect();
            let sql = format!(
                "WITH catalog(novel_id, path, name, number, position) AS (VALUES {}) \
                 INSERT INTO chapter(novel_id, path, name, chapter_number, position, progress, bookmark, read_at) \
                 SELECT c.novel_id, c.path, c.name, c.number, c.position, \
                        COALESCE(state.progress, 0), COALESCE(state.bookmark, 0), state.read_at \
                 FROM catalog c \
                 JOIN novel n ON n.id = c.novel_id \
                 LEFT JOIN work_metadata_reading_state state \
                   ON state.plugin_id = n.plugin_id AND state.novel_path = n.path AND state.chapter_path = c.path \
                 WHERE true \
                 ON CONFLICT(novel_id, path) DO UPDATE SET \
                   name = excluded.name, \
                   position = excluded.position \
                 WHERE chapter.name IS NOT excluded.name OR chapter.position IS NOT excluded.position",
                values.join(",")
            );
            let mut query = sqlx::query(AssertSqlSafe(sql));
            for (number, title, position, path) in batch {
                query = query
                    .bind(novel_id)
                    .bind(path)
                    .bind(title)
                    .bind(number)
                    .bind(*position);
            }
            query
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: upsert catalog chapters: {err}"))?;
        }
    }

    if let Some(dir) = directory {
        ctx.record_work_directory(WorkDirectoryUpdateDto {
            novel_id,
            plugin_id: metadata.identity.plugin_id.clone(),
            novel_path: metadata.identity.novel_path.clone(),
            directory: Some(dir.to_string()),
            fingerprint: None,
        });
    }

    defer_user_state_for_novel_in_tx(&mut *conn, ctx, novel_id).await?;
    Ok(novel_id)
}

pub async fn persist_work_chapter_directories_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    chapters: &[(i64, String)],
    register_native: bool,
) -> Result<(), String> {
    let previous_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT chapter_id FROM work_metadata_directory_cache WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: read previous chapter directories: {err}"))?;

    sqlx::query("DELETE FROM work_metadata_directory_cache WHERE novel_id = ?1")
        .bind(novel_id)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: delete chapter directory cache: {err}"))?;

    for batch in chapters.chunks(100) {
        let values: Vec<String> = (0..batch.len())
            .map(|idx| format!("(?{}, ?{}, ?{})", idx * 3 + 1, idx * 3 + 2, idx * 3 + 3))
            .collect();
        let sql = format!(
            "INSERT INTO work_metadata_directory_cache(chapter_id, novel_id, directory) VALUES {}",
            values.join(",")
        );
        let mut query = sqlx::query(AssertSqlSafe(sql));
        for (chapter_id, directory) in batch {
            query = query.bind(*chapter_id).bind(novel_id).bind(directory);
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: insert chapter directory cache: {err}"))?;
    }

    let next_ids: HashSet<i64> = chapters.iter().map(|(id, _)| *id).collect();
    for removed_id in previous_ids {
        if !next_ids.contains(&removed_id) {
            ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
                chapter_id: removed_id,
                directory: None,
            });
        }
    }
    for (chapter_id, directory) in chapters {
        ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
            chapter_id: *chapter_id,
            directory: Some(directory.clone()),
        });
    }

    if register_native {
        if let Some(root) = root {
            ctx.mark_native_directories_dirty(root);
            for batch in chapters.chunks(1000) {
                crate::chapter_media::register_work_chapter_directories_at(root, batch, false)?;
            }
        }
    }
    Ok(())
}

pub async fn remember_stored_novel_metadata_in_tx(
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    directory: &str,
    metadata: &NovelMetadataV1Dto,
    cover_changed: bool,
) -> Result<(), String> {
    let novel_id: i64 =
        sqlx::query_scalar("SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2")
            .bind(&metadata.identity.plugin_id)
            .bind(&metadata.identity.novel_path)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: lookup novel for file cache: {err}"))?
            .ok_or_else(|| "work metadata: cache identity missing".to_string())?;

    let fingerprint = stored_novel_metadata_fingerprint(metadata)?;
    let previous: Option<(String, String)> = sqlx::query_as(
        "SELECT directory, fingerprint FROM work_metadata_file_cache \
         WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&metadata.identity.plugin_id)
    .bind(&metadata.identity.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: read previous file cache: {err}"))?;

    sqlx::query(
        "INSERT INTO work_metadata_file_cache(plugin_id, path, novel_id, directory, fingerprint) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(plugin_id, path) DO UPDATE SET \
           novel_id = excluded.novel_id, \
           directory = excluded.directory, \
           fingerprint = excluded.fingerprint",
    )
    .bind(&metadata.identity.plugin_id)
    .bind(&metadata.identity.novel_path)
    .bind(novel_id)
    .bind(directory)
    .bind(&fingerprint)
    .execute(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: upsert file cache: {err}"))?;

    let previous_matches = previous
        .as_ref()
        .is_some_and(|(prev_dir, prev_fp)| prev_dir == directory && prev_fp == &fingerprint);
    if cover_changed || !previous_matches {
        sqlx::query(
            "INSERT INTO work_metadata_sync_journal(plugin_id, path, revision) VALUES (?1, ?2, 1) \
             ON CONFLICT(plugin_id, path) DO UPDATE SET revision = revision + 1",
        )
        .bind(&metadata.identity.plugin_id)
        .bind(&metadata.identity.novel_path)
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: bump sync journal: {err}"))?;
    }

    ctx.record_work_directory(WorkDirectoryUpdateDto {
        novel_id,
        plugin_id: metadata.identity.plugin_id.clone(),
        novel_path: metadata.identity.novel_path.clone(),
        directory: Some(directory.to_string()),
        fingerprint: Some(fingerprint),
    });
    Ok(())
}

pub async fn mark_work_metadata_refreshed_in_tx(
    conn: &mut SqliteConnection,
    plugin_id: &str,
    novel_path: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO work_metadata_sync_journal(plugin_id, path, revision) VALUES (?1, ?2, 1) \
         ON CONFLICT(plugin_id, path) DO UPDATE SET revision = revision + 1",
    )
    .bind(plugin_id)
    .bind(novel_path)
    .execute(conn)
    .await
    .map(|_| ())
    .map_err(|err| format!("db work metadata: mark refreshed: {err}"))
}

pub async fn read_work_metadata_sync_file_in_tx(
    conn: &mut SqliteConnection,
    plugin_id: &str,
    novel_path: &str,
) -> Result<Option<WorkMetadataSyncFileDto>, String> {
    let row = sqlx::query(
        "SELECT f.plugin_id, f.path, f.directory, f.fingerprint, COALESCE(j.revision, 0) AS revision, \
                CASE \
                  WHEN COALESCE(n.in_library, 0) = 1 \
                    OR EXISTS ( \
                      SELECT 1 FROM chapter c \
                      WHERE c.novel_id = f.novel_id \
                        AND (c.is_downloaded = 1 OR c.content_bytes > 0 OR c.media_repair_needed = 1) \
                    ) \
                  THEN 1 \
                  ELSE 0 \
                END AS upload_eligible \
         FROM work_metadata_file_cache f \
         LEFT JOIN novel n ON n.id = f.novel_id \
         LEFT JOIN work_metadata_sync_journal j \
           ON j.plugin_id = f.plugin_id AND j.path = f.path \
         WHERE f.plugin_id = ?1 AND f.path = ?2",
    )
    .bind(plugin_id)
    .bind(novel_path)
    .fetch_optional(conn)
    .await
    .map_err(|err| format!("db work metadata: read sync file: {err}"))?;

    Ok(row.map(|r| WorkMetadataSyncFileDto {
        plugin_id: r.get("plugin_id"),
        path: r.get("path"),
        directory: r.get("directory"),
        fingerprint: r.get("fingerprint"),
        revision: r.get("revision"),
        upload_eligible: r.get::<i64, _>("upload_eligible") != 0,
    }))
}

pub async fn has_work_metadata_conflict_in_tx(
    conn: &mut SqliteConnection,
    directory: &str,
    metadata: &NovelMetadataV1Dto,
) -> Result<bool, String> {
    let known: Option<(String, String)> = sqlx::query_as(
        "SELECT directory, fingerprint FROM work_metadata_file_cache \
         WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&metadata.identity.plugin_id)
    .bind(&metadata.identity.novel_path)
    .fetch_optional(conn)
    .await
    .map_err(|err| format!("db work metadata: check conflict: {err}"))?;

    let Some((known_dir, known_fp)) = known else {
        return Ok(false);
    };
    let fingerprint = stored_novel_metadata_fingerprint(metadata)?;
    Ok(known_dir != directory || known_fp != fingerprint)
}

pub async fn scan_stored_novel_chapters_to_cache_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    novel_id: i64,
    directory: &str,
    snapshot: Option<&ChapterScanSnapshot>,
) -> Result<(), String> {
    let reconciliation_pending: i64 = sqlx::query_scalar(
        "SELECT EXISTS( \
           SELECT 1 FROM content_sync_cache \
           WHERE cache_key >= 'norea-source-chapter-renumber:' \
             AND cache_key < 'norea-source-chapter-renumber;' \
             AND json_extract(payload, '$.work.id') = ?1 \
         )",
    )
    .bind(novel_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: check renumber reconciliation: {err}"))?;
    if reconciliation_pending != 0 {
        return Err(
            "Chapter storage reconciliation is pending. Existing files were retained.".to_string(),
        );
    }

    let composition = get_chapter_composition_in_tx(&mut *conn, novel_id).await?;
    let included_numbers: Option<HashSet<String>> = composition.as_ref().map(|comp| {
        comp.entries
            .iter()
            .filter(|entry| entry.user.included)
            .map(|entry| entry.storage_chapter_number.clone())
            .collect()
    });

    let raw_discovered = match snapshot {
        Some(snap) => snap.chapters.clone(),
        None => {
            let root = root.ok_or_else(|| "work metadata: missing storage root".to_string())?;
            list_stored_novel_chapters_at(root, directory)?
        }
    };
    let discovered: Vec<StoredNovelChapterDto> = raw_discovered
        .into_iter()
        .filter(|chapter| {
            included_numbers
                .as_ref()
                .is_none_or(|allowed| allowed.contains(&chapter.chapter_number))
        })
        .collect();

    let plugin_id: Option<String> =
        sqlx::query_scalar("SELECT plugin_id FROM novel WHERE id = ?1")
            .bind(novel_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: lookup novel plugin_id: {err}"))?;
    let is_local = plugin_id.as_deref() == Some(LOCAL_PLUGIN_ID);

    #[derive(Clone)]
    struct CachedChapterRow {
        id: i64,
        path: String,
        chapter_number: Option<String>,
        position: i64,
        directory: Option<String>,
        is_downloaded: i64,
        stored_content_type: Option<String>,
        media_repair_needed: i64,
        content_bytes: i64,
        media_bytes: i64,
    }

    let cached_rows = sqlx::query(
        "SELECT c.id, c.path, c.chapter_number, c.position, d.directory, \
                c.is_downloaded, c.stored_content_type, c.media_repair_needed, \
                c.content_bytes, c.media_bytes \
         FROM chapter c \
         LEFT JOIN work_metadata_directory_cache d ON d.chapter_id = c.id \
         WHERE c.novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: load cached chapters: {err}"))?;

    let cached: Vec<CachedChapterRow> = cached_rows
        .into_iter()
        .map(|row| CachedChapterRow {
            id: row.get("id"),
            path: row.get("path"),
            chapter_number: row.get("chapter_number"),
            position: row.get("position"),
            directory: row.get("directory"),
            is_downloaded: row.get("is_downloaded"),
            stored_content_type: row.get("stored_content_type"),
            media_repair_needed: row.get("media_repair_needed"),
            content_bytes: row.get("content_bytes"),
            media_bytes: row.get("media_bytes"),
        })
        .collect();

    let by_directory: HashMap<&str, &CachedChapterRow> = cached
        .iter()
        .filter_map(|row| Some((row.directory.as_deref()?, row)))
        .collect();
    let by_path: HashMap<&str, &CachedChapterRow> =
        cached.iter().map(|row| (row.path.as_str(), row)).collect();
    let mut by_number: HashMap<u64, Vec<&CachedChapterRow>> = HashMap::new();
    for row in &cached {
        let num_f64 = row
            .chapter_number
            .as_deref()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(row.position as f64);
        by_number.entry(num_f64.to_bits()).or_default().push(row);
    }

    let mut discovered_counts: HashMap<u64, usize> = HashMap::new();
    for chapter in &discovered {
        let num_f64 = chapter.chapter_number.parse::<f64>().unwrap_or(f64::NAN);
        *discovered_counts.entry(num_f64.to_bits()).or_insert(0) += 1;
    }

    let can_adopt = |chapter_id: i64| -> bool {
        snapshot.is_none_or(|snap| !snap.skipped_chapter_ids.contains(&chapter_id))
    };

    let mut directories: Vec<(i64, String)> = Vec::new();
    let mut used = HashSet::<i64>::new();
    let mut updates: HashMap<(String, bool), Vec<(i64, i64, i64)>> = HashMap::new();
    let mut inserts: Vec<(String, StoredNovelChapterDto, i64, String)> = Vec::new();
    let mut inserted_paths = HashSet::<String>::new();

    for (index, chapter) in discovered.iter().enumerate() {
        let absolute_directory = format!("{directory}/{}", chapter.directory);
        let recovered_path = if is_local {
            format!("local-folder:{}", chapter.directory)
        } else {
            format!("norea-folder:{}", chapter.chapter_number)
        };
        let exact = by_directory
            .get(absolute_directory.as_str())
            .or_else(|| by_path.get(recovered_path.as_str()))
            .copied();
        let number_bits = chapter
            .chapter_number
            .parse::<f64>()
            .unwrap_or(f64::NAN)
            .to_bits();
        let numbered = by_number
            .get(&number_bits)
            .map_or(&[][..], Vec::as_slice);
        let candidates: Vec<&CachedChapterRow> = if is_local {
            numbered
                .iter()
                .copied()
                .filter(|row| {
                    row.directory.is_none()
                        && crate::chapter_media::chapter_number_segment(
                            row.chapter_number.as_deref(),
                            Some(row.position),
                            row.id,
                        )
                        .ok()
                        .as_deref()
                            == Some(chapter.directory.as_str())
                })
                .collect()
        } else {
            numbered.to_vec()
        };

        let matched = exact.or_else(|| (candidates.len() == 1).then(|| candidates[0]));
        if is_local && exact.is_none() && candidates.len() > 1 {
            continue;
        }
        let discovered_dup = discovered_counts.get(&number_bits).copied().unwrap_or(0) > 1;
        if matched.is_some_and(|m| used.contains(&m.id))
            || (!is_local && exact.is_none() && (numbered.len() > 1 || discovered_dup))
        {
            continue;
        }
        if snapshot.is_some()
            && matched.is_some_and(|m| {
                m.is_downloaded != 0
                    && m.directory
                        .as_deref()
                        .is_some_and(|dir| dir != absolute_directory)
            })
        {
            continue;
        }
        let Some(matched_row) = matched else {
            if inserted_paths.insert(recovered_path.clone()) {
                inserts.push((
                    recovered_path,
                    chapter.clone(),
                    (index + 1) as i64,
                    absolute_directory,
                ));
            }
            continue;
        };
        if snapshot.is_some() && !can_adopt(matched_row.id) {
            continue;
        }
        let content_bytes_i64 = i64::try_from(chapter.content_bytes).unwrap_or(i64::MAX);
        let media_bytes_i64 = i64::try_from(chapter.media_bytes).unwrap_or(i64::MAX);
        if (matched_row.is_downloaded != 0) != chapter.media_complete
            || matched_row.stored_content_type.as_deref() != Some(chapter.content_type.as_str())
            || (matched_row.media_repair_needed != 0) == chapter.media_complete
            || matched_row.content_bytes != content_bytes_i64
            || matched_row.media_bytes != media_bytes_i64
        {
            updates
                .entry((chapter.content_type.clone(), chapter.media_complete))
                .or_default()
                .push((matched_row.id, content_bytes_i64, media_bytes_i64));
        }
        used.insert(matched_row.id);
        directories.push((matched_row.id, absolute_directory));
    }

    for batch in inserts.chunks(100) {
        let values: Vec<String> = (0..batch.len())
            .map(|idx| {
                let first = idx * 8 + 2;
                let cols: Vec<String> = (0..8).map(|col| format!("?{}", first + col)).collect();
                format!("({})", cols.join(","))
            })
            .collect();
        let sql = format!(
            "WITH discovered(path, name, number, position, type, complete, content_bytes, media_bytes) \
             AS (VALUES {}) \
             INSERT INTO chapter(novel_id, path, name, chapter_number, position, content_type, \
                                 stored_content_type, is_downloaded, media_repair_needed, \
                                 content_bytes, media_bytes, media_bytes_checked_at, \
                                 progress, bookmark, read_at) \
             SELECT n.id, d.path, d.name, d.number, d.position, d.type, d.type, \
                    d.complete, 1 - d.complete, d.content_bytes, d.media_bytes, unixepoch(), \
                    COALESCE(state.progress, 0), COALESCE(state.bookmark, 0), state.read_at \
             FROM discovered d \
             JOIN novel n ON n.id = ?1 \
             LEFT JOIN work_metadata_reading_state state \
               ON state.plugin_id = n.plugin_id AND state.novel_path = n.path AND state.chapter_path = d.path",
            values.join(",")
        );
        let mut query = sqlx::query(AssertSqlSafe(sql)).bind(novel_id);
        for (path, chapter, position, _) in batch {
            query = query
                .bind(path)
                .bind(&chapter.name)
                .bind(&chapter.chapter_number)
                .bind(*position)
                .bind(&chapter.content_type)
                .bind(i64::from(chapter.media_complete))
                .bind(i64::try_from(chapter.content_bytes).unwrap_or(i64::MAX))
                .bind(i64::try_from(chapter.media_bytes).unwrap_or(i64::MAX));
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: insert discovered chapters: {err}"))?;
    }

    if !inserts.is_empty() {
        let rows = sqlx::query("SELECT id, path FROM chapter WHERE novel_id = ?1")
            .bind(novel_id)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: lookup discovered chapter ids: {err}"))?;
        let ids: HashMap<String, i64> = rows
            .into_iter()
            .map(|r| (r.get("path"), r.get("id")))
            .collect();
        for (path, _, _, dir) in &inserts {
            let id = ids
                .get(path)
                .copied()
                .ok_or_else(|| "work metadata: discovered chapter identity missing".to_string())?;
            used.insert(id);
            directories.push((id, dir.clone()));
        }
    }

    for ((content_type, media_complete), chapter_rows) in updates {
        for batch in chapter_rows.chunks(100) {
            let eligible: Vec<_> = batch
                .iter()
                .copied()
                .filter(|(id, _, _)| can_adopt(*id))
                .collect();
            if eligible.is_empty() {
                continue;
            }
            let values: Vec<String> = (0..eligible.len())
                .map(|idx| format!("(?{}, ?{}, ?{})", idx * 3 + 3, idx * 3 + 4, idx * 3 + 5))
                .collect();
            let sql = format!(
                "WITH inspected(id, content_bytes, media_bytes) AS (VALUES {}) \
                 UPDATE chapter SET \
                   is_downloaded = ?2, \
                   media_repair_needed = 1 - ?2, \
                   stored_content_type = ?1, \
                   content_bytes = (SELECT content_bytes FROM inspected WHERE inspected.id = chapter.id), \
                   media_bytes = (SELECT media_bytes FROM inspected WHERE inspected.id = chapter.id), \
                   media_bytes_checked_at = unixepoch() \
                 WHERE id IN (SELECT id FROM inspected)",
                values.join(",")
            );
            let mut query = sqlx::query(AssertSqlSafe(sql))
                .bind(&content_type)
                .bind(i64::from(media_complete));
            for (id, c_bytes, m_bytes) in eligible {
                query = query.bind(id).bind(c_bytes).bind(m_bytes);
            }
            query
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: update inspected chapters: {err}"))?;
        }
    }

    let discovered_dirs: HashSet<String> = discovered
        .iter()
        .map(|chapter| format!("{directory}/{}", chapter.directory))
        .collect();
    let dir_prefix = format!("{directory}/");
    let missing_ids: Vec<i64> = cached
        .iter()
        .filter(|row| {
            !used.contains(&row.id)
                && row
                    .directory
                    .as_deref()
                    .is_some_and(|dir| dir.starts_with(&dir_prefix) && !discovered_dirs.contains(dir))
        })
        .map(|row| row.id)
        .collect();

    for batch in missing_ids.chunks(100) {
        let eligible: Vec<i64> = batch.iter().copied().filter(|id| can_adopt(*id)).collect();
        if eligible.is_empty() {
            continue;
        }
        let placeholders: Vec<String> = (0..eligible.len())
            .map(|idx| format!("?{}", idx + 1))
            .collect();
        let sql = format!(
            "UPDATE chapter SET \
               is_downloaded = 0, \
               media_repair_needed = 0, \
               stored_content_type = NULL, \
               content_bytes = 0, \
               media_bytes = 0, \
               media_bytes_checked_at = NULL \
             WHERE id IN ({}) \
               AND (is_downloaded <> 0 OR media_repair_needed <> 0 OR stored_content_type IS NOT NULL \
                    OR content_bytes <> 0 OR media_bytes <> 0 OR media_bytes_checked_at IS NOT NULL)",
            placeholders.join(",")
        );
        let mut query = sqlx::query(AssertSqlSafe(sql));
        for id in eligible {
            query = query.bind(id);
        }
        query
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: clear missing downloads: {err}"))?;
    }

    let mut combined_directories: Vec<(i64, String)> = cached
        .iter()
        .filter(|row| row.directory.is_some() && !used.contains(&row.id))
        .map(|row| (row.id, row.directory.clone().unwrap()))
        .collect();
    let mappings_changed = snapshot.is_none()
        || directories
            .iter()
            .any(|(id, dir)| by_directory.get(dir.as_str()).map(|r| r.id) != Some(*id));
    combined_directories.extend(directories);

    if mappings_changed {
        let register_native = snapshot.is_none_or(|snap| !snap.defer_native_registration);
        persist_work_chapter_directories_in_tx(
            root,
            &mut *conn,
            ctx,
            novel_id,
            &combined_directories,
            register_native,
        )
        .await?;
    }

    Ok(())
}

fn is_local_cover_data_uri(cover: Option<&str>) -> Option<(&str, &str)> {
    let cover = cover?;
    let rest = cover.strip_prefix("data:image/")?;
    let (subtype_and_params, encoded) = rest.split_once(',')?;
    let subtype = subtype_and_params.split(';').next()?;
    if subtype.is_empty() || !subtype_and_params.contains(";base64") {
        return None;
    }
    Some((subtype, encoded))
}

pub async fn flush_dirty_in_tx(
    metadata_root: &MetadataRoot,
    conn: &mut SqliteConnection,
    ctx: &mut TxContext,
    fetched: Option<&FetchedChapterCatalog>,
) -> Result<(), String> {
    if let Some(fetched) = fetched {
        let work_row = sqlx::query(
            "SELECT f.directory, n.name, n.author, n.artist, n.summary, n.status, n.genres, n.rating, \
                    EXISTS(SELECT 1 FROM work_metadata_dirty d \
                           WHERE d.plugin_id = n.plugin_id AND d.path = n.path) AS dirty \
             FROM novel n \
             LEFT JOIN work_metadata_file_cache f ON f.novel_id = n.id \
             WHERE n.id = ?1",
        )
        .bind(fetched.novel_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: inspect fetched work: {err}"))?;

        if let Some(work) = work_row {
            let dirty: i64 = work.get("dirty");
            if dirty == 0 {
                let directory: Option<String> = work.get("directory");
                let stored = match directory.as_deref() {
                    Some(dir) => match metadata_root.resolve()? {
                        Some(root) => read_stored_novel_metadata_at(&root, dir)?,
                        None => None,
                    },
                    None => None,
                };
                let name: String = work.get("name");
                let author: Option<String> = work.get("author");
                let artist: Option<String> = work.get("artist");
                let summary: Option<String> = work.get("summary");
                let status: Option<String> = work.get("status");
                let genres: Option<String> = work.get("genres");
                let rating: Option<f64> = crate::db::decode_sqlite_opt_f64(&work, "rating");

                let needs_dirty = match stored {
                    None => true,
                    Some(ref s) => {
                        s.metadata.novel.name != name
                            || s.metadata.novel.author != author
                            || s.metadata.novel.artist != artist
                            || s.metadata.novel.summary != summary
                            || s.metadata.novel.status != status
                            || s.metadata.novel.genres != genres
                            || s.metadata.novel.rating != rating
                            || fetched
                                .chapters
                                .ordered_entries()
                                .into_iter()
                                .any(|(num, title)| s.metadata.chapters.get(num) != Some(title))
                            || fetched
                                .replaced_chapter_numbers
                                .iter()
                                .any(|num| s.metadata.chapters.contains_key(num))
                    }
                };
                if needs_dirty {
                    sqlx::query(
                        "INSERT INTO work_metadata_dirty(plugin_id, path) \
                         SELECT plugin_id, path FROM novel WHERE id = ?1 \
                         ON CONFLICT(plugin_id, path) DO NOTHING",
                    )
                    .bind(fetched.novel_id)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: mark fetched dirty: {err}"))?;
                }
            }
        }
    }

    let dirty_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT plugin_id, path FROM work_metadata_dirty")
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: load dirty rows: {err}"))?;

    if dirty_rows.is_empty() {
        return Ok(());
    }

    let root = metadata_root
        .resolve()?
        .ok_or_else(|| "work metadata: storage root is unavailable".to_string())?;

    for (plugin_id, novel_path) in &dirty_rows {
        let known: Option<(i64, String, String)> = sqlx::query_as(
            "SELECT novel_id, directory, fingerprint FROM work_metadata_file_cache \
             WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(plugin_id)
        .bind(novel_path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: read known file cache: {err}"))?;

        let mut previous: Option<NovelMetadataV1Dto> = None;
        let mut file_changed = false;
        if let Some((_, ref known_dir, ref known_fp)) = known {
            let relative = format!("{known_dir}/novel.json");
            let bytes = crate::chapter_media::read_work_metadata_bytes_at(&root, &relative)?
                .ok_or_else(|| {
                    "work metadata: authoritative file disappeared; reload before editing"
                        .to_string()
                })?;
            let (mut parsed, _) = parse_novel_metadata_bytes(&bytes)?;
            parsed.cover =
                discover_stored_novel_cover_at(&root, known_dir, parsed.cover.as_ref())?;
            file_changed = stored_novel_metadata_fingerprint(&parsed)? != *known_fp;
            previous = Some(parsed);
        }

        let novel_row = sqlx::query(
            "SELECT id, plugin_id, source_novel_id, path, name, cover, author, artist, \
                    summary, status, genres, rating, is_local \
             FROM novel WHERE plugin_id = ?1 AND path = ?2",
        )
        .bind(plugin_id)
        .bind(novel_path)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: load dirty novel: {err}"))?;

        let novel_id_opt = novel_row.as_ref().map(|r| r.get::<i64, _>("id"));
        if file_changed && novel_id_opt != fetched.map(|f| f.novel_id) {
            return Err(
                "work metadata: file changed outside the cache; refresh from the source before editing"
                    .to_string(),
            );
        }

        let Some(novel) = novel_row else {
            if let Some((cached_novel_id, ref known_dir, _)) = known {
                let relative = format!("{known_dir}/novel.json");
                ctx.remove_metadata_file(&root, &relative)?;
                super::novel_override::remove_stored_override_file_in_tx(&root, ctx, known_dir)?;
                ctx.record_work_directory(WorkDirectoryUpdateDto {
                    novel_id: cached_novel_id,
                    plugin_id: plugin_id.clone(),
                    novel_path: novel_path.clone(),
                    directory: None,
                    fingerprint: None,
                });
                ctx.mark_work_metadata_changed();
            }
            let removed_chapters: Vec<i64> = sqlx::query_scalar(
                "SELECT chapter_id FROM work_metadata_directory_cache \
                 WHERE novel_id IN (SELECT novel_id FROM work_metadata_file_cache WHERE plugin_id = ?1 AND path = ?2)",
            )
            .bind(plugin_id)
            .bind(novel_path)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: load deleted chapter directories: {err}"))?;
            for ch_id in removed_chapters {
                ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
                    chapter_id: ch_id,
                    directory: None,
                });
            }
            sqlx::query(
                "DELETE FROM work_metadata_directory_cache \
                 WHERE novel_id IN (SELECT novel_id FROM work_metadata_file_cache WHERE plugin_id = ?1 AND path = ?2)",
            )
            .bind(plugin_id)
            .bind(novel_path)
            .execute(&mut *conn)
            .await
            .map_err(|err| format!("db work metadata: delete orphan directory cache: {err}"))?;
            sqlx::query("DELETE FROM work_metadata_file_cache WHERE plugin_id = ?1 AND path = ?2")
                .bind(plugin_id)
                .bind(novel_path)
                .execute(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: delete orphan file cache: {err}"))?;
            continue;
        };

        let novel_id: i64 = novel.get("id");
        let source_novel_id: String = novel
            .get::<Option<String>, _>("source_novel_id")
            .ok_or_else(|| "Plugin-owned novel ID is required for storage.".to_string())?;
        let identity = WorkMetadataIdentityDto {
            plugin_id: novel.get("plugin_id"),
            novel_id: source_novel_id.clone(),
            novel_path: novel.get("path"),
        };
        let directory = match known {
            Some((_, ref known_dir, _)) => known_dir.clone(),
            None => available_novel_metadata_directory_at(&root, &identity)?,
        };

        let chapter_rows = sqlx::query(
            "SELECT id, name, chapter_number, position \
             FROM chapter WHERE novel_id = ?1 ORDER BY position, id",
        )
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: load novel chapters for flush: {err}"))?;

        let cached_dir_rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT chapter_id, directory FROM work_metadata_directory_cache WHERE novel_id = ?1",
        )
        .bind(novel_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: load cached chapter directories: {err}"))?;

        let by_id: HashMap<i64, String> = cached_dir_rows.iter().cloned().collect();
        let mut used_lower: HashSet<String> = cached_dir_rows
            .iter()
            .map(|(_, dir)| dir.to_ascii_lowercase())
            .collect();

        let mut mapped: Vec<(i64, String)> = Vec::with_capacity(chapter_rows.len());
        for row in &chapter_rows {
            let ch_id: i64 = row.get("id");
            if let Some(prev_dir) = by_id.get(&ch_id) {
                mapped.push((ch_id, prev_dir.clone()));
                continue;
            }
            let ch_num: Option<String> = row.get("chapter_number");
            let ch_pos: i64 = row.get("position");
            let child =
                crate::chapter_media::chapter_number_segment(ch_num.as_deref(), Some(ch_pos), ch_id)
                    .map_err(|_| "Chapter storage sequence must be a nonnegative number.".to_string())?;
            let target = format!("{directory}/{child}");
            if !used_lower.insert(target.to_ascii_lowercase()) {
                return Err("work metadata: chapter sequence is already assigned".to_string());
            }
            mapped.push((ch_id, target));
        }

        let is_local: i64 = novel.get("is_local");
        let novel_cover_str: Option<String> = novel.get("cover");
        let mut cover = discover_stored_novel_cover_at(
            &root,
            &directory,
            previous.as_ref().and_then(|p| p.cover.as_ref()),
        )?;
        if is_local != 0 && novel_cover_str.is_none() {
            cover = None;
        }
        let mut local_cover_bytes: Option<Vec<u8>> = None;
        if let Some((subtype, encoded)) = is_local_cover_data_uri(novel_cover_str.as_deref()) {
            let extension = if subtype == "jpeg" { "jpg" } else { subtype };
            cover = Some(WorkMetadataCoverDto {
                file_name: format!("cover.{extension}"),
                content_type: Some(format!("image/{subtype}")),
            });
            local_cover_bytes = Some(
                decode_base64(encoded.trim())
                    .map_err(|err| format!("work metadata: decode local cover: {err}"))?,
            );
        }

        let composition = get_chapter_composition_in_tx(&mut *conn, novel_id).await?;
        let mut source_catalog = ChaptersMap::new();
        if file_changed {
            for row in &chapter_rows {
                let ch_num: Option<String> = row.get("chapter_number");
                let ch_name: String = row.get("name");
                if let Some(num_str) = ch_num.as_deref().and_then(canonical_chapter_number_str) {
                    source_catalog.insert(num_str, ch_name);
                }
            }
        } else if let Some(ref prev) = previous {
            for (k, v) in prev.chapters.ordered_entries() {
                source_catalog.insert(k.to_string(), v.to_string());
            }
        }

        if let Some(fetched) = fetched.filter(|f| f.novel_id == novel_id) {
            for replaced in &fetched.replaced_chapter_numbers {
                source_catalog.remove(replaced);
            }
        }

        let final_chapters = if let Some(ref comp) = composition {
            ChaptersMap::from_entries(chapter_composition_catalog(comp))
        } else if is_local != 0 {
            let mut local_map = ChaptersMap::new();
            for row in &chapter_rows {
                let ch_id: i64 = row.get("id");
                let ch_name: String = row.get("name");
                let ch_num: Option<String> = row.get("chapter_number");
                let ch_pos: i64 = row.get("position");
                let key = crate::chapter_media::chapter_number_segment(
                    ch_num.as_deref(),
                    Some(ch_pos),
                    ch_id,
                )?;
                local_map.insert(key, ch_name);
            }
            local_map
        } else {
            if let Some(fetched) = fetched.filter(|f| f.novel_id == novel_id) {
                for (k, v) in fetched.chapters.ordered_entries() {
                    source_catalog.insert(k.to_string(), v.to_string());
                }
            }
            source_catalog
        };

        let metadata = normalize_novel_metadata(&NovelMetadataV1Dto {
            schema_version: 1,
            identity,
            novel: WorkMetadataNovelDto {
                name: novel.get("name"),
                author: novel.get("author"),
                artist: novel.get("artist"),
                summary: novel.get("summary"),
                status: novel.get("status"),
                genres: novel.get("genres"),
                rating: novel.get("rating"),
                is_local: is_local != 0,
            },
            cover: cover.clone(),
            chapters: final_chapters,
            chapter_composition: composition,
        })?;

        let cover_changed = match local_cover_bytes {
            Some(ref bytes) => {
                write_stored_novel_cover_in_tx(&root, ctx, &directory, &metadata, bytes, true)?
            }
            None => false,
        };
        write_stored_novel_metadata_in_tx(&root, ctx, &directory, &metadata, true)?;
        super::novel_override::publish_missing_override_file_in_tx(
            &root,
            &mut *conn,
            ctx,
            novel_id,
            &directory,
        )
        .await?;
        if cover.is_none() {
            if let Some(prev_cover) = previous.as_ref().and_then(|p| p.cover.as_ref()) {
                remove_stored_novel_cover_in_tx(&root, ctx, &directory, Some(prev_cover), true)?;
            }
        }
        persist_work_chapter_directories_in_tx(
            Some(&root),
            &mut *conn,
            ctx,
            novel_id,
            &mapped,
            true,
        )
        .await?;
        remember_stored_novel_metadata_in_tx(
            &mut *conn,
            ctx,
            &directory,
            &metadata,
            cover_changed,
        )
        .await?;
    }

    sqlx::query("DELETE FROM work_metadata_dirty")
        .execute(&mut *conn)
        .await
        .map_err(|err| format!("db work metadata: clear work_metadata_dirty: {err}"))?;

    Ok(())
}

pub async fn restore_native_directories_from_pool(
    pool: &SqlitePool,
    root: &Path,
) -> Result<(), String> {
    let mut after_id = 0_i64;
    let mut all_chapters: Vec<(i64, String)> = Vec::new();
    loop {
        let batch: Vec<(i64, String)> = sqlx::query_as(
            "SELECT chapter_id, directory FROM work_metadata_directory_cache \
             WHERE chapter_id > ?1 ORDER BY chapter_id LIMIT 1000",
        )
        .bind(after_id)
        .fetch_all(pool)
        .await
        .map_err(|err| format!("db work metadata: restore native directories: {err}"))?;
        if batch.is_empty() {
            break;
        }
        after_id = batch.last().unwrap().0;
        all_chapters.extend(batch);
    }
    crate::chapter_media::register_work_chapter_directories_at(root, &all_chapters, true)
}

pub async fn read_restored_directories_from_pool(
    pool: &SqlitePool,
    root: Option<&Path>,
    register_native: bool,
) -> Result<RestoredWorkMetadataDirectoriesDto, String> {
    let file_rows = sqlx::query(
        "SELECT plugin_id, path, novel_id, directory, fingerprint FROM work_metadata_file_cache",
    )
    .fetch_all(pool)
    .await
    .map_err(|err| format!("db work metadata: load file cache: {err}"))?;
    let files: Vec<CachedMetadataFileRowDto> = file_rows
        .into_iter()
        .map(|row| CachedMetadataFileRowDto {
            plugin_id: row.get("plugin_id"),
            path: row.get("path"),
            novel_id: row.get("novel_id"),
            directory: row.get("directory"),
            fingerprint: row.get("fingerprint"),
        })
        .collect();

    let mut chapters: Vec<CachedChapterDirectoryRowDto> = Vec::new();
    let mut after_id = 0_i64;
    loop {
        let batch: Vec<(i64, String)> = sqlx::query_as(
            "SELECT chapter_id, directory FROM work_metadata_directory_cache \
             WHERE chapter_id > ?1 ORDER BY chapter_id LIMIT 1000",
        )
        .bind(after_id)
        .fetch_all(pool)
        .await
        .map_err(|err| format!("db work metadata: load directory cache: {err}"))?;
        if batch.is_empty() {
            break;
        }
        after_id = batch.last().unwrap().0;
        chapters.extend(
            batch
                .into_iter()
                .map(|(id, directory)| CachedChapterDirectoryRowDto { id, directory }),
        );
    }

    if register_native {
        if let Some(root) = root {
            let pairs: Vec<(i64, String)> = chapters
                .iter()
                .map(|c| (c.id, c.directory.clone()))
                .collect();
            crate::chapter_media::register_work_chapter_directories_at(root, &pairs, true)?;
        }
    }

    Ok(RestoredWorkMetadataDirectoriesDto { files, chapters })
}

pub async fn list_sync_files_from_pool(
    pool: &SqlitePool,
) -> Result<Vec<WorkMetadataSyncFileDto>, String> {
    let rows = sqlx::query(
        "SELECT f.plugin_id, f.path, f.directory, f.fingerprint, COALESCE(j.revision, 0) AS revision, \
                CASE \
                  WHEN COALESCE(n.in_library, 0) = 1 \
                    OR EXISTS ( \
                      SELECT 1 FROM chapter c \
                      WHERE c.novel_id = f.novel_id \
                        AND (c.is_downloaded = 1 OR c.content_bytes > 0 OR c.media_repair_needed = 1) \
                    ) \
                  THEN 1 \
                  ELSE 0 \
                END AS upload_eligible \
         FROM work_metadata_file_cache f \
         LEFT JOIN novel n ON n.id = f.novel_id \
         LEFT JOIN work_metadata_sync_journal j \
           ON j.plugin_id = f.plugin_id AND j.path = f.path",
    )
    .fetch_all(pool)
    .await
    .map_err(|err| format!("db work metadata: list sync files: {err}"))?;

    Ok(rows
        .into_iter()
        .map(|r| WorkMetadataSyncFileDto {
            plugin_id: r.get("plugin_id"),
            path: r.get("path"),
            directory: r.get("directory"),
            fingerprint: r.get("fingerprint"),
            revision: r.get("revision"),
            upload_eligible: r.get::<i64, _>("upload_eligible") != 0,
        })
        .collect())
}

fn optional_media_root(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "android")]
    if crate::chapter_media::configured_storage_root_value(app)?.is_none() {
        return Ok(None);
    }
    crate::chapter_media::media_root(app).map(Some)
}

#[tauri::command]
pub async fn db_work_metadata_restore_directories(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    register_native: Option<bool>,
) -> Result<RestoredWorkMetadataDirectoriesDto, String> {
    let register = register_native.unwrap_or(true);
    let root = if register {
        optional_media_root(&app)?
    } else {
        None
    };
    read_restored_directories_from_pool(databases.writer(), root.as_deref(), register).await
}

#[tauri::command]
pub async fn db_work_metadata_get_work_directory(
    databases: State<'_, AppDatabase>,
    novel_id: i64,
    read_mode: Option<ReadMode>,
) -> Result<Option<String>, String> {
    sqlx::query_scalar("SELECT directory FROM work_metadata_file_cache WHERE novel_id = ?1")
        .bind(novel_id)
        .fetch_optional(databases.pool_for(read_mode.unwrap_or_default()))
        .await
        .map_err(|err| format!("db work metadata: get work directory: {err}"))
}

#[tauri::command]
pub async fn db_work_metadata_apply_scanned_downloads(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    novel_id: i64,
    directory: String,
    chapters: Vec<StoredNovelChapterDto>,
    skipped_chapter_ids: Option<Vec<i64>>,
) -> Result<DbMutationEnvelope<()>, String> {
    let root = crate::chapter_media::media_root(&app)?;
    let skipped: HashSet<i64> = skipped_chapter_ids.unwrap_or_default().into_iter().collect();
    with_write_tx(
        databases.writer(),
        TxOptions {
            metadata_root: MetadataRoot::Path(root.clone()),
            ..TxOptions::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                let current_dir: Option<String> = sqlx::query_scalar(
                    "SELECT f.directory FROM work_metadata_file_cache f \
                     JOIN novel n ON n.id = f.novel_id WHERE n.id = ?1",
                )
                .bind(novel_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: verify work directory: {err}"))?;
                if current_dir.as_deref() != Some(directory.as_str()) {
                    return Ok(());
                }
                let snapshot = ChapterScanSnapshot {
                    chapters,
                    skipped_chapter_ids: skipped,
                    defer_native_registration: false,
                };
                scan_stored_novel_chapters_to_cache_in_tx(
                    Some(&root),
                    &mut *conn,
                    ctx,
                    novel_id,
                    &directory,
                    Some(&snapshot),
                )
                .await
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_refresh_stored_downloads(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    novel_id: i64,
    skipped_chapter_ids: Option<Vec<i64>>,
) -> Result<DbMutationEnvelope<()>, String> {
    let Some(directory): Option<String> = sqlx::query_scalar(
        "SELECT directory FROM work_metadata_file_cache WHERE novel_id = ?1",
    )
    .bind(novel_id)
    .fetch_optional(databases.writer())
    .await
    .map_err(|err| format!("db work metadata: lookup directory for refresh: {err}"))?
    else {
        return Ok(DbMutationEnvelope {
            value: (),
            effects: DbMutationEffects::default(),
        });
    };

    let root = crate::chapter_media::media_root(&app)?;
    let root_for_scan = root.clone();
    let dir_for_scan = directory.clone();
    let chapters = tauri::async_runtime::spawn_blocking(move || {
        list_stored_novel_chapters_at(&root_for_scan, &dir_for_scan)
    })
    .await
    .map_err(|err| format!("work metadata: chapter scan task: {err}"))??;

    db_work_metadata_apply_scanned_downloads(
        app,
        databases,
        novel_id,
        directory,
        chapters,
        skipped_chapter_ids,
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_flush_pending(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<()>, String> {
    let pending: Option<i64> = sqlx::query_scalar("SELECT 1 FROM work_metadata_dirty LIMIT 1")
        .fetch_optional(databases.writer())
        .await
        .map_err(|err| format!("db work metadata: check pending dirty rows: {err}"))?;
    if pending.is_none() {
        return Ok(DbMutationEnvelope {
            value: (),
            effects: DbMutationEffects::default(),
        });
    }
    with_write_tx(
        databases.writer(),
        TxOptions {
            metadata_root: MetadataRoot::App(app),
            ..TxOptions::default()
        },
        |_conn, _ctx| Box::pin(async move { Ok(()) }),
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_rescan_work(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    directory: String,
    chapters: Option<Vec<StoredNovelChapterDto>>,
    skipped_chapter_ids: Option<Vec<i64>>,
) -> Result<DbMutationEnvelope<()>, String> {
    let root = crate::chapter_media::media_root(&app)?;
    let inspected_chapters = match chapters {
        Some(list) => list,
        None => {
            let root_clone = root.clone();
            let dir_clone = directory.clone();
            tauri::async_runtime::spawn_blocking(move || {
                list_stored_novel_chapters_at(&root_clone, &dir_clone)
            })
            .await
            .map_err(|err| format!("work metadata: rescan task: {err}"))??
        }
    };
    let skipped: HashSet<i64> = skipped_chapter_ids.unwrap_or_default().into_iter().collect();

    with_write_tx(
        databases.writer(),
        TxOptions {
            remote_content_sync: true,
            metadata_root: MetadataRoot::Path(root.clone()),
            ..TxOptions::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                let Some(current) = read_stored_novel_metadata_at(&root, &directory)? else {
                    return Ok(());
                };
                let file_conflict =
                    has_work_metadata_conflict_in_tx(&mut *conn, &current.directory, &current.metadata)
                        .await?;
                let existing_id: Option<i64> = if file_conflict {
                    sqlx::query_scalar(
                        "SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2",
                    )
                    .bind(&current.metadata.identity.plugin_id)
                    .bind(&current.metadata.identity.novel_path)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: check conflicted work: {err}"))?
                } else {
                    None
                };
                if file_conflict && existing_id.is_none() {
                    return Ok(());
                }
                let novel_id = match existing_id {
                    Some(id) => id,
                    None => {
                        apply_novel_metadata_to_cache_in_tx(
                            Some(&root),
                            &mut *conn,
                            ctx,
                            &current.metadata,
                            Some(&current.directory),
                            ApplyNovelMetadataOptions {
                                preserve_missing_metadata: true,
                                ..ApplyNovelMetadataOptions::default()
                            },
                        )
                        .await?
                    }
                };
                super::novel_override::adopt_stored_novel_override_in_tx(
                    &root,
                    &mut *conn,
                    ctx,
                    novel_id,
                    &current.directory,
                )
                .await?;
                let snapshot = ChapterScanSnapshot {
                    chapters: inspected_chapters,
                    skipped_chapter_ids: skipped,
                    defer_native_registration: false,
                };
                scan_stored_novel_chapters_to_cache_in_tx(
                    Some(&root),
                    &mut *conn,
                    ctx,
                    novel_id,
                    &current.directory,
                    Some(&snapshot),
                )
                .await?;
                if !file_conflict {
                    remember_stored_novel_metadata_in_tx(
                        &mut *conn,
                        ctx,
                        &current.directory,
                        &current.metadata,
                        true,
                    )
                    .await?;
                }
                sqlx::query("DELETE FROM work_metadata_dirty WHERE plugin_id = ?1 AND path = ?2")
                    .bind(&current.metadata.identity.plugin_id)
                    .bind(&current.metadata.identity.novel_path)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: clear rescan dirty row: {err}"))?;
                Ok(())
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_read_sync_files(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
) -> Result<DbMutationEnvelope<Vec<WorkMetadataSyncFileDto>>, String> {
    let flush_envelope = db_work_metadata_flush_pending(app, databases.clone()).await?;
    let files = list_sync_files_from_pool(databases.writer()).await?;
    Ok(DbMutationEnvelope {
        value: files,
        effects: flush_envelope.effects,
    })
}

#[tauri::command]
pub async fn db_work_metadata_read_sync_file(
    databases: State<'_, AppDatabase>,
    plugin_id: String,
    novel_path: String,
    read_mode: Option<ReadMode>,
) -> Result<Option<WorkMetadataSyncFileDto>, String> {
    let mut conn = databases
        .pool_for(read_mode.unwrap_or_default())
        .acquire()
        .await
        .map_err(|err| format!("db work metadata: acquire connection: {err}"))?;
    read_work_metadata_sync_file_in_tx(&mut conn, &plugin_id, &novel_path).await
}

pub async fn persist_novel_cover_at(
    pool: &SqlitePool,
    root: PathBuf,
    directory: String,
    cover: Option<PersistNovelCoverInputDto>,
    preserve_existing: bool,
) -> Result<DbMutationEnvelope<Option<WorkMetadataIdentityDto>>, String> {
    with_write_tx(
        pool,
        TxOptions {
            metadata_root: MetadataRoot::Path(root.clone()),
            ..TxOptions::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                if preserve_existing
                    && crate::chapter_media::discover_work_cover_at(
                        &root,
                        &format!("{directory}/novel.json"),
                    )?
                    .is_some()
                {
                    return Ok(None);
                }

                let bytes = crate::chapter_media::read_work_metadata_bytes_at(
                    &root,
                    &format!("{directory}/novel.json"),
                )?
                .ok_or_else(|| "work metadata: missing work for cover".to_string())?;
                let (mut metadata, _) = parse_novel_metadata_bytes(&bytes)?;
                metadata.cover =
                    discover_stored_novel_cover_at(&root, &directory, metadata.cover.as_ref())?;
                if has_work_metadata_conflict_in_tx(&mut *conn, &directory, &metadata).await? {
                    return Err(
                        "work metadata: file changed outside the cache; refresh from the source before editing"
                            .to_string(),
                    );
                }

                let mut cover_changed = false;
                if let Some(cover_input) = cover {
                    let previous_cover = metadata.cover.clone();
                    metadata.cover = Some(WorkMetadataCoverDto {
                        file_name: cover_input.file_name.clone(),
                        content_type: cover_input.content_type,
                    });
                    cover_changed = write_stored_novel_cover_in_tx(
                        &root,
                        ctx,
                        &directory,
                        &metadata,
                        &cover_input.body,
                        false,
                    )?;
                    if let Some(prev) = previous_cover.filter(|p| p.file_name != cover_input.file_name)
                    {
                        remove_stored_novel_cover_in_tx(
                            &root,
                            ctx,
                            &directory,
                            Some(&prev),
                            false,
                        )?;
                    }
                } else {
                    let mut removed = HashSet::new();
                    while let Some(ref current_cover) = metadata.cover {
                        if !removed.insert(current_cover.file_name.clone()) {
                            return Err("work metadata: cleared cover is still present".to_string());
                        }
                        remove_stored_novel_cover_in_tx(
                            &root,
                            ctx,
                            &directory,
                            Some(current_cover),
                            false,
                        )?;
                        cover_changed = true;
                        metadata.cover = discover_stored_novel_cover_at(&root, &directory, None)?;
                    }
                }

                write_stored_novel_metadata_in_tx(&root, ctx, &directory, &metadata, false)?;
                remember_stored_novel_metadata_in_tx(
                    &mut *conn,
                    ctx,
                    &directory,
                    &metadata,
                    cover_changed,
                )
                .await?;
                ctx.mark_work_metadata_changed();
                Ok(Some(metadata.identity))
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_persist_cover(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    directory: String,
    cover: Option<PersistNovelCoverInputDto>,
    preserve_existing: Option<bool>,
) -> Result<DbMutationEnvelope<Option<WorkMetadataIdentityDto>>, String> {
    let root = crate::chapter_media::media_root(&app)?;
    persist_novel_cover_at(
        databases.writer(),
        root,
        directory,
        cover,
        preserve_existing.unwrap_or(false),
    )
    .await
}

fn remove_all_stored_covers_in_tx(
    root: &Path,
    ctx: &mut TxContext,
    directory: &str,
    preferred: Option<&WorkMetadataCoverDto>,
) -> Result<(), String> {
    let mut cover = discover_stored_novel_cover_at(root, directory, preferred)?;
    let mut removed = HashSet::new();
    while let Some(ref current) = cover {
        if !removed.insert(current.file_name.clone()) {
            return Err("work metadata: cleared cover is still present".to_string());
        }
        remove_stored_novel_cover_in_tx(root, ctx, directory, Some(current), false)?;
        cover = discover_stored_novel_cover_at(root, directory, None)?;
    }
    Ok(())
}

fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn compute_existing_install_digest(
    existing: &NovelMetadataV1Dto,
    cover_bytes: Option<&[u8]>,
) -> Result<String, String> {
    let serialized = serde_json::to_value(existing)
        .map_err(|err| format!("db work metadata: serialize existing metadata: {err}"))?;
    let canonical = serde_json::to_string(&canonical_json_value(&serialized))
        .map_err(|err| format!("db work metadata: encode canonical metadata: {err}"))?;
    let cover_hash = cover_bytes.map(sha256_hex_bytes);
    let combined = format!("{canonical}:{}", cover_hash.as_deref().unwrap_or("none"));
    Ok(sha256_hex_bytes(combined.as_bytes()))
}

fn assert_chapter_number_mappings(
    mappings: &[ChapterNumberMappingInputDto],
) -> Result<(), String> {
    let mut from_set = HashSet::new();
    let mut to_set = HashSet::new();
    let mut path_set = HashSet::new();
    for m in mappings {
        if m.from == m.to
            || !from_set.insert(m.from.clone())
            || !to_set.insert(m.to.clone())
            || !path_set.insert(m.chapter_path.clone())
        {
            return Err("Server chapter number mapping is invalid or ambiguous.".to_string());
        }
    }
    let pseudo_changes: Vec<super::chapter::SourceChapterNumberChangeDto> = mappings
        .iter()
        .map(|m| super::chapter::SourceChapterNumberChangeDto {
            id: 1,
            path: m.chapter_path.clone(),
            chapter_number: m.from.clone(),
            next_path: m.chapter_path.clone(),
            next_chapter_number: m.to.clone(),
            source_relative_dir: String::new(),
            target_relative_dir: String::new(),
            is_downloaded: false,
        })
        .collect();
    super::chapter::assert_source_chapter_number_changes_supported(&pseudo_changes)?;
    if from_set.iter().any(|num| to_set.contains(num)) {
        return Err("Server chapter number mapping overlaps.".to_string());
    }
    Ok(())
}

struct SupersededServerPlaceholder {
    id: i64,
    path: String,
    chapter_number: String,
    position: i64,
    has_cached_directory: bool,
}

struct ServerChapterNumberReconciliationPlan {
    changes: Vec<super::chapter::SourceChapterNumberChangeDto>,
    superseded_placeholders: Vec<SupersededServerPlaceholder>,
}

fn assert_superseded_placeholder_storage_empty(
    root: &Path,
    relative_dir: &str,
) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for segment in relative_dir.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("Chapter storage path is invalid.".to_string());
        }
        current.push(segment);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(
                        "A stored chapter directory is a symbolic link; existing files were retained."
                            .to_string(),
                    );
                }
                if !meta.is_dir() {
                    return Err(
                        "Existing chapter storage conflicts with incoming chapter number reconciliation; existing files were retained."
                            .to_string(),
                    );
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => {
                return Err(format!(
                    "db work metadata: inspect superseded placeholder storage: {err}"
                ));
            }
        }
    }
    let mut entries = std::fs::read_dir(&current).map_err(|err| {
        format!("db work metadata: read superseded placeholder storage: {err}")
    })?;
    if entries
        .next()
        .transpose()
        .map_err(|err| format!("db work metadata: scan superseded placeholder storage: {err}"))?
        .is_some()
    {
        return Err(
            "Existing chapter storage conflicts with incoming chapter number reconciliation; existing files were retained."
                .to_string(),
        );
    }
    Ok(())
}

fn plan_server_chapter_number_reconciliation(
    work: &super::chapter::RenumberWorkDto,
    stored: &[super::chapter::StoredRenumberChapterDto],
    mappings: &[ChapterNumberMappingInputDto],
) -> Result<ServerChapterNumberReconciliationPlan, String> {
    assert_chapter_number_mappings(mappings)?;
    let mut by_number: HashMap<String, Vec<&super::chapter::StoredRenumberChapterDto>> =
        HashMap::new();
    let mut stored_by_path: HashMap<&str, Vec<&super::chapter::StoredRenumberChapterDto>> =
        HashMap::new();
    for row in stored {
        if let Some(number) = row
            .chapter_number
            .as_deref()
            .and_then(canonical_chapter_number_str)
        {
            by_number.entry(number).or_default().push(row);
        }
        stored_by_path.entry(row.path.as_str()).or_default().push(row);
    }

    let mut superseded_placeholders = Vec::new();
    let mut superseded_ids = HashSet::new();
    for mapping in mappings {
        let Some(from_rows) = by_number.get(mapping.from.as_str()) else {
            continue;
        };
        let Some(to_rows) = by_number.get(mapping.to.as_str()) else {
            continue;
        };
        if from_rows.len() != 1 || to_rows.len() != 1 {
            continue;
        }
        let from_row = from_rows[0];
        let to_row = to_rows[0];
        if from_row.id == to_row.id {
            continue;
        }
        let expected_from_path = format!("norea-folder:{}", mapping.from);
        if from_row.path != expected_from_path {
            continue;
        }
        if from_row.is_downloaded != 0 || !from_row.is_stateless_placeholder {
            continue;
        }
        let path_matches = stored_by_path
            .get(mapping.chapter_path.as_str())
            .map_or(0, Vec::len);
        let expected_to_placeholder = format!("norea-folder:{}", mapping.to);
        let target_matches_path = to_row.path == mapping.chapter_path && path_matches == 1;
        let target_matches_placeholder =
            to_row.path == expected_to_placeholder && path_matches == 0;
        if !target_matches_path && !target_matches_placeholder {
            continue;
        }
        let expected_source_dir = super::chapter::chapter_storage_relative_dir_for_work(
            &work.plugin_id,
            &work.source_novel_id,
            Some(&mapping.from),
            from_row.position,
        )?;
        if from_row
            .directory
            .as_deref()
            .is_some_and(|dir| dir != expected_source_dir)
        {
            continue;
        }
        if superseded_ids.insert(from_row.id) {
            superseded_placeholders.push(SupersededServerPlaceholder {
                id: from_row.id,
                path: from_row.path.clone(),
                chapter_number: mapping.from.clone(),
                position: from_row.position,
                has_cached_directory: from_row.directory.is_some(),
            });
        }
    }

    let remaining: Vec<&super::chapter::StoredRenumberChapterDto> = stored
        .iter()
        .filter(|row| !superseded_ids.contains(&row.id))
        .collect();
    let by_from: HashMap<&str, &ChapterNumberMappingInputDto> =
        mappings.iter().map(|m| (m.from.as_str(), m)).collect();
    let by_path: HashMap<&str, &ChapterNumberMappingInputDto> = mappings
        .iter()
        .map(|m| (m.chapter_path.as_str(), m))
        .collect();
    let original: HashMap<i64, &super::chapter::StoredRenumberChapterDto> =
        remaining.iter().map(|r| (r.id, *r)).collect();

    let mut translated = Vec::with_capacity(remaining.len());
    for row in &remaining {
        let number = row
            .chapter_number
            .as_deref()
            .and_then(canonical_chapter_number_str);
        if let Some(path_mapping) = by_path.get(row.path.as_str()) {
            if number.as_deref() != Some(path_mapping.from.as_str())
                && number.as_deref() != Some(path_mapping.to.as_str())
            {
                return Err(
                    "Server chapter mapping does not match the stored chapter number.".to_string(),
                );
            }
        }
        let Some(mapping) = number
            .as_deref()
            .and_then(|num| by_from.get(num))
            .copied()
        else {
            translated.push((*row).clone());
            continue;
        };
        let legacy_folder = format!("norea-folder:{}", mapping.from);
        if row.path != mapping.chapter_path && row.path != legacy_folder {
            return Err("Server chapter mapping conflicts with a stored source path.".to_string());
        }
        let mut copy = (*row).clone();
        copy.path = mapping.chapter_path.clone();
        translated.push(copy);
    }

    let incoming: Vec<super::chapter::SyncSourceChapterItemDto> = mappings
        .iter()
        .map(|m| {
            let num: f64 = m
                .to
                .parse()
                .map_err(|_| "Server chapter number mapping is invalid or ambiguous.".to_string())?;
            Ok(super::chapter::SyncSourceChapterItemDto {
                path: m.chapter_path.clone(),
                name: String::new(),
                chapter_number: num,
                source_chapter_id: Some(m.from.clone()),
                page: None,
                release_time: None,
                content_type: None,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut planned =
        super::chapter::plan_source_chapter_number_changes(work, &translated, &incoming)?;
    for change in &mut planned {
        if let Some(orig) = original.get(&change.id) {
            change.path = orig.path.clone();
        }
    }
    Ok(ServerChapterNumberReconciliationPlan {
        changes: planned,
        superseded_placeholders,
    })
}

fn verify_and_guard_renumber_metadata_files_at(
    root: &Path,
    raw_journal: &JsonValue,
    ctx: &mut TxContext,
) -> Result<(), String> {
    let version = raw_journal.get("version").and_then(JsonValue::as_i64);
    let metadata_files = raw_journal.get("metadataFiles");
    if (version == Some(1) && metadata_files.is_some() && !metadata_files.unwrap().is_null())
        || (version == Some(2)
            && !metadata_files
                .and_then(JsonValue::as_array)
                .is_some_and(|arr| arr.len() == 1))
    {
        return Err("Stored chapter reconciliation metadata backup is invalid.".to_string());
    }
    let Some(files) = metadata_files.and_then(JsonValue::as_array) else {
        return Ok(());
    };
    let max_cover_bytes: usize = 20 * 1024 * 1024;
    for file in files {
        let path = file
            .get("path")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| "Stored chapter reconciliation cover identity is invalid.".to_string())?;
        let next_sha256 = file
            .get("nextSha256")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| "Stored chapter reconciliation cover identity is invalid.".to_string())?;
        let body = file.get("body").and_then(JsonValue::as_str);
        let sha256 = file
            .get("sha256")
            .and_then(JsonValue::as_str)
            .map(ToString::to_string);
        if let Some(body_b64) = body {
            let decoded = decode_base64(body_b64)
                .map_err(|_| "Stored cover backup encoding is invalid.".to_string())?;
            if decoded.len() > max_cover_bytes || encode_base64(&decoded) != body_b64 {
                return Err("Stored cover backup encoding is invalid.".to_string());
            }
            if Some(sha256_hex_bytes(&decoded)) != sha256 {
                return Err(
                    "Stored cover backup does not match its digest. Existing files were retained."
                        .to_string(),
                );
            }
        } else if sha256.is_some() {
            return Err("Stored chapter reconciliation cover identity is invalid.".to_string());
        }
        let current_bytes = crate::chapter_media::read_work_metadata_bytes_at(root, path)?;
        if let Some(ref bytes) = current_bytes {
            if bytes.len() > max_cover_bytes {
                return Err(
                    "Current cover exceeds the recovery byte limit. Existing files were retained."
                        .to_string(),
                );
            }
        }
        let current_sha256 = current_bytes.as_deref().map(sha256_hex_bytes);
        if current_sha256 != sha256 {
            return Err(
                "The cover changed outside chapter reconciliation. Existing files and the recovery backup were retained."
                    .to_string(),
            );
        }
        ctx.guard_work_metadata_rollback(path.to_string(), sha256, next_sha256.to_string());
    }
    Ok(())
}

pub async fn inspect_install_target_at(
    pool: &SqlitePool,
    root: &Path,
    identity: &WorkMetadataIdentityDto,
    server_url: Option<&str>,
) -> Result<InspectInstallTargetDto, String> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|err| format!("db work metadata: acquire inspect connection: {err}"))?;
    let cached_dir: Option<String> = sqlx::query_scalar(
        "SELECT directory FROM work_metadata_file_cache WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&identity.plugin_id)
    .bind(&identity.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: inspect cached directory: {err}"))?;

    let directory = match cached_dir {
        Some(dir) => dir,
        None => available_novel_metadata_directory_at(root, identity)?,
    };

    let existing_meta = match read_novel_metadata_for_replacement_at(root, &directory, identity)? {
        Some((mut meta, _)) => {
            meta.cover = discover_stored_novel_cover_at(root, &directory, meta.cover.as_ref())?;
            Some(meta)
        }
        None => None,
    };

    let existing_cover_bytes = match existing_meta {
        Some(ref meta) => read_stored_novel_cover_at(root, &directory, meta)?,
        None => None,
    };
    let existing_digest = match existing_meta {
        Some(ref meta) => Some(compute_existing_install_digest(
            meta,
            existing_cover_bytes.as_deref(),
        )?),
        None => None,
    };
    let existing = existing_meta.map(|metadata| StoredNovelMetadataDto {
        directory: directory.clone(),
        metadata,
    });

    let sync_file =
        read_work_metadata_sync_file_in_tx(&mut conn, &identity.plugin_id, &identity.novel_path)
            .await?;

    let indexed_row = sqlx::query(
        "SELECT id, source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2",
    )
    .bind(&identity.plugin_id)
    .bind(&identity.novel_path)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db work metadata: inspect indexed novel: {err}"))?;

    let indexed_novel = indexed_row.map(|row| IndexedInstallNovelDto {
        id: row.get("id"),
        source_novel_id: row.get("source_novel_id"),
    });

    let source_held = match server_url {
        Some(url) if !url.trim().is_empty() => {
            super::content_sync::is_novel_migration_source_held_in_conn(
                &mut conn,
                url,
                &identity.plugin_id,
                &identity.novel_path,
                &identity.novel_id,
            )
            .await?
        }
        _ => false,
    };

    Ok(InspectInstallTargetDto {
        directory,
        existing,
        existing_cover_bytes,
        existing_digest,
        sync_file,
        indexed_novel,
        source_held,
    })
}

#[tauri::command]
pub async fn db_work_metadata_inspect_install(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    identity: WorkMetadataIdentityDto,
    server_url: Option<String>,
) -> Result<InspectInstallTargetDto, String> {
    let root = crate::chapter_media::media_root(&app)?;
    inspect_install_target_at(databases.writer(), &root, &identity, server_url.as_deref()).await
}

#[tauri::command]
pub async fn db_work_metadata_reindex_preserved_work(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    input: ReindexPreservedWorkInputDto,
) -> Result<DbMutationEnvelope<i64>, String> {
    let root = crate::chapter_media::media_root(&app)?;
    let metadata = parse_novel_metadata_input(&input.metadata)?;
    let directory = input.directory;
    with_write_tx(
        databases.writer(),
        TxOptions {
            remote_content_sync: true,
            metadata_root: MetadataRoot::Path(root.clone()),
            ..TxOptions::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                let novel_id = apply_novel_metadata_to_cache_in_tx(
                    Some(&root),
                    &mut *conn,
                    ctx,
                    &metadata,
                    Some(&directory),
                    ApplyNovelMetadataOptions::default(),
                )
                .await?;
                super::novel_override::adopt_stored_novel_override_in_tx(
                    &root,
                    &mut *conn,
                    ctx,
                    novel_id,
                    &directory,
                )
                .await?;
                scan_stored_novel_chapters_to_cache_in_tx(
                    Some(&root),
                    &mut *conn,
                    ctx,
                    novel_id,
                    &directory,
                    None,
                )
                .await?;
                remember_stored_novel_metadata_in_tx(
                    &mut *conn,
                    ctx,
                    &directory,
                    &metadata,
                    false,
                )
                .await?;
                sqlx::query("DELETE FROM work_metadata_dirty WHERE plugin_id = ?1 AND path = ?2")
                    .bind(&metadata.identity.plugin_id)
                    .bind(&metadata.identity.novel_path)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: clear reindexed dirty: {err}"))?;
                Ok(novel_id)
            })
        },
    )
    .await
}

pub async fn install_stored_novel_metadata_at(
    pool: &SqlitePool,
    root: PathBuf,
    input: InstallStoredNovelMetadataInputDto,
) -> Result<DbMutationEnvelope<Option<InstalledNovelMetadataDto>>, String> {
    let mut metadata = parse_novel_metadata_input(&input.metadata)?;
    if input.authoritative
        && !input.preserve_local_cover
        && metadata.cover.is_some()
        && input.cover_bytes.as_ref().is_none_or(Vec::is_empty)
    {
        return Err("A migration target cover requires verified cover bytes.".to_string());
    }

    with_write_tx(
        pool,
        TxOptions {
            remote_content_sync: true,
            metadata_root: MetadataRoot::Path(root.clone()),
            ..TxOptions::default()
        },
        move |conn, ctx| {
            Box::pin(async move {
                if let Some(ref server_url) = input.guard_server_url {
                    if super::content_sync::is_novel_migration_source_held_in_conn(
                        &mut *conn,
                        server_url,
                        &metadata.identity.plugin_id,
                        &metadata.identity.novel_path,
                        &metadata.identity.novel_id,
                    )
                    .await?
                    {
                        if input.error_on_source_held {
                            return Err("CONTENT_SERVER_410".to_string());
                        }
                        return Ok(None);
                    }
                }

                if input.expected_novel.is_some() || input.require_new_work_absent {
                    let indexed = sqlx::query(
                        "SELECT id, source_novel_id FROM novel WHERE plugin_id = ?1 AND path = ?2",
                    )
                    .bind(&metadata.identity.plugin_id)
                    .bind(&metadata.identity.novel_path)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: check indexed novel: {err}"))?;

                    if let Some(ref expected) = input.expected_novel {
                        let matches = indexed.as_ref().is_some_and(|row| {
                            let id: i64 = row.get("id");
                            let src_id: Option<String> = row.get("source_novel_id");
                            id == expected.id
                                && src_id.as_deref() == Some(expected.novel_id.as_str())
                        });
                        if !matches {
                            return Err(
                                "The local migration target changed while refreshing its metadata."
                                    .to_string(),
                            );
                        }
                    } else if input.require_new_work_absent {
                        if let Some(row) = indexed {
                            let src_id: Option<String> = row.get("source_novel_id");
                            if let Some(actual_src) = src_id {
                                if actual_src != metadata.identity.novel_id {
                                    return Err(
                                        "Local work identity does not match the server metadata."
                                            .to_string(),
                                    );
                                }
                            }
                            return Ok(None);
                        }
                    }
                }

                let cached_dir: Option<String> = sqlx::query_scalar(
                    "SELECT directory FROM work_metadata_file_cache \
                     WHERE plugin_id = ?1 AND path = ?2",
                )
                .bind(&metadata.identity.plugin_id)
                .bind(&metadata.identity.novel_path)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: check install directory: {err}"))?;

                let directory = match cached_dir {
                    Some(dir) => dir,
                    None => available_novel_metadata_directory_at(&root, &metadata.identity)?,
                };

                let mut existing = match read_novel_metadata_for_replacement_at(
                    &root,
                    &directory,
                    &metadata.identity,
                )? {
                    Some((mut existing_meta, _)) => {
                        existing_meta.cover = discover_stored_novel_cover_at(
                            &root,
                            &directory,
                            existing_meta.cover.as_ref(),
                        )?;
                        Some(existing_meta)
                    }
                    None => None,
                };

                if let Some(ref expected_digest) = input.expected_existing_digest {
                    let current_cover = match existing {
                        Some(ref meta) => read_stored_novel_cover_at(&root, &directory, meta)?,
                        None => None,
                    };
                    let current_digest = match existing {
                        Some(ref meta) => Some(compute_existing_install_digest(
                            meta,
                            current_cover.as_deref(),
                        )?),
                        None => None,
                    };
                    if &current_digest != expected_digest {
                        return Ok(None);
                    }
                }

                if let Some(ref expected_version) = input.expected_sync_file_version {
                    let current_file = read_work_metadata_sync_file_in_tx(
                        &mut *conn,
                        &metadata.identity.plugin_id,
                        &metadata.identity.novel_path,
                    )
                    .await?;
                    let current_version = current_file
                        .map(|f| format!("{}:{}", f.directory, f.fingerprint));
                    if &current_version != expected_version {
                        return Ok(None);
                    }
                }

                if let Some(ref rec) = input.reconciliation {
                    assert_chapter_number_mappings(&rec.mappings)?;
                    let work_row = sqlx::query(
                        "SELECT id, plugin_id, source_novel_id, path \
                         FROM novel WHERE plugin_id = ?1 AND path = ?2",
                    )
                    .bind(&metadata.identity.plugin_id)
                    .bind(&metadata.identity.novel_path)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: read renumber work: {err}"))?;
                    let Some(work_row) = work_row else {
                        return Err("Incoming chapter number identity changed.".to_string());
                    };
                    let work_source_id: Option<String> = work_row.get("source_novel_id");
                    if work_source_id.as_deref() != Some(metadata.identity.novel_id.as_str()) {
                        return Err("Incoming chapter number identity changed.".to_string());
                    }
                    let work = super::chapter::RenumberWorkDto {
                        id: work_row.get("id"),
                        plugin_id: work_row.get("plugin_id"),
                        source_novel_id: work_source_id.unwrap_or_default(),
                        path: work_row.get("path"),
                    };
                    let current_chapters =
                        super::chapter::read_renumber_chapters_in_conn(&mut *conn, work.id).await?;
                    let plan = plan_server_chapter_number_reconciliation(
                        &work,
                        &current_chapters,
                        &rec.mappings,
                    )?;
                    for placeholder in &plan.superseded_placeholders {
                        let source_relative_dir =
                            super::chapter::chapter_storage_relative_dir_for_work(
                                &work.plugin_id,
                                &work.source_novel_id,
                                Some(&placeholder.chapter_number),
                                placeholder.position,
                            )?;
                        assert_superseded_placeholder_storage_empty(&root, &source_relative_dir)?;
                    }
                    if let Some(ref raw_journal) = rec.journal {
                        let journal_changes: Vec<super::chapter::SourceChapterNumberChangeDto> =
                            serde_json::from_value(
                                raw_journal
                                    .get("changes")
                                    .cloned()
                                    .unwrap_or(JsonValue::Null),
                            )
                            .map_err(|_| {
                                "Stored chapter number reconciliation is invalid.".to_string()
                            })?;
                        if plan.changes != journal_changes {
                            return Err(
                                "Local chapter state changed while the server correction was prepared."
                                    .to_string(),
                            );
                        }
                        verify_and_guard_renumber_metadata_files_at(&root, raw_journal, ctx)?;
                    } else if !plan.changes.is_empty() {
                        return Err(
                            "Incoming chapter numbers changed before their storage could be prepared."
                                .to_string(),
                        );
                    }

                    if !plan.superseded_placeholders.is_empty() {
                        let mut removed_cached_dir = false;
                        for placeholder in &plan.superseded_placeholders {
                            let deleted = sqlx::query(
                                "DELETE FROM chapter WHERE id = ?1 AND novel_id = ?2",
                            )
                            .bind(placeholder.id)
                            .bind(work.id)
                            .execute(&mut *conn)
                            .await
                            .map_err(|err| {
                                format!(
                                    "db work metadata: delete superseded placeholder chapter: {err}"
                                )
                            })?;
                            if deleted.rows_affected() != 1 {
                                return Err(
                                    "Local chapter state changed while the server correction was prepared."
                                        .to_string(),
                                );
                            }
                            sqlx::query(
                                "DELETE FROM work_metadata_directory_cache WHERE chapter_id = ?1",
                            )
                            .bind(placeholder.id)
                            .execute(&mut *conn)
                            .await
                            .map_err(|err| {
                                format!(
                                    "db work metadata: delete superseded placeholder directory: {err}"
                                )
                            })?;
                            // The BEFORE DELETE trigger records a zero-state row in
                            // work_metadata_reading_state; remove that dead placeholder entry.
                            sqlx::query(
                                "DELETE FROM work_metadata_reading_state \
                                 WHERE plugin_id = ?1 AND novel_path = ?2 AND chapter_path = ?3 \
                                   AND progress = 0 AND bookmark = 0 AND read_at IS NULL",
                            )
                            .bind(&work.plugin_id)
                            .bind(&work.path)
                            .bind(&placeholder.path)
                            .execute(&mut *conn)
                            .await
                            .map_err(|err| {
                                format!(
                                    "db work metadata: clean superseded placeholder reading state: {err}"
                                )
                            })?;
                            if placeholder.has_cached_directory {
                                removed_cached_dir = true;
                                ctx.record_chapter_directory(ChapterDirectoryUpdateDto {
                                    chapter_id: placeholder.id,
                                    directory: None,
                                });
                            }
                        }
                        if removed_cached_dir {
                            ctx.mark_native_directories_dirty(&root);
                        }
                    }

                    if let Some(ref raw_journal) = rec.journal {
                        super::chapter::apply_source_chapter_number_changes_in_tx(
                            Some(&root),
                            &mut *conn,
                            ctx,
                            work.id,
                            raw_journal,
                        )
                        .await?;
                    }

                    for mapping in &rec.mappings {
                        if metadata.chapters.0.iter().any(|(k, _)| k == &mapping.from) {
                            return Err(
                                "Incoming catalog still contains a replaced chapter number."
                                    .to_string(),
                            );
                        }
                        if let Some(ref mut prev) = existing {
                            prev.chapters.0.retain(|(k, _)| k != &mapping.from);
                        }
                    }

                    let anchors: Vec<super::novel::ImportedChapterIdentityDto> = rec
                        .mappings
                        .iter()
                        .map(|m| super::novel::ImportedChapterIdentityDto {
                            path: m.chapter_path.clone(),
                            chapter_number: Some(m.to.clone()),
                        })
                        .collect();
                    super::novel::reconcile_imported_novel_identity_in_tx(
                        &mut *conn,
                        &metadata.identity.plugin_id,
                        &metadata.identity.novel_path,
                        &anchors,
                    )
                    .await?;
                }

                let merged = merge_incoming_novel_metadata(existing.as_ref(), &metadata)?;
                if input.authoritative {
                    metadata = NovelMetadataV1Dto {
                        novel: metadata.novel.clone(),
                        cover: metadata.cover.clone(),
                        ..merged
                    };
                } else {
                    metadata = merged;
                }

                if input.authoritative && !input.preserve_local_cover {
                    remove_all_stored_covers_in_tx(
                        &root,
                        ctx,
                        &directory,
                        existing.as_ref().and_then(|e| e.cover.as_ref()),
                    )?;
                }

                if let Some(ref bytes) = input.cover_bytes {
                    write_stored_novel_cover_in_tx(
                        &root,
                        ctx,
                        &directory,
                        &metadata,
                        bytes,
                        false,
                    )?;
                } else if !input.authoritative || input.preserve_local_cover {
                    metadata.cover = existing.and_then(|e| e.cover);
                }

                let installed_novel_id = apply_novel_metadata_to_cache_in_tx(
                    Some(&root),
                    &mut *conn,
                    ctx,
                    &metadata,
                    Some(&directory),
                    ApplyNovelMetadataOptions {
                        preserve_missing_metadata: !input.authoritative,
                        ..ApplyNovelMetadataOptions::default()
                    },
                )
                .await?;

                if input.authoritative && !input.preserve_local_cover && !metadata.novel.is_local {
                    sqlx::query("UPDATE novel SET cover = NULL WHERE id = ?1")
                        .bind(installed_novel_id)
                        .execute(&mut *conn)
                        .await
                        .map_err(|err| format!("db work metadata: clear migration cover: {err}"))?;
                }

                let cached_novel = sqlx::query(
                    "SELECT author, artist, summary, status, genres, rating FROM novel WHERE id = ?1",
                )
                .bind(installed_novel_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|err| format!("db work metadata: read installed novel fields: {err}"))?
                .ok_or_else(|| "Installed work metadata is missing from the local cache.".to_string())?;

                metadata.novel.author = cached_novel.get("author");
                metadata.novel.artist = cached_novel.get("artist");
                metadata.novel.summary = cached_novel.get("summary");
                metadata.novel.status = cached_novel.get("status");
                metadata.novel.genres = cached_novel.get("genres");
                metadata.novel.rating = cached_novel.get("rating");

                write_stored_novel_metadata_in_tx(&root, ctx, &directory, &metadata, false)?;
                sqlx::query("DELETE FROM work_metadata_dirty WHERE plugin_id = ?1 AND path = ?2")
                    .bind(&metadata.identity.plugin_id)
                    .bind(&metadata.identity.novel_path)
                    .execute(&mut *conn)
                    .await
                    .map_err(|err| format!("db work metadata: clear installed dirty: {err}"))?;
                remember_stored_novel_metadata_in_tx(
                    &mut *conn,
                    ctx,
                    &directory,
                    &metadata,
                    true,
                )
                .await?;

                let sync_file = read_work_metadata_sync_file_in_tx(
                    &mut *conn,
                    &metadata.identity.plugin_id,
                    &metadata.identity.novel_path,
                )
                .await?
                .ok_or_else(|| "Installed work metadata is missing from the local index.".to_string())?;

                if let Some(ref rec) = input.reconciliation {
                    if let Some(ref raw_journal) = rec.journal {
                        super::chapter::commit_source_chapter_renumber_in_tx(
                            &mut *conn,
                            raw_journal,
                        )
                        .await?;
                    }
                }

                let cover_bytes = read_stored_novel_cover_at(&root, &directory, &metadata)?;
                ctx.record_cover_changed(installed_novel_id);

                Ok(Some(InstalledNovelMetadataDto {
                    novel_id: installed_novel_id,
                    directory,
                    metadata,
                    sync_file,
                    cover_bytes,
                }))
            })
        },
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_install_stored(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    input: InstallStoredNovelMetadataInputDto,
) -> Result<DbMutationEnvelope<Option<InstalledNovelMetadataDto>>, String> {
    let root = crate::chapter_media::media_root(&app)?;
    install_stored_novel_metadata_at(databases.writer(), root, input).await
}

fn merge_effects(target: &mut DbMutationEffects, next: DbMutationEffects) {
    if let Some(priority) = next.user_state_priority {
        target.user_state_priority = Some(match target.user_state_priority {
            Some(existing) => existing.merge(priority),
            None => priority,
        });
    }
    target.user_state_ledger_changed |= next.user_state_ledger_changed;
    target.user_state_deferred_ready |= next.user_state_deferred_ready;
    for novel_id in next.user_state_deferred_novel_ids {
        if !target.user_state_deferred_novel_ids.contains(&novel_id) {
            target.user_state_deferred_novel_ids.push(novel_id);
        }
    }
    if let Some(seq) = next.content_sync_max_sequence {
        target.content_sync_max_sequence = Some(
            target
                .content_sync_max_sequence
                .map_or(seq, |prev| prev.max(seq)),
        );
    }
    target.work_metadata_changed |= next.work_metadata_changed;
    for novel_id in next.cover_changed_novel_ids {
        if !target.cover_changed_novel_ids.contains(&novel_id) {
            target.cover_changed_novel_ids.push(novel_id);
        }
    }
    target.work_directories.extend(next.work_directories);
    target.chapter_directories.extend(next.chapter_directories);
}

pub async fn recover_work_metadata_at<F>(
    pool: &SqlitePool,
    root: Option<PathBuf>,
    rebuild: bool,
    recovery_state: &WorkMetadataRecoveryState,
    token: u64,
    mut on_event: F,
) -> Result<DbMutationEnvelope<WorkMetadataRecoveryProgressDto>, String>
where
    F: FnMut(WorkMetadataRecoveryEventDto),
{
    let mut combined_effects = DbMutationEffects::default();

    let initialized: Option<i64> =
        sqlx::query_scalar("SELECT id FROM work_metadata_cache_state WHERE id = 1")
            .fetch_optional(pool)
            .await
            .map_err(|err| format!("db work metadata: check cache state: {err}"))?;
    let pending: Option<i64> = sqlx::query_scalar("SELECT 1 FROM work_metadata_dirty LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|err| format!("db work metadata: check dirty state: {err}"))?;
    recovery_state.ensure_active(token)?;

    if initialized.is_some() && !rebuild {
        let restored =
            read_restored_directories_from_pool(pool, root.as_deref(), true).await?;
        for file in restored.files {
            combined_effects.work_directories.push(WorkDirectoryUpdateDto {
                novel_id: file.novel_id,
                plugin_id: file.plugin_id,
                novel_path: file.path,
                directory: Some(file.directory),
                fingerprint: Some(file.fingerprint),
            });
        }
        for chapter in restored.chapters {
            combined_effects
                .chapter_directories
                .push(ChapterDirectoryUpdateDto {
                    chapter_id: chapter.id,
                    directory: Some(chapter.directory),
                });
        }
        if pending.is_some() {
            recovery_state.ensure_active(token)?;
            let metadata_root = match root {
                Some(ref r) => MetadataRoot::Path(r.clone()),
                None => MetadataRoot::None,
            };
            let flush = with_write_tx(
                pool,
                TxOptions {
                    notify_content_sync: false,
                    metadata_root,
                    ..TxOptions::default()
                },
                |_, _| Box::pin(async move { Ok(()) }),
            )
            .await?;
            recovery_state.ensure_active(token)?;
            merge_effects(&mut combined_effects, flush.effects);
        }
        return Ok(DbMutationEnvelope {
            value: WorkMetadataRecoveryProgressDto {
                total_works: 0,
                completed_works: 0,
                recovered_works: 0,
                recovered_chapters: 0,
                skipped_works: 0,
                current_work: None,
            },
            effects: combined_effects,
        });
    }

    let mut progress = WorkMetadataRecoveryProgressDto {
        total_works: 0,
        completed_works: 0,
        recovered_works: 0,
        recovered_chapters: 0,
        skipped_works: 0,
        current_work: None,
    };
    on_event(WorkMetadataRecoveryEventDto {
        progress: progress.clone(),
        effects: None,
    });

    let baseline_restored =
        read_restored_directories_from_pool(pool, None, false).await?;
    let baselines: HashMap<(String, String), (String, String)> = baseline_restored
        .files
        .iter()
        .map(|f| {
            (
                (f.plugin_id.clone(), f.path.clone()),
                (f.directory.clone(), f.fingerprint.clone()),
            )
        })
        .collect();

    recovery_state.ensure_active(token)?;
    sqlx::query("DELETE FROM work_metadata_cache_state")
        .execute(pool)
        .await
        .map_err(|err| format!("db work metadata: reset cache state: {err}"))?;
    if initialized.is_none() {
        sqlx::query(
            "DELETE FROM work_metadata_dirty WHERE NOT EXISTS ( \
               SELECT 1 FROM work_metadata_file_cache f \
               WHERE f.plugin_id = work_metadata_dirty.plugin_id \
                 AND f.path = work_metadata_dirty.path \
             )",
        )
        .execute(pool)
        .await
        .map_err(|err| format!("db work metadata: prune uncached dirty rows: {err}"))?;
    }
    sqlx::query(
        "DELETE FROM work_metadata_directory_cache WHERE chapter_id NOT IN (SELECT id FROM chapter)",
    )
    .execute(pool)
    .await
    .map_err(|err| format!("db work metadata: prune orphan directory cache: {err}"))?;

    if let Some(ref root_path) = root {
        crate::chapter_media::register_work_chapter_directories_at(root_path, &[], true)?;
    }

    let candidate_paths = match root {
        Some(ref root_path) => {
            let root_clone = root_path.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::chapter_media::list_work_metadata_files_at(&root_clone)
            })
            .await
            .map_err(|err| format!("work metadata: list files task: {err}"))??
        }
        None => Vec::new(),
    };
    recovery_state.ensure_active(token)?;
    progress.total_works = candidate_paths.len();
    on_event(WorkMetadataRecoveryEventDto {
        progress: progress.clone(),
        effects: None,
    });

    let mut seen_identities = HashSet::<(String, String)>::new();
    if let Some(ref root_path) = root {
        for candidate_path in candidate_paths {
            recovery_state.ensure_active(token)?;
            let root_for_read = root_path.clone();
            let rel_for_read = candidate_path.clone();
            let raw_bytes = tauri::async_runtime::spawn_blocking(move || {
                crate::chapter_media::read_work_metadata_bytes_at(&root_for_read, &rel_for_read)
            })
            .await
            .map_err(|err| format!("work metadata: read metadata task: {err}"))??;
            recovery_state.ensure_active(token)?;

            let Some(bytes) = raw_bytes else {
                progress.completed_works += 1;
                progress.skipped_works += 1;
                on_event(WorkMetadataRecoveryEventDto {
                    progress: progress.clone(),
                    effects: None,
                });
                continue;
            };

            let parsed = parse_novel_metadata_bytes(&bytes).map(|(meta, _)| meta);
            let mut entry_metadata = match parsed {
                Ok(meta) => meta,
                Err(_) => {
                    log::warn!("[work-metadata] skipped invalid metadata {candidate_path}");
                    progress.completed_works += 1;
                    progress.skipped_works += 1;
                    on_event(WorkMetadataRecoveryEventDto {
                        progress: progress.clone(),
                        effects: None,
                    });
                    continue;
                }
            };

            let entry_directory = candidate_path
                .strip_suffix("/novel.json")
                .unwrap_or(&candidate_path)
                .to_string();
            let expected_dir = format!(
                "contents/{}/{}",
                entry_metadata.identity.plugin_id, entry_metadata.identity.novel_id
            );
            if entry_directory != expected_dir {
                progress.completed_works += 1;
                progress.skipped_works += 1;
                on_event(WorkMetadataRecoveryEventDto {
                    progress: progress.clone(),
                    effects: None,
                });
                continue;
            }
            let identity_key = (
                entry_metadata.identity.plugin_id.clone(),
                entry_metadata.identity.novel_path.clone(),
            );
            if !seen_identities.insert(identity_key.clone()) {
                return Err(format!("work metadata: duplicate work {candidate_path}"));
            }

            let root_for_cover = root_path.clone();
            let dir_for_cover = entry_directory.clone();
            let pref_cover = entry_metadata.cover.clone();
            entry_metadata.cover = tauri::async_runtime::spawn_blocking(move || {
                discover_stored_novel_cover_at(&root_for_cover, &dir_for_cover, pref_cover.as_ref())
            })
            .await
            .map_err(|err| format!("work metadata: discover cover task: {err}"))??;
            recovery_state.ensure_active(token)?;

            progress.current_work = Some(entry_metadata.novel.name.clone());
            on_event(WorkMetadataRecoveryEventDto {
                progress: progress.clone(),
                effects: None,
            });

            let root_for_chapters = root_path.clone();
            let dir_for_chapters = entry_directory.clone();
            let chapters = tauri::async_runtime::spawn_blocking(move || {
                list_stored_novel_chapters_at(&root_for_chapters, &dir_for_chapters)
            })
            .await
            .map_err(|err| format!("work metadata: chapter scan task: {err}"))??;
            recovery_state.ensure_active(token)?;

            let previous_known = baselines.get(&identity_key).cloned();
            let root_tx = root_path.clone();
            let dir_tx = entry_directory.clone();
            let meta_tx = entry_metadata.clone();
            let chapters_count = chapters.len();

            let tx_envelope = with_write_tx(
                pool,
                TxOptions {
                    publish_metadata: false,
                    notify_content_sync: false,
                    metadata_root: MetadataRoot::None,
                    ..TxOptions::default()
                },
                move |conn, ctx| {
                    Box::pin(async move {
                        let current_known: Option<(String, String)> = sqlx::query_as(
                            "SELECT directory, fingerprint FROM work_metadata_file_cache \
                             WHERE plugin_id = ?1 AND path = ?2",
                        )
                        .bind(&meta_tx.identity.plugin_id)
                        .bind(&meta_tx.identity.novel_path)
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(|err| format!("db work metadata: check current file cache: {err}"))?;

                        let metadata_changed = current_known != previous_known;
                        if metadata_changed
                            && current_known
                                .as_ref()
                                .is_none_or(|(curr_dir, _)| curr_dir != &dir_tx)
                        {
                            return Ok(None);
                        }

                        let mut metadata = meta_tx;
                        if !metadata_changed {
                            let Some(latest) = read_stored_novel_metadata_at(&root_tx, &dir_tx)?
                            else {
                                return Ok(None);
                            };
                            if latest.metadata.identity != metadata.identity {
                                return Err(
                                    "work metadata: recovery identity changed during inspection"
                                        .to_string(),
                                );
                            }
                            metadata = latest.metadata;
                        }

                        let file_conflict = !metadata_changed
                            && has_work_metadata_conflict_in_tx(&mut *conn, &dir_tx, &metadata)
                                .await?;
                        let preserve_cached = metadata_changed || file_conflict;
                        let cover_bytes = if !preserve_cached && metadata.novel.is_local {
                            read_stored_novel_cover_at(&root_tx, &dir_tx, &metadata)?
                        } else {
                            None
                        };

                        let pending_work: Option<i64> = sqlx::query_scalar(
                            "SELECT 1 FROM work_metadata_dirty WHERE plugin_id = ?1 AND path = ?2",
                        )
                        .bind(&metadata.identity.plugin_id)
                        .bind(&metadata.identity.novel_path)
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(|err| format!("db work metadata: check pending work: {err}"))?;

                        let existing_id: Option<i64> = if preserve_cached || pending_work.is_some()
                        {
                            sqlx::query_scalar(
                                "SELECT id FROM novel WHERE plugin_id = ?1 AND path = ?2",
                            )
                            .bind(&metadata.identity.plugin_id)
                            .bind(&metadata.identity.novel_path)
                            .fetch_optional(&mut *conn)
                            .await
                            .map_err(|err| {
                                format!("db work metadata: check existing novel: {err}")
                            })?
                        } else {
                            None
                        };
                        if (preserve_cached || pending_work.is_some()) && existing_id.is_none() {
                            return Ok(None);
                        }

                        let novel_id = if preserve_cached {
                            existing_id.unwrap()
                        } else {
                            apply_novel_metadata_to_cache_in_tx(
                                Some(&root_tx),
                                &mut *conn,
                                ctx,
                                &metadata,
                                Some(&dir_tx),
                                ApplyNovelMetadataOptions {
                                    stored_cover: Some(cover_bytes),
                                    add_to_library: true,
                                    preserve_missing_metadata: true,
                                    preserve_cached_novel: pending_work.is_some(),
                                },
                            )
                            .await?
                        };
                        super::novel_override::adopt_stored_novel_override_in_tx(
                            &root_tx,
                            &mut *conn,
                            ctx,
                            novel_id,
                            &dir_tx,
                        )
                        .await?;

                        let snapshot = ChapterScanSnapshot {
                            chapters,
                            skipped_chapter_ids: HashSet::new(),
                            defer_native_registration: true,
                        };
                        scan_stored_novel_chapters_to_cache_in_tx(
                            Some(&root_tx),
                            &mut *conn,
                            ctx,
                            novel_id,
                            &dir_tx,
                            Some(&snapshot),
                        )
                        .await?;

                        if !preserve_cached && pending_work.is_none() {
                            remember_stored_novel_metadata_in_tx(
                                &mut *conn,
                                ctx,
                                &dir_tx,
                                &metadata,
                                rebuild,
                            )
                            .await?;
                        }
                        if pending_work.is_none() {
                            sqlx::query(
                                "DELETE FROM work_metadata_dirty WHERE plugin_id = ?1 AND path = ?2",
                            )
                            .bind(&metadata.identity.plugin_id)
                            .bind(&metadata.identity.novel_path)
                            .execute(&mut *conn)
                            .await
                            .map_err(|err| {
                                format!("db work metadata: clear recovered dirty: {err}")
                            })?;
                        }

                        let mapped: Vec<(i64, String)> = sqlx::query_as(
                            "SELECT chapter_id, directory FROM work_metadata_directory_cache WHERE novel_id = ?1",
                        )
                        .bind(novel_id)
                        .fetch_all(&mut *conn)
                        .await
                        .map_err(|err| format!("db work metadata: load recovered directories: {err}"))?;

                        let cover_dir_changed = current_known
                            .as_ref()
                            .map(|(d, _)| d.as_str())
                            != Some(dir_tx.as_str());
                        if cover_dir_changed {
                            ctx.record_cover_changed(novel_id);
                        }
                        Ok(Some(mapped))
                    })
                },
            )
            .await?;

            if let Some(mapped_dirs) = tx_envelope.value {
                for batch in mapped_dirs.chunks(1000) {
                    recovery_state.ensure_active(token)?;
                    crate::chapter_media::register_work_chapter_directories_at(
                        root_path,
                        batch,
                        false,
                    )?;
                }
                progress.recovered_works += 1;
                progress.recovered_chapters += chapters_count;
            }
            let step_effects = tx_envelope.effects.clone();
            merge_effects(&mut combined_effects, tx_envelope.effects);

            recovery_state.ensure_active(token)?;
            progress.completed_works += 1;
            on_event(WorkMetadataRecoveryEventDto {
                progress: progress.clone(),
                effects: Some(step_effects),
            });
            tokio::task::yield_now().await;
        }
    }

    recovery_state.ensure_active(token)?;
    sqlx::query("INSERT OR IGNORE INTO work_metadata_cache_state(id) VALUES (1)")
        .execute(pool)
        .await
        .map_err(|err| format!("db work metadata: finalize cache state: {err}"))?;

    progress.current_work = None;
    on_event(WorkMetadataRecoveryEventDto {
        progress: progress.clone(),
        effects: None,
    });

    Ok(DbMutationEnvelope {
        value: progress,
        effects: combined_effects,
    })
}

#[tauri::command]
pub async fn db_startup_recover_work_metadata(
    app: AppHandle,
    databases: State<'_, AppDatabase>,
    recovery_state: State<'_, WorkMetadataRecoveryState>,
    rebuild: Option<bool>,
) -> Result<DbMutationEnvelope<WorkMetadataRecoveryProgressDto>, String> {
    let token = recovery_state.start_generation();
    let root = optional_media_root(&app)?;
    let app_for_events = app.clone();
    recover_work_metadata_at(
        databases.writer(),
        root,
        rebuild.unwrap_or(false),
        &recovery_state,
        token,
        move |event| {
            let _ = app_for_events.emit(STORAGE_RECOVERY_PROGRESS_EVENT, event);
        },
    )
    .await
}

#[tauri::command]
pub async fn db_work_metadata_cancel_recovery(
    recovery_state: State<'_, WorkMetadataRecoveryState>,
) -> Result<(), String> {
    recovery_state.cancel();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::open_test_db;
    use std::fs;

    #[test]
    fn fingerprint_matches_ecmascript_key_order_and_rating_serialization() {
        let mut chapters = ChaptersMap::new();
        chapters.insert("10".to_string(), "Tenth".to_string());
        chapters.insert("1.5".to_string(), "Interlude".to_string());
        chapters.insert("2".to_string(), "Second".to_string());
        chapters.insert("0.5".to_string(), "Prologue".to_string());
        chapters.insert("1".to_string(), "First".to_string());

        let metadata = NovelMetadataV1Dto {
            schema_version: 1,
            identity: WorkMetadataIdentityDto {
                plugin_id: "source".to_string(),
                novel_id: "book".to_string(),
                novel_path: "/book".to_string(),
            },
            novel: WorkMetadataNovelDto {
                name: "Disk title".to_string(),
                author: Some("Writer".to_string()),
                artist: None,
                summary: None,
                status: None,
                genres: None,
                rating: Some(4.0),
                is_local: false,
            },
            cover: Some(WorkMetadataCoverDto {
                file_name: "cover.jpg".to_string(),
                content_type: Some("image/jpeg".to_string()),
            }),
            chapters,
            chapter_composition: None,
        };

        let normalized = normalize_novel_metadata(&metadata).unwrap();
        let serialized = serde_json::to_string(&normalized).unwrap();
        let expected_json = concat!(
            r#"{"schemaVersion":1,"#,
            r#""identity":{"pluginId":"source","novelId":"book","novelPath":"/book"},"#,
            r#""novel":{"name":"Disk title","author":"Writer","artist":null,"summary":null,"status":null,"genres":null,"rating":4,"isLocal":false},"#,
            r#""cover":{"fileName":"cover.jpg","contentType":"image/jpeg"},"#,
            r#""chapters":{"1":"First","2":"Second","10":"Tenth","1.5":"Interlude","0.5":"Prologue"}}"#,
        );
        assert_eq!(serialized, expected_json);

        let expected_hash = Sha256::digest(expected_json.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        assert_eq!(
            stored_novel_metadata_fingerprint(&metadata).unwrap(),
            expected_hash
        );
    }

    #[tokio::test]
    async fn dirty_metadata_flushes_in_tx_and_rolls_back_files_on_failure() {
        let test_db = open_test_db().await;
        let root = test_db.dir.path().join("media");
        fs::create_dir_all(&root).unwrap();

        let root_for_insert = root.clone();
        let envelope = with_write_tx(
            test_db.db.writer(),
            TxOptions {
                metadata_root: MetadataRoot::Path(root_for_insert),
                ..TxOptions::default()
            },
            |conn, _ctx| {
                Box::pin(async move {
                    sqlx::query(
                        "INSERT INTO novel (id, plugin_id, source_novel_id, path, name, author, in_library) \
                         VALUES (1, 'source', 'book', '/book', 'Original Title', 'Author A', 1)",
                    )
                    .execute(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
                    sqlx::query(
                        "INSERT INTO chapter (id, novel_id, path, name, chapter_number, position) \
                         VALUES (10, 1, '/ch/1', 'Opening', '1', 1)",
                    )
                    .execute(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
                    Ok(())
                })
            },
        )
        .await
        .expect("initial flush succeeds");

        let novel_json_path = root.join("contents/source/book/novel.json");
        assert!(novel_json_path.is_file());
        let initial_bytes = fs::read(&novel_json_path).unwrap();
        assert!(envelope.effects.work_metadata_changed);
        assert_eq!(envelope.effects.work_directories.len(), 1);
        assert_eq!(
            envelope.effects.work_directories[0].directory.as_deref(),
            Some("contents/source/book")
        );
        assert!(envelope.effects.work_directories[0].fingerprint.is_some());

        // Now mutate novel + write novel.json via write_stored_novel_metadata_in_tx, then fail before commit!
        let root_for_fail = root.clone();
        let err = with_write_tx(
            test_db.db.writer(),
            TxOptions {
                metadata_root: MetadataRoot::Path(root_for_fail.clone()),
                ..TxOptions::default()
            },
            move |conn, ctx| {
                Box::pin(async move {
                    sqlx::query("UPDATE novel SET name = 'Broken Title' WHERE id = 1")
                        .execute(&mut *conn)
                        .await
                        .map_err(|e| e.to_string())?;
                    let meta_root = MetadataRoot::Path(root_for_fail);
                    flush_dirty_in_tx(&meta_root, &mut *conn, ctx, None).await?;
                    Err::<(), String>("abort after metadata write".to_string())
                })
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "abort after metadata write");

        // Verify both SQLite AND novel.json on disk were rolled back!
        let db_title: String = sqlx::query_scalar("SELECT name FROM novel WHERE id = 1")
            .fetch_one(test_db.db.writer())
            .await
            .unwrap();
        assert_eq!(db_title, "Original Title");
        assert_eq!(fs::read(&novel_json_path).unwrap(), initial_bytes);

        // Verify external file modification triggers conflict detection!
        let tampered = serde_json::json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
            "novel": { "name": "Tampered Outside", "isLocal": false },
            "cover": null,
            "chapters": { "1": "Opening" }
        });
        crate::chapter_media::write_work_metadata_bytes_at(
            &root,
            "contents/source/book/novel.json",
            &serde_json::to_vec_pretty(&tampered).unwrap(),
        )
        .unwrap();

        let conflict_err = persist_novel_cover_at(
            test_db.db.writer(),
            root.clone(),
            "contents/source/book".to_string(),
            Some(PersistNovelCoverInputDto {
                body: vec![1, 2, 3, 4],
                file_name: "cover.jpg".to_string(),
                content_type: Some("image/jpeg".to_string()),
            }),
            false,
        )
        .await
        .unwrap_err();
        assert!(conflict_err.contains("changed outside the cache"));

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn recovery_restores_disk_works_and_skipped_chapters_preserve_concurrent_downloads() {
        let test_db = open_test_db().await;
        let root = test_db.dir.path().join("media");
        fs::create_dir_all(root.join("contents/source/book/1")).unwrap();
        fs::create_dir_all(root.join("contents/source/book/2")).unwrap();
        fs::write(root.join("contents/source/book/1/content.html"), b"<p>ch1</p>").unwrap();
        fs::write(root.join("contents/source/book/2/content.pdf"), b"%PDF-1.4").unwrap();

        let disk_doc = serde_json::json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
            "novel": { "name": "Recovered Novel", "author": "Disk Author", "isLocal": false },
            "cover": null,
            "chapters": { "1": "Chapter One", "2": "Chapter Two" }
        });
        crate::chapter_media::write_work_metadata_bytes_at(
            &root,
            "contents/source/book/novel.json",
            &serde_json::to_vec_pretty(&disk_doc).unwrap(),
        )
        .unwrap();

        let state = WorkMetadataRecoveryState::default();
        let token = state.start_generation();
        let mut events = Vec::new();
        let result = recover_work_metadata_at(
            test_db.db.writer(),
            Some(root.clone()),
            false,
            &state,
            token,
            |ev| events.push(ev),
        )
        .await
        .expect("recovery succeeds");

        assert_eq!(result.value.total_works, 1);
        assert_eq!(result.value.recovered_works, 1);
        assert_eq!(result.value.recovered_chapters, 2);
        assert!(!events.is_empty());

        let chapters: Vec<(i64, String, i64, Option<String>)> = sqlx::query_as(
            "SELECT id, name, is_downloaded, stored_content_type FROM chapter ORDER BY position",
        )
        .fetch_all(test_db.db.writer())
        .await
        .unwrap();
        assert_eq!(chapters.len(), 2);
        assert_eq!(
            chapters[0].1, "Chapter One",
            "metadata title preserved while chapter body discovered"
        );
        assert_eq!(chapters[0].2, 1);
        assert_eq!(chapters[0].3.as_deref(), Some("html"));
        assert_eq!(chapters[1].2, 1);
        assert_eq!(chapters[1].3.as_deref(), Some("pdf"));

        // Simulate chapter 1 deleted concurrently while scan snapshot still saw chapter 1 present:
        let ch1_id = chapters[0].0;
        sqlx::query("UPDATE chapter SET is_downloaded = 0, stored_content_type = NULL WHERE id = ?1")
            .bind(ch1_id)
            .execute(test_db.db.writer())
            .await
            .unwrap();
        let stale_scan = list_stored_novel_chapters_at(&root, "contents/source/book").unwrap();
        let root_scan = root.clone();
        with_write_tx(
            test_db.db.writer(),
            TxOptions::default(),
            move |conn, ctx| {
                Box::pin(async move {
                    let snap = ChapterScanSnapshot {
                        chapters: stale_scan,
                        skipped_chapter_ids: HashSet::from([ch1_id]),
                        defer_native_registration: false,
                    };
                    scan_stored_novel_chapters_to_cache_in_tx(
                        Some(&root_scan),
                        &mut *conn,
                        ctx,
                        1,
                        "contents/source/book",
                        Some(&snap),
                    )
                    .await
                })
            },
        )
        .await
        .unwrap();

        let ch1_downloaded: i64 =
            sqlx::query_scalar("SELECT is_downloaded FROM chapter WHERE id = ?1")
                .bind(ch1_id)
                .fetch_one(test_db.db.writer())
                .await
                .unwrap();
        assert_eq!(
            ch1_downloaded, 0,
            "skipped_chapter_ids must prevent stale snapshot from restoring deleted flag"
        );

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn install_reconciliation_cleans_superseded_empty_placeholders_and_guards_disk_files() {
        let test_db = open_test_db().await;
        let root = test_db.dir.path().join("media");
        fs::create_dir_all(root.join("contents/source/book/1")).unwrap();
        fs::write(root.join("contents/source/book/1/content.html"), b"<p>ch1</p>").unwrap();

        let disk_doc = serde_json::json!({
            "schemaVersion": 1,
            "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
            "novel": { "name": "Superseded Book", "isLocal": false },
            "cover": null,
            "chapters": {
                "1": "Chapter 1",
                "2": "Chapter 2",
                "1000": "Old 1",
                "2000": "Old 2"
            }
        });
        crate::chapter_media::write_work_metadata_bytes_at(
            &root,
            "contents/source/book/novel.json",
            &serde_json::to_vec_pretty(&disk_doc).unwrap(),
        )
        .unwrap();

        sqlx::query(
            "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) \
             VALUES(1, 'source', 'book', '/book', 'Superseded Book', 1)",
        )
        .execute(test_db.db.writer())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chapter(id, novel_id, path, name, position, chapter_number, progress, bookmark, read_at, is_downloaded, stored_content_type, content_bytes) VALUES \
             (11, 1, 'norea-folder:1000', 'Old 1', 3, '1000', 0, 0, NULL, 0, NULL, 0), \
             (12, 1, 'norea-folder:2000', 'Old 2', 4, '2000', 0, 0, NULL, 0, NULL, 0), \
             (21, 1, '/chapter/1000', 'Chapter 1', 1, '1', 100, 1, 777, 1, 'html', 10), \
             (22, 1, 'norea-folder:2', 'Chapter 2', 2, '2', 0, 0, NULL, 0, NULL, 0)",
        )
        .execute(test_db.db.writer())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO work_metadata_directory_cache(chapter_id, novel_id, directory) VALUES \
             (11, 1, 'contents/source/book/1000'), \
             (12, 1, 'contents/source/book/2000'), \
             (21, 1, 'contents/source/book/1'), \
             (22, 1, 'contents/source/book/2')",
        )
        .execute(test_db.db.writer())
        .await
        .unwrap();

        let make_input = || -> InstallStoredNovelMetadataInputDto {
            serde_json::from_value(serde_json::json!({
                "metadata": {
                    "schemaVersion": 1,
                    "identity": { "pluginId": "source", "novelId": "book", "novelPath": "/book" },
                    "novel": { "name": "Superseded Book", "isLocal": false },
                    "cover": null,
                    "chapters": { "1": "Chapter 1", "2": "Chapter 2" }
                },
                "reconciliation": {
                    "journal": null,
                    "mappings": [
                        { "chapterPath": "/chapter/1000", "from": "1000", "to": "1" },
                        { "chapterPath": "/chapter/2000", "from": "2000", "to": "2" }
                    ]
                }
            }))
            .unwrap()
        };

        // First: if an unexpected file exists on disk under the legacy folder, reconciliation
        // must reject without deleting any DB row or modifying novel.json.
        fs::create_dir_all(root.join("contents/source/book/1000")).unwrap();
        fs::write(root.join("contents/source/book/1000/content.html"), b"<p>unindexed</p>").unwrap();

        let err = install_stored_novel_metadata_at(test_db.db.writer(), root.clone(), make_input())
            .await
            .unwrap_err();
        assert!(
            err.contains("Existing chapter storage conflicts"),
            "unexpected error: {err}"
        );
        let count_after_err: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM chapter WHERE novel_id = 1")
                .fetch_one(test_db.db.writer())
                .await
                .unwrap();
        assert_eq!(count_after_err, 4);

        // Remove the unexpected file; now reconciliation succeeds cleanly.
        fs::remove_dir_all(root.join("contents/source/book/1000")).unwrap();
        let installed =
            install_stored_novel_metadata_at(test_db.db.writer(), root.clone(), make_input())
                .await
                .expect("reconciliation should succeed")
                .value
                .expect("should return installed metadata");
        assert_eq!(installed.metadata.chapters.0.len(), 2);

        let rows: Vec<(i64, String, Option<String>, i64, i64)> = sqlx::query_as(
            "SELECT id, path, chapter_number, progress, is_downloaded \
             FROM chapter WHERE novel_id = 1 ORDER BY id",
        )
        .fetch_all(test_db.db.writer())
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![
                (21, "/chapter/1000".to_string(), Some("1".to_string()), 100, 1),
                (22, "/chapter/2000".to_string(), Some("2".to_string()), 0, 0),
            ]
        );

        let stale_dirs: Vec<i64> = sqlx::query_scalar(
            "SELECT chapter_id FROM work_metadata_directory_cache WHERE chapter_id IN (11, 12)",
        )
        .fetch_all(test_db.db.writer())
        .await
        .unwrap();
        assert!(stale_dirs.is_empty());

        let reading_state_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM work_metadata_reading_state")
                .fetch_one(test_db.db.writer())
                .await
                .unwrap();
        assert_eq!(
            reading_state_rows, 0,
            "zero-state trigger rows for deleted placeholders must be cleaned up"
        );

        let total_chapters_stat: i64 =
            sqlx::query_scalar("SELECT total_chapters FROM novel_stats WHERE novel_id = 1")
                .fetch_one(test_db.db.writer())
                .await
                .unwrap();
        assert_eq!(total_chapters_stat, 2);

        test_db.db.close().await;
    }

    #[tokio::test]
    async fn sync_files_mark_only_library_and_stored_chapter_works_upload_eligible() {
        let test_db = open_test_db().await;
        let pool = test_db.db.writer();

        sqlx::query(
            "INSERT INTO novel(id, plugin_id, source_novel_id, path, name, in_library) VALUES \
             (1, 'source', 'browse-only', '/browse-only', 'Browse Only', 0), \
             (2, 'source', 'in-lib', '/in-lib', 'In Library', 1), \
             (3, 'source', 'downloaded', '/downloaded', 'Downloaded Only', 0), \
             (4, 'source', 'repair', '/repair', 'Repair Needed', 0)",
        )
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO chapter(id, novel_id, path, name, position, is_downloaded, content_bytes, media_repair_needed) VALUES \
             (11, 1, '/ch/1', 'Ch 1', 1, 0, 0, 0), \
             (31, 3, '/ch/1', 'Ch 1', 1, 1, 128, 0), \
             (41, 4, '/ch/1', 'Ch 1', 1, 0, 0, 1)",
        )
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO work_metadata_file_cache(plugin_id, path, novel_id, directory, fingerprint) VALUES \
             ('source', '/browse-only', 1, 'contents/source/browse-only', 'fp1'), \
             ('source', '/in-lib', 2, 'contents/source/in-lib', 'fp2'), \
             ('source', '/downloaded', 3, 'contents/source/downloaded', 'fp3'), \
             ('source', '/repair', 4, 'contents/source/repair', 'fp4')",
        )
        .execute(pool)
        .await
        .unwrap();

        let files = list_sync_files_from_pool(pool).await.unwrap();
        let eligibility: HashMap<String, bool> = files
            .into_iter()
            .map(|f| (f.path, f.upload_eligible))
            .collect();
        assert_eq!(eligibility.get("/browse-only"), Some(&false));
        assert_eq!(eligibility.get("/in-lib"), Some(&true));
        assert_eq!(eligibility.get("/downloaded"), Some(&true));
        assert_eq!(eligibility.get("/repair"), Some(&true));

        {
            let mut conn = pool.acquire().await.unwrap();
            let browse_only =
                read_work_metadata_sync_file_in_tx(&mut conn, "source", "/browse-only")
                    .await
                    .unwrap()
                    .unwrap();
            assert!(!browse_only.upload_eligible);

            sqlx::query("UPDATE novel SET in_library = 1 WHERE id = 1")
                .execute(&mut *conn)
                .await
                .unwrap();
            let shelved =
                read_work_metadata_sync_file_in_tx(&mut conn, "source", "/browse-only")
                    .await
                    .unwrap()
                    .unwrap();
            assert!(shelved.upload_eligible);
        }

        test_db.db.close().await;
    }
}
