use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use crate::db::chapter_composition::{
    canonical_chapter_number_str, chapter_composition_catalog, parse_chapter_composition,
};

use super::{
    ChaptersMap, NovelMetadataV1Dto, RawNovelMetadataInput, WorkMetadataCoverDto,
    WorkMetadataIdentityDto, WorkMetadataNovelDto, LOCAL_PLUGIN_ID,
};

pub fn cover_content_type(file_name: &str) -> Option<String> {
    let extension = file_name.rsplit('.').next()?;
    match extension {
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "svg" => Some("image/svg+xml".to_string()),
        "avif" | "bmp" | "gif" | "png" | "webp" => Some(format!("image/{extension}")),
        _ => None,
    }
}

fn expect_json_object(value: &JsonValue) -> Result<&serde_json::Map<String, JsonValue>, String> {
    value
        .as_object()
        .ok_or_else(|| "work metadata: expected object".to_string())
}

fn validate_metadata_text(
    value: Option<&JsonValue>,
    nullable: bool,
) -> Result<Option<String>, String> {
    let limit = if nullable {
        crate::chapter_media::MAX_METADATA_BYTES
    } else {
        4096
    };
    match value {
        None | Some(JsonValue::Null) if nullable => Ok(None),
        Some(JsonValue::String(text)) => {
            if text.encode_utf16().count() > limit || (!nullable && text.trim().is_empty()) {
                return Err("work metadata: invalid text".to_string());
            }
            Ok(Some(text.clone()))
        }
        _ => Err("work metadata: invalid text".to_string()),
    }
}

fn is_valid_cover_content_type(content_type: &str) -> bool {
    let Some(rest) = content_type.strip_prefix("image/") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-'))
}

pub fn parse_novel_metadata_input(
    input: &RawNovelMetadataInput,
) -> Result<NovelMetadataV1Dto, String> {
    parse_novel_metadata_with_chapters(&input.raw, input.ordered_chapters.as_deref())
}

pub fn parse_novel_metadata_bytes(bytes: &[u8]) -> Result<(NovelMetadataV1Dto, JsonValue), String> {
    let input: RawNovelMetadataInput = serde_json::from_slice(bytes)
        .map_err(|err| format!("work metadata: invalid JSON: {err}"))?;
    let parsed = parse_novel_metadata_input(&input)?;
    Ok((parsed, input.raw))
}

pub fn parse_novel_metadata(raw: &JsonValue) -> Result<NovelMetadataV1Dto, String> {
    parse_novel_metadata_with_chapters(raw, None)
}

