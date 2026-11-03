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
use super::plugin_vpn::saved_profiles::backup::{
    create_private_backup_directory, read_backup_entry, validate_vault_backup,
    vault_backup_entry_limit, write_private_backup_file, VpnBackupPublication, VpnVaultBackupManifest,
    VAULT_INDEX_ENTRY,
};
#[path = "device_backup_restore.rs"]
pub(crate) mod restore_checkpoint;

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
    vpn_vault: VpnVaultBackupManifest,
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
    if manifest.format != "norea-device-backup" || manifest.version != 2 {
        return Err(failure("unsupported device backup format"));
    }
    validate_name(&manifest.device_name)?;
    manifest.vpn_vault.validate()?;
    if manifest.storage_root.as_ref().is_some_and(|value| value.len() > 16 * 1024 || value.contains('\0')) {
        return Err(failure("invalid storage folder setting"));
    }
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
            Ok(()) => {
                create_private_backup_directory(&path)?;
                return Ok(path);
            }
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
    read_storage_root_file(&path)
}

fn read_storage_root_file(path: &Path) -> Result<Option<String>, String> {
    validate_storage_root_file(path)?;
    match File::open(path) {
        Ok(file) => {
            let mut value = String::new();
            file.take(16 * 1024 + 1).read_to_string(&mut value).map_err(failure)?;
            if value.len() > 16 * 1024 {
                return Err(failure("storage folder setting exceeds the size limit"));
            }
            Ok(Some(value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failure(error)),
    }
}

fn restore_storage_root_file(path: &Path, value: Option<&str>) -> Result<(), String> {
    validate_storage_root_file(path)?;
    match value {
        Some(value) => {
            if value.len() > 16 * 1024 || value.contains('\0') {
                return Err(failure("invalid storage folder setting"));
            }
            write_private_backup_file(path, value.as_bytes())
        }
        None => match fs::remove_file(path) {
            Ok(()) => super::plugin_vpn::saved_profiles::backup::sync_backup_directory(path.parent().ok_or_else(|| failure("invalid storage folder setting path"))?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(failure(error)),
        },
    }
}

fn validate_storage_root_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => Err(failure("storage folder setting is not a regular file")),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(failure(error)),
        _ => Ok(()),
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
            if has_table("work_metadata_dirty") {
                sqlx::query("DELETE FROM work_metadata_dirty").execute(&mut *connection).await.map_err(failure)?;
            }
            if has_table("chapter_download_queue") {
                sqlx::query("DELETE FROM chapter_download_queue WHERE CASE WHEN json_valid(job_json) THEN json_extract(job_json,'$.vpnRangeId') IS NULL AND json_extract(job_json,'$.vpnBatchId') IS NULL ELSE 1 END")
                    .execute(&mut *connection).await.map_err(failure)?;
                sqlx::query("UPDATE chapter_download_queue SET leased_at_ms=NULL")
                    .execute(&mut *connection).await.map_err(failure)?;
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
    vault_directory: &Path,
    archive: &Path,
) -> Result<(), String> {
    validate_manifest(manifest)?;
    if let Some(profile) = profile { super::plugin_vpn::validate_backup_profile(profile)?; }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(archive).map_err(failure)?;
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
    for entry in std::iter::once(&manifest.vpn_vault.index).chain(&manifest.vpn_vault.profiles) {
        let bytes = read_backup_entry(vault_directory, entry)?;
        writer.start_file(&entry.path, options).map_err(failure)?;
        writer.write_all(&bytes).map_err(failure)?;
    }
    writer.finish().map_err(failure)?.flush().map_err(failure)?;
    Ok(())
}

fn unpack_archive(
    archive: &Path,
) -> Result<(DeviceBackupManifest, Option<Vec<u8>>, PathBuf, PathBuf), String> {
    let file = File::open(archive).map_err(failure)?;
    if file.metadata().map_err(failure)?.len() > MAX_ARCHIVE_BYTES {
        return Err(failure("archive exceeds the size limit"));
    }
    let mut zip = ZipArchive::new(BufReader::new(file)).map_err(failure)?;
    if !(3..=104).contains(&zip.len()) {
        return Err(failure("unexpected archive entries"));
    }
    let stage = archive
        .parent()
        .ok_or_else(|| failure("missing staging directory"))?
        .join(format!("unpacked-{}", NEXT_STAGE.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir(&stage).map_err(failure)?;
    create_private_backup_directory(&stage)?;
    let vault_directory = stage.join("saved-profiles");
    create_private_backup_directory(&vault_directory)?;
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
            _ => vault_backup_entry_limit(&name).map_err(failure)?,
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
        if total > MAX_ARCHIVE_BYTES + MAX_SETTINGS_BYTES + 101 * 1024 * 1024 + 128 * 1024 {
            return Err(failure("expanded archive exceeds the size limit"));
        }
        if name == DB_ENTRY {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&database).map_err(failure)?;
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
            } else if name == PROFILE_ENTRY {
                super::plugin_vpn::validate_backup_profile(&bytes)?;
                profile = Some(bytes);
            } else {
                write_private_backup_file(&stage.join(&name), &bytes)?;
            }
        }
    }
    if !names.contains(DB_ENTRY) {
        return Err(failure("database is missing"));
    }
    let manifest = manifest.ok_or_else(|| failure("manifest is missing"))?;
    validate_manifest(&manifest)?;
    let mut expected: HashSet<&str> = HashSet::from([MANIFEST_ENTRY, DB_ENTRY, VAULT_INDEX_ENTRY]);
    if profile.is_some() { expected.insert(PROFILE_ENTRY); }
    expected.extend(manifest.vpn_vault.profiles.iter().map(|entry| entry.path.as_str()));
    if names.len() != expected.len() || !names.iter().all(|name| expected.contains(name.as_str())) {
        return Err(failure("archive entries do not match the VPN vault inventory"));
    }
    for entry in std::iter::once(&manifest.vpn_vault.index).chain(&manifest.vpn_vault.profiles) {
        read_backup_entry(&vault_directory, entry)?;
    }
    Ok((manifest, profile, database, vault_directory))
}

async fn validate_staged_backup(
    database: &Path, vault_directory: &Path, manifest: &DeviceBackupManifest,
    profile: Option<&[u8]>, pool: &SqlitePool,
) -> Result<(), String> {
    validate_manifest(manifest)?;
    validate_database(database, pool).await?;
    let snapshot = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(
        SqliteConnectOptions::new().filename(database).read_only(true),
    ).await.map_err(failure)?;
    let result = validate_vault_backup(vault_directory, &manifest.vpn_vault, &snapshot, profile).await;
    snapshot.close().await;
    result.map(|_| ())
}

async fn restore_database_and_vpn_files(
    database: &Path, vault_directory: &Path, manifest: &DeviceBackupManifest,
    profile: Option<&[u8]>, pool: &SqlitePool, profile_path: &Path,
    storage_root_path: &Path, mut reload_files: impl FnMut() -> Result<(), String>,
) -> Result<restore_checkpoint::RestoreReceipt, String> {
    validate_staged_backup(database, vault_directory, manifest, profile, pool).await?;
    let previous_root = read_storage_root_file(storage_root_path)?;
    let mut checkpoint = restore_checkpoint::RestoreCheckpoint::begin(profile_path, previous_root.clone(), manifest.settings.clone())?;
    let mut publication = match VpnBackupPublication::install(profile_path, vault_directory, &manifest.vpn_vault, profile) {
        Ok(publication) => publication,
        Err(error) => {
            return match checkpoint.rolled_back() { Ok(()) => Err(error), Err(recovery) => Err(failure(format!("{error}; restore checkpoint retained: {recovery}"))) };
        },
    };
    let result = async {
        restore_storage_root_file(storage_root_path, manifest.storage_root.as_deref())?;
        reload_files()?;
        restore_database(database, pool).await
    }.await;
    if let Err(error) = result {
        let files = publication.rollback();
        let root = restore_storage_root_file(storage_root_path, previous_root.as_deref());
        let state = reload_files();
        if files.is_err() || root.is_err() || state.is_err() {
            return Err(failure(format!("{error}; restore checkpoint retained after rollback failure: {files:?}; {root:?}; {state:?}")));
        }
        return match checkpoint.rolled_back() { Ok(()) => Err(error), Err(recovery) => Err(failure(format!("{error}; restore checkpoint retained: {recovery}"))) };
    }
    checkpoint.committed(publication.checkpoint_name())
}

#[tauri::command]
pub async fn device_backup_create(
    app: AppHandle,
    databases: State<'_, DbInstances>,
    vpn: State<'_, super::plugin_vpn::state::PluginVpnState>,
    device_name: String,
    settings: Vec<DeviceSetting>,
) -> Result<BackupFile, String> {
    let stage = new_stage(&app)?;
    let result = async {
        let guard = vpn.lock_device_backup().await?;
        let pool = writer(&databases).await?;
        let database = stage.join(DB_ENTRY);
        sqlx::query("VACUUM INTO ?")
            .bind(database.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .map_err(failure)?;
        let vault_directory = stage.join("saved-profiles");
        let (profile, vpn_vault) = guard.export_vault(&pool, &vault_directory).await?;
        let manifest = DeviceBackupManifest {
            format: "norea-device-backup".into(), version: 2, device_name,
            created_at: now_millis(), settings, storage_root: storage_root_setting(&app)?, vpn_vault,
        };
        validate_manifest(&manifest)?;
        validate_staged_backup(&database, &vault_directory, &manifest, profile.as_deref(), &pool).await?;
        let archive = stage.join("backup.zip");
        let output = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            pack_archive(&database, &manifest, profile.as_deref(), &vault_directory, &output)
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
    let (manifest, profile, database, vault_directory) =
        tauri::async_runtime::spawn_blocking(move || unpack_archive(&archive))
            .await
            .map_err(failure)??;
    validate_staged_backup(&database, &vault_directory, &manifest, profile.as_deref(), &writer(&databases).await?).await?;
    Ok(manifest)
}

#[tauri::command]
pub async fn device_backup_restore(
    app: AppHandle,
    databases: State<'_, DbInstances>,
    vpn: State<'_, super::plugin_vpn::state::PluginVpnState>,
    workers: State<'_, super::plugin_vpn::download_workers::DownloadVpnWorkers>,
    path: String,
) -> Result<restore_checkpoint::RestoreReceipt, String> {
    let archive = checked_archive(&app, &path)?;
    let (manifest, profile, database, vault_directory) =
        tauri::async_runtime::spawn_blocking(move || unpack_archive(&archive))
            .await
            .map_err(failure)??;
    let pool = writer(&databases).await?;
    validate_staged_backup(&database, &vault_directory, &manifest, profile.as_deref(), &pool).await?;
    let mut guard = vpn.lock_device_backup_restore(workers.inner()).await?;
    let storage_root_path = app.path().app_config_dir().map_err(failure)?.join("chapter-media-storage-root.txt");
    restore_database_and_vpn_files(
        &database, &vault_directory, &manifest, profile.as_deref(), &pool, &guard.profile_path()?,
        &storage_root_path, || guard.reload_published_files(),
    ).await
}

fn managed_profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    super::plugin_vpn::state::managed_profile_path(&app.path().app_data_dir().map_err(failure)?)
}

#[tauri::command]
pub fn device_backup_restore_check(app: AppHandle) -> Result<(), String> {
    restore_checkpoint::require_complete(&managed_profile_path(&app)?)
}

#[tauri::command]
pub fn device_backup_restore_complete(app: AppHandle, restore_id: String) -> Result<(), String> {
    restore_checkpoint::complete(&managed_profile_path(&app)?, &restore_id)
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
    use super::super::plugin_vpn::saved_profiles::{SavedProfileVault, SavedVpnProfileSelection};
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

    fn retained_profile(ip: &str, protocol: &str) -> Vec<u8> {
        format!("client\ndev tun\nproto {protocol}\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n# norea:vpn-gate-finder\nauth-user-pass\n").into_bytes()
    }

    async fn retained_bundle(directory: &Path) -> (SqlitePool, DeviceBackupManifest, Vec<u8>, PathBuf, PathBuf) {
        let pool = database(&directory.join("live.db")).await;
        pool.execute("CREATE TABLE vpn_gate_server_verdict(ip TEXT PRIMARY KEY,verdict TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT(unixepoch())); INSERT INTO items(name) VALUES('snapshot');").await.unwrap();
        let mut vault = SavedProfileVault::open(directory.join("source-vault")).unwrap();
        let first = vault.capture(&pool, "8.8.4.4", &retained_profile("8.8.4.4", "udp")).await.unwrap().saved_profile.unwrap();
        let active = retained_profile("1.1.1.1", "tcp-client");
        let selected = vault.capture(&pool, "1.1.1.1", &active).await.unwrap().saved_profile.unwrap();
        vault.set_limit(&pool, 10).await.unwrap();
        vault.set_active(Some(SavedVpnProfileSelection { id: selected.id, hash: selected.hash })).unwrap();
        vault.reserve(&pool, "old-session", &first.id, &first.hash, None).await.unwrap();
        let staged = directory.join("staged-vault");
        let vpn_vault = vault.export_device_backup(&pool, Some(&active), &staged).await.unwrap();
        let database = directory.join("snapshot.db");
        sqlx::query("VACUUM INTO ?").bind(database.to_str().unwrap()).execute(&pool).await.unwrap();
        let manifest = DeviceBackupManifest {
            format: "norea-device-backup".into(), version: 2, device_name: "Vault tablet".into(), created_at: 123,
            storage_root: Some("content://retained/root".into()),
            settings: vec![DeviceSetting { key: "plugin-vpn-settings".into(), value: "saved configuration".into() }], vpn_vault,
        };
        (pool, manifest, active, database, staged)
    }

    fn archive_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut zip = ZipArchive::new(File::open(path).unwrap()).unwrap();
        (0..zip.len()).map(|index| {
            let mut entry = zip.by_index(index).unwrap();
            let name = entry.name().unwrap().into_owned();
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            (name, bytes)
        }).collect()
    }

    fn write_test_archive(path: &Path, entries: &[(String, Vec<u8>)]) {
        let mut zip = ZipWriter::new(File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(name, SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[tokio::test]
    async fn retained_vault_archive_round_trip_restores_database_capacity_and_selection_without_content_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (pool, manifest, active, snapshot, staged) = retained_bundle(dir.path()).await;
        let archive = dir.path().join("backup.zip");
        pack_archive(&snapshot, &manifest, Some(&active), &staged, &archive).unwrap();
        let (manifest, profile, database, vault) = unpack_archive(&archive).unwrap();
        let live = dir.path().join("managed");
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("profile.ovpn"), retained_profile("9.9.9.9", "udp")).unwrap();
        pool.execute("UPDATE items SET name='current'; UPDATE vpn_gate_server_verdict SET verdict='fails';").await.unwrap();
        let originals = ["contents/novel.json", "contents/cover.jpg", "contents/1/content.html", "contents/1/media.zip", "external-import.ovpn"];
        for name in originals {
            let path = dir.path().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, name.as_bytes()).unwrap();
        }
        let receipt = restore_database_and_vpn_files(&database, &vault, &manifest, profile.as_deref(), &pool, &live.join("profile.ovpn"), &dir.path().join("chapter-media-storage-root.txt"), || Ok(())).await.unwrap();
        assert!(restore_checkpoint::require_complete(&live.join("profile.ovpn")).is_err());
        assert_eq!(receipt.settings[0].value, "saved configuration");
        restore_checkpoint::complete(&live.join("profile.ovpn"), &receipt.id).unwrap();
        restore_checkpoint::require_complete(&live.join("profile.ovpn")).unwrap();
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM items").fetch_one(&pool).await.unwrap(), "snapshot");
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM vpn_gate_server_verdict WHERE verdict='works'").fetch_one(&pool).await.unwrap(), 2);
        assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), active);
        assert_eq!(fs::read(live.join("saved-profiles/index.json")).unwrap(), fs::read(staged.join("index.json")).unwrap());
        let mut restored = validate_vault_backup(&live.join("saved-profiles"), &manifest.vpn_vault, &pool, Some(&active)).await.unwrap();
        assert_eq!(restored.snapshot(&pool).await.unwrap().limit, 10);
        let entries = archive_entries(&archive);
        assert_eq!(entries.len(), 6);
        assert!(entries.iter().all(|(name, _)| !name.contains("cookie") && !name.contains("session") && !name.starts_with("contents/")));
        for name in originals { assert_eq!(fs::read(dir.path().join(name)).unwrap(), name.as_bytes()); }
    }

    #[tokio::test]
    async fn file_installation_failure_preserves_old_verdict_database_and_active_file() {
        let dir = tempfile::tempdir().unwrap();
        let (pool, manifest, active, database, staged) = retained_bundle(dir.path()).await;
        pool.execute("UPDATE vpn_gate_server_verdict SET verdict='fails'; UPDATE items SET name='current'").await.unwrap();
        let live = dir.path().join("managed");
        fs::create_dir_all(&live).unwrap();
        fs::write(live.join("profile.ovpn"), b"old active bytes").unwrap();
        fs::write(live.join("saved-profiles"), b"blocked target").unwrap();
        assert!(restore_database_and_vpn_files(&database, &staged, &manifest, Some(&active), &pool, &live.join("profile.ovpn"), &dir.path().join("chapter-media-storage-root.txt"), || Ok(())).await.is_err());
        assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), b"old active bytes");
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM vpn_gate_server_verdict WHERE verdict='works'").fetch_one(&pool).await.unwrap(), 0);
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM items").fetch_one(&pool).await.unwrap(), "current");
    }

    #[tokio::test]
    async fn database_or_settings_failure_rolls_back_installed_vault_and_profile_before_returning() {
        for fail_database in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (pool, manifest, active, database, staged) = retained_bundle(dir.path()).await;
            pool.execute("UPDATE items SET name='current'").await.unwrap();
            let live = dir.path().join("managed");
            let mut old_vault = SavedProfileVault::open(live.join("saved-profiles")).unwrap();
            let old_profile = retained_profile("9.9.9.9", "udp");
            old_vault.capture(&pool, "9.9.9.9", &old_profile).await.unwrap();
            fs::write(live.join("profile.ovpn"), &old_profile).unwrap();
            let old_index = fs::read(live.join("saved-profiles/index.json")).unwrap();
            if fail_database { pool.execute("PRAGMA query_only=ON").await.unwrap(); }
            let mut installing = true;
            let setting = dir.path().join("chapter-media-storage-root.txt");
            restore_storage_root_file(&setting, Some("previous root")).unwrap();
            let result = restore_database_and_vpn_files(&database, &staged, &manifest, Some(&active), &pool, &live.join("profile.ovpn"), &setting, || {
                if installing {
                    installing = false;
                    assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), active);
                    if !fail_database { return Err("settings publication failed".into()); }
                }
                Ok(())
            }).await;
            assert!(result.is_err());
            assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), old_profile);
            assert_eq!(fs::read(live.join("saved-profiles/index.json")).unwrap(), old_index);
            assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM items").fetch_one(&pool).await.unwrap(), "current");
            assert_eq!(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM vpn_gate_server_verdict WHERE ip='9.9.9.9'").fetch_one(&pool).await.unwrap(), 1);
            assert_eq!(read_storage_root_file(&setting).unwrap().as_deref(), Some("previous root"));
            restore_checkpoint::require_complete(&live.join("profile.ovpn")).unwrap();
            if fail_database { pool.execute("PRAGMA query_only=OFF").await.unwrap(); }
        }
    }

    #[tokio::test]
    async fn interrupted_device_restore_child() {
        let Ok(root) = std::env::var("NOREA_INTERRUPTED_RESTORE_TEST_ROOT") else { return; };
        let root = PathBuf::from(root);
        let phase = std::env::var("NOREA_INTERRUPTED_RESTORE_TEST_PHASE").unwrap_or_default();
        if phase == "restart" {
            std::process::exit(if restore_checkpoint::require_complete(&root.join("managed/profile.ovpn")).is_err() { 88 } else { 0 });
        }
        let (pool, manifest, active, database, staged) = retained_bundle(&root).await;
        pool.execute("UPDATE items SET name='current'").await.unwrap();
        let live = root.join("managed");
        let mut vault = SavedProfileVault::open(live.join("saved-profiles")).unwrap();
        let old = retained_profile("9.9.9.9", "udp");
        vault.capture(&pool, "9.9.9.9", &old).await.unwrap();
        fs::write(live.join("profile.ovpn"), &old).unwrap();
        let setting = root.join("chapter-media-storage-root.txt");
        restore_storage_root_file(&setting, Some("content://previous/root")).unwrap();
        fs::write(root.join("original-content.html"), "original content").unwrap();
        let receipt = restore_database_and_vpn_files(
            &database, &staged, &manifest, Some(&active), &pool, &live.join("profile.ovpn"), &setting, || {
                assert_eq!(read_storage_root_file(&setting).unwrap(), manifest.storage_root);
                assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), active);
                if phase == "before-commit" { std::process::exit(86); }
                Ok(())
            },
        ).await.unwrap();
        if phase == "after-ack" { restore_checkpoint::complete(&live.join("profile.ovpn"), &receipt.id).unwrap(); }
        std::process::exit(87);
    }

    #[tokio::test]
    async fn interrupted_device_restore_keeps_a_durable_checkpoint_after_files_and_settings_before_sql_commit() {
        let directory = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "device_backup::tests::interrupted_device_restore_child", "--nocapture"])
            .env("NOREA_INTERRUPTED_RESTORE_TEST_ROOT", directory.path())
            .env("NOREA_INTERRUPTED_RESTORE_TEST_PHASE", "before-commit")
            .status().unwrap();
        assert_eq!(status.code(), Some(86));
        let live = directory.path().join("managed");
        assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), retained_profile("1.1.1.1", "tcp-client"));
        assert_eq!(read_storage_root_file(&directory.path().join("chapter-media-storage-root.txt")).unwrap().as_deref(), Some("content://retained/root"));
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(directory.path().join("live.db")),
        ).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM items").fetch_one(&pool).await.unwrap(), "current");
        assert_eq!(fs::read_to_string(directory.path().join("original-content.html")).unwrap(), "original content");
        let checkpoint = fs::read_dir(&live).unwrap().map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().starts_with(".device-backup-")).unwrap();
        assert_eq!(fs::read(checkpoint.join("old-profile.ovpn")).unwrap(), retained_profile("9.9.9.9", "udp"));
        assert!(checkpoint.join("old-vault/index.json").is_file());
        assert!(live.join(".device-restore/restore.json").is_file(), "process exit left mixed stores without a durable restore checkpoint");
        let before = fs::read(live.join(".device-restore/restore.json")).unwrap();
        let record: serde_json::Value = serde_json::from_slice(&before).unwrap();
        assert_eq!(record["previousStorageRoot"], "content://previous/root");
        for _ in 0..2 {
            let error = restore_checkpoint::require_complete(&live.join("profile.ovpn")).unwrap_err();
            assert!(error.contains("startup is blocked"), "{error}");
            assert_eq!(fs::read(live.join(".device-restore/restore.json")).unwrap(), before);
            assert_eq!(fs::read(checkpoint.join("old-profile.ovpn")).unwrap(), retained_profile("9.9.9.9", "udp"));
        }
        assert!(restore_checkpoint::complete(&live.join("profile.ovpn"), record["id"].as_str().unwrap()).is_err());
        let restart = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "device_backup::tests::interrupted_device_restore_child"])
            .env("NOREA_INTERRUPTED_RESTORE_TEST_ROOT", directory.path())
            .env("NOREA_INTERRUPTED_RESTORE_TEST_PHASE", "restart").status().unwrap();
        assert_eq!(restart.code(), Some(88));
        assert_eq!(fs::read(live.join(".device-restore/restore.json")).unwrap(), before);
        pool.close().await;
    }

    #[test]
    fn interrupted_device_restore_blocks_committed_but_unacknowledged_restart_without_guessing_sql_outcome() {
        for acknowledged in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "device_backup::tests::interrupted_device_restore_child", "--nocapture"])
                .env("NOREA_INTERRUPTED_RESTORE_TEST_ROOT", directory.path())
                .env("NOREA_INTERRUPTED_RESTORE_TEST_PHASE", if acknowledged { "after-ack" } else { "after-commit" }).status().unwrap();
            assert_eq!(status.code(), Some(87));
            let profile = directory.path().join("managed/profile.ovpn");
            if !acknowledged {
                let record: serde_json::Value = serde_json::from_slice(&fs::read(profile.parent().unwrap().join(".device-restore/restore.json")).unwrap()).unwrap();
                assert_eq!(record["committed"], true);
                let previous = profile.parent().unwrap().join(record["publication"].as_str().unwrap()).join("old-profile.ovpn");
                assert_eq!(fs::read(previous).unwrap(), retained_profile("9.9.9.9", "udp"));
                assert!(restore_checkpoint::complete(&profile, &"0".repeat(64)).is_err());
            }
            let restart = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "device_backup::tests::interrupted_device_restore_child"])
                .env("NOREA_INTERRUPTED_RESTORE_TEST_ROOT", directory.path())
                .env("NOREA_INTERRUPTED_RESTORE_TEST_PHASE", "restart").status().unwrap();
            assert_eq!(restart.code(), Some(if acknowledged { 0 } else { 88 }));
            assert_eq!(fs::read(profile).unwrap(), retained_profile("1.1.1.1", "tcp-client"));
            assert_eq!(fs::read_to_string(directory.path().join("original-content.html")).unwrap(), "original content");
        }
    }

    #[test]
    fn interrupted_device_restore_refuses_incomplete_or_legacy_checkpoints_without_removing_them() {
        for name in [".device-restore", ".device-backup-previous"] {
            let directory = tempfile::tempdir().unwrap();
            let checkpoint = directory.path().join(name);
            fs::create_dir(&checkpoint).unwrap();
            fs::write(checkpoint.join("unrecognized-recovery-data"), "preserve").unwrap();
            let profile = directory.path().join("profile.ovpn");
            for _ in 0..2 {
                assert!(restore_checkpoint::require_complete(&profile).is_err());
                assert!(restore_checkpoint::RestoreCheckpoint::begin(&profile, None, Vec::new()).is_err());
                assert_eq!(fs::read_to_string(checkpoint.join("unrecognized-recovery-data")).unwrap(), "preserve");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_device_restore_identifies_the_rejected_parent_path() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        fs::create_dir(&app_data).unwrap();
        let alias = directory.path().join("data-alias");
        symlink(&app_data, &alias).unwrap();
        let error = restore_checkpoint::require_complete(&alias.join("plugin-vpn/profile.ovpn")).unwrap_err();
        assert!(error.contains(alias.to_str().unwrap()), "the rejected ancestor is missing from the diagnostic: {error}");
        assert!(fs::symlink_metadata(&alias).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_device_restore_rejects_linked_checkpoint_and_unsafe_acknowledgement_paths() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("original"), "untouched").unwrap();
        let profile = directory.path().join("profile.ovpn");
        symlink(external.path(), directory.path().join(".device-restore")).unwrap();
        assert!(restore_checkpoint::require_complete(&profile).is_err());
        assert!(restore_checkpoint::complete(&profile, &"c".repeat(64)).is_err());
        fs::remove_file(directory.path().join(".device-restore")).unwrap();
        for publication in ["../outside", ".device-backup-../outside"] {
            fs::create_dir(directory.path().join(".device-restore")).unwrap();
            let record = serde_json::json!({ "version": 1, "id": "c".repeat(64), "committed": true, "publication": publication, "previousStorageRoot": null, "settings": [] });
            fs::write(directory.path().join(".device-restore/restore.json"), serde_json::to_vec(&record).unwrap()).unwrap();
            assert!(restore_checkpoint::complete(&profile, &"c".repeat(64)).is_err());
            assert!(directory.path().join(".device-restore/restore.json").exists());
            fs::remove_file(directory.path().join(".device-restore/restore.json")).unwrap();
            fs::remove_dir(directory.path().join(".device-restore")).unwrap();
        }
        assert_eq!(fs::read_to_string(external.path().join("original")).unwrap(), "untouched");
    }

    #[tokio::test]
    async fn inconsistent_snapshot_approval_is_rejected_before_any_live_mutation() {
        for update in ["UPDATE vpn_gate_server_verdict SET verdict='fails'", "UPDATE vpn_gate_server_verdict SET updated_at=updated_at+1", "DELETE FROM vpn_gate_server_verdict"] {
            let dir = tempfile::tempdir().unwrap();
            let (pool, manifest, active, database, staged) = retained_bundle(dir.path()).await;
            let input = SqlitePoolOptions::new().max_connections(1).connect_with(SqliteConnectOptions::new().filename(&database)).await.unwrap();
            input.execute(update).await.unwrap();
            input.close().await;
            pool.execute("UPDATE items SET name='current'").await.unwrap();
            let live = dir.path().join("managed");
            fs::create_dir_all(&live).unwrap();
            fs::write(live.join("profile.ovpn"), b"original").unwrap();
            assert!(restore_database_and_vpn_files(&database, &staged, &manifest, Some(&active), &pool, &live.join("profile.ovpn"), &dir.path().join("chapter-media-storage-root.txt"), || panic!("settings must remain untouched")).await.is_err());
            assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), b"original");
            assert!(!live.join("saved-profiles").exists());
            assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM items").fetch_one(&pool).await.unwrap(), "current");
        }
    }

    #[tokio::test]
    async fn valid_device_backup_replaces_an_unopenable_destination_vault_without_deleting_its_originals() {
        use crate::plugin_vpn::{download_workers::DownloadVpnWorkers, state::tests::backup_worker_test_state};
        let directory = tempfile::tempdir().unwrap();
        let (pool, manifest, active, database, staged) = retained_bundle(directory.path()).await;
        let live = directory.path().join("plugin-vpn");
        let vault = live.join("saved-profiles");
        fs::create_dir_all(&vault).unwrap();
        fs::write(vault.join("index.json"), "broken destination index").unwrap();
        fs::write(vault.join("preserved.ovpn"), "previous private data").unwrap();
        let old_profile = retained_profile("9.9.9.9", "udp");
        fs::write(live.join("profile.ovpn"), &old_profile).unwrap();
        let failed = SavedProfileVault::open(vault.clone());
        assert!(failed.is_err());
        let state = backup_worker_test_state(live.join("profile.ovpn"), failed);
        let workers = DownloadVpnWorkers::bind().unwrap();
        validate_staged_backup(&database, &staged, &manifest, Some(&active), &pool).await.unwrap();
        let mut guard = state.lock_device_backup_restore(&workers).await.expect("a valid full backup must be able to replace a vault that failed initialization");
        let receipt = restore_database_and_vpn_files(&database, &staged, &manifest, Some(&active), &pool, &guard.profile_path().unwrap(),
            &directory.path().join("chapter-media-storage-root.txt"), || guard.reload_published_files()).await.unwrap();
        restore_checkpoint::complete(&live.join("profile.ovpn"), &receipt.id).unwrap();
        let quarantine = fs::read_dir(&live).unwrap().map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().starts_with("saved-profiles.quarantine-")).unwrap();
        assert_eq!(fs::read_to_string(quarantine.join("index.json")).unwrap(), "broken destination index");
        assert_eq!(fs::read_to_string(quarantine.join("preserved.ovpn")).unwrap(), "previous private data");
        assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), active);
        validate_vault_backup(&vault, &manifest.vpn_vault, &pool, Some(&active)).await.unwrap();
        let (restored_profile, exported) = guard.export_vault(&pool, &directory.path().join("verified-restored-vault")).await.unwrap();
        assert_eq!(restored_profile, Some(active));
        assert_eq!(exported.profiles.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn storage_root_snapshot_never_reads_or_overwrites_a_symlinked_original() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original.txt");
        fs::write(&original, "preserved original").unwrap();
        let setting = dir.path().join("chapter-media-storage-root.txt");
        symlink(&original, &setting).unwrap();
        assert!(read_storage_root_file(&setting).is_err());
        assert!(restore_storage_root_file(&setting, Some("restored root")).is_err());
        assert_eq!(fs::read_to_string(original).unwrap(), "preserved original");
    }

    #[tokio::test]
    async fn archive_rejects_corrupt_oversize_unknown_and_duplicate_vault_entries() {
        let dir = tempfile::tempdir().unwrap();
        let (_pool, manifest, active, database, staged) = retained_bundle(dir.path()).await;
        let archive = dir.path().join("backup.zip");
        pack_archive(&database, &manifest, Some(&active), &staged, &archive).unwrap();
        let entries = archive_entries(&archive);
        for change in 0..8 {
            let mut modified = entries.clone();
            match change {
                0 => modified.iter_mut().find(|(name, _)| name.ends_with("8.8.4.4.ovpn")).unwrap().1.push(b'!'),
                1 => modified.iter_mut().find(|(name, _)| name == VAULT_INDEX_ENTRY).unwrap().1 = vec![b' '; 128 * 1024 + 1],
                2 => modified.iter_mut().find(|(name, _)| name.ends_with("8.8.4.4.ovpn")).unwrap().1 = vec![b' '; 1024 * 1024 + 1],
                3 => modified.push(("saved-profiles/unknown.ovpn".into(), b"invalid".to_vec())),
                4 => modified.push(("saved-profiles/../outside.ovpn".into(), b"invalid".to_vec())),
                5..=7 => {
                    let entry = modified.iter_mut().find(|(name, _)| name == MANIFEST_ENTRY).unwrap();
                    let mut value: serde_json::Value = serde_json::from_slice(&entry.1).unwrap();
                    let first = value["vpnVault"]["profiles"][0].clone();
                    if change == 5 { value["vpnVault"]["profiles"].as_array_mut().unwrap().push(first); }
                    else if change == 6 { value["vpnVault"]["profiles"] = vec![first; 101].into(); }
                    else { value["version"] = 1.into(); }
                    entry.1 = serde_json::to_vec(&value).unwrap();
                }
                _ => unreachable!(),
            }
            let bad = dir.path().join(format!("invalid-{change}.zip"));
            write_test_archive(&bad, &modified);
            assert!(unpack_archive(&bad).is_err(), "accepted invalid archive case {change}");
        }
        let mut duplicate = fs::read(&archive).unwrap();
        let from = b"saved-profiles/1.1.1.1.ovpn";
        let to = b"saved-profiles/8.8.4.4.ovpn";
        let positions: Vec<_> = duplicate.windows(from.len()).enumerate().filter_map(|(index, bytes)| (bytes == from).then_some(index)).collect();
        assert_eq!(positions.len(), 2);
        for index in positions { duplicate[index..index + from.len()].copy_from_slice(to); }
        let bad = dir.path().join("duplicate.zip");
        fs::write(&bad, duplicate).unwrap();
        assert!(unpack_archive(&bad).is_err());
    }

    #[tokio::test]
    async fn restore_retains_frozen_range_jobs_but_discards_ordinary_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let pool = database(&dir.path().join("live.db")).await;
        pool.execute("CREATE TABLE chapter_download_queue(chapter_id INTEGER PRIMARY KEY,job_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,leased_at_ms INTEGER,attempt_count INTEGER NOT NULL); CREATE TABLE vpn_download_plan(id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL); INSERT INTO chapter_download_queue VALUES(1,'{\"vpnPlanId\":\"plan\",\"vpnRangeId\":\"range\",\"chapterPath\":\"frozen-payload\"}',10,20,30,4),(2,'{\"chapterPath\":\"ordinary\"}',10,20,NULL,2); INSERT INTO vpn_download_plan VALUES('plan','{\"status\":\"paused\",\"attemptedProfileIds\":[\"retained-id\"],\"checkpoint\":7}',3);").await.unwrap();
        let source = dir.path().join("snapshot.db");
        sqlx::query("VACUUM INTO ?").bind(source.to_str().unwrap()).execute(&pool).await.unwrap();
        pool.execute("DELETE FROM chapter_download_queue; DELETE FROM vpn_download_plan;").await.unwrap();
        restore_database(&source, &pool).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, String, Option<i64>, i64)>("SELECT chapter_id,job_json,leased_at_ms,attempt_count FROM chapter_download_queue").fetch_all(&pool).await.unwrap(), [(1, "{\"vpnPlanId\":\"plan\",\"vpnRangeId\":\"range\",\"chapterPath\":\"frozen-payload\"}".into(), None, 4)]);
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT payload FROM vpn_download_plan").fetch_one(&pool).await.unwrap(), "{\"status\":\"paused\",\"attemptedProfileIds\":[\"retained-id\"],\"checkpoint\":7}");
    }

    #[tokio::test]
    async fn restore_retains_pending_vpn_intent_without_releasing_it_to_ordinary_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let pool = database(&dir.path().join("live.db")).await;
        pool.execute("CREATE TABLE chapter_download_queue(chapter_id INTEGER PRIMARY KEY,job_json TEXT NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL,leased_at_ms INTEGER,attempt_count INTEGER NOT NULL);
            INSERT INTO chapter_download_queue VALUES(1,'{\"vpnBatchId\":\"pending-run\",\"chapterPath\":\"/pending\"}',10,20,30,4),(2,'{\"chapterPath\":\"/ordinary\"}',10,20,NULL,2);
            INSERT INTO items(name) VALUES('retained personal state');").await.unwrap();
        let source = dir.path().join("snapshot.db");
        sqlx::query("VACUUM INTO ?").bind(source.to_str().unwrap()).execute(&pool).await.unwrap();
        pool.execute("DELETE FROM chapter_download_queue; DELETE FROM items;").await.unwrap();
        restore_database(&source, &pool).await.unwrap();
        assert_eq!(sqlx::query_as::<_, (i64, String, i64, i64, Option<i64>, i64)>(
            "SELECT chapter_id,job_json,created_at_ms,updated_at_ms,leased_at_ms,attempt_count FROM chapter_download_queue ORDER BY chapter_id")
            .fetch_all(&pool).await.unwrap(), [(1, "{\"vpnBatchId\":\"pending-run\",\"chapterPath\":\"/pending\"}".into(), 10, 20, None, 4)]);
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT name FROM items").fetch_all(&pool).await.unwrap(), ["retained personal state"]);
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

    #[tokio::test]
    async fn archive_includes_settings_and_profile_without_content_files() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("source.db");
        let pool = database(&db).await;
        pool.execute("INSERT INTO items(name) VALUES('snapshot row')").await.unwrap();
        let source = dir.path().join("snapshot.db");
        sqlx::query("VACUUM INTO ?").bind(source.to_str().unwrap()).execute(&pool).await.unwrap();
        let vault = SavedProfileVault::open(dir.path().join("empty-vault")).unwrap();
        let staged_vault = dir.path().join("staged-vault");
        let vpn_vault = vault.export_device_backup(&pool, None, &staged_vault).await.unwrap();
        let archive = dir.path().join("backup.zip");
        let manifest = DeviceBackupManifest {
            format: "norea-device-backup".into(),
            version: 2,
            device_name: "Test tablet".into(),
            created_at: 123,
            storage_root: Some("content://test/root".into()),
            settings: vec![DeviceSetting {
                key: "server".into(),
                value: "test-setting".into(),
            }],
            vpn_vault,
        };
        let profile = b"client\ndev tun\nremote vpn.example.test 1194\n";
        pack_archive(&source, &manifest, Some(profile), &staged_vault, &archive).unwrap();
        let (restored, vpn, database, vault_directory) = unpack_archive(&archive).unwrap();
        assert_eq!(restored.settings[0].value, "test-setting");
        assert_eq!(vpn.as_deref().unwrap(), profile);
        validate_staged_backup(&database, &vault_directory, &restored, vpn.as_deref(), &pool).await.unwrap();
        let mut zip = ZipArchive::new(File::open(archive).unwrap()).unwrap();
        assert_eq!(zip.len(), 4);
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
