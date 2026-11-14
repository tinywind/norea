use std::collections::HashSet;
use std::path::Path;

use serde_json::{json, Value as JsonValue};
use sqlx::{Row, SqliteConnection};

use super::types::{
    parse_chapter_reference, parse_stored_chapter_path, parse_work_reference, stored_chapter_digest,
    stored_chapter_number, stored_chapter_path, UserStateChapterReferenceDto,
    UserStateWorkReferenceDto,
};

#[derive(Debug, Clone)]
pub struct StoredChapterCandidate {
    pub id: i64,
    pub novel_id: i64,
    pub plugin_id: String,
    pub source_novel_id: Option<String>,
    pub novel_path: String,
    pub path: String,
    pub name: String,
    pub chapter_number: Option<String>,
    pub position: i64,
    pub content_type: String,
}

const CANDIDATE_COLUMNS: &str = "\
c.id, c.novel_id AS novelId, n.plugin_id AS pluginId, \
n.source_novel_id AS sourceNovelId, n.path AS novelPath, c.path, c.name, \
c.chapter_number AS chapterNumber, c.position, \
COALESCE(c.stored_content_type, c.content_type) AS contentType";

fn map_candidate_row(row: &sqlx::sqlite::SqliteRow) -> StoredChapterCandidate {
    StoredChapterCandidate {
        id: row.get("id"),
        novel_id: row.get("novelId"),
        plugin_id: row.get("pluginId"),
        source_novel_id: row.get("sourceNovelId"),
        novel_path: row.get("novelPath"),
        path: row.get("path"),
        name: row.get("name"),
        chapter_number: row.get("chapterNumber"),
        position: row.get("position"),
        content_type: row.get("contentType"),
    }
}

pub async fn has_composition_in_tx(
    conn: &mut SqliteConnection,
    novel_id: i64,
) -> Result<bool, String> {
    let present: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM novel_chapter_composition WHERE novel_id = ?1 LIMIT 1",
    )
    .bind(novel_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: check composition: {err}"))?;
    Ok(present.is_some())
}

pub fn canonical_chapter_storage_dir(
    plugin_id: &str,
    source_novel_id: Option<&str>,
    chapter_number: Option<&str>,
    position: i64,
) -> Result<String, String> {
    if !crate::chapter_media::is_plugin_storage_id(plugin_id) {
        return Err("Plugin ID is required for storage.".into());
    }
    let Some(novel_id) = source_novel_id.filter(|id| crate::chapter_media::is_storage_id(id))
    else {
        return Err("Plugin-owned novel ID is required for storage.".into());
    };
    let sequence = if let Some(raw_num) = chapter_number {
        stored_chapter_number(Some(raw_num))
            .ok_or_else(|| "Chapter storage sequence must be a decimal number.".to_string())?
    } else if position > 0 {
        position.to_string()
    } else {
        return Err("Chapter storage sequence must be a nonnegative number.".into());
    };
    Ok(format!("contents/{plugin_id}/{novel_id}/{sequence}"))
}

pub async fn verified_chapter_storage_dir_in_tx(
    conn: &mut SqliteConnection,
    chapter_id: i64,
    plugin_id: &str,
    source_novel_id: Option<&str>,
    chapter_number: Option<&str>,
    position: i64,
) -> Result<String, String> {
    let canonical =
        canonical_chapter_storage_dir(plugin_id, source_novel_id, chapter_number, position)?;
    let resolved: Option<String> = sqlx::query_scalar(
        "SELECT directory FROM work_metadata_directory_cache WHERE chapter_id = ?1",
    )
    .bind(chapter_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| format!("db user state: lookup chapter directory cache: {err}"))?;
    if let Some(dir) = resolved {
        if dir != canonical {
            return Err("Stored chapter directory does not match its canonical identity.".into());
        }
    }
    Ok(canonical)
}

pub async fn digest_candidate_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    candidate: &StoredChapterCandidate,
    skipped_chapter_ids: &HashSet<i64>,
) -> Option<String> {
    let root_path = root?;
    if skipped_chapter_ids.contains(&candidate.id) {
        return None;
    }
    let chapter_dir = verified_chapter_storage_dir_in_tx(
        conn,
        candidate.id,
        &candidate.plugin_id,
        candidate.source_novel_id.as_deref(),
        candidate.chapter_number.as_deref(),
        candidate.position,
    )
    .await
    .ok()?;
    let inventory =
        crate::chapter_media::inspect_payload_inventory_at(root_path, &chapter_dir).ok()?;
    stored_chapter_digest(&inventory)
}

async fn local_folder_candidate_in_tx(
    conn: &mut SqliteConnection,
    work: &UserStateWorkReferenceDto,
    chapter: &UserStateChapterReferenceDto,
) -> Result<Option<StoredChapterCandidate>, String> {
    let Some(raw_num) = chapter.chapter_path.strip_prefix("norea-folder:") else {
        return Ok(None);
    };
    let Some(ref source_novel_id) = work.source_novel_id else {
        return Ok(None);
    };
    if work.plugin_id == "local" {
        return Ok(None);
    }
    let Some(number) = stored_chapter_number(Some(raw_num)) else {
        return Ok(None);
    };
    let sql = format!(
        "SELECT {CANDIDATE_COLUMNS} FROM chapter c JOIN novel n ON n.id = c.novel_id \
         WHERE n.plugin_id = ?1 AND lower(n.source_novel_id) = lower(?2) AND c.path = ?3"
    );
    let rows = sqlx::query(&sql)
        .bind(&work.plugin_id)
        .bind(source_novel_id)
        .bind(&chapter.chapter_path)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: lookup local folder candidate: {err}"))?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let candidate = map_candidate_row(&rows[0]);
    if stored_chapter_number(candidate.chapter_number.as_deref()).as_deref()
        != Some(number.as_str())
        || has_composition_in_tx(conn, candidate.novel_id).await?
    {
        return Ok(None);
    }
    Ok(Some(candidate))
}