fn parse_novel_metadata_with_chapters(
    raw: &JsonValue,
    ordered_chapters: Option<&[(String, JsonValue)]>,
) -> Result<NovelMetadataV1Dto, String> {
    let value = expect_json_object(raw)?;
    if let Some(version) = value.get("schemaVersion") {
        let valid_v1 = version.as_u64() == Some(1)
            || version.as_f64().is_some_and(|v| v.is_finite() && v == 1.0);
        if !valid_v1 {
            return Err("work metadata: invalid version".to_string());
        }
    }

    let identity = expect_json_object(
        value
            .get("identity")
            .ok_or_else(|| "work metadata: expected object".to_string())?,
    )?;
    let plugin_id = validate_metadata_text(identity.get("pluginId"), false)?.unwrap();
    let novel_path = validate_metadata_text(identity.get("novelPath"), false)?.unwrap();
    let Some(novel_id) = identity.get("novelId").and_then(JsonValue::as_str) else {
        return Err("work metadata: invalid plugin or novel ID".to_string());
    };
    if !crate::chapter_media::is_plugin_storage_id(&plugin_id)
        || !crate::chapter_media::is_storage_id(novel_id)
    {
        return Err("work metadata: invalid plugin or novel ID".to_string());
    }
    if novel_path.starts_with("norea-folder:") {
        return Err("work metadata: source work identity required".to_string());
    }
    let lower_path = novel_path.to_ascii_lowercase();
    if lower_path.starts_with("http://")
        || lower_path.starts_with("https://")
        || lower_path.starts_with("//")
    {
        return Err("work metadata: work identity must exclude the base URL".to_string());
    }

    let novel = expect_json_object(
        value
            .get("novel")
            .ok_or_else(|| "work metadata: expected object".to_string())?,
    )?;
    let name = validate_metadata_text(novel.get("name"), false)?.unwrap();
    let author = validate_metadata_text(novel.get("author"), true)?;
    let artist = validate_metadata_text(novel.get("artist"), true)?;
    let summary = validate_metadata_text(novel.get("summary"), true)?;
    let status = validate_metadata_text(novel.get("status"), true)?;
    let genres = validate_metadata_text(novel.get("genres"), true)?;

    let rating = match novel.get("rating") {
        None | Some(JsonValue::Null) => None,
        Some(raw_rating) => {
            let Some(num) = raw_rating.as_f64() else {
                return Err("work metadata: invalid rating".to_string());
            };
            if !num.is_finite() || !(0.0..=5.0).contains(&num) {
                return Err("work metadata: invalid rating".to_string());
            }
            Some(if num == 0.0 { 0.0 } else { num })
        }
    };

    let is_local = match novel.get("isLocal") {
        None | Some(JsonValue::Null) => plugin_id == LOCAL_PLUGIN_ID,
        Some(JsonValue::Bool(flag)) => *flag,
        Some(_) => return Err("work metadata: invalid local flag".to_string()),
    };

    let mut chapters = ChaptersMap::new();
    if let Some(raw_chapters) = value.get("chapters") {
        let map = expect_json_object(raw_chapters)?;
        if let Some(entries) = ordered_chapters {
            for (number, raw_title) in entries {
                if canonical_chapter_number_str(number).as_deref() != Some(number.as_str()) {
                    return Err("work metadata: invalid chapter number".to_string());
                }
                let title = validate_metadata_text(Some(raw_title), false)?.unwrap();
                chapters.insert(number.clone(), title);
            }
        } else {
            for (number, raw_title) in map {
                if canonical_chapter_number_str(number).as_deref() != Some(number.as_str()) {
                    return Err("work metadata: invalid chapter number".to_string());
                }
                let title = validate_metadata_text(Some(raw_title), false)?.unwrap();
                chapters.insert(number.clone(), title);
            }
        }
    }

    let chapter_composition = match value.get("chapterComposition") {
        None => None,
        Some(raw_comp) => Some(parse_chapter_composition(raw_comp)?),
    };
    if let Some(ref comp) = chapter_composition {
        let expected = chapter_composition_catalog(comp);
        if chapters.len() != expected.len()
            || expected
                .iter()
                .any(|(number, title)| chapters.get(number) != Some(title.as_str()))
        {
            return Err(
                "work metadata: chapter catalog does not match the user composition".to_string(),
            );
        }
    }

    let cover = match value.get("cover") {
        None | Some(JsonValue::Null) => None,
        Some(raw_cover) => {
            let input = expect_json_object(raw_cover)?;
            let file_name = validate_metadata_text(input.get("fileName"), false)?.unwrap();
            let explicit_type = validate_metadata_text(input.get("contentType"), true)?;
            if let Some(ref ct) = explicit_type {
                if !is_valid_cover_content_type(ct) {
                    return Err("work metadata: invalid cover content type".to_string());
                }
            }
            if !crate::chapter_media::is_cover_file(&file_name) {
                return Err("work metadata: unsafe cover filename".to_string());
            }
            let content_type = explicit_type.or_else(|| cover_content_type(&file_name));
            Some(WorkMetadataCoverDto {
                file_name,
                content_type,
            })
        }
    };

    let encoded_len = serde_json::to_vec(raw)
        .map_err(|err| format!("work metadata: encode check: {err}"))?
        .len();
    if encoded_len > crate::chapter_media::MAX_METADATA_BYTES {
        return Err("work metadata: document exceeds size limit".to_string());
    }

    Ok(NovelMetadataV1Dto {
        schema_version: 1,
        identity: WorkMetadataIdentityDto {
            plugin_id,
            novel_id: novel_id.to_string(),
            novel_path,
        },
        novel: WorkMetadataNovelDto {
            name,
            author,
            artist,
            summary,
            status,
            genres,
            rating,
            is_local,
        },
        cover,
        chapters,
        chapter_composition,
    })
}

