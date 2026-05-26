//! Backup file format v1: zip pack / unpack.
//!
//! The current zip layout is:
//!
//! ```text
//! manifest.json
//! chapter-media/<chapterId>/<fileName>
//! ```
//!
//! The manifest is the source of truth for structure, downloaded
//! chapter content, and metadata. Chapter media files are stored as
//! flat `chapter-media/<chapterId>/<fileName>` entries.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::Sqlite;
use tauri::{async_runtime, AppHandle, Manager, State};
use tauri_plugin_sql::{DbInstances, DbPool};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::chapter_media::{
    chapter_media_body_from_src_with_context, chapter_media_from_backup_entry,
    store_chapter_media_file_source,
};

const BYTES_PER_MIB: u64 = 1024 * 1024;
const MANIFEST_ENTRY: &str = "manifest.json";
const CHAPTERS_PREFIX: &str = "chapters/";
const CHAPTER_SUFFIX: &str = ".html";
const DB_URL: &str = "sqlite:norea.db";
const BACKUP_TEMP_DIR: &str = "backup";
const BACKUP_STAGING_DIR: &str = "staged-restore";
const MAX_BACKUP_ARCHIVE_BYTES: u64 = 2 * 1024 * BYTES_PER_MIB;
const MAX_BACKUP_ZIP_ENTRIES: usize = 100_000;
const MAX_BACKUP_MANIFEST_BYTES: u64 = 256 * BYTES_PER_MIB;
const MAX_BACKUP_CHAPTER_HTML_BYTES: u64 = 64 * BYTES_PER_MIB;
const MAX_BACKUP_MEDIA_ENTRY_BYTES: u64 = 256 * BYTES_PER_MIB;
const MAX_BACKUP_TOTAL_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * BYTES_PER_MIB;
const MAX_BACKUP_COMPRESSION_RATIO: u64 = 200;
const MIN_BACKUP_RATIO_CHECK_BYTES: u64 = BYTES_PER_MIB;

#[derive(Debug, Clone, Copy)]
struct BackupArchiveLimits {
    max_entries: usize,
    max_manifest_bytes: u64,
    max_chapter_html_bytes: u64,
    max_media_entry_bytes: u64,
    max_total_uncompressed_bytes: u64,
    max_compression_ratio: u64,
}

impl BackupArchiveLimits {
    const DEFAULT: Self = Self {
        max_entries: MAX_BACKUP_ZIP_ENTRIES,
        max_manifest_bytes: MAX_BACKUP_MANIFEST_BYTES,
        max_chapter_html_bytes: MAX_BACKUP_CHAPTER_HTML_BYTES,
        max_media_entry_bytes: MAX_BACKUP_MEDIA_ENTRY_BYTES,
        max_total_uncompressed_bytes: MAX_BACKUP_TOTAL_UNCOMPRESSED_BYTES,
        max_compression_ratio: MAX_BACKUP_COMPRESSION_RATIO,
    };
}

#[derive(Debug)]
struct BackupArchiveReadBudget {
    limits: BackupArchiveLimits,
    total_uncompressed_bytes: u64,
}

impl BackupArchiveReadBudget {
    fn new(limits: BackupArchiveLimits) -> Self {
        Self {
            limits,
            total_uncompressed_bytes: 0,
        }
    }

    fn validate_declared_entry(
        &mut self,
        name: &str,
        uncompressed_size: u64,
        compressed_size: u64,
    ) -> Result<(), String> {
        self.add_total_uncompressed(name, uncompressed_size)?;
        self.validate_compression_ratio(name, uncompressed_size, compressed_size)
    }

    fn validate_actual_entry_size(
        &mut self,
        name: &str,
        declared_size: u64,
        actual_size: u64,
    ) -> Result<(), String> {
        if actual_size > declared_size {
            self.add_total_uncompressed(name, actual_size - declared_size)?;
        }
        Ok(())
    }

    fn add_total_uncompressed(&mut self, name: &str, size: u64) -> Result<(), String> {
        let next_total = self
            .total_uncompressed_bytes
            .checked_add(size)
            .ok_or_else(|| {
                format!("backup_unpack: total uncompressed size overflow at entry '{name}'")
            })?;
        if next_total > self.limits.max_total_uncompressed_bytes {
            return Err(format!(
                "backup_unpack: total uncompressed size is {next_total} bytes, which exceeds the {} byte limit",
                self.limits.max_total_uncompressed_bytes
            ));
        }
        self.total_uncompressed_bytes = next_total;
        Ok(())
    }

    fn validate_compression_ratio(
        &self,
        name: &str,
        uncompressed_size: u64,
        compressed_size: u64,
    ) -> Result<(), String> {
        if uncompressed_size < MIN_BACKUP_RATIO_CHECK_BYTES {
            return Ok(());
        }
        if compressed_size == 0 {
            return Err(format!(
                "backup_unpack: entry '{name}' has an invalid zero compressed size"
            ));
        }
        let max_uncompressed = compressed_size.saturating_mul(self.limits.max_compression_ratio);
        if uncompressed_size > max_uncompressed {
            return Err(format!(
                "backup_unpack: entry '{name}' has an excessive compression ratio"
            ));
        }
        Ok(())
    }
}

/// One downloaded chapter body, keyed by the local chapter row id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterContent {
    pub id: i64,
    pub html: String,
}

/// One local chapter media file to include in the backup archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterMediaContent {
    pub media_src: String,
    pub chapter_id: Option<i64>,
    pub body: Vec<u8>,
}

/// One local chapter media ref to resolve and include in the backup archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChapterMediaFileRef {
    pub media_src: String,
    pub chapter_id: Option<i64>,
    pub novel_id: Option<i64>,
    pub source_id: Option<String>,
    pub novel_name: Option<String>,
    pub novel_path: Option<String>,
    pub chapter_number: Option<String>,
    pub chapter_name: Option<String>,
    pub chapter_position: Option<i64>,
}

/// Result of `backup_unpack`: the raw manifest JSON plus legacy
/// chapter HTML and local media entries when an old archive carries them.
#[derive(Debug, Serialize)]
pub struct UnpackedBackup {
    pub manifest_json: String,
    pub chapters: Vec<ChapterContent>,
    pub chapter_media: Vec<ChapterMediaContent>,
}

/// One staged local chapter media file extracted from a backup archive.
#[derive(Debug, Clone, Serialize)]
pub struct StagedChapterMediaContent {
    pub media_src: String,
    pub chapter_id: Option<i64>,
    pub staged_ref: String,
    pub bytes: u64,
}

