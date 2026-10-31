//! Complete device database and settings snapshots. Content files are never included or changed.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection, SqlitePool};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{DbInstances, DbPool};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_SETTINGS_BYTES: u64 = 16 * 1024 * 1024;
const DB_ENTRY: &str = "norea.db";
const MANIFEST_ENTRY: &str = "manifest.json";
const PROFILE_ENTRY: &str = "profile.ovpn";
static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceSetting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceBackupManifest {
    format: String,
    version: u32,
    pub device_name: String,
    created_at: u64,
    pub settings: Vec<DeviceSetting>,
    storage_root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBackupEntry {
    device_name: String,
    updated_at: u64,
    size: u64,
    sha256: String,
}

fn failure(error: impl std::fmt::Display) -> String {
    format!("Device backup: {error}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim() != name
        || name.is_empty()
        || name.chars().count() > 120
        || name.chars().any(char::is_control)
    {
        return Err(failure("invalid device name"));
    }
    Ok(())
}

fn validate_manifest(manifest: &DeviceBackupManifest) -> Result<(), String> {
    if manifest.format != "norea-device-backup" || manifest.version != 1 {
        return Err(failure("unsupported device backup format"));
    }
    validate_name(&manifest.device_name)?;
    let mut keys = HashSet::new();
    for setting in &manifest.settings {
        if !keys.insert(&setting.key) {
            return Err(failure("duplicate setting key"));
        }
    }
    Ok(())
}

fn stage_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(failure)?
        .join("device-backups");
    fs::create_dir_all(&root).map_err(failure)?;
    root.canonicalize().map_err(failure)
}

fn new_stage(app: &AppHandle) -> Result<PathBuf, String> {
    let root = stage_root(app)?;
    for _ in 0..16 {
        let path = root.join(format!(
            "snapshot-{}-{}",
            now_millis(),
            NEXT_STAGE.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(failure(error)),
        }
    }
    Err(failure("cannot allocate temporary snapshot"))
}

fn checked_archive(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let root = stage_root(app)?;
    let file = Path::new(path).canonicalize().map_err(failure)?;
    let parent = file
        .parent()
        .ok_or_else(|| failure("invalid snapshot path"))?;
    if parent.parent() != Some(root.as_path())
        || file.file_name().and_then(|v| v.to_str()) != Some("backup.zip")
        || !parent
            .file_name()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.starts_with("snapshot-"))
    {
        return Err(failure("snapshot is outside the backup staging directory"));
    }
    Ok(file)
}

fn digest_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(failure)?;
    let size = file.metadata().map_err(failure)?.len();
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err(failure("archive exceeds the size limit or is empty"));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(failure)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok((
        size,
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    ))
}

async fn writer(instances: &DbInstances) -> Result<SqlitePool, String> {
    let guard = instances.0.read().await;
    match guard.get("sqlite:norea.db") {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err(failure("database is not open")),
    }
}

async fn schema(
    connection: &mut SqliteConnection,
    database: &str,
) -> Result<Vec<(String, String, String)>, String> {
    sqlx::query_as(&format!("SELECT type,name,sql FROM {database}.sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name"))
        .fetch_all(connection).await.map_err(failure)
}

async fn migrations(
    connection: &mut SqliteConnection,
    database: &str,
) -> Result<Vec<(i64, bool, Vec<u8>)>, String> {
    sqlx::query_as(&format!(
        "SELECT version,success,checksum FROM {database}._sqlx_migrations ORDER BY version"
    ))
    .fetch_all(connection)
    .await
    .map_err(failure)
}

async fn validate_database(source: &Path, pool: &SqlitePool) -> Result<(), String> {
    let mut input = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(failure)?;
    let result = async {
        let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_all(&mut input)
            .await
            .map_err(failure)?;
        if integrity != ["ok"]
            || sqlx::query("PRAGMA foreign_key_check")
                .fetch_optional(&mut input)
                .await
                .map_err(failure)?
                .is_some()
        {
            return Err(failure("database integrity check failed"));
        }
        let mut current = pool.acquire().await.map_err(failure)?;
        if schema(&mut input, "main").await? != schema(&mut current, "main").await?
            || migrations(&mut input, "main").await? != migrations(&mut current, "main").await?
        {
            return Err(failure(
                "database schema or migration history does not match this app",
            ));
        }
        Ok(())
    }
    .await;
    input.close().await.map_err(failure)?;
    result
}

