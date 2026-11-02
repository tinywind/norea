use super::{
    profile_hash, publish_private_file, read_private_file, validate_ip, validate_saved_profile,
    validate_selection, SavedProfileVault, INDEX_FILE, MAX_INDEX_BYTES, MAX_PROFILE_BYTES,
};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) const VAULT_INDEX_ENTRY: &str = "saved-profiles/index.json";
static NEXT_PUBLICATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VpnVaultBackupEntry {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct VpnVaultBackupManifest {
    pub(crate) index: VpnVaultBackupEntry,
    pub(crate) profiles: Vec<VpnVaultBackupEntry>,
}

impl VpnVaultBackupManifest {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.index.path != VAULT_INDEX_ENTRY || self.profiles.len() > 100 {
            return Err("invalid VPN vault backup inventory".into());
        }
        let mut paths = HashSet::new();
        for entry in std::iter::once(&self.index).chain(&self.profiles) {
            validate_selection(&entry.sha256, &entry.sha256)?;
            let limit = vault_backup_entry_limit(&entry.path)?;
            if entry.size == 0 || entry.size > limit || !paths.insert(&entry.path) {
                return Err("invalid VPN vault backup entry".into());
            }
        }
        Ok(())
    }
}

pub(crate) fn vault_backup_entry_limit(path: &str) -> Result<u64, String> {
    if path == VAULT_INDEX_ENTRY {
        return Ok(MAX_INDEX_BYTES as u64);
    }
    let ip = path.strip_prefix("saved-profiles/").and_then(|name| name.strip_suffix(".ovpn"))
        .ok_or_else(|| "unknown VPN vault backup entry".to_string())?;
    validate_ip(ip)?;
    Ok(MAX_PROFILE_BYTES as u64)
}

pub(crate) fn create_private_backup_directory(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if !metadata.is_dir() => return Err("VPN backup directory is not regular".into()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
            _ => {}
        }
    }
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn write_private_backup_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    create_private_backup_directory(path.parent().ok_or_else(|| "invalid VPN backup path".to_string())?)?;
    publish_private_file(path, bytes)
}

pub(crate) fn read_backup_active_profile(path: &Path) -> Result<Option<Vec<u8>>, String> {
    reject_linked_backup_directory(path.parent().ok_or_else(|| "invalid managed VPN profile path".to_string())?)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let bytes = read_private_file(path, MAX_PROFILE_BYTES)?;
    super::super::validate_backup_profile(&bytes)?;
    Ok(Some(bytes))
}

pub(crate) fn read_backup_entry(directory: &Path, entry: &VpnVaultBackupEntry) -> Result<Vec<u8>, String> {
    reject_linked_backup_directory(directory)?;
    let name = entry.path.strip_prefix("saved-profiles/").ok_or_else(|| "invalid VPN backup path".to_string())?;
    let bytes = read_private_file(&directory.join(name), vault_backup_entry_limit(&entry.path)? as usize)?;
    if bytes.len() as u64 != entry.size || profile_hash(&bytes) != entry.sha256 {
        return Err("VPN vault backup size or hash does not match".into());
    }
    Ok(bytes)
}

pub(crate) async fn validate_vault_backup(
    directory: &Path,
    manifest: &VpnVaultBackupManifest,
    pool: &SqlitePool,
    active_profile: Option<&[u8]>,
) -> Result<SavedProfileVault, String> {
    manifest.validate()?;
    let vault = SavedProfileVault::open(directory.to_path_buf())?;
    read_backup_entry(directory, &manifest.index)?;
    if vault.index.profiles.len() != manifest.profiles.len() {
        return Err("VPN vault backup metadata and file inventory differ".into());
    }
    let expected: HashSet<&str> = std::iter::once(INDEX_FILE)
        .chain(manifest.profiles.iter().map(|entry| entry.path.strip_prefix("saved-profiles/").unwrap()))
        .collect();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !expected.contains(entry.file_name().to_string_lossy().as_ref()) {
            return Err("unexpected VPN vault backup file".into());
        }
    }
    for profile in &vault.index.profiles {
        let path = format!("saved-profiles/{}.ovpn", profile.ip);
        let entry = manifest.profiles.iter().find(|entry| entry.path == path)
            .ok_or_else(|| "VPN vault backup profile is missing".to_string())?;
        let bytes = read_backup_entry(directory, entry)?;
        if entry.sha256 != profile.hash || validate_saved_profile(&profile.ip, &bytes)? != profile.protocol {
            return Err("VPN vault backup profile identity or protocol differs".into());
        }
        let verdict: Option<(String, i64)> = sqlx::query_as(
            "SELECT verdict,updated_at FROM vpn_gate_server_verdict WHERE ip=?",
        ).bind(&profile.ip).fetch_optional(pool).await.map_err(|error| error.to_string())?;
        if verdict != Some(("works".into(), profile.approved_at)) {
            return Err("VPN vault backup profile approval does not match its database".into());
        }
    }
    if let Some(active) = &vault.index.active {
        if !active_profile.is_some_and(|bytes| profile_hash(bytes) == active.hash) {
            return Err("VPN vault backup active selection does not match its profile".into());
        }
    }
    Ok(vault)
}