/// Result of `backup_unpack_staged`: the raw manifest JSON plus legacy
/// chapter HTML and staged local media refs.
#[derive(Debug, Serialize)]
pub struct StagedUnpackedBackup {
    pub manifest_json: String,
    pub chapters: Vec<ChapterContent>,
    pub chapter_media: Vec<StagedChapterMediaContent>,
    pub staging_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreManifest {
    novels: Vec<BackupRestoreNovel>,
    chapters: Vec<BackupRestoreChapter>,
    categories: Vec<BackupRestoreCategory>,
    novel_categories: Vec<BackupRestoreNovelCategory>,
    repositories: Vec<BackupRestoreRepository>,
    installed_plugins: Option<Vec<BackupRestoreInstalledPlugin>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreNovel {
    id: i64,
    plugin_id: String,
    path: String,
    name: String,
    cover: Option<String>,
    summary: Option<String>,
    author: Option<String>,
    artist: Option<String>,
    status: Option<String>,
    genres: Option<String>,
    in_library: bool,
    is_local: bool,
    created_at: i64,
    updated_at: i64,
    library_added_at: Option<i64>,
    last_read_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreChapter {
    id: i64,
    novel_id: i64,
    path: String,
    name: String,
    chapter_number: Option<String>,
    position: i64,
    page: String,
    bookmark: bool,
    unread: bool,
    progress: i64,
    is_downloaded: bool,
    content_type: Option<String>,
    content: Option<String>,
    media_bytes: Option<i64>,
    release_time: Option<String>,
    read_at: Option<i64>,
    created_at: i64,
    found_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreCategory {
    id: i64,
    name: String,
    sort: i64,
    is_system: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreNovelCategory {
    id: i64,
    novel_id: i64,
    category_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreRepository {
    id: i64,
    url: String,
    name: Option<String>,
    added_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreInstalledPlugin {
    id: String,
    name: String,
    lang: String,
    version: String,
    icon_url: String,
    source_url: String,
    source_code: String,
    installed_at: i64,
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn backup_content_type(value: Option<&str>) -> &str {
    match value {
        Some("pdf") => "pdf",
        Some("epub") => "epub",
        _ => "html",
    }
}

fn content_byte_len(value: Option<&str>) -> i64 {
    value
        .map(|content| content.as_bytes().len() as i64)
        .unwrap_or(0)
}

fn segment_has_remote_url(segment: &str) -> bool {
    segment.contains("http://")
        || segment.contains("https://")
        || segment.contains("=\"//")
        || segment.contains("='//")
        || segment.contains("=//")
}

fn contains_remote_style_url(content: &str) -> bool {
    let mut rest = content;
    while let Some(position) = rest.find("url(") {
        let value = &rest[position + 4..];
        let value = value
            .trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == '"' || ch == '\'');
        if value.starts_with("http://") || value.starts_with("https://") || value.starts_with("//")
        {
            return true;
        }
        rest = &value[1.min(value.len())..];
    }
    false
}

fn contains_remote_media_tag(content: &str) -> bool {
    const MEDIA_TAGS: [&str; 9] = [
        "<img", "<picture", "<source", "<video", "<audio", "<track", "<iframe", "<embed", "<object",
    ];
    for tag in MEDIA_TAGS {
        let mut rest = content;
        while let Some(position) = rest.find(tag) {
            let tag_body = &rest[position..];
            let end = tag_body
                .find('>')
                .unwrap_or_else(|| tag_body.len().min(4096));
            if segment_has_remote_url(&tag_body[..end]) {
                return true;
            }
            let next = position + tag.len();
            if next >= rest.len() {
                break;
            }
            rest = &rest[next..];
        }
    }
    false
}

fn chapter_media_repair_needed(content: Option<&str>, content_type: Option<&str>) -> i64 {
    if !matches!(backup_content_type(content_type), "html" | "epub") {
        return 0;
    }
    let Some(content) = content else {
        return 0;
    };
    if content.is_empty() {
        return 0;
    }
    let content = content.to_ascii_lowercase();
    bool_to_int(contains_remote_media_tag(&content) || contains_remote_style_url(&content))
}

fn select_backup_repository(
    repositories: &[BackupRestoreRepository],
) -> Option<&BackupRestoreRepository> {
    repositories.iter().max_by(|left, right| {
        left.added_at
            .cmp(&right.added_at)
            .then(left.id.cmp(&right.id))
    })
}

async fn execute_restore_snapshot(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    manifest: BackupRestoreManifest,
    media_bytes_by_chapter_id: HashMap<i64, i64>,
) -> Result<(), String> {
    sqlx::query("DELETE FROM novel_category")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete novel_category: {err}"))?;
    sqlx::query("DELETE FROM chapter")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete chapter: {err}"))?;
    sqlx::query("DELETE FROM novel_stats")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete novel_stats: {err}"))?;
    sqlx::query("DELETE FROM novel")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete novel: {err}"))?;
    sqlx::query("DELETE FROM category")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete category: {err}"))?;
    sqlx::query("DELETE FROM repository")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete repository: {err}"))?;
    sqlx::query("DELETE FROM repository_index_cache")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete repository_index_cache: {err}"))?;
    if manifest.installed_plugins.is_some() {
        sqlx::query("DELETE FROM installed_plugin")
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: delete installed_plugin: {err}"))?;
    }

    for category in &manifest.categories {
        sqlx::query("INSERT INTO category (id, name, sort, is_system) VALUES ($1, $2, $3, $4)")
            .bind(category.id)
            .bind(&category.name)
            .bind(category.sort)
            .bind(bool_to_int(category.is_system))
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: insert category: {err}"))?;
    }

    if let Some(repository) = select_backup_repository(&manifest.repositories) {
        sqlx::query("INSERT INTO repository (id, url, name, added_at) VALUES ($1, $2, $3, $4)")
            .bind(1_i64)
            .bind(repository.url.as_str())
            .bind(repository.name.as_deref())
            .bind(repository.added_at)
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: insert repository: {err}"))?;
    }

    if let Some(installed_plugins) = &manifest.installed_plugins {
        for plugin in installed_plugins {
            sqlx::query(
                "INSERT INTO installed_plugin (
                    id, name, lang, version, icon_url, source_url, source_code, installed_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(plugin.id.as_str())
            .bind(plugin.name.as_str())
            .bind(plugin.lang.as_str())
            .bind(plugin.version.as_str())
            .bind(plugin.icon_url.as_str())
            .bind(plugin.source_url.as_str())
            .bind(plugin.source_code.as_str())
            .bind(plugin.installed_at)
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: insert installed_plugin: {err}"))?;
        }
    }

    for novel in &manifest.novels {
        sqlx::query(
            "INSERT INTO novel (
                id, plugin_id, path, name, cover, summary, author, artist,
                status, genres, in_library, is_local,
                created_at, updated_at, library_added_at, last_read_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)",
        )
        .bind(novel.id)
        .bind(novel.plugin_id.as_str())
        .bind(novel.path.as_str())
        .bind(novel.name.as_str())
        .bind(novel.cover.as_deref())
        .bind(novel.summary.as_deref())
        .bind(novel.author.as_deref())
        .bind(novel.artist.as_deref())
        .bind(novel.status.as_deref())
        .bind(novel.genres.as_deref())
        .bind(bool_to_int(novel.in_library))
        .bind(bool_to_int(novel.is_local))
        .bind(novel.created_at)
        .bind(novel.updated_at)
        .bind(novel.library_added_at)
        .bind(novel.last_read_at)
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: insert novel: {err}"))?;
    }

    for chapter in &manifest.chapters {
        let restored_downloaded = chapter.is_downloaded && chapter.content.is_some();
        let restored_media_bytes = if restored_downloaded {
            media_bytes_by_chapter_id
                .get(&chapter.id)
                .copied()
                .or(chapter.media_bytes)
                .unwrap_or(0)
        } else {
            0
        };
        sqlx::query(
            "INSERT INTO chapter (
                id, novel_id, path, name, chapter_number, position, page,
                bookmark, unread, progress, is_downloaded, content, content_bytes,
                media_bytes, media_repair_needed, content_type, release_time,
                read_at, created_at, found_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)",
        )
        .bind(chapter.id)
        .bind(chapter.novel_id)
        .bind(chapter.path.as_str())
        .bind(chapter.name.as_str())
        .bind(chapter.chapter_number.as_deref())
        .bind(chapter.position)
        .bind(chapter.page.as_str())
        .bind(bool_to_int(chapter.bookmark))
        .bind(bool_to_int(chapter.unread))
        .bind(chapter.progress)
        .bind(bool_to_int(restored_downloaded))
        .bind(chapter.content.as_deref())
        .bind(content_byte_len(chapter.content.as_deref()))
        .bind(restored_media_bytes)
        .bind(chapter_media_repair_needed(
            chapter.content.as_deref(),
            chapter.content_type.as_deref(),
        ))
        .bind(backup_content_type(chapter.content_type.as_deref()))
        .bind(chapter.release_time.as_deref())
        .bind(chapter.read_at)
        .bind(chapter.created_at)
        .bind(chapter.found_at)
        .bind(chapter.updated_at)
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: insert chapter: {err}"))?;
    }

    for link in &manifest.novel_categories {
        sqlx::query("INSERT INTO novel_category (id, novel_id, category_id) VALUES ($1, $2, $3)")
            .bind(link.id)
            .bind(link.novel_id)
            .bind(link.category_id)
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: insert novel_category: {err}"))?;
    }

    Ok(())
}

fn write_manifest_entry<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    manifest_json: &str,
    error_prefix: &str,
) -> Result<(), String> {
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    zip.start_file(MANIFEST_ENTRY, options)
        .map_err(|err| format!("{error_prefix}: start manifest: {err}"))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|err| format!("{error_prefix}: write manifest: {err}"))?;
    Ok(())
}

fn media_backup_entry_name(
    media_src: &str,
    context_chapter_id: Option<i64>,
) -> Result<String, String> {
    let payload = media_src
        .strip_prefix("norea-media://chapter/")
        .ok_or_else(|| "backup_pack: unsupported chapter media uri".to_string())?;
    let parts = payload.split('/').collect::<Vec<_>>();
    let (uri_chapter_id, file_name) = match parts.as_slice() {
        [file_name] => (None, *file_name),
        [raw_chapter_id, file_name] => {
            let chapter_id = raw_chapter_id
                .parse::<i64>()
                .map_err(|err| format!("backup_pack: invalid chapter media id: {err}"))?;
            (Some(chapter_id), *file_name)
        }
        _ => return Err("backup_pack: invalid chapter media uri".to_string()),
    };
    let chapter_id = uri_chapter_id
        .or(context_chapter_id)
        .ok_or_else(|| "backup_pack: missing chapter media id".to_string())?;
    if chapter_id <= 0 {
        return Err("backup_pack: chapter media id must be positive".to_string());
    }
    if file_name.is_empty()
        || file_name == "."
        || file_name == ".."
        || file_name.contains('\0')
        || file_name.contains('/')
        || file_name.contains('\\')
    {
        return Err("backup_pack: invalid chapter media file name".to_string());
    }
    Ok(format!("chapter-media/{chapter_id}/{file_name}"))
}

fn write_chapter_media_entries<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    chapter_media: &[ChapterMediaContent],
    error_prefix: &str,
    total_uncompressed_bytes: &mut u64,
) -> Result<(), String> {
    if chapter_media.is_empty() {
        return Ok(());
    }
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut written = HashSet::new();
    for file in chapter_media {
        let entry_name = media_backup_entry_name(&file.media_src, file.chapter_id)?;
        if !written.insert(entry_name.clone()) {
            continue;
        }
        validate_backup_media_entry_size(
            &entry_name,
            file.body.len() as u64,
            error_prefix,
            total_uncompressed_bytes,
        )?;
        zip.start_file(&entry_name, options)
            .map_err(|err| format!("{error_prefix}: start media entry: {err}"))?;
        zip.write_all(&file.body)
            .map_err(|err| format!("{error_prefix}: write media entry: {err}"))?;
    }
    Ok(())
}

fn validate_backup_media_entry_size(
    entry_name: &str,
    bytes: u64,
    error_prefix: &str,
    total_uncompressed_bytes: &mut u64,
) -> Result<(), String> {
    if bytes > MAX_BACKUP_MEDIA_ENTRY_BYTES {
        return Err(format!(
            "{error_prefix}: media entry '{entry_name}' is {bytes} bytes, which exceeds the {MAX_BACKUP_MEDIA_ENTRY_BYTES} byte limit"
        ));
    }
    *total_uncompressed_bytes = total_uncompressed_bytes
        .checked_add(bytes)
        .ok_or_else(|| format!("{error_prefix}: media total byte count overflow"))?;
    if *total_uncompressed_bytes > MAX_BACKUP_TOTAL_UNCOMPRESSED_BYTES {
        return Err(format!(
            "{error_prefix}: media total is {} bytes, which exceeds the {MAX_BACKUP_TOTAL_UNCOMPRESSED_BYTES} byte limit",
            *total_uncompressed_bytes
        ));
    }
    Ok(())
}

fn write_chapter_media_file_ref_entries<W: Write + Seek>(
    app: &AppHandle,
    zip: &mut ZipWriter<W>,
    chapter_media_files: &[ChapterMediaFileRef],
    error_prefix: &str,
    total_uncompressed_bytes: &mut u64,
) -> Result<(), String> {
    if chapter_media_files.is_empty() {
        return Ok(());
    }
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut written = HashSet::new();
    for file in chapter_media_files {
        let entry_name = media_backup_entry_name(&file.media_src, file.chapter_id)?;
        if !written.insert(entry_name.clone()) {
            continue;
        }
        let (body, _) = chapter_media_body_from_src_with_context(
            app,
            &file.media_src,
            file.chapter_id,
            file.novel_id,
            file.source_id.as_deref(),
            file.novel_path.as_deref(),
            file.novel_name.as_deref(),
            file.chapter_number.as_deref(),
            file.chapter_name.as_deref(),
            file.chapter_position,
        )
        .map_err(|err| format!("{error_prefix}: resolve media entry '{entry_name}': {err}"))?;
        validate_backup_media_entry_size(
            &entry_name,
            body.len() as u64,
            error_prefix,
            total_uncompressed_bytes,
        )?;
        zip.start_file(&entry_name, options)
            .map_err(|err| format!("{error_prefix}: start media entry: {err}"))?;
        zip.write_all(&body)
            .map_err(|err| format!("{error_prefix}: write media entry: {err}"))?;
    }
    Ok(())
}

fn write_backup_zip(
    app: Option<AppHandle>,
    manifest_json: String,
    chapter_media: Vec<ChapterMediaContent>,
    chapter_media_files: Vec<ChapterMediaFileRef>,
    output_path: String,
) -> Result<(), String> {
    let file = File::create(&output_path)
        .map_err(|err| format!("backup_pack: failed to create '{output_path}': {err}"))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    write_manifest_entry(&mut zip, &manifest_json, "backup_pack")?;
    let mut total_uncompressed_bytes = 0;
    write_chapter_media_entries(
        &mut zip,
        &chapter_media,
        "backup_pack",
        &mut total_uncompressed_bytes,
    )?;
    if !chapter_media_files.is_empty() {
        let app = app
            .as_ref()
            .ok_or_else(|| "backup_pack: app handle required for media refs".to_string())?;
        write_chapter_media_file_ref_entries(
            app,
            &mut zip,
            &chapter_media_files,
            "backup_pack",
            &mut total_uncompressed_bytes,
        )?;
    }
    zip.finish()
        .map_err(|err| format!("backup_pack: finalize: {err}"))?;
    Ok(())
}

fn write_backup_zip_file<W: Write + Seek>(
    app: Option<AppHandle>,
    file: W,
    manifest_json: String,
    chapter_media: Vec<ChapterMediaContent>,
    chapter_media_files: Vec<ChapterMediaFileRef>,
    error_prefix: &str,
) -> Result<(), String> {
    let mut zip = ZipWriter::new(BufWriter::new(file));
    write_manifest_entry(&mut zip, &manifest_json, error_prefix)?;
    let mut total_uncompressed_bytes = 0;
    write_chapter_media_entries(
        &mut zip,
        &chapter_media,
        error_prefix,
        &mut total_uncompressed_bytes,
    )?;
    if !chapter_media_files.is_empty() {
        let app = app
            .as_ref()
            .ok_or_else(|| format!("{error_prefix}: app handle required for media refs"))?;
        write_chapter_media_file_ref_entries(
            app,
            &mut zip,
            &chapter_media_files,
            error_prefix,
            &mut total_uncompressed_bytes,
        )?;
    }
    zip.finish()
        .map_err(|err| format!("{error_prefix}: finalize: {err}"))?;
    Ok(())
}

fn backup_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("backup_pack_temp_file: app cache dir: {err}"))?
        .join(BACKUP_TEMP_DIR);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("backup_pack_temp_file: create temp dir: {err}"))?;
    Ok(dir)
}