fn storage_root_setting(app: &AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(failure)?
        .join("chapter-media-storage-root.txt");
    match fs::read_to_string(path) {
        Ok(value) if value.len() <= 16 * 1024 => Ok(Some(value)),
        Ok(_) => Err(failure("storage folder setting exceeds the size limit")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure(error)),
    }
}

fn restore_storage_root_setting(app: &AppHandle, value: Option<&str>) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(failure)?
        .join("chapter-media-storage-root.txt");
    match value {
        Some(value) => {
            if value.len() > 16 * 1024 || value.contains('\0') {
                return Err(failure("invalid storage folder setting"));
            }
            fs::write(path, value).map_err(failure)
        }
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failure(error)),
        },
    }
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

async fn restore_database(source: &Path, pool: &SqlitePool) -> Result<(), String> {
    validate_database(source, pool).await?;
    let mut connection = pool.acquire().await.map_err(failure)?;
    let source_url =
        reqwest::Url::from_file_path(source).map_err(|_| failure("invalid database path"))?;
    let source_url = format!("{source_url}?mode=ro");
    sqlx::query("ATTACH DATABASE ? AS device_backup")
        .bind(source_url)
        .execute(&mut *connection)
        .await
        .map_err(failure)?;
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(&mut *connection)
        .await
        .map_err(failure)?;
    let result = async {
        let objects = schema(&mut connection, "main").await?;
        if objects != schema(&mut connection, "device_backup").await? ||
            migrations(&mut connection, "main").await? != migrations(&mut connection, "device_backup").await? {
            return Err(failure("database changed while preparing restore"));
        }
        sqlx::query("PRAGMA foreign_keys=OFF").execute(&mut *connection).await.map_err(failure)?;
        sqlx::query("BEGIN IMMEDIATE").execute(&mut *connection).await.map_err(failure)?;
        let changed = async {
            for (kind, name, _) in &objects {
                if kind == "trigger" {
                    sqlx::query(&format!("DROP TRIGGER {}", quote_identifier(name))).execute(&mut *connection).await.map_err(failure)?;
                }
            }
            for (kind, name, _) in &objects {
                if kind == "table" {
                    let table = quote_identifier(name);
                    sqlx::query(&format!("DELETE FROM main.{table}")).execute(&mut *connection).await.map_err(failure)?;
                    sqlx::query(&format!("INSERT INTO main.{table} SELECT * FROM device_backup.{table}")).execute(&mut *connection).await.map_err(failure)?;
                }
            }
            let has_sequence: i64 = sqlx::query_scalar("SELECT count(*) FROM main.sqlite_schema WHERE name='sqlite_sequence'").fetch_one(&mut *connection).await.map_err(failure)?;
            if has_sequence != 0 {
                sqlx::query("DELETE FROM main.sqlite_sequence").execute(&mut *connection).await.map_err(failure)?;
                sqlx::query("INSERT INTO main.sqlite_sequence SELECT * FROM device_backup.sqlite_sequence").execute(&mut *connection).await.map_err(failure)?;
            }
            // Queued filesystem mutations belong to the source device, not the restored profile.
            let has_table = |name: &str| objects.iter().any(|(kind, candidate, _)| kind == "table" && candidate == name);
            for table in ["work_metadata_dirty", "chapter_download_queue"] {
                if has_table(table) {
                    sqlx::query(&format!("DELETE FROM {}", quote_identifier(table))).execute(&mut *connection).await.map_err(failure)?;
                }
            }
            if has_table("download_cache_work") {
                sqlx::query("UPDATE download_cache_work SET status='cancelled',cancel_requested=1,finished_at_ms=? WHERE status IN ('queued','running')")
                    .bind(now_millis() as i64).execute(&mut *connection).await.map_err(failure)?;
            }
            if has_table("content_sync_origin") {
                sqlx::query("UPDATE content_sync_origin SET remote=0 WHERE id=1").execute(&mut *connection).await.map_err(failure)?;
            }
            // Content files are deliberately outside this archive. Recheck the target's
            // files on demand instead of trusting the source device's physical cache.
            if has_table("chapter") {
                sqlx::query("UPDATE chapter SET is_downloaded=0,content_bytes=0,media_bytes=0,media_repair_needed=0,stored_content_type=NULL,media_bytes_checked_at=NULL")
                    .execute(&mut *connection).await.map_err(failure)?;
            }
            if has_table("novel_stats") {
                sqlx::query("UPDATE novel_stats SET chapters_downloaded=0").execute(&mut *connection).await.map_err(failure)?;
            }
            for (kind, _, sql) in &objects {
                if kind == "trigger" { sqlx::query(sql).execute(&mut *connection).await.map_err(failure)?; }
            }
            if sqlx::query("PRAGMA main.foreign_key_check").fetch_optional(&mut *connection).await.map_err(failure)?.is_some() {
                return Err(failure("restored database contains broken relationships"));
            }
            sqlx::query("COMMIT").execute(&mut *connection).await.map_err(failure)?;
            Ok(())
        }.await;
        if changed.is_err() {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
        }
        changed
    }.await;
    let foreign_result = sqlx::query(if foreign_keys != 0 {
        "PRAGMA foreign_keys=ON"
    } else {
        "PRAGMA foreign_keys=OFF"
    })
    .execute(&mut *connection)
    .await
    .map_err(failure);
    let detach_result = sqlx::query("DETACH DATABASE device_backup")
        .execute(&mut *connection)
        .await
        .map_err(failure);
    if let Err(error) = foreign_result.and(detach_result) {
        // A successful COMMIT must not trigger rollback of the separate settings.
        // Discard the connection if its per-connection cleanup failed.
        eprintln!("device backup: discarding restore connection after cleanup error: {error}");
        let _ = connection.close().await;
    }
    result
}

