//! Backup archive pack / unpack.
//!
//! Current exports write a single entry:
//!
//! ```text
//! manifest.json
//! ```
//!
//! The manifest carries library, progress, category, repository, plugin,
//! and chapter download metadata. Chapter bodies and media stay in chapter
//! storage. Only the current manifest-only archive format is supported.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, Cursor, Read, Seek, Write};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::Sqlite;
use tauri::{AppHandle, Manager, State, async_runtime};
use tauri_plugin_sql::{DbInstances, DbPool};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const BYTES_PER_MIB: u64 = 1024 * 1024;
const MANIFEST_ENTRY: &str = "manifest.json";
const DB_URL: &str = "sqlite:norea.db";
const BACKUP_TEMP_DIR: &str = "backup";
const MAX_BACKUP_ARCHIVE_BYTES: u64 = 2 * 1024 * BYTES_PER_MIB;
const MAX_BACKUP_ZIP_ENTRIES: usize = 1;
const MAX_BACKUP_MANIFEST_BYTES: u64 = 256 * BYTES_PER_MIB;
const MAX_BACKUP_TOTAL_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * BYTES_PER_MIB;
const MAX_BACKUP_COMPRESSION_RATIO: u64 = 200;
const MIN_BACKUP_RATIO_CHECK_BYTES: u64 = BYTES_PER_MIB;

#[derive(Debug, Clone, Copy)]
struct BackupArchiveLimits {
    max_entries: usize,
    max_manifest_bytes: u64,
    max_total_uncompressed_bytes: u64,
    max_compression_ratio: u64,
}