fn backup_temp_path(dir: &Path, attempt: u32) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    dir.join(format!("norea-backup-{now}-{attempt}.zip"))
}

fn write_backup_temp_file(
    app: AppHandle,
    manifest_json: String,
    chapter_media: Vec<ChapterMediaContent>,
    chapter_media_files: Vec<ChapterMediaFileRef>,
) -> Result<String, String> {
    let dir = backup_temp_dir(&app)?;
    for attempt in 0..16 {
        let path = backup_temp_path(&dir, attempt);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                if let Err(err) = write_backup_zip_file(
                    Some(app.clone()),
                    file,
                    manifest_json,
                    chapter_media.clone(),
                    chapter_media_files.clone(),
                    "backup_pack_temp_file",
                ) {
                    let _ = fs::remove_file(&path);
                    return Err(err);
                }
                return Ok(path.to_string_lossy().into_owned());
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(format!("backup_pack_temp_file: create temp file: {err}"));
            }
        }
    }
    Err("backup_pack_temp_file: failed to allocate a temp file".to_string())
}

fn backup_zip_bytes(
    app: Option<AppHandle>,
    manifest_json: String,
    chapter_media: Vec<ChapterMediaContent>,
    chapter_media_files: Vec<ChapterMediaFileRef>,
) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    write_manifest_entry(&mut zip, &manifest_json, "backup_pack_bytes")?;
    let mut total_uncompressed_bytes = 0;
    write_chapter_media_entries(
        &mut zip,
        &chapter_media,
        "backup_pack_bytes",
        &mut total_uncompressed_bytes,
    )?;
    if !chapter_media_files.is_empty() {
        let app = app
            .as_ref()
            .ok_or_else(|| "backup_pack_bytes: app handle required for media refs".to_string())?;
        write_chapter_media_file_ref_entries(
            app,
            &mut zip,
            &chapter_media_files,
            "backup_pack_bytes",
            &mut total_uncompressed_bytes,
        )?;
    }
    let cursor = zip
        .finish()
        .map_err(|err| format!("backup_pack_bytes: finalize: {err}"))?;
    Ok(cursor.into_inner())
}