impl SavedProfileVault {
    pub(crate) async fn export_device_backup(
        &self,
        pool: &SqlitePool,
        active_profile: Option<&[u8]>,
        directory: &Path,
    ) -> Result<VpnVaultBackupManifest, String> {
        self.require_healthy()?;
        reject_linked_backup_directory(&self.directory)?;
        let index = serde_json::to_vec(&self.index).map_err(|error| error.to_string())?;
        if index.len() > MAX_INDEX_BYTES {
            return Err("VPN vault backup index exceeds its size limit".into());
        }
        create_private_backup_directory(directory)?;
        publish_private_file(&directory.join(INDEX_FILE), &index)?;
        let mut manifest = VpnVaultBackupManifest {
            index: VpnVaultBackupEntry { path: VAULT_INDEX_ENTRY.into(), size: index.len() as u64, sha256: profile_hash(&index) },
            profiles: Vec::new(),
        };
        for profile in &self.index.profiles {
            let name = format!("{}.ovpn", profile.ip);
            let bytes = read_private_file(&self.directory.join(&name), MAX_PROFILE_BYTES)?;
            publish_private_file(&directory.join(&name), &bytes)?;
            manifest.profiles.push(VpnVaultBackupEntry { path: format!("saved-profiles/{name}"), size: bytes.len() as u64, sha256: profile_hash(&bytes) });
        }
        validate_vault_backup(directory, &manifest, pool, active_profile).await?;
        Ok(manifest)
    }

    pub(crate) fn require_idle_device_backup_restore(&self) -> Result<(), String> {
        if self.leases.is_empty() { Ok(()) } else { Err("stop all VPN download workers before restoring a device backup".into()) }
    }
}

fn reject_linked_backup_directory(directory: &Path) -> Result<(), String> {
    for path in std::iter::once(directory).chain(directory.parent()) {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_dir() => return Err("VPN backup directory is not regular".into()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
            _ => {}
        }
    }
    Ok(())
}

pub(crate) struct VpnBackupPublication {
    directory: PathBuf,
    stage: PathBuf,
    moved_profile: bool,
    moved_vault: bool,
    installed_profile: bool,
    installed_vault: bool,
}