impl BackupArchiveLimits {
    const DEFAULT: Self = Self {
        max_entries: MAX_BACKUP_ZIP_ENTRIES,
        max_manifest_bytes: MAX_BACKUP_MANIFEST_BYTES,
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

/// Result of `backup_unpack`: the current manifest JSON.
#[derive(Debug, Serialize)]
pub struct UnpackedBackup {
    pub manifest_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreManifest {
    version: u32,
    novels: Vec<BackupRestoreNovel>,
    chapters: Vec<BackupRestoreChapter>,
    categories: Vec<BackupRestoreCategory>,
    novel_categories: Vec<BackupRestoreNovelCategory>,
    repositories: Vec<BackupRestoreRepository>,
    installed_plugins: Vec<BackupRestoreInstalledPlugin>,
    vpn_gate_server_verdicts: Vec<BackupRestoreVpnGateServerVerdict>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreNovel {
    id: i64,
    source_novel_id: Option<String>,
    plugin_id: String,
    path: String,
    name: String,
    cover: Option<String>,
    summary: Option<String>,
    author: Option<String>,
    artist: Option<String>,
    status: Option<String>,
    genres: Option<String>,
    rating: Option<f64>,
    in_library: bool,
    is_local: bool,
    created_at: i64,
    updated_at: i64,
    library_added_at: Option<i64>,
    last_read_at: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreCache {
    files: Vec<BackupRestoreMetadataFile>,
    chapters: Vec<BackupRestoreChapterDirectory>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreMetadataFile {
    plugin_id: String,
    path: String,
    novel_id: i64,
    directory: String,
    fingerprint: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreChapterDirectory {
    chapter_id: i64,
    novel_id: i64,
    directory: String,
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
    content_type: String,
    source_content_type: String,
    content: Option<String>,
    content_bytes: i64,
    media_bytes: i64,
    release_time: Option<String>,
    read_at: Option<i64>,
    // Require the current-format key even when the creation time is unknown.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    created_at: Option<i64>,
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

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum BackupRestoreVpnGateServerVerdictValue {
    Works,
    Fails,
}

impl BackupRestoreVpnGateServerVerdictValue {
    fn as_str(self) -> &'static str {
        match self {
            Self::Works => "works",
            Self::Fails => "fails",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRestoreVpnGateServerVerdict {
    ip: String,
    verdict: BackupRestoreVpnGateServerVerdictValue,
    updated_at: i64,
}

fn bool_to_int(value: bool) -> i64 {
    if value { 1 } else { 0 }
}

async fn restore_vpn_gate_server_verdicts(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    verdicts: &[BackupRestoreVpnGateServerVerdict],
) -> Result<(), String> {
    for verdict in verdicts {
        let Ok(address) = verdict.ip.parse::<Ipv4Addr>() else {
            return Err(format!(
                "backup_restore_snapshot: VPN Gate server verdict IP '{}' must be a canonical IPv4 address",
                verdict.ip
            ));
        };
        if address.to_string() != verdict.ip {
            return Err(format!(
                "backup_restore_snapshot: VPN Gate server verdict IP '{}' must be a canonical IPv4 address",
                verdict.ip
            ));
        }
    }

    sqlx::query("DELETE FROM vpn_gate_server_verdict")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete vpn_gate_server_verdict: {err}"))?;

    for verdict in verdicts {
        sqlx::query(
            "INSERT INTO vpn_gate_server_verdict (ip, verdict, updated_at)
             VALUES ($1, $2, $3)",
        )
        .bind(verdict.ip.as_str())
        .bind(verdict.verdict.as_str())
        .bind(verdict.updated_at)
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: insert vpn_gate_server_verdict: {err}"))?;
    }

    Ok(())
}

async fn execute_restore_snapshot(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    manifest: BackupRestoreManifest,
    cache: &BackupRestoreCache,
) -> Result<(), String> {
    if manifest.version != 2 {
        return Err(format!(
            "backup_restore_snapshot: unsupported backup version {}",
            manifest.version
        ));
    }
    if manifest
        .chapters
        .iter()
        .any(|chapter| chapter.content.is_some())
    {
        return Err("backup_restore_snapshot: inline chapter bodies are not supported".to_string());
    }
    if manifest.repositories.len() > 1 {
        return Err("backup_restore_snapshot: at most one repository is supported".to_string());
    }
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
    sqlx::query("DELETE FROM installed_plugin")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: delete installed_plugin: {err}"))?;
    restore_vpn_gate_server_verdicts(tx, &manifest.vpn_gate_server_verdicts).await?;

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

    if let Some(repository) = manifest.repositories.first() {
        sqlx::query("INSERT INTO repository (id, url, name, added_at) VALUES ($1, $2, $3, $4)")
            .bind(repository.id)
            .bind(repository.url.as_str())
            .bind(repository.name.as_deref())
            .bind(repository.added_at)
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: insert repository: {err}"))?;
    }

    for plugin in &manifest.installed_plugins {
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

    for novel in &manifest.novels {
        sqlx::query(
            "INSERT INTO novel (
                id, plugin_id, path, name, cover, summary, author, artist,
                status, genres, in_library, is_local,
                created_at, updated_at, library_added_at, last_read_at, rating, source_novel_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
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
        .bind(novel.rating)
        .bind(novel.source_novel_id.as_deref())
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: insert novel: {err}"))?;
    }

    let stored_chapters: HashSet<_> = cache.chapters.iter()
        .map(|chapter| (chapter.novel_id, chapter.chapter_id)).collect();
    for chapter in &manifest.chapters {
        let restored_body = stored_chapters.contains(&(chapter.novel_id, chapter.id));
        let restored_downloaded = chapter.is_downloaded && restored_body;
        let restored_content_bytes = if restored_body {
            chapter.content_bytes
        } else {
            0
        };
        let restored_media_bytes = if restored_body {
            chapter.media_bytes
        } else {
            0
        };
        sqlx::query(
            "INSERT INTO chapter (
                id, novel_id, path, name, chapter_number, position, page,
                bookmark, unread, progress, is_downloaded, content_bytes,
                media_bytes, media_repair_needed, content_type,
                stored_content_type, release_time, read_at, created_at,
                found_at, updated_at
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
        .bind(restored_content_bytes)
        .bind(restored_media_bytes)
        .bind(bool_to_int(restored_body && !restored_downloaded))
        .bind(chapter.source_content_type.as_str())
        .bind(if restored_body {
            Some(chapter.content_type.as_str())
        } else {
            None
        })
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

    restore_metadata_cache(tx, cache).await
}

async fn restore_metadata_cache(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    cache: &BackupRestoreCache,
) -> Result<(), String> {
    for table in [
        "work_metadata_file_cache",
        "work_metadata_directory_cache",
        "work_metadata_reading_state",
        "chapter_download_queue",
        "download_cache_work",
    ] {
        sqlx::query(&format!("DELETE FROM {table}"))
            .execute(&mut **tx)
            .await
            .map_err(|err| format!("backup_restore_snapshot: clear {table}: {err}"))?;
    }
    sqlx::query("DELETE FROM content_sync_cache WHERE cache_key LIKE 'norea-content-source:%'")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: clear replaced novel source IDs: {err}"))?;
    for file in &cache.files {
        let result = sqlx::query(
            "INSERT INTO work_metadata_file_cache(plugin_id,path,novel_id,directory,fingerprint)
             SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM novel WHERE id=$3 AND plugin_id=$1 AND path=$2)",
        )
        .bind(&file.plugin_id)
        .bind(&file.path)
        .bind(file.novel_id)
        .bind(&file.directory)
        .bind(&file.fingerprint)
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: restore metadata cache: {err}"))?;
        if result.rows_affected() != 1 {
            return Err("backup_restore_snapshot: metadata cache identity mismatch".to_string());
        }
        sqlx::query(
            "INSERT INTO work_metadata_sync_journal(plugin_id,path,revision) VALUES($1,$2,1)
             ON CONFLICT(plugin_id,path) DO UPDATE SET revision=revision+1",
        )
        .bind(&file.plugin_id)
        .bind(&file.path)
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: mark retained metadata for sync: {err}"))?;
    }
    for chapter in &cache.chapters {
        let result = sqlx::query(
            "INSERT INTO work_metadata_directory_cache(chapter_id,novel_id,directory)
             SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM chapter WHERE id=$1 AND novel_id=$2 AND stored_content_type IS NOT NULL)",
        )
        .bind(chapter.chapter_id)
        .bind(chapter.novel_id)
        .bind(&chapter.directory)
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: restore chapter directories: {err}"))?;
        if result.rows_affected() != 1 {
            return Err("backup_restore_snapshot: chapter cache identity mismatch".to_string());
        }
    }
    sqlx::query(
        "INSERT INTO work_metadata_reading_state(plugin_id,novel_path,chapter_path,progress,bookmark,unread,read_at)
         SELECT n.plugin_id,n.path,c.path,c.progress,c.bookmark,c.unread,c.read_at FROM chapter c JOIN novel n ON n.id=c.novel_id",
    )
    .execute(&mut **tx)
    .await
    .map_err(|err| format!("backup_restore_snapshot: restore reading state cache: {err}"))?;
    sqlx::query("DELETE FROM work_metadata_dirty")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: discard file publication: {err}"))?;
    sqlx::query("INSERT OR IGNORE INTO work_metadata_cache_state(id) VALUES(1)")
        .execute(&mut **tx)
        .await
        .map_err(|err| format!("backup_restore_snapshot: initialize metadata cache: {err}"))?;
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

fn write_backup_zip_file<W: Write + Seek>(
    file: W,
    manifest_json: &str,
    error_prefix: &str,
) -> Result<(), String> {
    let mut zip = ZipWriter::new(BufWriter::new(file));
    write_manifest_entry(&mut zip, manifest_json, error_prefix)?;
    zip.finish()
        .map_err(|err| format!("{error_prefix}: finalize: {err}"))?;
    Ok(())
}

fn write_backup_zip(manifest_json: &str, output_path: &str) -> Result<(), String> {
    let file = File::create(output_path)
        .map_err(|err| format!("backup_pack: failed to create '{output_path}': {err}"))?;
    write_backup_zip_file(file, manifest_json, "backup_pack")
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

fn write_backup_temp_file(app: AppHandle, manifest_json: String) -> Result<String, String> {
    let dir = backup_temp_dir(&app)?;
    for attempt in 0..16 {
        let path = backup_temp_path(&dir, attempt);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                if let Err(err) =
                    write_backup_zip_file(file, &manifest_json, "backup_pack_temp_file")
                {
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

fn backup_zip_bytes(manifest_json: &str) -> Result<Vec<u8>, String> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    write_manifest_entry(&mut zip, manifest_json, "backup_pack_bytes")?;
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
pub async fn backup_pack(manifest_json: String, output_path: String) -> Result<(), String> {
    backup_blocking("backup_pack", move || {
        write_backup_zip(&manifest_json, &output_path)
    })
    .await
}

#[tauri::command]
pub async fn backup_pack_temp_file(
    app: AppHandle,
    manifest_json: String,
) -> Result<String, String> {
    backup_blocking("backup_pack_temp_file", move || {
        write_backup_temp_file(app, manifest_json)
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

#[tauri::command]
pub async fn backup_pack_bytes(manifest_json: String) -> Result<Vec<u8>, String> {
    backup_blocking("backup_pack_bytes", move || {
        backup_zip_bytes(&manifest_json)
    })
    .await
}

#[tauri::command]
pub async fn backup_restore_snapshot(
    db_instances: State<'_, DbInstances>,
    manifest_json: String,
    cache_json: String,
) -> Result<(), String> {
    let manifest: BackupRestoreManifest = serde_json::from_str(&manifest_json)
        .map_err(|err| format!("backup_restore_snapshot: parse manifest: {err}"))?;
    let cache: BackupRestoreCache = serde_json::from_str(&cache_json)
        .map_err(|err| format!("backup_restore_snapshot: parse storage cache: {err}"))?;
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

    if let Err(error) = execute_restore_snapshot(&mut tx, manifest, &cache).await {
        let _ = tx.rollback().await;
        return Err(error);
    }

    tx.commit()
        .await
        .map_err(|err| format!("backup_restore_snapshot: commit transaction: {err}"))?;
    Ok(())
}

/// Read the current manifest-only archive. Missing or extra entries are errors.
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
    let mut budget = BackupArchiveReadBudget::new(limits);

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("backup_unpack: read entry {index}: {err}"))?;
        let name = entry
            .name()
            .map_err(|err| format!("backup_unpack: read entry {index} name: {err}"))?
            .into_owned();
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

        return Err(format!("backup_unpack: unsupported archive entry '{name}'"));
    }

    let manifest_json = manifest_json
        .ok_or_else(|| "backup_unpack: archive is missing manifest.json".to_string())?;

    Ok(UnpackedBackup { manifest_json })
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

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use tempfile::tempdir;

    async fn vpn_gate_verdict_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect");
        sqlx::query(
            "CREATE TABLE vpn_gate_server_verdict (
                ip TEXT PRIMARY KEY NOT NULL,
                verdict TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .expect("create verdict table");
        pool
    }

    #[test]
    fn restore_manifest_rejects_an_unknown_vpn_gate_verdict() {
        let json = r#"{
            "version": 2,
            "installedPlugins": [],
            "novels": [],
            "chapters": [],
            "categories": [],
            "novelCategories": [],
            "repositories": [],
            "vpnGateServerVerdicts": [
                {"ip":"198.51.100.10","verdict":"unknown","updatedAt":1700000000}
            ]
        }"#;

        assert!(serde_json::from_str::<BackupRestoreManifest>(json).is_err());
    }

    #[tokio::test]
    async fn restore_vpn_gate_verdicts_replaces_rows_when_present() {
        let pool = vpn_gate_verdict_pool().await;
        sqlx::query(
            "INSERT INTO vpn_gate_server_verdict (ip, verdict, updated_at)
             VALUES ('198.51.100.10', 'works', 1700000000)",
        )
        .execute(&pool)
        .await
        .expect("seed verdict");
        let restored = vec![BackupRestoreVpnGateServerVerdict {
            ip: "203.0.113.20".to_string(),
            verdict: BackupRestoreVpnGateServerVerdictValue::Fails,
            updated_at: 1_700_000_001,
        }];
        let mut tx = pool.begin().await.expect("begin");

        restore_vpn_gate_server_verdicts(&mut tx, &restored)
            .await
            .expect("replace verdicts");
        tx.commit().await.expect("commit");

        let rows = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT ip, verdict, updated_at FROM vpn_gate_server_verdict",
        )
        .fetch_all(&pool)
        .await
        .expect("select verdicts");
        assert_eq!(
            rows,
            vec![(
                "203.0.113.20".to_string(),
                "fails".to_string(),
                1_700_000_001,
            )]
        );
    }

    #[tokio::test]
    async fn restore_vpn_gate_verdicts_rejects_non_canonical_ipv4() {
        let pool = vpn_gate_verdict_pool().await;
        let restored = vec![BackupRestoreVpnGateServerVerdict {
            ip: "198.051.100.10".to_string(),
            verdict: BackupRestoreVpnGateServerVerdictValue::Works,
            updated_at: 1_700_000_000,
        }];
        let mut tx = pool.begin().await.expect("begin");

        let error = restore_vpn_gate_server_verdicts(&mut tx, &restored)
            .await
            .expect_err("reject non-canonical IPv4 address");

        assert!(error.contains("canonical IPv4 address"));
    }

    async fn restore_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect");
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&pool)
            .await
            .expect("apply schema");
        pool
    }

    fn restore_chapter_json(id: i64, downloaded: bool, content: Option<&str>) -> String {
        let content = content
            .map(|value| format!("\"{value}\""))
            .unwrap_or_else(|| "null".to_string());
        format!(
            r#"{{"id":{id},"novelId":1,"path":"/c/{id}","name":"Chapter {id}","chapterNumber":"{id}","position":{id},"page":"1","bookmark":false,"unread":false,"progress":40,"isDownloaded":{downloaded},"contentType":"html","sourceContentType":"text","content":{content},"contentBytes":1234,"mediaBytes":56,"releaseTime":null,"readAt":7,"createdAt":1,"foundAt":1,"updatedAt":1}}"#
        )
    }

    #[test]
    fn restore_chapter_requires_a_present_nullable_creation_time() {
        let mut chapter: serde_json::Value =
            serde_json::from_str(&restore_chapter_json(10, false, None)).expect("parse chapter");
        chapter["createdAt"] = serde_json::Value::Null;
        let restored: BackupRestoreChapter =
            serde_json::from_value(chapter.clone()).expect("parse unknown creation time");
        assert_eq!(restored.created_at, None);

        chapter.as_object_mut().expect("chapter object").remove("createdAt");
        assert!(serde_json::from_value::<BackupRestoreChapter>(chapter.clone())
            .unwrap_err().to_string().contains("missing field `createdAt`"));
        for value in [serde_json::json!("unknown"), serde_json::json!(true), serde_json::json!(1.5)] {
            chapter["createdAt"] = value;
            assert!(serde_json::from_value::<BackupRestoreChapter>(chapter.clone()).is_err());
        }
    }

    #[tokio::test]
    async fn restore_snapshot_preserves_nullable_chapter_creation_times() {
        let pool = restore_pool().await;
        sqlx::raw_sql(
            "INSERT INTO novel(id,plugin_id,path,name) VALUES(1,'demo','/n/1','Novel');
             INSERT INTO chapter(id,novel_id,path,name,position) VALUES(10,1,'norea-folder:1','Recovered chapter',1);
             INSERT INTO chapter(id,novel_id,path,name,position,created_at,found_at) VALUES(12,1,'/c/12','Source chapter',2,123,456);",
        ).execute(&pool).await.expect("seed recovered and source chapters");
        let timestamps: Vec<(i64, Option<i64>, i64, i64)> = sqlx::query_as(
            "SELECT id,created_at,found_at,updated_at FROM chapter ORDER BY id",
        ).fetch_all(&pool).await.expect("read original timestamps");
        assert_eq!(timestamps[0].1, None);
        assert_eq!(timestamps[0].2, 0);
        let chapters: Vec<serde_json::Value> = timestamps.iter().map(|(id, created_at, found_at, updated_at)| {
            let mut chapter: serde_json::Value = serde_json::from_str(&restore_chapter_json(*id, false, None))
                .expect("parse chapter");
            chapter["createdAt"] = serde_json::json!(created_at);
            chapter["foundAt"] = serde_json::json!(found_at);
            chapter["updatedAt"] = serde_json::json!(updated_at);
            chapter
        }).collect();
        let manifest: BackupRestoreManifest = serde_json::from_value(serde_json::json!({
            "version": 2,
            "novels": [{ "id": 1, "pluginId": "demo", "path": "/n/1", "name": "Novel",
                "inLibrary": true, "isLocal": false, "createdAt": 1, "updatedAt": 1 }],
            "chapters": chapters, "categories": [], "novelCategories": [], "repositories": [],
            "installedPlugins": [], "vpnGateServerVerdicts": []
        })).expect("parse exported manifest");
        let mut tx = pool.begin().await.expect("begin");
        execute_restore_snapshot(&mut tx, manifest, &BackupRestoreCache::default())
            .await.expect("restore nullable creation time");
        tx.commit().await.expect("commit");

        let restored: Vec<(i64, Option<i64>, i64, i64)> = sqlx::query_as(
            "SELECT id,created_at,found_at,updated_at FROM chapter ORDER BY id",
        ).fetch_all(&pool).await.expect("read restored timestamps");
        assert_eq!(restored, timestamps);
    }

    #[tokio::test]
    async fn restore_snapshot_keeps_incomplete_chapter_bodies_and_directory_mappings() {
        let pool = restore_pool().await;
        let json = format!(
            r#"{{
                "version": 2,
                "installedPlugins": [],
                "vpnGateServerVerdicts": [],
                "novels": [{{"id":1,"pluginId":"demo","path":"/n/1","name":"Novel","inLibrary":true,"isLocal":false,"createdAt":1,"updatedAt":1}}],
                "chapters": [{}],
                "categories": [],
                "novelCategories": [],
                "repositories": []
            }}"#,
            restore_chapter_json(10, false, None),
        );
        let manifest: BackupRestoreManifest = serde_json::from_str(&json).expect("parse manifest");
        let cache: BackupRestoreCache = serde_json::from_value(serde_json::json!({
            "files": [{ "pluginId": "demo", "path": "/n/1", "novelId": 1,
                "directory": "contents/demo/book", "fingerprint": "retained-fingerprint" }],
            "chapters": [{ "chapterId": 10, "novelId": 1, "directory": "contents/demo/book/10" }]
        })).expect("parse retained file cache");
        let mut tx = pool.begin().await.expect("begin");
        execute_restore_snapshot(&mut tx, manifest, &cache).await.expect("restore");
        tx.commit().await.expect("commit");

        let row: (i64, i64, Option<String>) = sqlx::query_as(
            "SELECT is_downloaded,media_repair_needed,stored_content_type FROM chapter WHERE id=10",
        ).fetch_one(&pool).await.expect("read chapter");
        assert_eq!(row, (0, 1, Some("html".to_string())));
        let directory: String = sqlx::query_scalar(
            "SELECT directory FROM work_metadata_directory_cache WHERE chapter_id=10",
        ).fetch_one(&pool).await.expect("read retained directory");
        assert_eq!(directory, "contents/demo/book/10");
    }

    #[tokio::test]
    async fn restore_snapshot_marks_only_inspected_files_downloaded() {
        let pool = restore_pool().await;
        for key in ["norea-content-source:1", "norea-content-work:http://server", "norea-content-catalog:http://server", "norea-content-device:http://server"] {
            sqlx::query("INSERT INTO content_sync_cache(cache_key,payload) VALUES($1,'{}')")
                .bind(key).execute(&pool).await.expect("seed sync cache");
        }
        let json = format!(
            r#"{{
                "version": 2,
                "installedPlugins": [],
                "vpnGateServerVerdicts": [],
                "novels": [{{"id":1,"pluginId":"demo","path":"/n/1","name":"Novel","inLibrary":true,"isLocal":false,"createdAt":1,"updatedAt":1}}],
                "chapters": [{}, {}],
                "categories": [],
                "novelCategories": [],
                "repositories": []
            }}"#,
            restore_chapter_json(10, true, None),
            restore_chapter_json(12, true, None),
        );
        let manifest: BackupRestoreManifest = serde_json::from_str(&json).expect("parse manifest");
        let cache: BackupRestoreCache = serde_json::from_value(serde_json::json!({
            "files": [{ "pluginId": "demo", "path": "/n/1", "novelId": 1,
                "directory": "contents/demo/Original", "fingerprint": "retained-fingerprint" }],
            "chapters": [{ "chapterId": 10, "novelId": 1, "directory": "contents/demo/Original/10-Original" }]
        })).expect("parse retained file cache");
        let mut tx = pool.begin().await.expect("begin");
        execute_restore_snapshot(&mut tx, manifest, &cache)
            .await
            .expect("restore");
        tx.commit().await.expect("commit");

        let rows = sqlx::query_as::<_, (i64, i64, i64, i64, Option<String>, i64, i64)>(
            "SELECT id, is_downloaded, content_bytes, media_bytes, stored_content_type, unread, progress
             FROM chapter
             ORDER BY id",
        )
        .fetch_all(&pool)
        .await
        .expect("read chapters");
        assert_eq!(
            rows,
            vec![
                (10, 1, 1234, 56, Some("html".to_string()), 0, 40),
                (12, 0, 0, 0, None, 0, 40),
            ]
        );
        let dirty: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM work_metadata_dirty")
            .fetch_one(&pool).await.expect("read publication queue");
        assert_eq!(dirty, 0);
        let directories: Vec<(i64, String)> = sqlx::query_as(
            "SELECT chapter_id,directory FROM work_metadata_directory_cache",
        ).fetch_all(&pool).await.expect("read retained directories");
        assert_eq!(directories, vec![(10, "contents/demo/Original/10-Original".to_string())]);
        let pending: i64 = sqlx::query_scalar(
            "SELECT revision FROM work_metadata_sync_journal WHERE plugin_id='demo' AND path='/n/1'",
        ).fetch_one(&pool).await.expect("read retained work revision");
        assert_eq!(pending, 1);
        let reading: Vec<(i64, i64)> = sqlx::query_as("SELECT unread,progress FROM work_metadata_reading_state ORDER BY chapter_path")
            .fetch_all(&pool).await.expect("read restored reading cache");
        assert_eq!(reading, vec![(0, 40), (0, 40)]);
        let cache_keys: Vec<String> = sqlx::query_scalar("SELECT cache_key FROM content_sync_cache ORDER BY cache_key")
            .fetch_all(&pool).await.expect("read retained sync cache");
        assert_eq!(cache_keys, vec!["norea-content-catalog:http://server", "norea-content-device:http://server", "norea-content-work:http://server"]);
    }

    #[tokio::test]
    async fn restore_snapshot_rolls_back_when_retained_cache_is_inconsistent() {
        let pool = restore_pool().await;
        sqlx::query("INSERT INTO novel(id,plugin_id,path,name,rating,in_library) VALUES(99,'demo','/original','Current original',4.5,1)")
            .execute(&pool).await.expect("seed original cache");
        sqlx::query("INSERT INTO work_metadata_sync_journal(plugin_id,path,revision) VALUES('demo','/original',7)")
            .execute(&pool).await.expect("seed pending revision");
        let manifest: BackupRestoreManifest = serde_json::from_value(serde_json::json!({
            "version": 2, "novels": [], "chapters": [], "categories": [], "novelCategories": [],
            "repositories": [], "installedPlugins": [], "vpnGateServerVerdicts": []
        })).expect("parse manifest");
        let cache: BackupRestoreCache = serde_json::from_value(serde_json::json!({
            "files": [{ "pluginId": "demo", "path": "/original", "novelId": 99,
                "directory": "contents/demo/Original", "fingerprint": "retained-fingerprint" }], "chapters": []
        })).expect("parse inconsistent cache");
        let mut tx = pool.begin().await.expect("begin");
        assert!(execute_restore_snapshot(&mut tx, manifest, &cache).await.unwrap_err().contains("identity mismatch"));
        tx.rollback().await.expect("rollback");
        let original: (String, f64, i64) = sqlx::query_as("SELECT name,rating,in_library FROM novel WHERE id=99")
            .fetch_one(&pool).await.expect("read original cache");
        assert_eq!(original, ("Current original".to_string(), 4.5, 1));
        let pending: i64 = sqlx::query_scalar("SELECT revision FROM work_metadata_sync_journal WHERE plugin_id='demo' AND path='/original'")
            .fetch_one(&pool).await.expect("read original pending revision");
        assert_eq!(pending, 7);
    }

    #[tokio::test]
    async fn restore_snapshot_rejects_obsolete_formats_before_replacing_rows() {
        let pool = restore_pool().await;
        sqlx::query("INSERT INTO category (id, name, sort, is_system) VALUES (99, 'Keep', 1, 0)")
            .execute(&pool)
            .await
            .expect("seed category");
        for (version, content) in [(1, None), (2, Some("<p>old body</p>"))] {
            let json = format!(
                r#"{{"version":{version},"novels":[],"chapters":[{}],"categories":[],"novelCategories":[],"repositories":[],"installedPlugins":[],"vpnGateServerVerdicts":[]}}"#,
                restore_chapter_json(10, true, content),
            );
            let manifest = serde_json::from_str(&json).expect("parse obsolete manifest");
            let mut tx = pool.begin().await.expect("begin");
            let error = execute_restore_snapshot(&mut tx, manifest, &BackupRestoreCache::default())
                .await
                .expect_err("reject obsolete manifest");
            assert!(
                error.contains("unsupported backup version")
                    || error.contains("inline chapter bodies")
            );
            let retained =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM category WHERE id=99")
                    .fetch_one(&mut *tx)
                    .await
                    .expect("read existing category");
            assert_eq!(retained, 1);
            tx.rollback().await.expect("rollback");
        }
    }

    fn test_limits() -> BackupArchiveLimits {
        BackupArchiveLimits {
            max_entries: 8,
            max_manifest_bytes: 16,
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
    fn pack_then_unpack_round_trips_manifest_only() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("backup.zip");
        let zip_path_str = zip_path.to_string_lossy().to_string();

        let manifest_json = r#"{"version":2,"exportedAt":1700000000}"#.to_string();

        write_backup_zip(&manifest_json, &zip_path_str).expect("pack");

        let unpacked = unpack_backup_path(zip_path_str).expect("unpack");
        assert_eq!(unpacked.manifest_json, manifest_json);
    }

    #[test]
    fn unpack_rejects_archive_without_manifest() {
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("no-manifest.zip");

        let file = File::create(&zip_path).expect("create");
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.add_directory("empty/", options).expect("start");
        zip.finish().expect("finish");

        let result = unpack_backup_path(zip_path.to_string_lossy().to_string());
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("manifest.json"), "error was: {err}");
    }

    #[test]
    fn unpack_rejects_archives_with_chapter_content_or_media() {
        for name in ["chapters/10.html", "chapter-media/10/image.png"] {
            let body = zip_bytes(&[(MANIFEST_ENTRY, br#"{}"#), (name, b"obsolete content")]);
            let result = read_backup_archive(Cursor::new(body));
            assert!(result.is_err(), "accepted obsolete entry: {name}");
        }
    }

    #[test]
    fn unpack_rejects_unknown_entries() {
        let body = zip_bytes(&[("README.txt", b"extra")]);
        let error = read_backup_archive(Cursor::new(body)).expect_err("reject unknown entry");
        assert!(error.contains("unsupported archive entry"));
    }

    #[test]
    fn unpack_rejects_oversized_manifest_entry() {
        let limits = BackupArchiveLimits {
            max_manifest_bytes: 4,
            ..test_limits()
        };
        let body = zip_bytes(&[(MANIFEST_ENTRY, br#"{"version":2}"#)]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("manifest"), "error was: {err}");
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
            max_total_uncompressed_bytes: 6,
            ..test_limits()
        };
        let body = zip_bytes(&[(MANIFEST_ENTRY, br#"{"long":true}"#)]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("total uncompressed"), "error was: {err}");
    }

    #[test]
    fn unpack_rejects_excessive_compression_ratio() {
        let limits = BackupArchiveLimits {
            max_total_uncompressed_bytes: 2 * BYTES_PER_MIB,
            max_compression_ratio: 2,
            ..test_limits()
        };
        let manifest = vec![b' '; MIN_BACKUP_RATIO_CHECK_BYTES as usize];
        let body = zip_bytes(&[(MANIFEST_ENTRY, manifest.as_slice())]);

        let result = read_backup_archive_with_limits(Cursor::new(body), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("compression ratio"), "error was: {err}");
    }
}