async fn backup_blocking<T, F>(operation: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("{operation}: blocking task failed: {err}"))?
}

/// Write a backup zip to `output_path`.
///
/// `manifest_json` should be the output of TS-side
/// `encodeBackupManifest(...)`; this command does not validate or
/// reshape it; the JS side owns the schema.
#[tauri::command]
pub async fn backup_pack(
    app: AppHandle,
    manifest_json: String,
    chapter_media: Option<Vec<ChapterMediaContent>>,
    chapter_media_files: Option<Vec<ChapterMediaFileRef>>,
    output_path: String,
) -> Result<(), String> {
    let chapter_media = chapter_media.unwrap_or_default();
    let chapter_media_files = chapter_media_files.unwrap_or_default();
    backup_blocking("backup_pack", move || {
        write_backup_zip(
            Some(app),
            manifest_json,
            chapter_media,
            chapter_media_files,
            output_path,
        )
    })
    .await
}

#[tauri::command]
pub async fn backup_pack_temp_file(
    app: AppHandle,
    manifest_json: String,
    chapter_media: Option<Vec<ChapterMediaContent>>,
    chapter_media_files: Option<Vec<ChapterMediaFileRef>>,
) -> Result<String, String> {
    let chapter_media = chapter_media.unwrap_or_default();
    let chapter_media_files = chapter_media_files.unwrap_or_default();
    backup_blocking("backup_pack_temp_file", move || {
        write_backup_temp_file(app, manifest_json, chapter_media, chapter_media_files)
    })
    .await
}

#[tauri::command]
pub fn backup_delete_temp_file(app: AppHandle, path: String) -> Result<(), String> {
    let temp_dir = backup_temp_dir(&app)?;
    let temp_dir = temp_dir
        .canonicalize()
        .map_err(|err| format!("backup_delete_temp_file: temp dir: {err}"))?;
    let path = PathBuf::from(path);
    let file_path = path
        .canonicalize()
        .map_err(|err| format!("backup_delete_temp_file: temp file: {err}"))?;
    if !file_path.starts_with(&temp_dir) {
        return Err("backup_delete_temp_file: path is outside backup temp dir".to_string());
    }
    fs::remove_file(&file_path).map_err(|err| format!("backup_delete_temp_file: remove: {err}"))
}

fn backup_staging_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(backup_temp_dir(app)?.join(BACKUP_STAGING_DIR))
}

fn prepare_backup_staging_root(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|err| format!("backup_unpack_staged: create root: {err}"))?;
    root.canonicalize()
        .map_err(|err| format!("backup_unpack_staged: canonicalize root: {err}"))
}

