use super::{failure, DeviceSetting, MAX_SETTINGS_BYTES};
use crate::plugin_vpn::saved_profiles::backup::{create_private_backup_directory, sync_backup_directory, write_private_backup_file};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const DIRECTORY: &str = ".device-restore";
const RECORD: &str = "restore.json";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreReceipt {
    pub(crate) id: String,
    pub(crate) settings: Vec<DeviceSetting>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreRecord {
    version: u32,
    id: String,
    committed: bool,
    publication: Option<String>,
    previous_storage_root: Option<String>,
    settings: Vec<DeviceSetting>,
}

pub(crate) struct RestoreCheckpoint {
    parent: PathBuf,
    record: RestoreRecord,
}

fn parent(profile_path: &Path) -> Result<&Path, String> {
    profile_path.parent().ok_or_else(|| failure("invalid managed VPN profile path"))
}

fn blocked(path: &Path) -> String {
    failure(format!("unfinished device restore at {}; app startup is blocked to protect mixed database, VPN and settings state. Preserve this checkpoint and its rollback files for recovery", path.display()))
}

fn require_no_publication(directory: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(failure(error)),
    };
    for entry in entries {
        let entry = entry.map_err(failure)?;
        if entry.file_name().to_string_lossy().starts_with(".device-backup-") { return Err(blocked(&entry.path())); }
    }
    Ok(())
}

pub(crate) fn require_complete(profile_path: &Path) -> Result<(), String> {
    let directory = parent(profile_path)?;
    for ancestor in directory.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if !metadata.is_dir() => return Err(failure("device restore checkpoint parent is not a regular directory")),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(failure(error)),
            _ => {},
        }
    }
    let checkpoint = directory.join(DIRECTORY);
    match fs::symlink_metadata(&checkpoint) {
        Ok(_) => return Err(blocked(&checkpoint)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(failure(error)),
    }
    require_no_publication(directory)
}

impl RestoreCheckpoint {
    pub(crate) fn begin(profile_path: &Path, previous_storage_root: Option<String>, settings: Vec<DeviceSetting>) -> Result<Self, String> {
        require_complete(profile_path)?;
        let parent = parent(profile_path)?.to_path_buf();
        create_private_backup_directory(&parent)?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let id = Sha256::digest(format!("{stamp}:{}", std::process::id())).iter().map(|byte| format!("{byte:02x}")).collect();
        let checkpoint = Self { parent, record: RestoreRecord { version: 1, id, committed: false, publication: None, previous_storage_root, settings } };
        let bytes = checkpoint.bytes()?;
        fs::create_dir(checkpoint.parent.join(DIRECTORY)).map_err(failure)?;
        create_private_backup_directory(&checkpoint.parent.join(DIRECTORY))?;
        write_private_backup_file(&checkpoint.parent.join(DIRECTORY).join(RECORD), &bytes)?;
        sync_backup_directory(&checkpoint.parent)?;
        Ok(checkpoint)
    }

    fn bytes(&self) -> Result<Vec<u8>, String> {
        let bytes = serde_json::to_vec(&self.record).map_err(failure)?;
        if bytes.len() > MAX_SETTINGS_BYTES as usize { return Err(failure("restore checkpoint exceeds the settings size limit")); }
        Ok(bytes)
    }

    pub(crate) fn committed(&mut self, publication: String) -> Result<RestoreReceipt, String> {
        validate_publication(&publication)?;
        self.record.publication = Some(publication);
        self.record.committed = true;
        write_private_backup_file(&self.parent.join(DIRECTORY).join(RECORD), &self.bytes()?)?;
        Ok(RestoreReceipt { id: self.record.id.clone(), settings: self.record.settings.clone() })
    }

    pub(crate) fn rolled_back(self) -> Result<(), String> {
        require_no_publication(&self.parent)?;
        self.remove()
    }

    fn remove(self) -> Result<(), String> {
        let directory = self.parent.join(DIRECTORY);
        fs::remove_file(directory.join(RECORD)).map_err(failure)?;
        fs::remove_dir(directory).map_err(failure)?;
        sync_backup_directory(&self.parent)
    }
}

fn validate_publication(name: &str) -> Result<(), String> {
    if !name.strip_prefix(".device-backup-").is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit() || byte == b'-')) {
        return Err(failure("invalid device restore rollback directory"));
    }
    Ok(())
}

pub(crate) fn complete(profile_path: &Path, restore_id: &str) -> Result<(), String> {
    let parent = parent(profile_path)?.to_path_buf();
    create_private_backup_directory(&parent)?;
    let directory = parent.join(DIRECTORY);
    if !fs::symlink_metadata(&directory).map_err(failure)?.is_dir() { return Err(failure("restore checkpoint is not a regular directory")); }
    let path = directory.join(RECORD);
    let metadata = fs::symlink_metadata(&path).map_err(failure)?;
    if !metadata.is_file() || metadata.len() > MAX_SETTINGS_BYTES { return Err(failure("restore checkpoint is not a bounded regular file")); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(failure)?.take(MAX_SETTINGS_BYTES + 1).read_to_end(&mut bytes).map_err(failure)?;
    if bytes.len() > MAX_SETTINGS_BYTES as usize { return Err(failure("restore checkpoint exceeds the settings size limit")); }
    let record: RestoreRecord = serde_json::from_slice(&bytes).map_err(failure)?;
    let mut keys = HashSet::new();
    if record.version != 1 || !record.committed || record.id != restore_id || record.id.len() != 64 ||
        !record.id.bytes().all(|byte| byte.is_ascii_hexdigit()) || !record.settings.iter().all(|setting| keys.insert(&setting.key)) {
        return Err(failure("device restore acknowledgement does not match a committed checkpoint"));
    }
    let publication = record.publication.as_deref().ok_or_else(|| failure("device restore rollback directory is missing"))?;
    validate_publication(publication)?;
    let stage = parent.join(publication);
    match fs::symlink_metadata(&stage) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&stage).map_err(failure)?,
        Ok(_) => return Err(failure("device restore rollback directory is not regular")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(failure(error)),
    }
    require_no_publication(&parent)?;
    RestoreCheckpoint { parent, record }.remove()
}