impl VpnBackupPublication {
    pub(crate) fn install(
        profile_path: &Path,
        vault_directory: &Path,
        manifest: &VpnVaultBackupManifest,
        profile: Option<&[u8]>,
    ) -> Result<Self, String> {
        manifest.validate()?;
        if let Some(bytes) = profile { super::super::validate_backup_profile(bytes)?; }
        let directory = profile_path.parent().ok_or_else(|| "invalid managed VPN profile path".to_string())?;
        create_private_backup_directory(directory)?;
        for (name, is_directory) in [("profile.ovpn", false), ("saved-profiles", true)] {
            match fs::symlink_metadata(directory.join(name)) {
                Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_dir() != is_directory || (!is_directory && !metadata.is_file()) => return Err("managed VPN backup target is not regular".into()),
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.to_string()),
                _ => {}
            }
        }
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let stage = directory.join(format!(".device-backup-{stamp}-{}", NEXT_PUBLICATION.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&stage).map_err(|error| error.to_string())?;
        create_private_backup_directory(&stage)?;
        sync_backup_directory(directory)?;
        let mut publication = Self { directory: directory.to_path_buf(), stage, moved_profile: false, moved_vault: false, installed_profile: false, installed_vault: false };
        let result = (|| {
            let new_vault = publication.stage.join("new-vault");
            create_private_backup_directory(&new_vault)?;
            for entry in std::iter::once(&manifest.index).chain(&manifest.profiles) {
                let bytes = read_backup_entry(vault_directory, entry)?;
                let name = entry.path.strip_prefix("saved-profiles/").unwrap();
                publish_private_file(&new_vault.join(name), &bytes)?;
            }
            SavedProfileVault::open(new_vault.clone())?;
            if let Some(bytes) = profile { publish_private_file(&publication.stage.join("new-profile.ovpn"), bytes)?; }
            publication.moved_profile = move_if_present(profile_path, &publication.stage.join("old-profile.ovpn"))?;
            publication.moved_vault = move_if_present(&directory.join("saved-profiles"), &publication.stage.join("old-vault"))?;
            sync_backup_directory(&publication.stage)?;
            sync_backup_directory(directory)?;
            fs::rename(new_vault, directory.join("saved-profiles")).map_err(|error| error.to_string())?;
            publication.installed_vault = true;
            if profile.is_some() {
                fs::rename(publication.stage.join("new-profile.ovpn"), profile_path).map_err(|error| error.to_string())?;
                publication.installed_profile = true;
            }
            sync_backup_directory(directory)
        })();
        if let Err(error) = result {
            return match publication.rollback() {
                Ok(()) => Err(error),
                Err(rollback) => Err(format!("{error}; VPN backup rollback failed: {rollback}")),
            };
        }
        Ok(publication)
    }

    pub(crate) fn checkpoint_name(&self) -> String {
        self.stage.file_name().expect("generated publication directory").to_string_lossy().into_owned()
    }

    pub(crate) fn rollback(&mut self) -> Result<(), String> {
        if self.installed_profile {
            fs::rename(self.directory.join("profile.ovpn"), self.stage.join("new-profile.ovpn")).map_err(|error| error.to_string())?;
            self.installed_profile = false;
        }
        if self.installed_vault {
            fs::rename(self.directory.join("saved-profiles"), self.stage.join("new-vault")).map_err(|error| error.to_string())?;
            self.installed_vault = false;
        }
        if self.moved_profile {
            fs::rename(self.stage.join("old-profile.ovpn"), self.directory.join("profile.ovpn")).map_err(|error| error.to_string())?;
            self.moved_profile = false;
        }
        if self.moved_vault {
            fs::rename(self.stage.join("old-vault"), self.directory.join("saved-profiles")).map_err(|error| error.to_string())?;
            self.moved_vault = false;
        }
        sync_backup_directory(&self.directory)?;
        fs::remove_dir_all(&self.stage).map_err(|error| error.to_string())
    }

}