fn validate_backup_stage_token(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(format!("backup_unpack_staged: invalid {label}"));
    }
    Ok(())
}

fn allocate_backup_staging_dir(app: &AppHandle) -> Result<(String, PathBuf), String> {
    let root = prepare_backup_staging_root(&backup_staging_root(app)?)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    for attempt in 0..16_u32 {
        let staging_id = format!("restore-{now}-{attempt}");
        let path = root.join(&staging_id);
        match fs::create_dir(&path) {
            Ok(()) => {
                let path = path.canonicalize().map_err(|err| {
                    format!("backup_unpack_staged: canonicalize staging dir: {err}")
                })?;
                if !path.starts_with(&root) {
                    return Err("backup_unpack_staged: staging dir escaped root".to_string());
                }
                return Ok((staging_id, path));
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("backup_unpack_staged: create staging dir: {err}")),
        }
    }
    Err("backup_unpack_staged: failed to allocate staging dir".to_string())
}

fn backup_staging_dir(root: &Path, staging_id: &str) -> Result<PathBuf, String> {
    validate_backup_stage_token(staging_id, "staging id")?;
    let root = prepare_backup_staging_root(root)?;
    let path = root.join(staging_id);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|err| format!("backup_unpack_staged: inspect staging dir: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("backup_unpack_staged: staging path is not a directory".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|err| format!("backup_unpack_staged: canonicalize staging dir: {err}"))?;
    if !path.starts_with(&root) {
        return Err("backup_unpack_staged: staging dir escaped root".to_string());
    }
    Ok(path)
}

fn backup_staged_media_path(
    app: &AppHandle,
    staging_id: &str,
    staged_ref: &str,
) -> Result<PathBuf, String> {
    validate_backup_stage_token(staged_ref, "staged ref")?;
    let dir = backup_staging_dir(&backup_staging_root(app)?, staging_id)?;
    let path = dir.join(staged_ref);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|err| format!("backup_restore_staged_media: inspect staged file: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("backup_restore_staged_media: staged path is not a file".to_string());
    }
    let path = path
        .canonicalize()
        .map_err(|err| format!("backup_restore_staged_media: canonicalize staged file: {err}"))?;
    if !path.starts_with(&dir) {
        return Err("backup_restore_staged_media: staged file escaped staging dir".to_string());
    }
    Ok(path)
}

fn remove_backup_staging_dir(app: &AppHandle, staging_id: &str) -> Result<(), String> {
    let dir = backup_staging_dir(&backup_staging_root(app)?, staging_id)?;
    fs::remove_dir_all(&dir)
        .map_err(|err| format!("backup_cleanup_staged_unpack: remove staging dir: {err}"))
}

#[tauri::command]
pub async fn backup_cleanup_staged_unpack(
    app: AppHandle,
    staging_id: String,
) -> Result<(), String> {
    backup_blocking("backup_cleanup_staged_unpack", move || {
        remove_backup_staging_dir(&app, &staging_id)
    })
    .await
}

#[tauri::command]
pub async fn backup_pack_bytes(
    app: AppHandle,
    manifest_json: String,
    chapter_media: Option<Vec<ChapterMediaContent>>,
    chapter_media_files: Option<Vec<ChapterMediaFileRef>>,
) -> Result<Vec<u8>, String> {
    let chapter_media = chapter_media.unwrap_or_default();
    let chapter_media_files = chapter_media_files.unwrap_or_default();
    backup_blocking("backup_pack_bytes", move || {
        backup_zip_bytes(Some(app), manifest_json, chapter_media, chapter_media_files)
    })
    .await
}

#[tauri::command]
pub async fn backup_restore_snapshot(
    db_instances: State<'_, DbInstances>,
    manifest_json: String,
    media_bytes_by_chapter_id: HashMap<i64, i64>,
) -> Result<(), String> {
    let manifest: BackupRestoreManifest = serde_json::from_str(&manifest_json)
        .map_err(|err| format!("backup_restore_snapshot: parse manifest: {err}"))?;
    let pool = {
        let instances = db_instances.0.read().await;
        match instances.get(DB_URL) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            None => return Err("backup_restore_snapshot: norea.db is not loaded".to_string()),
        }
    };
    let mut tx = pool
        .begin()
        .await
        .map_err(|err| format!("backup_restore_snapshot: begin transaction: {err}"))?;

    if let Err(error) = execute_restore_snapshot(&mut tx, manifest, media_bytes_by_chapter_id).await
    {
        let _ = tx.rollback().await;
        return Err(error);
    }

    tx.commit()
        .await
        .map_err(|err| format!("backup_restore_snapshot: commit transaction: {err}"))?;
    Ok(())
}

/// Read a backup zip from `input_path` and return the manifest JSON
/// plus every `chapters/<id>.html` and chapter media entry.
///
/// Unrelated entries (foreign tools writing extra files) are skipped
/// silently. Missing `manifest.json` is an error.
fn read_backup_archive<R: Read + Seek>(reader: R) -> Result<UnpackedBackup, String> {
    read_backup_archive_with_limits(reader, BackupArchiveLimits::DEFAULT)
}

fn ensure_entry_declared_size(
    name: &str,
    entry_kind: &str,
    size: u64,
    max_size: u64,
) -> Result<(), String> {
    if size > max_size {
        return Err(format!(
            "backup_unpack: {entry_kind} entry '{name}' is {size} bytes, which exceeds the {max_size} byte limit"
        ));
    }
    Ok(())
}

fn read_limited_bytes<R: Read>(
    reader: &mut R,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 8192];

    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("backup_unpack: read {label}: {err}"))?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| format!("backup_unpack: read {label}: byte count overflow"))?;
        if total > max_bytes {
            return Err(format!(
                "backup_unpack: {label} exceeds the {max_bytes} byte limit"
            ));
        }
        output.extend_from_slice(&buffer[..read]);
    }

    Ok(output)
}

fn read_limited_string<R: Read>(
    reader: &mut R,
    max_bytes: u64,
    label: &str,
) -> Result<String, String> {
    let bytes = read_limited_bytes(reader, max_bytes, label)?;
    String::from_utf8(bytes)
        .map_err(|err| format!("backup_unpack: {label} is not valid UTF-8: {err}"))
}