pub async fn portable_stored_chapter_reference_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    work: &UserStateWorkReferenceDto,
    chapter: &UserStateChapterReferenceDto,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<UserStateChapterReferenceDto, String> {
    let Some(candidate) = local_folder_candidate_in_tx(conn, work, chapter).await? else {
        return Ok(chapter.clone());
    };
    let Some(digest) =
        digest_candidate_in_tx(root, conn, &candidate, skipped_chapter_ids).await
    else {
        return Ok(chapter.clone());
    };
    let Some(path) = stored_chapter_path(candidate.chapter_number.as_deref(), &digest) else {
        return Ok(chapter.clone());
    };
    Ok(UserStateChapterReferenceDto {
        chapter_path: path,
        composition_entry_id: None,
        name: Some(chapter.name.clone().unwrap_or(candidate.name)),
    })
}

pub async fn portable_stored_user_state_intent_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    entity: &JsonValue,
    value: &JsonValue,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<(JsonValue, JsonValue), String> {
    let kind = entity.get("kind").and_then(JsonValue::as_str).unwrap_or("");
    if matches!(kind, "reading" | "bookmark") {
        let work = parse_work_reference(&entity["work"])?;
        let chapter = parse_chapter_reference(&entity["chapter"])?;
        let next_ch = portable_stored_chapter_reference_in_tx(
            root,
            conn,
            &work,
            &chapter,
            skipped_chapter_ids,
        )
        .await?;
        if next_ch.chapter_path == chapter.chapter_path {
            return Ok((entity.clone(), value.clone()));
        }
        let mut next_ent = entity.clone();
        next_ent["chapter"] = serde_json::to_value(next_ch).unwrap();
        return Ok((next_ent, value.clone()));
    }
    if kind == "resume" {
        if let Some(raw_ch) = value.get("chapter").filter(|v| !v.is_null()) {
            let work = parse_work_reference(&entity["work"])?;
            let chapter = parse_chapter_reference(raw_ch)?;
            let next_ch = portable_stored_chapter_reference_in_tx(
                root,
                conn,
                &work,
                &chapter,
                skipped_chapter_ids,
            )
            .await?;
            if next_ch.chapter_path != chapter.chapter_path {
                let mut next_val = value.clone();
                next_val["chapter"] = serde_json::to_value(next_ch).unwrap();
                return Ok((entity.clone(), next_val));
            }
        }
    }
    Ok((entity.clone(), value.clone()))
}

pub async fn resolve_stored_chapter_reference_in_tx(
    root: Option<&Path>,
    conn: &mut SqliteConnection,
    novel_id: i64,
    chapter: &UserStateChapterReferenceDto,
    skipped_chapter_ids: &HashSet<i64>,
) -> Result<Option<i64>, String> {
    let Some(stored) = parse_stored_chapter_path(&chapter.chapter_path) else {
        return Ok(None);
    };
    if has_composition_in_tx(conn, novel_id).await? {
        return Ok(None);
    }

    let direct_sql = format!(
        "SELECT {CANDIDATE_COLUMNS} FROM chapter c JOIN novel n ON n.id = c.novel_id \
         WHERE c.novel_id = ?1 AND c.path = ?2"
    );
    let mut rows: Vec<StoredChapterCandidate> = sqlx::query(&direct_sql)
        .bind(novel_id)
        .bind(&stored.folder_path)
        .fetch_all(&mut *conn)
        .await
        .map_err(|err| format!("db user state: resolve stored chapter by path: {err}"))?
        .iter()
        .map(map_candidate_row)
        .collect();

    if rows.is_empty() {
        let num_sql = format!(
            "SELECT {CANDIDATE_COLUMNS} FROM chapter c JOIN novel n ON n.id = c.novel_id \
             WHERE c.novel_id = ?1 AND CAST(c.chapter_number AS REAL) = CAST(?2 AS REAL) \
             ORDER BY c.id LIMIT 3"
        );
        rows = sqlx::query(&num_sql)
            .bind(novel_id)
            .bind(&stored.chapter_number)
            .fetch_all(&mut *conn)
            .await
            .map_err(|err| format!("db user state: resolve stored chapter by number: {err}"))?
            .iter()
            .map(map_candidate_row)
            .filter(|r| {
                stored_chapter_number(r.chapter_number.as_deref()).as_deref()
                    == Some(stored.chapter_number.as_str())
            })
            .collect();
    }

    if rows.len() != 1 {
        return Ok(None);
    }
    let candidate = &rows[0];
    if stored_chapter_number(candidate.chapter_number.as_deref()).as_deref()
        != Some(stored.chapter_number.as_str())
    {
        return Ok(None);
    }
    let Some(digest) =
        digest_candidate_in_tx(root, conn, candidate, skipped_chapter_ids).await
    else {
        return Ok(None);
    };
    Ok((digest == stored.sha256).then_some(candidate.id))
}

pub fn make_chapter_ref_json(
    chapter_path: &str,
    name: Option<&str>,
    composition_entry_id: Option<&str>,
) -> JsonValue {
    let mut map = serde_json::Map::new();
    map.insert("chapterPath".into(), json!(chapter_path));
    if let Some(id) = composition_entry_id {
        map.insert("compositionEntryId".into(), json!(id));
    }
    if let Some(n) = name {
        map.insert("name".into(), json!(n));
    }
    JsonValue::Object(map)
}