fn pack_archive(
    database: &Path,
    manifest: &DeviceBackupManifest,
    profile: Option<&[u8]>,
    archive: &Path,
) -> Result<(), String> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(archive)
        .map_err(failure)?;
    let mut writer = ZipWriter::new(BufWriter::new(file));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer
        .start_file(MANIFEST_ENTRY, options)
        .map_err(failure)?;
    let json = serde_json::to_vec(manifest).map_err(failure)?;
    if json.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(failure("settings exceed the size limit"));
    }
    writer.write_all(&json).map_err(failure)?;
    writer.start_file(DB_ENTRY, options).map_err(failure)?;
    let mut db = File::open(database).map_err(failure)?;
    if db.metadata().map_err(failure)?.len() > MAX_ARCHIVE_BYTES {
        return Err(failure("database exceeds the size limit"));
    }
    std::io::copy(&mut db, &mut writer).map_err(failure)?;
    if let Some(profile) = profile {
        writer.start_file(PROFILE_ENTRY, options).map_err(failure)?;
        writer.write_all(profile).map_err(failure)?;
    }
    writer.finish().map_err(failure)?.flush().map_err(failure)?;
    Ok(())
}

fn unpack_archive(
    archive: &Path,
) -> Result<(DeviceBackupManifest, Option<Vec<u8>>, PathBuf), String> {
    let file = File::open(archive).map_err(failure)?;
    if file.metadata().map_err(failure)?.len() > MAX_ARCHIVE_BYTES {
        return Err(failure("archive exceeds the size limit"));
    }
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(failure)?;
    if !(2..=3).contains(&zip.len()) {
        return Err(failure("unexpected archive entries"));
    }
    let stage = archive
        .parent()
        .ok_or_else(|| failure("missing staging directory"))?;
    let database = stage.join(DB_ENTRY);
    let mut names = HashSet::new();
    let mut manifest = None;
    let mut profile = None;
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(failure)?;
        let name = entry.name().map_err(failure)?.into_owned();
        let limit = match name.as_str() {
            MANIFEST_ENTRY => MAX_SETTINGS_BYTES,
            DB_ENTRY => MAX_ARCHIVE_BYTES,
            PROFILE_ENTRY => 1024 * 1024,
            _ => return Err(failure("unexpected archive entry")),
        };
        if !names.insert(name.clone())
            || entry.is_dir()
            || entry.is_symlink()
            || entry.size() > limit
        {
            return Err(failure("invalid archive entry"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| failure("archive size overflow"))?;
        if total > MAX_ARCHIVE_BYTES + MAX_SETTINGS_BYTES + 1024 * 1024 {
            return Err(failure("expanded archive exceeds the size limit"));
        }
        if name == DB_ENTRY {
            let mut file = File::create(&database).map_err(failure)?;
            let copied =
                std::io::copy(&mut (&mut entry).take(limit + 1), &mut file).map_err(failure)?;
            if copied > limit {
                return Err(failure("database exceeds the size limit"));
            }
            file.sync_all().map_err(failure)?;
        } else {
            let mut bytes = Vec::new();
            (&mut entry)
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .map_err(failure)?;
            if bytes.len() as u64 > limit {
                return Err(failure("archive entry exceeds the size limit"));
            }
            if name == MANIFEST_ENTRY {
                manifest =
                    Some(serde_json::from_slice::<DeviceBackupManifest>(&bytes).map_err(failure)?);
            } else {
                super::plugin_vpn::validate_backup_profile(&bytes)?;
                profile = Some(bytes);
            }
        }
    }
    if !names.contains(DB_ENTRY) {
        return Err(failure("database is missing"));
    }
    let manifest = manifest.ok_or_else(|| failure("manifest is missing"))?;
    validate_manifest(&manifest)?;
    Ok((manifest, profile, database))
}

#[tauri::command]
pub async fn device_backup_create(
    app: AppHandle,
    databases: State<'_, DbInstances>,
    vpn: State<'_, super::plugin_vpn::state::PluginVpnState>,
    device_name: String,
    settings: Vec<DeviceSetting>,
) -> Result<BackupFile, String> {
    let manifest = DeviceBackupManifest {
        format: "norea-device-backup".into(),
        version: 1,
        device_name,
        created_at: now_millis(),
        settings,
        storage_root: storage_root_setting(&app)?,
    };
    validate_manifest(&manifest)?;
    let profile = vpn.export_backup_profile()?;
    let stage = new_stage(&app)?;
    let result = async {
        let pool = writer(&databases).await?;
        let database = stage.join(DB_ENTRY);
        sqlx::query("VACUUM INTO ?")
            .bind(database.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .map_err(failure)?;
        let archive = stage.join("backup.zip");
        let output = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            pack_archive(&database, &manifest, profile.as_deref(), &output)
        })
        .await
        .map_err(failure)??;
        let (size, sha256) = digest_file(&archive)?;
        Ok(BackupFile {
            path: archive.to_string_lossy().into_owned(),
            size,
            sha256,
        })
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[tauri::command]
pub async fn device_backup_inspect(
    app: AppHandle,
    databases: State<'_, DbInstances>,
    path: String,
) -> Result<DeviceBackupManifest, String> {
    let archive = checked_archive(&app, &path)?;
    let (manifest, _, database) =
        tauri::async_runtime::spawn_blocking(move || unpack_archive(&archive))
            .await
            .map_err(failure)??;
    validate_database(&database, &writer(&databases).await?).await?;
    Ok(manifest)
}

#[tauri::command]
pub async fn device_backup_restore(
    app: AppHandle,
    databases: State<'_, DbInstances>,
    vpn: State<'_, super::plugin_vpn::state::PluginVpnState>,
    path: String,
) -> Result<(), String> {
    let archive = checked_archive(&app, &path)?;
    let (manifest, profile, database) =
        tauri::async_runtime::spawn_blocking(move || unpack_archive(&archive))
            .await
            .map_err(failure)??;
    let pool = writer(&databases).await?;
    validate_database(&database, &pool).await?;
    let previous_profile = vpn.export_backup_profile()?;
    let previous_root = storage_root_setting(&app)?;
    let result = async {
        vpn.restore_backup_profile(&app, profile).await?;
        restore_storage_root_setting(&app, manifest.storage_root.as_deref())?;
        restore_database(&database, &pool).await
    }
    .await;
    if let Err(error) = result {
        let profile_rollback = vpn.restore_backup_profile(&app, previous_profile).await;
        let root_rollback = restore_storage_root_setting(&app, previous_root.as_deref());
        if profile_rollback.is_err() || root_rollback.is_err() {
            return Err(failure(format!(
                "{error}; native settings rollback failed: {profile_rollback:?}; {root_rollback:?}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn device_backup_cleanup(app: AppHandle, path: String) -> Result<(), String> {
    let archive = checked_archive(&app, &path)?;
    fs::remove_dir_all(
        archive
            .parent()
            .ok_or_else(|| failure("missing staging directory"))?,
    )
    .map_err(failure)
}

fn backup_url(server_url: &str, device_name: &str) -> Result<reqwest::Url, String> {
    validate_name(device_name)?;
    let mut url = reqwest::Url::parse(server_url).map_err(failure)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(failure("invalid server URL"));
    }
    url.path_segments_mut()
        .map_err(|_| failure("invalid server URL"))?
        .pop_if_empty()
        .extend(["api", "v1", "device-backups", device_name]);
    Ok(url)
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(failure)
}

#[tauri::command]
pub async fn device_backup_upload(
    app: AppHandle,
    server_url: String,
    device_name: String,
    token: String,
    path: String,
) -> Result<DeviceBackupEntry, String> {
    let archive = checked_archive(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let url = backup_url(&server_url, &device_name)?;
        let (size, sha256) = digest_file(&archive)?;
        let response = http_client()?
            .put(url)
            .bearer_auth(token)
            .header("Content-Type", "application/octet-stream")
            .header("X-Backup-Sha256", &sha256)
            .body(reqwest::blocking::Body::sized(
                File::open(archive).map_err(failure)?,
                size,
            ))
            .send()
            .map_err(failure)?;
        if !response.status().is_success() {
            return Err(failure(format!(
                "server rejected upload ({})",
                response.status()
            )));
        }
        let entry: DeviceBackupEntry = serde_json::from_reader(response).map_err(failure)?;
        if entry.device_name != device_name || entry.size != size || entry.sha256 != sha256 {
            return Err(failure("server returned inconsistent backup metadata"));
        }
        Ok(entry)
    })
    .await
    .map_err(failure)?
}

#[tauri::command]
pub async fn device_backup_download(
    app: AppHandle,
    server_url: String,
    device_name: String,
    token: String,
    sha256: String,
) -> Result<BackupFile, String> {
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(failure("invalid backup digest"));
    }
    let stage = new_stage(&app)?;
    let output_stage = stage.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut url = backup_url(&server_url, &device_name)?;
        url.query_pairs_mut().append_pair("sha256", &sha256);
        let response = http_client()?
            .get(url)
            .bearer_auth(token)
            .send()
            .map_err(failure)?;
        if !response.status().is_success() {
            return Err(failure(format!(
                "server rejected download ({})",
                response.status()
            )));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_ARCHIVE_BYTES)
        {
            return Err(failure("archive exceeds the size limit"));
        }
        let archive = output_stage.join("backup.zip");
        let mut file = File::create(&archive).map_err(failure)?;
        let copied =
            std::io::copy(&mut response.take(MAX_ARCHIVE_BYTES + 1), &mut file).map_err(failure)?;
        if copied > MAX_ARCHIVE_BYTES {
            return Err(failure("archive exceeds the size limit"));
        }
        file.sync_all().map_err(failure)?;
        let (size, actual) = digest_file(&archive)?;
        if actual != sha256 {
            return Err(failure("downloaded backup checksum does not match"));
        }
        Ok(BackupFile {
            path: archive.to_string_lossy().into_owned(),
            size,
            sha256: actual,
        })
    })
    .await
    .map_err(failure)?;
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{sqlite::SqlitePoolOptions, Executor};

    async fn database(path: &Path) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        pool.execute("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER NOT NULL,checksum BLOB NOT NULL); INSERT INTO _sqlx_migrations VALUES(1,1,X'0102'); CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT); CREATE TABLE audit(value TEXT); CREATE TRIGGER track_insert AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(new.name); END;").await.unwrap();
        pool
    }

    #[tokio::test]
    async fn complete_database_round_trip_preserves_rows_sequences_and_triggers() {
        let dir = tempfile::tempdir().unwrap();
        let pool = database(&dir.path().join("current.db")).await;
        pool.execute("INSERT INTO items(name) VALUES('original'); DELETE FROM audit; INSERT INTO audit VALUES('retained audit');").await.unwrap();
        let snapshot = dir.path().join("snapshot.db");
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        pool.execute(
            "DELETE FROM items; INSERT INTO items(name) VALUES('discard'); DELETE FROM audit;",
        )
        .await
        .unwrap();
        restore_database(&snapshot, &pool).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM items")
                .fetch_all(&pool)
                .await
                .unwrap(),
            ["original"]
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM audit")
                .fetch_all(&pool)
                .await
                .unwrap(),
            ["retained audit"]
        );
        pool.execute("INSERT INTO items(name) VALUES('next')")
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT max(id) FROM items")
                .fetch_one(&pool)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM audit ORDER BY rowid DESC LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "next"
        );
    }

    #[tokio::test]
    async fn full_app_schema_restores_personal_data_and_rechecks_physical_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let pool = database(&dir.path().join("current.db")).await;
        pool.execute(include_str!("schema.sql")).await.unwrap();
        pool.execute("INSERT INTO repository(url) VALUES('https://plugins.example.test/index.json'); INSERT INTO installed_plugin(id,name,lang,version,icon_url,source_url,source_code) VALUES('test','Test','en','1','','https://plugins.example.test/test.js','full plugin source'); INSERT INTO novel(id,plugin_id,path,name,in_library) VALUES(1,'test','/novel','Saved novel',1); INSERT INTO category(id,name,sort) VALUES(1,'Saved category',0); INSERT INTO novel_category(novel_id,category_id) VALUES(1,1); INSERT INTO chapter(novel_id,path,name,position,progress,bookmark,unread,is_downloaded,content_bytes,media_bytes,stored_content_type) VALUES(1,'/chapter','Saved chapter',1,42,1,0,1,123,456,'html');").await.unwrap();
        let snapshot = dir.path().join("snapshot.db");
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        pool.execute("UPDATE chapter SET progress=0,bookmark=0; DELETE FROM repository; DELETE FROM installed_plugin; UPDATE novel SET in_library=0;").await.unwrap();
        restore_database(&snapshot, &pool).await.unwrap();
        assert_eq!(
            sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
                "SELECT progress,bookmark,unread,is_downloaded,content_bytes FROM chapter"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            (42, 1, 0, 0, 0)
        );
        assert_eq!(
            sqlx::query_as::<_, (i64, i64, i64)>(
                "SELECT total_chapters,chapters_downloaded,reading_progress FROM novel_stats"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            (1, 0, 42)
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT source_code FROM installed_plugin")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "full plugin source"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT in_library FROM novel")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM novel_category")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM work_metadata_dirty")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        pool.execute("UPDATE chapter SET is_downloaded=1")
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT chapters_downloaded FROM novel_stats")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn invalid_or_incompatible_database_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        let pool = database(&dir.path().join("current.db")).await;
        pool.execute("INSERT INTO items(name) VALUES('retained')")
            .await
            .unwrap();
        let source = dir.path().join("source.db");
        let wrong = database(&source).await;
        wrong
            .execute("UPDATE _sqlx_migrations SET checksum=X'ff'")
            .await
            .unwrap();
        wrong.close().await;
        assert!(restore_database(&source, &pool).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM items")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "retained"
        );
        fs::write(&source, "not a database").unwrap();
        assert!(restore_database(&source, &pool).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT name FROM items")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "retained"
        );
    }

    #[test]
    fn archive_includes_settings_and_profile_without_content_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("source.db");
        fs::write(&db, b"database fixture").unwrap();
        let archive = dir.path().join("backup.zip");
        let manifest = DeviceBackupManifest {
            format: "norea-device-backup".into(),
            version: 1,
            device_name: "Test tablet".into(),
            created_at: 123,
            storage_root: Some("content://test/root".into()),
            settings: vec![DeviceSetting {
                key: "server".into(),
                value: "test-setting".into(),
            }],
        };
        let profile = b"client\ndev tun\nremote vpn.example.test 1194\n";
        pack_archive(&db, &manifest, Some(profile), &archive).unwrap();
        let (restored, vpn, database) = unpack_archive(&archive).unwrap();
        assert_eq!(restored.settings[0].value, "test-setting");
        assert_eq!(vpn.unwrap(), profile);
        assert_eq!(fs::read(database).unwrap(), b"database fixture");
        let mut zip = ZipArchive::new(File::open(archive).unwrap()).unwrap();
        assert_eq!(zip.len(), 3);
        assert!(zip.by_name("content.html").is_err());
    }

    #[test]
    fn archive_rejects_unsafe_and_duplicate_entries() {
        for names in [
            ["manifest.json", "../norea.db"],
            ["manifest.json", "manifest.json"],
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("backup.zip");
            let mut zip = ZipWriter::new(File::create(&path).unwrap());
            for name in names {
                if zip.start_file(name, SimpleFileOptions::default()).is_err() {
                    break;
                }
                zip.write_all(b"{}").unwrap();
            }
            zip.finish().unwrap();
            assert!(unpack_archive(&path).is_err());
        }
    }

    #[test]
    fn device_names_are_encoded_as_one_url_segment() {
        let url = backup_url("https://server.example/root", "Tablet / one").unwrap();
        assert_eq!(url.path(), "/root/api/v1/device-backups/Tablet%20%2F%20one");
        assert!(backup_url("https://user:secret@server.example", "Tablet").is_err());
    }
}