fn read_backup_archive_with_limits<R: Read + Seek>(
    reader: R,
    limits: BackupArchiveLimits,
) -> Result<UnpackedBackup, String> {
    let mut archive =
        ZipArchive::new(reader).map_err(|err| format!("backup_unpack: not a valid zip: {err}"))?;

    if archive.len() > limits.max_entries {
        return Err(format!(
            "backup_unpack: archive has {} entries, which exceeds the {} entry limit",
            archive.len(),
            limits.max_entries
        ));
    }

    let mut manifest_json: Option<String> = None;
    let mut chapters: Vec<ChapterContent> = Vec::new();
    let mut chapter_media: Vec<ChapterMediaContent> = Vec::new();
    let mut budget = BackupArchiveReadBudget::new(limits);

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("backup_unpack: read entry {index}: {err}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let declared_size = entry.size();
        budget.validate_declared_entry(&name, declared_size, entry.compressed_size())?;

        if name == MANIFEST_ENTRY {
            ensure_entry_declared_size(
                &name,
                "manifest",
                declared_size,
                limits.max_manifest_bytes,
            )?;
            let buf = read_limited_string(&mut entry, limits.max_manifest_bytes, "manifest")?;
            budget.validate_actual_entry_size(&name, declared_size, buf.len() as u64)?;
            manifest_json = Some(buf);
            continue;
        }

        if let Some(rest) = name.strip_prefix(CHAPTERS_PREFIX) {
            if let Some(stem) = rest.strip_suffix(CHAPTER_SUFFIX) {
                let Ok(id) = stem.parse::<i64>() else {
                    continue;
                };
                ensure_entry_declared_size(
                    &name,
                    "chapter HTML",
                    declared_size,
                    limits.max_chapter_html_bytes,
                )?;
                let html = read_limited_string(&mut entry, limits.max_chapter_html_bytes, &name)?;
                budget.validate_actual_entry_size(&name, declared_size, html.len() as u64)?;
                chapters.push(ChapterContent { id, html });
            }
            continue;
        }

        if let Some((chapter_id, media_src)) = chapter_media_from_backup_entry(&name) {
            ensure_entry_declared_size(
                &name,
                "chapter media",
                declared_size,
                limits.max_media_entry_bytes,
            )?;
            let body = read_limited_bytes(&mut entry, limits.max_media_entry_bytes, &name)?;
            budget.validate_actual_entry_size(&name, declared_size, body.len() as u64)?;
            chapter_media.push(ChapterMediaContent {
                media_src,
                chapter_id: Some(chapter_id),
                body,
            });
        }
    }

    let manifest_json = manifest_json
        .ok_or_else(|| "backup_unpack: archive is missing manifest.json".to_string())?;

    Ok(UnpackedBackup {
        manifest_json,
        chapters,
        chapter_media,
    })
}

fn write_limited_staged_file<R: Read>(
    reader: &mut R,
    stage_dir: &Path,
    staged_ref: &str,
    max_bytes: u64,
    label: &str,
) -> Result<u64, String> {
    validate_backup_stage_token(staged_ref, "staged ref")?;
    fs::create_dir_all(stage_dir)
        .map_err(|err| format!("backup_unpack_staged: create staging dir: {err}"))?;
    let stage_dir = stage_dir
        .canonicalize()
        .map_err(|err| format!("backup_unpack_staged: canonicalize staging dir: {err}"))?;
    let final_path = stage_dir.join(staged_ref);
    let part_path = stage_dir.join(format!("{staged_ref}.part"));
    if !final_path.starts_with(&stage_dir) || !part_path.starts_with(&stage_dir) {
        return Err("backup_unpack_staged: staged file escaped staging dir".to_string());
    }
    let _ = fs::remove_file(&part_path);

    let result = (|| -> Result<u64, String> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|err| format!("backup_unpack_staged: create staged file: {err}"))?;
        let mut total = 0_u64;
        let mut buffer = [0_u8; 8192];

        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|err| format!("backup_unpack_staged: read {label}: {err}"))?;
            if read == 0 {
                break;
            }
            total = total.checked_add(read as u64).ok_or_else(|| {
                format!("backup_unpack_staged: read {label}: byte count overflow")
            })?;
            if total > max_bytes {
                return Err(format!(
                    "backup_unpack_staged: {label} exceeds the {max_bytes} byte limit"
                ));
            }
            output
                .write_all(&buffer[..read])
                .map_err(|err| format!("backup_unpack_staged: write staged file: {err}"))?;
        }
        output
            .flush()
            .map_err(|err| format!("backup_unpack_staged: flush staged file: {err}"))?;
        drop(output);
        fs::rename(&part_path, &final_path)
            .map_err(|err| format!("backup_unpack_staged: finalize staged file: {err}"))?;
        Ok(total)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&final_path);
    }
    result
}

fn read_backup_archive_staged_with_limits<R: Read + Seek>(
    reader: R,
    stage_dir: &Path,
    staging_id: String,
    limits: BackupArchiveLimits,
) -> Result<StagedUnpackedBackup, String> {
    let mut archive = ZipArchive::new(reader)
        .map_err(|err| format!("backup_unpack_staged: not a valid zip: {err}"))?;

    if archive.len() > limits.max_entries {
        return Err(format!(
            "backup_unpack_staged: archive has {} entries, which exceeds the {} entry limit",
            archive.len(),
            limits.max_entries
        ));
    }

    let mut manifest_json: Option<String> = None;
    let mut chapters: Vec<ChapterContent> = Vec::new();
    let mut chapter_media: Vec<StagedChapterMediaContent> = Vec::new();
    let mut budget = BackupArchiveReadBudget::new(limits);

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("backup_unpack_staged: read entry {index}: {err}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let declared_size = entry.size();
        budget.validate_declared_entry(&name, declared_size, entry.compressed_size())?;

        if name == MANIFEST_ENTRY {
            ensure_entry_declared_size(
                &name,
                "manifest",
                declared_size,
                limits.max_manifest_bytes,
            )?;
            let buf = read_limited_string(&mut entry, limits.max_manifest_bytes, "manifest")?;
            budget.validate_actual_entry_size(&name, declared_size, buf.len() as u64)?;
            manifest_json = Some(buf);
            continue;
        }

        if let Some(rest) = name.strip_prefix(CHAPTERS_PREFIX) {
            if let Some(stem) = rest.strip_suffix(CHAPTER_SUFFIX) {
                let Ok(id) = stem.parse::<i64>() else {
                    continue;
                };
                ensure_entry_declared_size(
                    &name,
                    "chapter HTML",
                    declared_size,
                    limits.max_chapter_html_bytes,
                )?;
                let html = read_limited_string(&mut entry, limits.max_chapter_html_bytes, &name)?;
                budget.validate_actual_entry_size(&name, declared_size, html.len() as u64)?;
                chapters.push(ChapterContent { id, html });
            }
            continue;
        }

        if let Some((chapter_id, media_src)) = chapter_media_from_backup_entry(&name) {
            ensure_entry_declared_size(
                &name,
                "chapter media",
                declared_size,
                limits.max_media_entry_bytes,
            )?;
            let staged_ref = format!("media-{}.bin", chapter_media.len());
            let bytes = write_limited_staged_file(
                &mut entry,
                stage_dir,
                &staged_ref,
                limits.max_media_entry_bytes,
                &name,
            )?;
            budget.validate_actual_entry_size(&name, declared_size, bytes)?;
            chapter_media.push(StagedChapterMediaContent {
                media_src,
                chapter_id: Some(chapter_id),
                staged_ref,
                bytes,
            });
        }
    }

    let manifest_json = manifest_json
        .ok_or_else(|| "backup_unpack_staged: archive is missing manifest.json".to_string())?;

    Ok(StagedUnpackedBackup {
        manifest_json,
        chapters,
        staging_id: if chapter_media.is_empty() {
            None
        } else {
            Some(staging_id)
        },
        chapter_media,
    })
}

#[tauri::command]
pub async fn backup_unpack(input_path: String) -> Result<UnpackedBackup, String> {
    backup_blocking("backup_unpack", move || unpack_backup_path(input_path)).await
}