pub fn normalize_novel_metadata(
    metadata: &NovelMetadataV1Dto,
) -> Result<NovelMetadataV1Dto, String> {
    let encoded = serde_json::to_vec(metadata)
        .map_err(|err| format!("work metadata: serialize check: {err}"))?;
    Ok(parse_novel_metadata_bytes(&encoded)?.0)
}

pub fn stored_novel_metadata_fingerprint(metadata: &NovelMetadataV1Dto) -> Result<String, String> {
    let normalized = normalize_novel_metadata(metadata)?;
    let encoded = serde_json::to_vec(&normalized)
        .map_err(|err| format!("work metadata: serialize fingerprint: {err}"))?;
    let digest = Sha256::digest(&encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn merge_incoming_novel_metadata(
    current: Option<&NovelMetadataV1Dto>,
    incoming: &NovelMetadataV1Dto,
) -> Result<NovelMetadataV1Dto, String> {
    let pick_str = |next: &Option<String>, prev: Option<&Option<String>>| -> Option<String> {
        if next.as_deref().is_some_and(|text| !text.trim().is_empty()) {
            next.clone()
        } else {
            prev.and_then(|val| val.clone())
        }
    };
    let mut chapters = ChaptersMap::new();
    if let Some(curr) = current {
        for (k, v) in curr.chapters.ordered_entries() {
            chapters.insert(k.to_string(), v.to_string());
        }
    }
    for (k, v) in incoming.chapters.ordered_entries() {
        chapters.insert(k.to_string(), v.to_string());
    }

    let composition = match (
        incoming.chapter_composition.as_ref(),
        current.and_then(|c| c.chapter_composition.as_ref()),
    ) {
        (Some(inc), Some(curr)) if inc.updated_at <= curr.updated_at => Some(curr.clone()),
        (Some(inc), _) => Some(inc.clone()),
        (None, Some(curr)) => Some(curr.clone()),
        (None, None) => None,
    };

    if let Some(ref comp) = composition {
        chapters = ChaptersMap::from_entries(chapter_composition_catalog(comp));
    }

    let candidate = NovelMetadataV1Dto {
        schema_version: 1,
        identity: incoming.identity.clone(),
        novel: WorkMetadataNovelDto {
            name: incoming.novel.name.clone(),
            author: pick_str(&incoming.novel.author, current.map(|c| &c.novel.author)),
            artist: pick_str(&incoming.novel.artist, current.map(|c| &c.novel.artist)),
            summary: pick_str(&incoming.novel.summary, current.map(|c| &c.novel.summary)),
            status: pick_str(&incoming.novel.status, current.map(|c| &c.novel.status)),
            genres: pick_str(&incoming.novel.genres, current.map(|c| &c.novel.genres)),
            rating: incoming
                .novel
                .rating
                .or_else(|| current.and_then(|c| c.novel.rating)),
            is_local: incoming.novel.is_local,
        },
        cover: incoming
            .cover
            .clone()
            .or_else(|| current.and_then(|c| c.cover.clone())),
        chapters,
        chapter_composition: composition,
    };
    normalize_novel_metadata(&candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_parser_and_normalizer_preserve_catalog_order_and_fingerprint() {
        let bytes = br#"{"identity":{"pluginId":"demo","novelId":"work","novelPath":"/work"},"novel":{"name":"Work"},"chapters":{"10.5":"First","2.5":"Second"}}"#;
        let (metadata, _) = parse_novel_metadata_bytes(bytes).unwrap();
        let normalized = normalize_novel_metadata(&metadata).unwrap();
        assert_eq!(
            normalized.chapters.ordered_entries(),
            [("10.5", "First"), ("2.5", "Second")]
        );
        assert_eq!(
            stored_novel_metadata_fingerprint(&metadata).unwrap(),
            stored_novel_metadata_fingerprint(&normalized).unwrap()
        );
    }
}