fn move_if_present(source: &Path, target: &Path) -> Result<bool, String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn sync_backup_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(directory).and_then(|file| file.sync_all()).map_err(|error| error.to_string())?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn profile(ip: &str) -> Vec<u8> {
        format!("client\ndev tun\nproto tcp-client\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n{}\nauth-user-pass\n", super::super::super::VPN_GATE_PROFILE_MARKER).into_bytes()
    }

    async fn fixture() -> (tempfile::TempDir, SqlitePool, SavedProfileVault) {
        let dir = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(dir.path().join("verdicts.db")).create_if_missing(true)
        ).await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict(ip TEXT PRIMARY KEY,verdict TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT(unixepoch()))").execute(&pool).await.unwrap();
        let vault = SavedProfileVault::open(dir.path().join("live/saved-profiles")).unwrap();
        (dir, pool, vault)
    }

    #[tokio::test]
    async fn backup_preserves_capacity_sequence_exact_bytes_selection_and_resets_leases() {
        let (dir, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4");
        let approved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
        vault.set_limit(&pool, 10).await.unwrap();
        vault.set_active(Some(SavedVpnProfileSelection { id: approved.id.clone(), hash: approved.hash.clone() })).unwrap();
        vault.reserve(&pool, "old-worker", &approved.id, &approved.hash, None).await.unwrap();
        let stage = dir.path().join("stage");
        let manifest = vault.export_device_backup(&pool, Some(&bytes), &stage).await.unwrap();
        let restored = validate_vault_backup(&stage, &manifest, &pool, Some(&bytes)).await.unwrap();
        assert_eq!(restored.index.limit, 10);
        assert_eq!(restored.index.sequence, 1);
        assert_eq!(restored.index.active.unwrap().id, approved.id);
        assert_eq!(restored.index.profiles, [approved]);
        assert!(restored.leases.is_empty());
        assert_eq!(fs::read(stage.join("8.8.4.4.ovpn")).unwrap(), bytes);
    }

    #[tokio::test]
    async fn backup_preserves_revoked_active_selection_as_unusable_instead_of_resurrecting_it() {
        let (dir, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4");
        let approved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
        vault.set_active(Some(SavedVpnProfileSelection { id: approved.id.clone(), hash: approved.hash.clone() })).unwrap();
        vault.revoke(&pool, "8.8.4.4", Some(VpnGateServerVerdictValue::Fails)).await.unwrap();
        let stage = dir.path().join("stage");
        let manifest = vault.export_device_backup(&pool, Some(&bytes), &stage).await.unwrap();
        let mut restored = validate_vault_backup(&stage, &manifest, &pool, Some(&bytes)).await.unwrap();
        assert!(restored.index.profiles.is_empty());
        assert_eq!(restored.index.active.as_ref().unwrap().id, approved.id);
        assert!(!stage.join("8.8.4.4.ovpn").exists());
        assert!(restored.validate_active(&pool, &bytes).await.is_err());
    }

    #[tokio::test]
    async fn empty_vault_backup_replaces_old_managed_data_without_touching_originals() {
        let (dir, pool, vault) = fixture().await;
        let stage = dir.path().join("empty");
        let manifest = vault.export_device_backup(&pool, None, &stage).await.unwrap();
        let live = dir.path().join("live");
        fs::create_dir_all(live.join("saved-profiles")).unwrap();
        fs::write(live.join("profile.ovpn"), profile("1.1.1.1")).unwrap();
        fs::write(live.join("saved-profiles/old.ovpn"), "old managed bytes").unwrap();
        let original = dir.path().join("imported.ovpn");
        fs::write(&original, "external original").unwrap();
        let publication = VpnBackupPublication::install(&live.join("profile.ovpn"), &stage, &manifest, None).unwrap();
        assert!(!live.join("profile.ovpn").exists());
        assert!(!live.join("saved-profiles/old.ovpn").exists());
        fs::remove_dir_all(publication.stage).unwrap();
        assert!(SavedProfileVault::open(live.join("saved-profiles")).unwrap().index.profiles.is_empty());
        assert_eq!(fs::read_to_string(original).unwrap(), "external original");
    }

    #[tokio::test]
    async fn backup_rejects_revoked_or_timestamp_mismatched_approval() {
        for update in ["UPDATE vpn_gate_server_verdict SET verdict='fails'", "UPDATE vpn_gate_server_verdict SET updated_at=updated_at+1", "DELETE FROM vpn_gate_server_verdict"] {
            let (dir, pool, mut vault) = fixture().await;
            vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4")).await.unwrap();
            let stage = dir.path().join("stage");
            let manifest = vault.export_device_backup(&pool, None, &stage).await.unwrap();
            sqlx::query(update).execute(&pool).await.unwrap();
            assert!(validate_vault_backup(&stage, &manifest, &pool, None).await.is_err());
            assert!(vault.export_device_backup(&pool, None, &dir.path().join("retry")).await.is_err());
        }
    }

    #[tokio::test]
    async fn backup_rejects_rehashed_unmarked_wrong_ip_or_wrong_protocol_profiles() {
        for replacement in [profile("1.1.1.1"), String::from_utf8(profile("8.8.4.4")).unwrap().replace(super::super::super::VPN_GATE_PROFILE_MARKER, "").into_bytes(), String::from_utf8(profile("8.8.4.4")).unwrap().replace("tcp-client", "udp").into_bytes()] {
            let (dir, pool, mut vault) = fixture().await;
            vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4")).await.unwrap();
            let stage = dir.path().join("stage");
            let mut manifest = vault.export_device_backup(&pool, None, &stage).await.unwrap();
            let mut index: serde_json::Value = serde_json::from_slice(&fs::read(stage.join(INDEX_FILE)).unwrap()).unwrap();
            let hash = profile_hash(&replacement);
            index["profiles"][0]["id"] = hash.clone().into();
            index["profiles"][0]["hash"] = hash.clone().into();
            let index = serde_json::to_vec(&index).unwrap();
            fs::write(stage.join(INDEX_FILE), &index).unwrap();
            fs::write(stage.join("8.8.4.4.ovpn"), &replacement).unwrap();
            manifest.index.size = index.len() as u64;
            manifest.index.sha256 = profile_hash(&index);
            manifest.profiles[0].size = replacement.len() as u64;
            manifest.profiles[0].sha256 = hash;
            assert!(validate_vault_backup(&stage, &manifest, &pool, None).await.is_err());
        }
    }

    #[tokio::test]
    async fn backup_rejects_hash_corruption_duplicate_paths_and_oversize_inventory() {
        let (dir, pool, mut vault) = fixture().await;
        vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4")).await.unwrap();
        let stage = dir.path().join("stage");
        let manifest = vault.export_device_backup(&pool, None, &stage).await.unwrap();
        let mut duplicate = manifest.clone();
        duplicate.profiles.push(duplicate.profiles[0].clone());
        assert!(validate_vault_backup(&stage, &duplicate, &pool, None).await.is_err());
        let mut oversized = manifest.clone();
        oversized.profiles[0].size = MAX_PROFILE_BYTES as u64 + 1;
        assert!(oversized.validate().is_err());
        oversized = manifest.clone();
        oversized.index.size = MAX_INDEX_BYTES as u64 + 1;
        assert!(oversized.validate().is_err());
        oversized = manifest.clone();
        oversized.profiles = vec![manifest.profiles[0].clone(); 101];
        assert!(oversized.validate().is_err());
        fs::write(stage.join("8.8.4.4.ovpn"), b"corrupt").unwrap();
        assert!(validate_vault_backup(&stage, &manifest, &pool, None).await.is_err());
    }

    #[tokio::test]
    async fn publication_rollback_restores_both_files_and_old_index() {
        let (dir, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4");
        vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap();
        let stage = dir.path().join("stage");
        let manifest = vault.export_device_backup(&pool, None, &stage).await.unwrap();
        let live = dir.path().join("live");
        fs::write(live.join("profile.ovpn"), b"old active file").unwrap();
        let old_index = fs::read(live.join("saved-profiles/index.json")).unwrap();
        let mut publication = VpnBackupPublication::install(&live.join("profile.ovpn"), &stage, &manifest, Some(&bytes)).unwrap();
        assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), bytes);
        publication.rollback().unwrap();
        assert_eq!(fs::read(live.join("profile.ovpn")).unwrap(), b"old active file");
        assert_eq!(fs::read(live.join("saved-profiles/index.json")).unwrap(), old_index);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn backup_reads_reject_symlinked_managed_directories() {
        use std::os::unix::fs::symlink;
        let (dir, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4");
        vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap();
        let outside = dir.path().join("external-vault");
        fs::rename(&vault.directory, &outside).unwrap();
        symlink(&outside, &vault.directory).unwrap();
        assert!(vault.export_device_backup(&pool, None, &dir.path().join("stage")).await.is_err());
        let external_profile = dir.path().join("external-profile");
        fs::create_dir(&external_profile).unwrap();
        fs::write(external_profile.join("profile.ovpn"), &bytes).unwrap();
        let linked = dir.path().join("linked-profile");
        symlink(&external_profile, &linked).unwrap();
        assert!(read_backup_active_profile(&linked.join("profile.ovpn")).is_err());
        assert_eq!(fs::read(external_profile.join("profile.ovpn")).unwrap(), bytes);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn publication_rejects_symlinks_without_changing_external_files() {
        use std::os::unix::fs::symlink;
        let (dir, pool, vault) = fixture().await;
        let stage = dir.path().join("stage");
        let manifest = vault.export_device_backup(&pool, None, &stage).await.unwrap();
        let outside = dir.path().join("external.ovpn");
        fs::write(&outside, "original").unwrap();
        let live = dir.path().join("live");
        fs::create_dir_all(&live).unwrap();
        symlink(&outside, live.join("profile.ovpn")).unwrap();
        assert!(VpnBackupPublication::install(&live.join("profile.ovpn"), &stage, &manifest, None).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "original");
    }
}