fn ensure_backup_archive_size(size: u64) -> Result<(), String> {
    if size > MAX_BACKUP_ARCHIVE_BYTES {
        return Err(format!(
            "backup_unpack: archive is {size} bytes, which exceeds the {MAX_BACKUP_ARCHIVE_BYTES} byte limit"
        ));
    }
    Ok(())
}

fn unpack_backup_path(input_path: String) -> Result<UnpackedBackup, String> {
    let file = File::open(&input_path)
        .map_err(|err| format!("backup_unpack: failed to open '{input_path}': {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("backup_unpack: failed to inspect '{input_path}': {err}"))?;
    ensure_backup_archive_size(metadata.len())?;
    read_backup_archive(BufReader::new(file))
}

fn unpack_backup_path_staged(
    app: AppHandle,
    input_path: String,
) -> Result<StagedUnpackedBackup, String> {
    let file = File::open(&input_path)
        .map_err(|err| format!("backup_unpack_staged: failed to open '{input_path}': {err}"))?;
    let metadata = file
        .metadata()
        .map_err(|err| format!("backup_unpack_staged: failed to inspect '{input_path}': {err}"))?;
    ensure_backup_archive_size(metadata.len())?;
    let (staging_id, stage_dir) = allocate_backup_staging_dir(&app)?;
    let result = read_backup_archive_staged_with_limits(
        BufReader::new(file),
        &stage_dir,
        staging_id,
        BackupArchiveLimits::DEFAULT,
    );
    match result {
        Ok(unpacked) => {
            if unpacked.chapter_media.is_empty() {
                let _ = fs::remove_dir_all(&stage_dir);
            }
            Ok(unpacked)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&stage_dir);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn backup_unpack_staged(
    app: AppHandle,
    input_path: String,
) -> Result<StagedUnpackedBackup, String> {
    backup_blocking("backup_unpack_staged", move || {
        unpack_backup_path_staged(app, input_path)
    })
    .await
}

#[tauri::command]
pub async fn backup_unpack_bytes(body: Vec<u8>) -> Result<UnpackedBackup, String> {
    backup_blocking("backup_unpack_bytes", move || {
        unpack_backup_bytes_body(body)
    })
    .await
}

fn unpack_backup_bytes_body(body: Vec<u8>) -> Result<UnpackedBackup, String> {
    ensure_backup_archive_size(body.len() as u64)?;
    read_backup_archive(Cursor::new(body))
}

fn unpack_backup_bytes_staged_body(
    app: AppHandle,
    body: Vec<u8>,
) -> Result<StagedUnpackedBackup, String> {
    ensure_backup_archive_size(body.len() as u64)?;
    let (staging_id, stage_dir) = allocate_backup_staging_dir(&app)?;
    let result = read_backup_archive_staged_with_limits(
        Cursor::new(body),
        &stage_dir,
        staging_id,
        BackupArchiveLimits::DEFAULT,
    );
    match result {
        Ok(unpacked) => {
            if unpacked.chapter_media.is_empty() {
                let _ = fs::remove_dir_all(&stage_dir);
            }
            Ok(unpacked)
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&stage_dir);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn backup_unpack_bytes_staged(
    app: AppHandle,
    body: Vec<u8>,
) -> Result<StagedUnpackedBackup, String> {
    backup_blocking("backup_unpack_bytes_staged", move || {
        unpack_backup_bytes_staged_body(app, body)
    })
    .await
}

#[tauri::command]
pub async fn backup_restore_staged_media(
    app: AppHandle,
    staging_id: String,
    staged_ref: String,
    chapter_id: i64,
    file_name: String,
    novel_id: Option<i64>,
    source_id: Option<String>,
    novel_name: Option<String>,
    novel_path: Option<String>,
    chapter_number: Option<String>,
    chapter_name: Option<String>,
    chapter_position: Option<i64>,
) -> Result<String, String> {
    let staged_path = backup_staged_media_path(&app, &staging_id, &staged_ref)?;
    backup_blocking("backup_restore_staged_media", move || {
        store_chapter_media_file_source(
            &app,
            staged_path,
            chapter_id,
            file_name,
            novel_id,
            source_id,
            novel_name,
            novel_path,
            chapter_number,
            chapter_name,
            chapter_position,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_limits() -> BackupArchiveLimits {
        BackupArchiveLimits {
            max_entries: 8,
            max_manifest_bytes: 16,
            max_chapter_html_bytes: 16,
            max_media_entry_bytes: 4,
            max_total_uncompressed_bytes: 64,
            max_compression_ratio: MAX_BACKUP_COMPRESSION_RATIO,
        }
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, body) in entries {
            zip.start_file(*name, options).expect("start file");
            zip.write_all(body).expect("write file");
        }
        zip.finish().expect("finish").into_inner()
    }

    #[test]
    fn media_repair_detection_ignores_local_media_refs() {
        assert_eq!(
            chapter_media_repair_needed(
                Some(r#"<img src="norea-media://chapter/7/page.png">"#),
                Some("html"),
            ),
            0
        );
    }

    #[test]
    fn media_repair_detection_flags_remote_media_refs() {
        assert_eq!(
            chapter_media_repair_needed(
                Some(r#"<img src="https://cdn.example/page.png">"#),
                Some("html"),
            ),
            1
        );
        assert_eq!(
            chapter_media_repair_needed(
                Some(r#"<p style="background-image: url(//cdn.example/page.png)"></p>"#),
                Some("html"),
            ),
            1
        );
    }

    #[test]
    fn pack_then_unpack_round_trips_manifest_only() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("backup.zip");
        let zip_path_str = zip_path.to_string_lossy().to_string();

        let manifest_json = r#"{"version":1,"exportedAt":1700000000}"#.to_string();

        write_backup_zip(
            None,
            manifest_json.clone(),
            Vec::new(),
            Vec::new(),
            zip_path_str.clone(),
        )
        .expect("pack");

        let unpacked = unpack_backup_path(zip_path_str).expect("unpack");
        assert_eq!(unpacked.manifest_json, manifest_json);
        assert!(unpacked.chapters.is_empty());
        assert!(unpacked.chapter_media.is_empty());
    }

    #[test]
    fn pack_includes_chapter_media_entries() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("backup.zip");
        let zip_path_str = zip_path.to_string_lossy().to_string();
        let manifest_json = r#"{"version":1,"exportedAt":1700000000}"#.to_string();

        write_backup_zip(
            None,
            manifest_json.clone(),
            vec![ChapterMediaContent {
                media_src: "norea-media://chapter/image.png".to_string(),
                chapter_id: Some(10),
                body: vec![1, 2, 3, 4],
            }],
            Vec::new(),
            zip_path_str.clone(),
        )
        .expect("pack");

        let unpacked = unpack_backup_path(zip_path_str).expect("unpack");
        assert_eq!(unpacked.manifest_json, manifest_json);
        assert_eq!(unpacked.chapter_media.len(), 1);
        assert_eq!(
            unpacked.chapter_media[0].media_src.as_str(),
            "norea-media://chapter/image.png"
        );
        assert_eq!(unpacked.chapter_media[0].chapter_id, Some(10));
        assert_eq!(unpacked.chapter_media[0].body.as_slice(), &[1, 2, 3, 4]);
    }

    #[test]
    fn unpack_accepts_chapter_media() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("backup.zip");
        let zip_path_str = zip_path.to_string_lossy().to_string();

        let file = File::create(&zip_path).expect("create");
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(MANIFEST_ENTRY, options).expect("manifest");
        zip.write_all(br#"{"version":1,"exportedAt":1700000000}"#)
            .expect("manifest body");
        zip.start_file("chapter-media/10/image.png", options)
            .expect("media");
        zip.write_all(&[1, 2, 3, 4]).expect("media body");
        zip.finish().expect("finish");

        let unpacked = unpack_backup_path(zip_path_str).expect("unpack");
        assert_eq!(unpacked.chapter_media.len(), 1);
        assert_eq!(
            unpacked.chapter_media[0].media_src.as_str(),
            "norea-media://chapter/image.png"
        );
        assert_eq!(unpacked.chapter_media[0].chapter_id, Some(10));
        assert_eq!(unpacked.chapter_media[0].body.as_slice(), &[1, 2, 3, 4]);
    }

    #[test]
    fn staged_unpack_writes_chapter_media_refs_without_bodies() {
        let dir = tempdir().expect("tempdir");
        let stage_dir = dir.path().join("stage-1");
        let body = zip_bytes(&[
            (MANIFEST_ENTRY, br#"{}"#),
            ("chapter-media/10/image.png", &[1, 2, 3, 4]),
        ]);

        let unpacked = read_backup_archive_staged_with_limits(
            Cursor::new(body),
            &stage_dir,
            "stage-1".to_string(),
            test_limits(),
        )
        .expect("staged unpack");

        assert_eq!(unpacked.manifest_json, r#"{}"#);
        assert_eq!(unpacked.staging_id.as_deref(), Some("stage-1"));
        assert_eq!(unpacked.chapter_media.len(), 1);
        assert_eq!(
            unpacked.chapter_media[0].media_src.as_str(),
            "norea-media://chapter/image.png"
        );
        assert_eq!(unpacked.chapter_media[0].chapter_id, Some(10));
        assert_eq!(unpacked.chapter_media[0].staged_ref.as_str(), "media-0.bin");
        assert_eq!(unpacked.chapter_media[0].bytes, 4);
        assert_eq!(
            fs::read(stage_dir.join("media-0.bin")).expect("staged media"),
            vec![1, 2, 3, 4]
        );
    }

    #[test]
    fn staged_unpack_rejects_oversized_media_without_staged_file() {
        let dir = tempdir().expect("tempdir");
        let stage_dir = dir.path().join("stage-1");
        let media = vec![1, 2, 3, 4, 5];
        let body = zip_bytes(&[
            (MANIFEST_ENTRY, br#"{}"#),
            ("chapter-media/10/image.png", media.as_slice()),
        ]);

        let result = read_backup_archive_staged_with_limits(
            Cursor::new(body),
            &stage_dir,
            "stage-1".to_string(),
            test_limits(),
        );

        assert!(result.is_err());
        let entries = fs::read_dir(&stage_dir)
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(entries, 0);
    }

    #[test]
    fn unpack_rejects_archive_without_manifest() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("no-manifest.zip");

        // Build a zip with only a chapter entry, no manifest.json.
        let file = File::create(&zip_path).expect("create");
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("chapters/1.html", options).expect("start");
        zip.write_all(b"<p>orphan</p>").expect("write");
        zip.finish().expect("finish");

        let result = unpack_backup_path(zip_path.to_string_lossy().to_string());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("manifest.json"), "error was: {err}");
    }

    #[test]
    fn unpack_skips_unknown_entries() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("with-junk.zip");

        let file = File::create(&zip_path).expect("create");
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file(MANIFEST_ENTRY, options).expect("manifest");
        zip.write_all(br#"{"version":1,"exportedAt":0}"#)
            .expect("manifest body");
        zip.start_file("README.txt", options).expect("readme");
        zip.write_all(b"ignore me").expect("readme body");
        zip.start_file("chapters/not-a-number.html", options)
            .expect("bad name");
        zip.write_all(b"ignored").expect("bad body");
        zip.start_file("chapters/42.html", options).expect("good");
        zip.write_all(b"<p>kept</p>").expect("good body");
        zip.finish().expect("finish");

        let unpacked = unpack_backup_path(zip_path.to_string_lossy().to_string()).expect("unpack");
        assert_eq!(unpacked.chapters.len(), 1);
        assert_eq!(unpacked.chapters[0].id, 42);
        assert_eq!(unpacked.chapters[0].html, "<p>kept</p>");
    }

    #[test]
    fn unpack_rejects_oversized_manifest_entry() {
        let limits = BackupArchiveLimits {
            max_manifest_bytes: 4,
            ..test_limits()
        };
        let body = zip_bytes(&[(MANIFEST_ENTRY, br#"{"version":1}"#)]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("manifest"), "error was: {err}");
        assert!(err.contains("byte limit"), "error was: {err}");
    }

    #[test]
    fn unpack_rejects_oversized_media_entry() {
        let media = vec![1, 2, 3, 4, 5];
        let body = zip_bytes(&[
            (MANIFEST_ENTRY, br#"{}"#),
            ("chapter-media/10/image.png", media.as_slice()),
        ]);

        let result = read_backup_archive_with_limits(Cursor::new(body), test_limits());

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("chapter media"), "error was: {err}");
        assert!(err.contains("byte limit"), "error was: {err}");
    }

    #[test]
    fn unpack_rejects_excessive_entry_count() {
        let limits = BackupArchiveLimits {
            max_entries: 1,
            ..test_limits()
        };
        let body = zip_bytes(&[(MANIFEST_ENTRY, br#"{}"#), ("README.txt", b"extra")]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("entries"), "error was: {err}");
    }

    #[test]
    fn unpack_rejects_excessive_total_uncompressed_size() {
        let limits = BackupArchiveLimits {
            max_media_entry_bytes: 16,
            max_total_uncompressed_bytes: 6,
            ..test_limits()
        };
        let media = vec![1, 2, 3, 4, 5];
        let body = zip_bytes(&[
            (MANIFEST_ENTRY, br#"{}"#),
            ("chapter-media/10/image.png", media.as_slice()),
        ]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("total uncompressed"), "error was: {err}");
    }

    #[test]
    fn unpack_rejects_excessive_compression_ratio() {
        let limits = BackupArchiveLimits {
            max_media_entry_bytes: 2 * BYTES_PER_MIB,
            max_total_uncompressed_bytes: 2 * BYTES_PER_MIB,
            max_compression_ratio: 2,
            ..test_limits()
        };
        let media = vec![0; MIN_BACKUP_RATIO_CHECK_BYTES as usize];
        let body = zip_bytes(&[
            (MANIFEST_ENTRY, br#"{}"#),
            ("chapter-media/10/image.png", media.as_slice()),
        ]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("compression ratio"), "error was: {err}");
    }
}
