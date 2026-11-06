use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use super::{
    directive_tokens,
    finder::{inspect_profile_transport, is_public_ipv4, VpnGateProtocol},
    inline_closing_tag, inline_opening_tag, validate_profile, MAX_PROFILE_BYTES,
};

#[path = "saved_profiles_backup.rs"]
pub(crate) mod backup;
#[path = "saved_profiles_automatic.rs"]
pub(crate) mod automatic;
#[path = "saved_profiles_stored.rs"]
pub(crate) mod stored;

const INDEX_FILE: &str = "index.json";
const MAX_INDEX_BYTES: usize = 128 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
static NEXT_QUARANTINE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedVpnProfile {
    pub(crate) id: String,
    pub(crate) ip: String,
    pub(crate) protocol: VpnGateProtocol,
    pub(crate) hash: String,
    pub(crate) approved_at: i64,
    pub(crate) approval_sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SavedVpnProfileSelection {
    pub(crate) id: String,
    pub(crate) hash: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum SavedVpnProfileCaptureSource {
    Finder {
        #[serde(rename = "candidateId")]
        candidate_id: String,
    },
    Active {
        #[serde(rename = "expectedHash")]
        expected_hash: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum VpnGateServerVerdictValue {
    Works,
    Fails,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VpnGateServerVerdict {
    ip: String,
    verdict: VpnGateServerVerdictValue,
    updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VpnGateServerVerdictMutation {
    pub(crate) verdict: Option<VpnGateServerVerdict>,
    pub(crate) saved_profile: Option<SavedVpnProfile>,
    pub(crate) cleanup_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedVpnProfileVaultSnapshot {
    pub(crate) limit: usize,
    pub(crate) profiles: Vec<SavedVpnProfile>,
    pub(crate) cleanup_error: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct SavedVpnProfileLease {
    pub(crate) owner: String,
    pub(crate) profile: SavedVpnProfile,
    pub(crate) revoked: bool,
    pub(crate) revocation: Arc<AtomicBool>,
}

impl SavedVpnProfileLease {
    pub(crate) fn is_revoked(&self) -> bool { self.revoked || self.revocation.load(Ordering::Acquire) }
}

pub(crate) struct ForegroundVpnProfile {
    pub(crate) remote_hosts: Vec<String>,
    pub(crate) hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultIndex {
    version: u8,
    limit: usize,
    sequence: u64,
    profiles: Vec<SavedVpnProfile>,
    active: Option<SavedVpnProfileSelection>,
}

impl Default for VaultIndex {
    fn default() -> Self {
        Self {
            version: 1,
            limit: 20,
            sequence: 0,
            profiles: Vec::new(),
            active: None,
        }
    }
}

pub(crate) struct SavedProfileVault {
    directory: PathBuf,
    index: VaultIndex,
    automatic: automatic::AutomaticProfilePool,
    stored: stored::StoredProfiles,
    leases: HashMap<String, SavedVpnProfileLease>,
    publication_failed: bool,
}

/// Automatic servers live beside the approved vault, outside device backups of `saved-profiles`.
fn automatic_directory(directory: &Path) -> PathBuf { directory.with_file_name("automatic-profiles") }

impl SavedProfileVault {
    pub(super) fn quarantine_and_open(directory: PathBuf, active: Option<SavedVpnProfileSelection>) -> Result<Self, String> {
        if let Some(active) = &active { validate_selection(&active.id, &active.hash)?; }
        let existing = match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => true,
            Ok(_) => return Err("saved VPN profile directory is not a regular directory".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("could not inspect the unusable VPN profile vault: {error}")),
        };
        let recovery = vault_recovery_marker(&directory)?;
        let checkpoint = serde_json::to_vec(&active).map_err(|error| format!("could not encode saved VPN profile recovery: {error}"))?;
        publish_private_file(&recovery, &checkpoint)?;
        if existing {
            let name = directory.file_name().ok_or_else(|| "saved VPN profile directory is invalid".to_string())?.to_string_lossy();
            let target = loop {
                let sequence = NEXT_QUARANTINE.fetch_add(1, Ordering::Relaxed);
                let candidate = directory.with_file_name(format!("{name}.quarantine-{}-{sequence}", std::process::id()));
                if !candidate.try_exists().map_err(|error| error.to_string())? { break candidate; }
            };
            fs::rename(&directory, target).map_err(|error| format!("could not quarantine the unusable VPN profile vault: {error}"))?;
        }
        let mut vault = Self {
            automatic: automatic::AutomaticProfilePool::open(automatic_directory(&directory)),
            stored: stored::StoredProfiles::open(&directory),
            directory,
            index: VaultIndex { active, ..VaultIndex::default() },
            leases: HashMap::new(),
            publication_failed: false,
        };
        vault.persist()?;
        sync_vault_parent(&vault.directory)?;
        remove_private_file(&recovery)?;
        sync_vault_parent(&vault.directory)?;
        Ok(vault)
    }

    pub(super) fn needs_recovery(&self) -> bool { self.publication_failed }

    pub(super) fn has_leases(&self) -> bool { !self.leases.is_empty() }

    pub(super) fn active_selection(&self) -> Option<SavedVpnProfileSelection> { self.index.active.clone() }

    pub(super) fn restore_active_selection(&mut self, active: Option<SavedVpnProfileSelection>) -> Result<(), String> {
        if let Some(active) = &active { validate_selection(&active.id, &active.hash)?; }
        self.index.active = active;
        self.persist()?;
        self.publication_failed = false;
        Ok(())
    }

    pub(crate) fn open(directory: PathBuf) -> Result<Self, String> {
        let recovery = vault_recovery_marker(&directory)?;
        let recovery_name = recovery.file_name().expect("vault recovery filename");
        for suffix in ["", ".part", ".backup"] {
            let mut name = recovery_name.to_os_string();
            name.push(suffix);
            match fs::symlink_metadata(recovery.with_file_name(name)) {
                Ok(_) => return Err("saved VPN profile vault recovery was interrupted; profile allocation is disabled".to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(format!("could not inspect saved VPN profile recovery: {error}")),
            }
        }
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if !metadata.is_dir() => {
                return Err("saved VPN profile directory is not a regular directory".to_string())
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!(
                    "could not inspect the saved VPN profile directory: {error}"
                ))
            }
            _ => {}
        }
        for sidecar in ["index.json.part", "index.json.backup"] {
            match fs::symlink_metadata(directory.join(sidecar)) {
                Ok(_) => return Err("saved VPN profile index publication was interrupted; profile allocation is disabled".to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => return Err(format!("could not inspect saved VPN profile publication: {error}")),
            }
        }
        let path = directory.join(INDEX_FILE);
        let index = match fs::symlink_metadata(&path) {
            Ok(_) => {
                serde_json::from_slice::<VaultIndex>(&read_private_file(&path, MAX_INDEX_BYTES)?)
                    .map_err(|error| {
                        format!("could not read the saved VPN profile index: {error}")
                    })?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if directory
                    .join("index.json.backup")
                    .try_exists()
                    .map_err(|error| {
                        format!("could not inspect saved VPN profile publication: {error}")
                    })?
                    || directory
                        .join("index.json.part")
                        .try_exists()
                        .map_err(|error| {
                            format!("could not inspect saved VPN profile publication: {error}")
                        })?
                {
                    return Err("saved VPN profile index publication was interrupted; profile allocation is disabled".to_string());
                }
                VaultIndex::default()
            }
            Err(error) => {
                return Err(format!(
                    "could not inspect the saved VPN profile index: {error}"
                ))
            }
        };
        if index.version != 1
            || !(1..=100).contains(&index.limit)
            || index.profiles.len() > index.limit
            || index.sequence > MAX_SAFE_INTEGER
        {
            return Err("saved VPN profile index is invalid".to_string());
        }
        let mut ips = HashSet::new();
        let mut sequences = HashSet::new();
        for profile in &index.profiles {
            validate_ip(&profile.ip)?;
            validate_selection(&profile.id, &profile.hash)?;
            if profile.approved_at < 0
                || profile.approved_at as u64 > MAX_SAFE_INTEGER
                || profile.approval_sequence == 0
                || profile.approval_sequence > index.sequence
                || !ips.insert(&profile.ip)
                || !sequences.insert(profile.approval_sequence)
            {
                return Err("saved VPN profile metadata is invalid".to_string());
            }
        }
        if let Some(active) = &index.active {
            validate_selection(&active.id, &active.hash)?;
        }
        Ok(Self {
            automatic: automatic::AutomaticProfilePool::open(automatic_directory(&directory)),
            stored: stored::StoredProfiles::open(&directory),
            directory,
            index,
            leases: HashMap::new(),
            publication_failed: false,
        })
    }

    fn require_healthy(&self) -> Result<(), String> {
        if self.publication_failed {
            Err(
                "saved VPN profile publication failed; restart before allocating profiles"
                    .to_string(),
            )
        } else {
            Ok(())
        }
    }

    fn persist(&mut self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.index)
            .map_err(|error| format!("could not encode the saved VPN profile index: {error}"))?;
        if bytes.len() > MAX_INDEX_BYTES {
            return Err("saved VPN profile index exceeds its size limit".to_string());
        }
        let result = publish_private_file(&self.directory.join(INDEX_FILE), &bytes);
        if result.is_err() {
            self.publication_failed = true;
        }
        result
    }

    fn invalidate_ip(&mut self, ip: &str) {
        for lease in self
            .leases
            .values_mut()
            .filter(|lease| lease.profile.ip == ip)
        {
            lease.revoked = true;
            lease.revocation.store(true, Ordering::Release);
        }
    }

    fn forget(&mut self, ip: &str) {
        self.invalidate_ip(ip);
        self.index.profiles.retain(|profile| profile.ip != ip);
    }

    async fn reconcile(&mut self, pool: &SqlitePool) -> Result<Option<String>, String> {
        self.require_healthy()?;
        let mut invalid = Vec::new();
        for profile in &self.index.profiles {
            let verdict: Option<(String, i64)> = sqlx::query_as(
                "SELECT verdict, updated_at FROM vpn_gate_server_verdict WHERE ip = ?",
            )
            .bind(&profile.ip)
            .fetch_optional(pool)
            .await
            .map_err(|error| format!("could not verify saved VPN profile approval: {error}"))?;
            let valid_file = read_private_file(
                &self.directory.join(format!("{}.ovpn", profile.ip)),
                MAX_PROFILE_BYTES,
            )
            .and_then(|bytes| {
                validate_saved_profile(&profile.ip, &bytes).map(|protocol| (bytes, protocol))
            })
            .is_ok_and(|(bytes, protocol)| {
                profile_hash(&bytes) == profile.hash && protocol == profile.protocol
            });
            if verdict != Some(("works".to_string(), profile.approved_at)) || !valid_file {
                invalid.push(profile.ip.clone());
            }
        }
        if !invalid.is_empty() {
            for ip in invalid {
                self.forget(&ip);
            }
            self.persist()?;
        }
        let marked = marked_ips(pool).await?;
        for ip in self.automatic.reconcile(&marked)? { self.invalidate_ip(&ip); }
        Ok(self.cleanup_orphans())
    }

    fn cleanup_orphans(&self) -> Option<String> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                return Some(format!(
                    "could not inspect saved VPN profile files: {error}"
                ))
            }
        };
        let retained: HashSet<String> = self
            .index
            .profiles
            .iter()
            .map(|profile| format!("{}.ovpn", profile.ip))
            .collect();
        let mut failure = None;
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    failure = Some(format!(
                        "could not inspect a saved VPN profile file: {error}"
                    ));
                    continue;
                }
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == INDEX_FILE || retained.contains(name.as_ref()) {
                continue;
            }
            if name.ends_with(".ovpn") || name.ends_with(".part") || name.ends_with(".backup") {
                if let Err(error) = remove_private_file(&entry.path()) {
                    failure = Some(error);
                }
            }
        }
        failure
    }

    pub(crate) async fn snapshot(
        &mut self,
        pool: &SqlitePool,
    ) -> Result<SavedVpnProfileVaultSnapshot, String> {
        let cleanup_error = self.reconcile(pool).await?;
        Ok(self.snapshot_with_error(cleanup_error))
    }

    fn snapshot_with_error(&self, cleanup_error: Option<String>) -> SavedVpnProfileVaultSnapshot {
        let mut profiles = self.index.profiles.clone();
        profiles.sort_by_key(|profile| std::cmp::Reverse(profile.approval_sequence));
        SavedVpnProfileVaultSnapshot {
            limit: self.index.limit,
            profiles,
            cleanup_error,
        }
    }

    pub(crate) async fn capture(
        &mut self,
        pool: &SqlitePool,
        ip: &str,
        bytes: &[u8],
    ) -> Result<VpnGateServerVerdictMutation, String> {
        self.require_healthy()?;
        let protocol = validate_saved_profile(ip, bytes)?;
        self.reconcile(pool).await?;
        self.forget(ip);
        // Commit the absence before publishing bytes: an interrupted reapproval cannot resurrect the old entry.
        self.persist()?;
        publish_private_file(&self.directory.join(format!("{ip}.ovpn")), bytes)?;
        let updated_at: i64 = sqlx::query_scalar("INSERT INTO vpn_gate_server_verdict (ip, verdict) VALUES (?, 'works') ON CONFLICT(ip) DO UPDATE SET verdict = excluded.verdict, updated_at = unixepoch() RETURNING updated_at")
            .bind(ip).fetch_one(pool).await.map_err(|error| format!("could not save VPN Gate approval: {error}"))?;
        let sequence = self
            .index
            .sequence
            .checked_add(1)
            .filter(|sequence| *sequence <= MAX_SAFE_INTEGER)
            .ok_or_else(|| "saved VPN profile approval sequence is exhausted".to_string())?;
        let hash = profile_hash(bytes);
        let profile = SavedVpnProfile {
            id: hash.clone(),
            ip: ip.to_string(),
            protocol,
            hash,
            approved_at: updated_at,
            approval_sequence: sequence,
        };
        self.index.sequence = sequence;
        self.index.profiles.push(profile.clone());
        self.evict_oldest();
        self.persist()?;
        let cleanup_error = self.cleanup_orphans();
        Ok(VpnGateServerVerdictMutation {
            verdict: Some(VpnGateServerVerdict {
                ip: ip.to_string(),
                verdict: VpnGateServerVerdictValue::Works,
                updated_at,
            }),
            saved_profile: Some(profile),
            cleanup_error,
        })
    }

    pub(crate) async fn revoke(
        &mut self,
        pool: &SqlitePool,
        ip: &str,
        verdict: Option<VpnGateServerVerdictValue>,
    ) -> Result<VpnGateServerVerdictMutation, String> {
        validate_ip(ip)?;
        if verdict == Some(VpnGateServerVerdictValue::Works) {
            return Err("approval requires capture of an exact VPN Gate profile".to_string());
        }
        self.forget(ip);
        let publication_error = self.persist().err();
        let persisted_verdict: Result<Option<VpnGateServerVerdict>, String> = async { Ok(if verdict.is_some() {
            let updated_at: i64 = sqlx::query_scalar("INSERT INTO vpn_gate_server_verdict (ip, verdict) VALUES (?, 'fails') ON CONFLICT(ip) DO UPDATE SET verdict = excluded.verdict, updated_at = unixepoch() RETURNING updated_at")
                .bind(ip).fetch_one(pool).await.map_err(|error| format!("could not save VPN Gate revocation: {error}"))?;
            Some(VpnGateServerVerdict {
                ip: ip.to_string(),
                verdict: VpnGateServerVerdictValue::Fails,
                updated_at,
            })
        } else {
            sqlx::query("DELETE FROM vpn_gate_server_verdict WHERE ip = ?")
                .bind(ip)
                .execute(pool)
                .await
                .map_err(|error| format!("could not clear VPN Gate approval: {error}"))?;
            None
        }) }.await;
        let cleanup_error = publication_error.or(self.cleanup_orphans());
        let persisted_verdict = persisted_verdict.map_err(|error| match &cleanup_error {
            Some(cleanup) => format!("{error}; saved profile invalidation also reported: {cleanup}"),
            None => error,
        })?;
        Ok(VpnGateServerVerdictMutation {
            verdict: persisted_verdict,
            saved_profile: None,
            cleanup_error,
        })
    }

    fn evict_oldest(&mut self) {
        self.index
            .profiles
            .sort_by_key(|profile| std::cmp::Reverse(profile.approval_sequence));
        while self.index.profiles.len() > self.index.limit {
            if let Some(profile) = self.index.profiles.pop() {
                self.invalidate_ip(&profile.ip);
            }
        }
    }

    pub(crate) async fn set_limit(
        &mut self,
        pool: &SqlitePool,
        limit: usize,
    ) -> Result<SavedVpnProfileVaultSnapshot, String> {
        if !(1..=100).contains(&limit) {
            return Err("saved VPN profile capacity must be between 1 and 100".to_string());
        }
        self.reconcile(pool).await?;
        self.index.limit = limit;
        self.evict_oldest();
        self.persist()?;
        for ip in self.automatic.set_limit(limit)? { self.invalidate_ip(&ip); }
        Ok(self.snapshot_with_error(self.cleanup_orphans()))
    }

    pub(crate) async fn read_retained(
        &mut self,
        pool: &SqlitePool,
        id: &str,
        expected_hash: &str,
    ) -> Result<(SavedVpnProfile, Vec<u8>), String> {
        validate_selection(id, expected_hash)?;
        self.reconcile(pool).await?;
        let profile = self
            .index
            .profiles
            .iter()
            .find(|profile| profile.id == id && profile.hash == expected_hash)
            .cloned()
            .ok_or_else(|| "saved VPN profile is no longer approved or available".to_string())?;
        let bytes = read_private_file(
            &self.directory.join(format!("{}.ovpn", profile.ip)),
            MAX_PROFILE_BYTES,
        )?;
        if profile_hash(&bytes) != expected_hash
            || validate_saved_profile(&profile.ip, &bytes)? != profile.protocol
        {
            self.forget(&profile.ip);
            self.persist()?;
            return Err("saved VPN profile hash or protocol changed".to_string());
        }
        Ok((profile, bytes))
    }

    /// Worker leases may use an approved profile or an automatic server; the foreground uses approved ones only.
    async fn read_leasable(
        &mut self,
        pool: &SqlitePool,
        id: &str,
        expected_hash: &str,
    ) -> Result<(SavedVpnProfile, Vec<u8>), String> {
        validate_selection(id, expected_hash)?;
        self.reconcile(pool).await?;
        if self.index.profiles.iter().any(|profile| profile.id == id && profile.hash == expected_hash) {
            return self.read_retained(pool, id, expected_hash).await;
        }
        let (profile, bytes) = self.automatic.read(id, expected_hash)?
            .ok_or_else(|| "saved VPN profile is no longer approved or available".to_string())?;
        Ok((profile.lease_profile(), bytes))
    }

    pub(crate) async fn automatic_profiles(&mut self, pool: &SqlitePool) -> Result<Vec<automatic::AutomaticVpnProfile>, String> {
        self.reconcile(pool).await?;
        Ok(self.automatic.profiles())
    }

    /// True when a Finder candidate should not be tested: the user marked its IP, it is in either pool, or a worker leases it.
    pub(crate) async fn automatic_candidate_known(&mut self, pool: &SqlitePool, ip: &str) -> Result<bool, String> {
        validate_ip(ip)?;
        self.reconcile(pool).await?;
        Ok(marked_ips(pool).await?.contains(ip) || self.automatic.contains_ip(ip) ||
            self.leases.values().any(|lease| lease.profile.ip == ip))
    }

    pub(crate) async fn add_automatic(
        &mut self, pool: &SqlitePool, ip: &str, bytes: &[u8], score: u64, tested_at: i64,
    ) -> Result<automatic::AutomaticVpnProfile, String> {
        self.require_healthy()?;
        self.reconcile(pool).await?;
        let (profile, removed) = self.automatic.add(ip, bytes, score, tested_at, self.index.limit, &marked_ips(pool).await?)?;
        for ip in removed { self.invalidate_ip(&ip); }
        Ok(profile)
    }

    /// Approves, as O, every tested server without a recent worker tunnel failure ("Approve all
    /// working"). The best-scored server is approved last so capacity eviction keeps it longest.
    /// A worker already leasing one keeps running: the approved file has the same bytes and hash.
    /// Returns the newly approved profiles.
    pub(crate) async fn approve_working_automatic(&mut self, pool: &SqlitePool) -> Result<Vec<SavedVpnProfile>, String> {
        self.require_healthy()?;
        self.reconcile(pool).await?;
        let mut working: Vec<_> = self.automatic.profiles().into_iter().filter(|profile| profile.failures == 0).collect();
        working.reverse();
        let mut approved = Vec::new();
        for candidate in working {
            let Ok(Some((tested, bytes))) = self.automatic.read(&candidate.id, &candidate.hash) else { continue };
            let protocol = validate_saved_profile(&tested.ip, &bytes)?;
            publish_private_file(&self.directory.join(format!("{}.ovpn", tested.ip)), &bytes)?;
            let updated_at: i64 = sqlx::query_scalar("INSERT INTO vpn_gate_server_verdict (ip, verdict) VALUES (?, 'works') ON CONFLICT(ip) DO UPDATE SET verdict = excluded.verdict, updated_at = unixepoch() RETURNING updated_at")
                .bind(&tested.ip).fetch_one(pool).await.map_err(|error| format!("could not save VPN Gate approval: {error}"))?;
            let sequence = self
                .index
                .sequence
                .checked_add(1)
                .filter(|sequence| *sequence <= MAX_SAFE_INTEGER)
                .ok_or_else(|| "saved VPN profile approval sequence is exhausted".to_string())?;
            let profile = SavedVpnProfile {
                id: tested.hash.clone(),
                ip: tested.ip.clone(),
                protocol,
                hash: tested.hash.clone(),
                approved_at: updated_at,
                approval_sequence: sequence,
            };
            self.index.sequence = sequence;
            self.index.profiles.push(profile.clone());
            for lease in self.leases.values_mut().filter(|lease| lease.profile.ip == profile.ip && lease.profile.hash == profile.hash) {
                lease.profile = profile.clone();
            }
            self.evict_oldest();
            self.persist()?;
            approved.push(profile);
        }
        let approved_ips: HashSet<&str> = approved.iter().map(|profile| profile.ip.as_str()).collect();
        for ip in self.automatic.reconcile(&marked_ips(pool).await?)? {
            if !approved_ips.contains(ip.as_str()) { self.invalidate_ip(&ip); }
        }
        if let Some(error) = self.cleanup_orphans() { log::warn!("{error}"); }
        let retained: HashSet<&str> = self.index.profiles.iter().map(|profile| profile.ip.as_str()).collect();
        Ok(approved.into_iter().filter(|profile| retained.contains(profile.ip.as_str())).collect())
    }

    pub(crate) fn record_automatic_result(&mut self, id: &str, hash: &str, connected: bool) -> Result<(), String> {
        validate_selection(id, hash)?;
        if let Some(ip) = self.automatic.record_result(id, hash, connected)? { self.invalidate_ip(&ip); }
        Ok(())
    }

    pub(crate) async fn read_for_apply(
        &mut self,
        pool: &SqlitePool,
        id: &str,
        expected_hash: &str,
    ) -> Result<(SavedVpnProfile, Vec<u8>), String> {
        let (profile, bytes) = self.read_retained(pool, id, expected_hash).await?;
        self.ensure_foreground_available(&profile.ip, &profile.hash)?;
        Ok((profile, bytes))
    }

    pub(crate) fn set_active(
        &mut self,
        active: Option<SavedVpnProfileSelection>,
    ) -> Result<(), String> {
        self.require_healthy()?;
        if let Some(active) = &active {
            validate_selection(&active.id, &active.hash)?;
        }
        let previous = std::mem::replace(&mut self.index.active, active);
        if let Err(error) = self.persist() {
            self.index.active = previous;
            return Err(error);
        }
        Ok(())
    }

    pub(crate) async fn validate_active(
        &mut self,
        pool: &SqlitePool,
        bytes: &[u8],
    ) -> Result<(), String> {
        if let Some(active) = self.index.active.clone() {
            if profile_hash(bytes) != active.hash {
                return Err("active saved VPN profile hash changed".to_string());
            }
            self.read_for_apply(pool, &active.id, &active.hash).await?;
        }
        let validated = validate_profile(bytes)?;
        for host in &validated.remote_hosts { self.ensure_foreground_available(host, &validated.hash)?; }
        Ok(())
    }

    pub(crate) fn ensure_foreground_available(&self, ip: &str, hash: &str) -> Result<(), String> {
        if self
            .leases
            .values()
            .any(|lease| lease.profile.ip == ip || lease.profile.hash == hash)
        {
            return Err("VPN profile is reserved by a download worker".to_string());
        }
        Ok(())
    }

    pub(crate) async fn reserve(
        &mut self,
        pool: &SqlitePool,
        owner: &str,
        id: &str,
        expected_hash: &str,
        foreground: Option<&ForegroundVpnProfile>,
    ) -> Result<SavedVpnProfileLease, String> {
        if owner.is_empty() || owner.len() > 128 || owner.chars().any(char::is_control) {
            return Err("saved VPN profile lease owner is invalid".to_string());
        }
        if self.leases.len() >= 100 || self.leases.contains_key(owner) {
            return Err(
                "saved VPN profile owner already has a lease or the lease limit is reached"
                    .to_string(),
            );
        }
        let (profile, _) = self.read_leasable(pool, id, expected_hash).await?;
        if foreground
            .is_some_and(|current| current.remote_hosts.contains(&profile.ip) || current.hash == profile.hash)
        {
            return Err("saved VPN profile is the current foreground profile".to_string());
        }
        self.ensure_foreground_available(&profile.ip, &profile.hash)?;
        let lease = SavedVpnProfileLease {
            owner: owner.to_string(),
            profile,
            revoked: false,
            revocation: Arc::new(AtomicBool::new(false)),
        };
        self.leases.insert(owner.to_string(), lease.clone());
        Ok(lease)
    }

    pub(crate) async fn lease(
        &mut self,
        pool: &SqlitePool,
        owner: &str,
    ) -> Result<Option<SavedVpnProfileLease>, String> {
        self.reconcile(pool).await?;
        Ok(self.leases.get(owner).cloned())
    }

    pub(crate) async fn read_lease(
        &mut self,
        pool: &SqlitePool,
        owner: &str,
    ) -> Result<(SavedVpnProfileLease, Vec<u8>), String> {
        let lease = self
            .lease(pool, owner)
            .await?
            .filter(|lease| !lease.revoked)
            .ok_or_else(|| "saved VPN profile lease is missing or revoked".to_string())?;
        let (profile, bytes) = self
            .read_leasable(pool, &lease.profile.id, &lease.profile.hash)
            .await?;
        if profile.approval_sequence != lease.profile.approval_sequence {
            return Err("saved VPN profile lease approval changed".to_string());
        }
        Ok((lease, bytes))
    }

    pub(crate) fn release(&mut self, owner: &str) -> Result<(), String> {
        self.leases.remove(owner);
        Ok(())
    }
}

async fn marked_ips(pool: &SqlitePool) -> Result<HashSet<String>, String> {
    let ips: Vec<String> = sqlx::query_scalar("SELECT ip FROM vpn_gate_server_verdict")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("could not read VPN Gate verdicts: {error}"))?;
    Ok(ips.into_iter().collect())
}

pub(crate) fn profile_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn read_active_capture(
    path: &Path,
    ip: &str,
    expected_hash: &str,
) -> Result<Vec<u8>, String> {
    validate_selection(expected_hash, expected_hash)?;
    let bytes = read_private_file(path, MAX_PROFILE_BYTES)?;
    if profile_hash(&bytes) != expected_hash {
        return Err("active VPN profile hash changed before approval".to_string());
    }
    validate_saved_profile(ip, &bytes)?;
    Ok(bytes)
}

fn validate_selection(id: &str, hash: &str) -> Result<(), String> {
    if id != hash
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("saved VPN profile ID or expected hash is invalid".to_string());
    }
    Ok(())
}

fn validate_ip(ip: &str) -> Result<Ipv4Addr, String> {
    let parsed: Ipv4Addr = ip
        .parse()
        .map_err(|_| "saved VPN profile IP is invalid".to_string())?;
    if parsed.to_string() != ip || !is_public_ipv4(parsed) {
        return Err("saved VPN profile IP must be a public IPv4 address".to_string());
    }
    Ok(parsed)
}

pub(super) fn validate_saved_profile(ip: &str, bytes: &[u8]) -> Result<VpnGateProtocol, String> {
    let expected_ip = validate_ip(ip)?;
    let validated = validate_profile(bytes)?;
    if !validated.is_vpn_gate_finder
        || validated.remote_host != ip
        || !validated.requires_username_password
    {
        return Err("saved VPN profile IP or VPN Gate provenance does not match".to_string());
    }
    let text =
        std::str::from_utf8(bytes).map_err(|_| "saved VPN profile is not UTF-8".to_string())?;
    let mut block: Option<String> = None;
    let mut has_data = false;
    let mut complete_blocks = HashSet::new();
    let mut required_blocks = HashSet::from(["ca".to_string()]);
    let mut client = false;
    let mut tunnel = false;
    for line in text.lines().map(str::trim) {
        if let Some(current) = block.as_ref() {
            if inline_closing_tag(line).is_some_and(|closing| closing.eq_ignore_ascii_case(current))
            {
                if has_data {
                    complete_blocks.insert(current.clone());
                }
                block = None;
            } else if !line.is_empty() && !line.starts_with('#') && !line.starts_with(';') {
                has_data = true;
            }
            continue;
        }
        if let Some(opening) =
            inline_opening_tag(line).filter(|opening| !opening.eq_ignore_ascii_case("connection"))
        {
            block = Some(opening.to_ascii_lowercase());
            has_data = false;
        } else if !line.is_empty()
            && !line.starts_with('#')
            && !line.starts_with(';')
            && inline_closing_tag(line).is_none()
        {
            let tokens = directive_tokens(line)?;
            if let Some(directive) = tokens.first().map(|token| token.to_ascii_lowercase()) {
                if matches!(directive.as_str(), "client" | "tls-client") {
                    client = true;
                }
                if directive == "dev"
                    && tokens
                        .get(1)
                        .is_some_and(|value| value.eq_ignore_ascii_case("tun"))
                {
                    tunnel = true;
                }
                if super::INLINE_DATA_DIRECTIVES.contains(&directive.as_str()) {
                    required_blocks.insert(directive);
                }
            }
        }
    }
    if !client || !tunnel || !required_blocks.is_subset(&complete_blocks) {
        return Err(
            "saved VPN profile requires a complete inline TUN client configuration".to_string(),
        );
    }
    inspect_profile_transport(bytes, expected_ip)
}

fn read_private_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect a saved VPN profile file: {error}"))?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("saved VPN profile file is not regular or exceeds its size limit".to_string());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(limit as u64 + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("could not read a saved VPN profile file: {error}"))?;
    if bytes.len() > limit {
        return Err("saved VPN profile file exceeds its size limit".to_string());
    }
    Ok(bytes)
}

fn vault_recovery_marker(directory: &Path) -> Result<PathBuf, String> {
    let mut name = directory.file_name().ok_or_else(|| "saved VPN profile directory is invalid".to_string())?.to_os_string();
    name.push(".recovery.json");
    Ok(directory.with_file_name(name))
}

fn sync_vault_parent(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(directory.parent().ok_or_else(|| "saved VPN profile directory is invalid".to_string())?)
        .and_then(|parent| parent.sync_all())
        .map_err(|error| format!("could not sync saved VPN profile recovery: {error}"))?;
    #[cfg(not(unix))]
    let _ = directory;
    Ok(())
}

fn remove_private_file(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not remove a saved VPN profile file: {error}"
        )),
    }
}

pub(super) fn publish_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "saved VPN profile directory is invalid".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("could not create the saved VPN profile directory: {error}"))?;
    if !fs::symlink_metadata(directory)
        .map_err(|error| format!("could not inspect the saved VPN profile directory: {error}"))?
        .is_dir()
    {
        return Err("saved VPN profile directory is not a regular directory".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!("could not secure the saved VPN profile directory: {error}")
        })?;
    }
    let part = path.with_file_name(format!(
        "{}.part",
        path.file_name().unwrap().to_string_lossy()
    ));
    let backup = path.with_file_name(format!(
        "{}.backup",
        path.file_name().unwrap().to_string_lossy()
    ));
    remove_private_file(&part)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&part)
        .map_err(|error| format!("could not stage a saved VPN profile file: {error}"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("could not write a saved VPN profile file: {error}"))?;
    drop(file);
    remove_private_file(&backup)?;
    match fs::rename(path, &backup) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "could not stage the previous saved VPN profile file: {error}"
            ))
        }
    }
    // Never recover a backup index: restoring it could resurrect a revoked approval.
    fs::rename(&part, path)
        .map_err(|error| format!("could not publish a saved VPN profile file: {error}"))?;
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not sync saved VPN profile publication: {error}"))?;
    remove_private_file(&backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn profile(ip: &str, protocol: &str) -> Vec<u8> {
        format!("client\ndev tun\nproto {protocol}\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n{}\nauth-user-pass\n", super::super::VPN_GATE_PROFILE_MARKER).into_bytes()
    }

    async fn fixture() -> (tempfile::TempDir, SqlitePool, SavedProfileVault) {
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(directory.path().join("verdicts.db"))
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict (ip TEXT PRIMARY KEY NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('works', 'fails')), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))").execute(&pool).await.unwrap();
        let vault = SavedProfileVault::open(directory.path().join("profiles")).unwrap();
        (directory, pool, vault)
    }

    #[tokio::test]
    async fn automatic_servers_lease_to_workers_apart_from_o_files_and_leave_on_any_verdict() {
        let (directory, pool, mut vault) = fixture().await;
        let verdicts = || async { sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM vpn_gate_server_verdict").fetch_one(&pool).await.unwrap() };
        let added = vault.add_automatic(&pool, "8.8.8.8", &profile("8.8.8.8", "tcp"), 7, 1).await.unwrap();
        vault.add_automatic(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"), 3, 1).await.unwrap();
        assert_eq!(verdicts().await, 0);
        assert!(vault.snapshot(&pool).await.unwrap().profiles.is_empty());
        assert!(directory.path().join("automatic-profiles/8.8.8.8.ovpn").exists());
        assert!(!directory.path().join("profiles/8.8.8.8.ovpn").exists());
        assert!(vault.read_for_apply(&pool, &added.id, &added.hash).await.is_err());
        let lease = vault.reserve(&pool, "download:0:1:range", &added.id, &added.hash, None).await.unwrap();
        assert_eq!(lease.profile.approval_sequence, 0);
        assert_eq!(vault.read_lease(&pool, "download:0:1:range").await.unwrap().1, profile("8.8.8.8", "tcp"));
        assert!(vault.automatic_candidate_known(&pool, "8.8.8.8").await.unwrap());
        vault.revoke(&pool, "8.8.8.8", Some(VpnGateServerVerdictValue::Fails)).await.unwrap();
        assert!(vault.read_lease(&pool, "download:0:1:range").await.is_err());
        vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp")).await.unwrap();
        assert!(vault.automatic_profiles(&pool).await.unwrap().is_empty());
        assert!(vault.add_automatic(&pool, "8.8.8.8", &profile("8.8.8.8", "tcp"), 7, 2).await.is_err());
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT ip, verdict FROM vpn_gate_server_verdict ORDER BY ip").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("8.8.4.4".to_string(), "works".to_string()), ("8.8.8.8".to_string(), "fails".to_string())]);
    }

    #[tokio::test]
    async fn approves_working_tested_servers_as_o_without_interrupting_their_leases() {
        let (directory, pool, mut vault) = fixture().await;
        let best = vault.add_automatic(&pool, "8.8.8.8", &profile("8.8.8.8", "tcp"), 9, 1).await.unwrap();
        let other = vault.add_automatic(&pool, "1.1.1.1", &profile("1.1.1.1", "udp"), 5, 1).await.unwrap();
        let failing = vault.add_automatic(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp"), 7, 1).await.unwrap();
        vault.record_automatic_result(&failing.id, &failing.hash, false).unwrap();
        vault.reserve(&pool, "download:0:1:range", &best.id, &best.hash, None).await.unwrap();

        let approved = vault.approve_working_automatic(&pool).await.unwrap();

        assert_eq!(approved.iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), vec!["1.1.1.1", "8.8.8.8"]);
        assert!(approved[1].approval_sequence > approved[0].approval_sequence);
        assert_eq!(approved[1].hash, best.hash);
        assert_eq!(vault.read_lease(&pool, "download:0:1:range").await.unwrap().1, profile("8.8.8.8", "tcp"));
        assert!(vault.read_for_apply(&pool, &other.id, &other.hash).await.is_ok());
        assert!(directory.path().join("profiles/8.8.8.8.ovpn").exists());
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT ip, verdict FROM vpn_gate_server_verdict ORDER BY ip").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("1.1.1.1".to_string(), "works".to_string()), ("8.8.8.8".to_string(), "works".to_string())]);
        assert_eq!(vault.automatic_profiles(&pool).await.unwrap().iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), vec!["8.8.4.4"]);
        assert!(vault.approve_working_automatic(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn automatic_pool_follows_the_retention_capacity_and_retires_failing_servers() {
        let (_directory, pool, mut vault) = fixture().await;
        vault.set_limit(&pool, 2).await.unwrap();
        for (ip, score) in [("8.8.8.8", 9), ("8.8.4.4", 5), ("1.1.1.1", 7)] {
            vault.add_automatic(&pool, ip, &profile(ip, "tcp"), score, 1).await.unwrap();
        }
        let kept = vault.automatic_profiles(&pool).await.unwrap();
        assert_eq!(kept.iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), vec!["8.8.8.8", "1.1.1.1"]);
        let best = kept[0].clone();
        vault.reserve(&pool, "download:1:2:range", &best.id, &best.hash, None).await.unwrap();
        for _ in 0..automatic::RETIRE_AFTER_FAILURES { vault.record_automatic_result(&best.id, &best.hash, false).unwrap(); }
        assert!(vault.read_lease(&pool, "download:1:2:range").await.is_err());
        assert_eq!(vault.automatic_profiles(&pool).await.unwrap().iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), vec!["1.1.1.1"]);
    }

    #[tokio::test]
    async fn approves_exact_bytes_and_replaces_the_protocol_for_the_same_ip() {
        let (_directory, pool, mut vault) = fixture().await;
        let tcp = profile("8.8.4.4", "tcp-client");
        let first = vault
            .capture(&pool, "8.8.4.4", &tcp)
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        assert_eq!(first.protocol, VpnGateProtocol::Tcp);
        assert_eq!(
            vault
                .read_for_apply(&pool, &first.id, &first.hash)
                .await
                .unwrap()
                .1,
            tcp
        );
        let udp = profile("8.8.4.4", "udp");
        let second = vault
            .capture(&pool, "8.8.4.4", &udp)
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        assert_eq!(second.protocol, VpnGateProtocol::Udp);
        assert_ne!(first.id, second.id);
        assert!(second.approval_sequence > first.approval_sequence);
        assert!(vault
            .read_for_apply(&pool, &first.id, &first.hash)
            .await
            .is_err());
        assert_eq!(
            vault
                .read_for_apply(&pool, &second.id, &second.hash)
                .await
                .unwrap()
                .1,
            udp
        );
        assert_eq!(vault.snapshot(&pool).await.unwrap().profiles, vec![second]);
    }

    #[tokio::test]
    async fn reapproval_promotes_recency_but_allocation_does_not() {
        let (_directory, pool, mut vault) = fixture().await;
        vault.set_limit(&pool, 2).await.unwrap();
        let first = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        let second = vault
            .capture(&pool, "8.8.8.8", &profile("8.8.8.8", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        vault
            .read_for_apply(&pool, &first.id, &first.hash)
            .await
            .unwrap();
        let promoted = vault
            .capture(&pool, "8.8.8.8", &profile("8.8.8.8", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        assert_eq!(second.id, promoted.id);
        assert!(promoted.approval_sequence > second.approval_sequence);
        vault
            .capture(&pool, "1.1.1.1", &profile("1.1.1.1", "tcp"))
            .await
            .unwrap();
        let snapshot = vault.snapshot(&pool).await.unwrap();
        assert_eq!(
            snapshot
                .profiles
                .iter()
                .map(|p| p.ip.as_str())
                .collect::<Vec<_>>(),
            ["1.1.1.1", "8.8.8.8"]
        );
        assert!(!vault.directory.join("8.8.4.4.ovpn").exists());
        let verdict: String =
            sqlx::query_scalar("SELECT verdict FROM vpn_gate_server_verdict WHERE ip='8.8.4.4'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(verdict, "works");
    }

    #[tokio::test]
    async fn default_capacity_and_shrink_keep_the_newest_approvals() {
        let (_directory, pool, mut vault) = fixture().await;
        for last in 1..=21 {
            let ip = format!("8.8.4.{last}");
            vault
                .capture(&pool, &ip, &profile(&ip, "udp"))
                .await
                .unwrap();
        }
        let snapshot = vault.snapshot(&pool).await.unwrap();
        assert_eq!(snapshot.limit, 20);
        assert_eq!(snapshot.profiles.len(), 20);
        assert_eq!(snapshot.profiles.last().unwrap().ip, "8.8.4.2");
        let snapshot = vault.set_limit(&pool, 1).await.unwrap();
        assert_eq!(snapshot.profiles.len(), 1);
        assert_eq!(snapshot.profiles[0].ip, "8.8.4.21");
        for limit in [0, 101] {
            assert!(vault.set_limit(&pool, limit).await.is_err());
        }
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert_eq!(reopened.snapshot(&pool).await.unwrap().limit, 1);
    }

    #[tokio::test]
    async fn fails_and_null_remove_the_file_without_changing_an_external_original() {
        let (directory, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4", "udp");
        let original = directory.path().join("external.ovpn");
        fs::write(&original, &bytes).unwrap();
        for verdict in [Some(VpnGateServerVerdictValue::Fails), None] {
            let saved = vault
                .capture(&pool, "8.8.4.4", &bytes)
                .await
                .unwrap()
                .saved_profile
                .unwrap();
            let result = vault.revoke(&pool, "8.8.4.4", verdict).await.unwrap();
            assert_eq!(result.verdict.as_ref().map(|v| v.verdict), verdict);
            assert!(result.saved_profile.is_none());
            assert!(vault
                .read_for_apply(&pool, &saved.id, &saved.hash)
                .await
                .is_err());
            assert!(!vault.directory.join("8.8.4.4.ovpn").exists());
            assert_eq!(fs::read(&original).unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn historical_approvals_and_orphan_files_do_not_create_saved_entries() {
        let (_directory, pool, mut vault) = fixture().await;
        sqlx::query("INSERT INTO vpn_gate_server_verdict(ip, verdict) VALUES ('8.8.4.4','works')")
            .execute(&pool)
            .await
            .unwrap();
        fs::create_dir_all(&vault.directory).unwrap();
        fs::write(
            vault.directory.join("8.8.4.4.ovpn"),
            profile("8.8.4.4", "tcp"),
        )
        .unwrap();
        assert!(vault.snapshot(&pool).await.unwrap().profiles.is_empty());
        assert!(!vault.directory.join("8.8.4.4.ovpn").exists());
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM vpn_gate_server_verdict")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn restart_rejects_missing_mismatched_and_non_approved_files() {
        let (_directory, pool, mut vault) = fixture().await;
        for ip in ["8.8.4.4", "8.8.8.8", "1.1.1.1"] {
            vault.capture(&pool, ip, &profile(ip, "udp")).await.unwrap();
        }
        fs::remove_file(vault.directory.join("8.8.4.4.ovpn")).unwrap();
        fs::write(
            vault.directory.join("8.8.8.8.ovpn"),
            profile("8.8.8.8", "tcp"),
        )
        .unwrap();
        sqlx::query("UPDATE vpn_gate_server_verdict SET verdict='fails' WHERE ip='1.1.1.1'")
            .execute(&pool)
            .await
            .unwrap();
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened.snapshot(&pool).await.unwrap().profiles.is_empty());
    }

    #[tokio::test]
    async fn invalid_profiles_and_expected_hashes_never_allocate() {
        let (_directory, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4", "udp");
        for invalid in [
            b"remote 8.8.4.4 443".to_vec(),
            profile("8.8.8.8", "tcp"),
            vec![b'x'; MAX_PROFILE_BYTES + 1],
            bytes[..bytes.len() - 2].to_vec(),
        ] {
            assert!(vault.capture(&pool, "8.8.4.4", &invalid).await.is_err());
        }
        let no_ca = String::from_utf8(bytes.clone())
            .unwrap()
            .replace("<ca>\ncertificate\n</ca>\n", "");
        assert!(vault
            .capture(&pool, "8.8.4.4", no_ca.as_bytes())
            .await
            .is_err());
        let saved = vault
            .capture(&pool, "8.8.4.4", &bytes)
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        assert!(vault
            .read_for_apply(&pool, &saved.id, &"0".repeat(64))
            .await
            .is_err());
        assert!(vault
            .read_for_apply(&pool, "../external", &saved.hash)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn active_capture_reads_only_the_expected_profile_hash_and_ip() {
        let (directory, _pool, _vault) = fixture().await;
        let path = directory.path().join("active.ovpn");
        let bytes = profile("8.8.4.4", "tcp");
        fs::write(&path, &bytes).unwrap();
        let hash = profile_hash(&bytes);
        assert_eq!(read_active_capture(&path, "8.8.4.4", &hash).unwrap(), bytes);
        assert!(read_active_capture(&path, "8.8.4.4", &"0".repeat(64)).is_err());
        assert!(read_active_capture(&path, "8.8.8.8", &hash).is_err());
        fs::write(&path, profile("8.8.4.4", "udp")).unwrap();
        assert!(read_active_capture(&path, "8.8.4.4", &hash).is_err());
        fs::remove_file(&path).unwrap();
        assert!(read_active_capture(&path, "8.8.4.4", &hash).is_err());
    }

    #[tokio::test]
    async fn incomplete_client_or_tunnel_profiles_are_not_retained() {
        let (_directory, pool, mut vault) = fixture().await;
        let text = String::from_utf8(profile("8.8.4.4", "udp")).unwrap();
        for incomplete in [
            text.replace("client\n", ""),
            text.replace("dev tun\n", ""),
            text.replace("certificate", ""),
            text.replace("<ca>", "key [inline]\n<ca>"),
        ] {
            assert!(vault
                .capture(&pool, "8.8.4.4", incomplete.as_bytes())
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn failed_file_write_never_publishes_a_saved_approval() {
        let (_directory, pool, mut vault) = fixture().await;
        fs::create_dir_all(vault.directory.join("8.8.4.4.ovpn.part")).unwrap();
        assert!(vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .is_err());
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened.snapshot(&pool).await.unwrap().profiles.is_empty());
    }

    #[tokio::test]
    async fn failed_delete_revokes_before_returning_a_cleanup_error_and_survives_restart() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        let path = vault.directory.join("8.8.4.4.ovpn");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        let result = vault
            .revoke(&pool, "8.8.4.4", Some(VpnGateServerVerdictValue::Fails))
            .await
            .unwrap();
        assert!(result.cleanup_error.is_some());
        assert!(vault
            .read_for_apply(&pool, &saved.id, &saved.hash)
            .await
            .is_err());
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened.snapshot(&pool).await.unwrap().profiles.is_empty());
        assert!(path.is_dir());
    }

    #[tokio::test]
    async fn failed_database_approval_leaves_prepared_bytes_unallocatable() {
        let (_directory, pool, mut vault) = fixture().await;
        sqlx::query("CREATE TRIGGER reject_approval BEFORE INSERT ON vpn_gate_server_verdict BEGIN SELECT RAISE(FAIL, 'reject approval'); END").execute(&pool).await.unwrap();
        assert!(vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .is_err());
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened.snapshot(&pool).await.unwrap().profiles.is_empty());
    }

    #[tokio::test]
    async fn every_literal_remote_and_connection_block_participates_in_foreground_collision_checks() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp")).await.unwrap().saved_profile.unwrap();
        vault.reserve(&pool, "worker-a", &saved.id, &saved.hash, None).await.unwrap();
        for remotes in ["remote 8.8.8.8 443\nremote 8.8.4.4 443\n", "remote 8.8.8.8 443\n<connection>\nremote 8.8.4.4 443\n</connection>\n"] {
            let manual = format!("client\ndev tun\n{remotes}");
            assert!(vault.validate_active(&pool, manual.as_bytes()).await.is_err());
        }
    }

    #[tokio::test]
    async fn unusable_vault_quarantine_preserves_old_files_and_opens_an_empty_pool() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp")).await.unwrap().saved_profile.unwrap();
        fs::create_dir(vault.directory.join("index.json.part")).unwrap();
        assert!(SavedProfileVault::open(vault.directory.clone()).is_err());
        let mut recovered = SavedProfileVault::quarantine_and_open(vault.directory.clone(), None).unwrap();
        assert!(recovered.snapshot(&pool).await.unwrap().profiles.is_empty());
        assert!(recovered.read_for_apply(&pool, &saved.id, &saved.hash).await.is_err());
        let archived = fs::read_dir(vault.directory.parent().unwrap()).unwrap()
            .filter_map(Result::ok).find(|entry| entry.file_name().to_string_lossy().starts_with("profiles.quarantine-")).unwrap().path();
        assert_eq!(fs::read(archived.join("8.8.4.4.ovpn")).unwrap(), profile("8.8.4.4", "tcp"));
        assert!(recovered.validate_active(&pool, b"client\ndev tun\nremote 8.8.8.8 443\n").await.is_ok());
    }

    #[tokio::test]
    async fn quarantine_restart_cannot_reclassify_a_revoked_active_profile_as_manual() {
        let (_directory, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4", "tcp");
        let saved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
        let active = SavedVpnProfileSelection { id: saved.id, hash: saved.hash };
        vault.set_active(Some(active.clone())).unwrap();
        vault.revoke(&pool, "8.8.4.4", None).await.unwrap();
        fs::write(vault.directory.join(INDEX_FILE), b"invalid index").unwrap();
        let directory = vault.directory.clone();
        drop(vault);

        let recovered = SavedProfileVault::quarantine_and_open(directory.clone(), Some(active.clone())).unwrap();
        let first_index: serde_json::Value = serde_json::from_slice(&fs::read(directory.join(INDEX_FILE)).unwrap()).unwrap();
        assert_eq!(first_index["active"], serde_json::json!({ "id": active.id, "hash": active.hash }));
        drop(recovered);
        let mut restarted = SavedProfileVault::open(directory.clone()).unwrap();
        assert!(restarted.validate_active(&pool, &bytes).await.is_err());
        assert_eq!(restarted.active_selection(), Some(active.clone()));
        assert!(restarted.snapshot(&pool).await.unwrap().profiles.is_empty());
    }

    #[test]
    fn incomplete_quarantine_is_not_opened_as_a_fresh_unrestricted_vault() {
        for suffix in ["recovery.json", "recovery.json.part", "recovery.json.backup"] {
            let root = tempfile::tempdir().unwrap();
            let directory = root.path().join("profiles");
            fs::write(root.path().join(format!("profiles.{suffix}")), b"pending recovery").unwrap();
            assert!(SavedProfileVault::open(directory.clone()).is_err(), "{suffix}: absent replacement directory");
            fs::create_dir(&directory).unwrap();
            assert!(SavedProfileVault::open(directory).is_err(), "{suffix}: replacement index not published");
        }
    }

    #[tokio::test]
    async fn failed_retained_publication_does_not_disable_an_independent_manual_profile() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp")).await.unwrap().saved_profile.unwrap();
        vault.reserve(&pool, "worker-a", &saved.id, &saved.hash, None).await.unwrap();
        fs::create_dir(vault.directory.join("index.json.part")).unwrap();
        assert!(vault.set_limit(&pool, 1).await.is_err());
        assert!(vault.validate_active(&pool, b"client\ndev tun\nremote 8.8.8.8 443\n").await.is_ok());
        assert!(vault.validate_active(&pool, b"client\ndev tun\nremote 8.8.4.4 443\n").await.is_err());
        assert!(vault.read_for_apply(&pool, &saved.id, &saved.hash).await.is_err());
    }

    #[tokio::test]
    async fn leases_are_exclusive_and_exclude_the_current_foreground_profile() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        let foreground = ForegroundVpnProfile {
            remote_hosts: vec!["8.8.4.4".into()],
            hash: "f".repeat(64),
        };
        assert!(vault
            .reserve(&pool, "worker-a", &saved.id, &saved.hash, Some(&foreground))
            .await
            .is_err());
        let lease = vault
            .reserve(&pool, "worker-a", &saved.id, &saved.hash, None)
            .await
            .unwrap();
        assert!(!lease.revoked);
        assert!(vault
            .reserve(&pool, "worker-b", &saved.id, &saved.hash, None)
            .await
            .is_err());
        assert!(vault
            .read_for_apply(&pool, &saved.id, &saved.hash)
            .await
            .is_err());
        assert!(vault
            .ensure_foreground_available("8.8.4.4", &"f".repeat(64))
            .is_err());
        assert_eq!(
            vault.read_lease(&pool, "worker-a").await.unwrap().1,
            profile("8.8.4.4", "udp")
        );
        vault.release("worker-a").unwrap();
        assert!(vault
            .reserve(&pool, "worker-b", &saved.id, &saved.hash, None)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn lease_revocation_is_visible_without_waiting_for_the_allocation_operation_lock() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp")).await.unwrap().saved_profile.unwrap();
        let cached = vault.reserve(&pool, "worker-a", &saved.id, &saved.hash, None).await.unwrap();
        assert!(!cached.is_revoked());
        vault.revoke(&pool, "8.8.4.4", None).await.unwrap();
        assert!(cached.is_revoked());
    }

    #[tokio::test]
    async fn revocation_reapproval_and_eviction_invalidate_existing_leases() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        vault
            .reserve(&pool, "worker-a", &saved.id, &saved.hash, None)
            .await
            .unwrap();
        vault.revoke(&pool, "8.8.4.4", None).await.unwrap();
        assert!(
            vault
                .lease(&pool, "worker-a")
                .await
                .unwrap()
                .unwrap()
                .revoked
        );
        assert!(vault.read_lease(&pool, "worker-a").await.is_err());
        let newer = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        assert!(
            vault
                .lease(&pool, "worker-a")
                .await
                .unwrap()
                .unwrap()
                .revoked
        );
        vault.release("worker-a").unwrap();
        vault
            .reserve(&pool, "worker-b", &newer.id, &newer.hash, None)
            .await
            .unwrap();
        vault.set_limit(&pool, 1).await.unwrap();
        vault
            .capture(&pool, "8.8.8.8", &profile("8.8.8.8", "udp"))
            .await
            .unwrap();
        assert!(
            vault
                .lease(&pool, "worker-b")
                .await
                .unwrap()
                .unwrap()
                .revoked
        );
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened.lease(&pool, "worker-b").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn active_saved_identity_is_rechecked_after_revocation_and_restart() {
        let (_directory, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4", "tcp");
        let saved = vault
            .capture(&pool, "8.8.4.4", &bytes)
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        vault
            .set_active(Some(SavedVpnProfileSelection {
                id: saved.id,
                hash: saved.hash,
            }))
            .unwrap();
        vault.validate_active(&pool, &bytes).await.unwrap();
        vault.revoke(&pool, "8.8.4.4", None).await.unwrap();
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened.validate_active(&pool, &bytes).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_dangling_index_symlink_is_not_treated_as_a_fresh_vault() {
        use std::os::unix::fs::symlink;
        let (directory, _pool, vault) = fixture().await;
        fs::create_dir_all(&vault.directory).unwrap();
        symlink(
            directory.path().join("missing-index"),
            vault.directory.join(INDEX_FILE),
        )
        .unwrap();
        assert!(SavedProfileVault::open(vault.directory).is_err());
    }

    #[tokio::test]
    async fn combined_index_and_sql_revocation_failure_never_resurrects_after_restart() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp")).await.unwrap().saved_profile.unwrap();
        fs::create_dir(vault.directory.join("index.json.part")).unwrap();
        sqlx::query("CREATE TRIGGER reject_revocation BEFORE DELETE ON vpn_gate_server_verdict BEGIN SELECT RAISE(FAIL, 'reject revocation'); END").execute(&pool).await.unwrap();
        assert!(vault.revoke(&pool, "8.8.4.4", None).await.is_err());
        assert!(!vault.directory.join("8.8.4.4.ovpn").exists());
        match SavedProfileVault::open(vault.directory.clone()) {
            Err(_) => {},
            Ok(mut reopened) => assert!(reopened.read_for_apply(&pool, &saved.id, &saved.hash).await.is_err()),
        }
    }

    #[tokio::test]
    async fn an_index_with_a_publication_sidecar_is_ambiguous_even_when_the_index_exists() {
        let (_directory, pool, mut vault) = fixture().await;
        vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4", "tcp")).await.unwrap();
        fs::write(vault.directory.join("index.json.backup"), fs::read(vault.directory.join(INDEX_FILE)).unwrap()).unwrap();
        assert!(SavedProfileVault::open(vault.directory).is_err());
    }

    #[tokio::test]
    async fn database_revocation_failure_still_removes_the_durable_allocation() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        sqlx::query("CREATE TRIGGER reject_revocation BEFORE DELETE ON vpn_gate_server_verdict BEGIN SELECT RAISE(FAIL, 'reject revocation'); END").execute(&pool).await.unwrap();
        assert!(vault.revoke(&pool, "8.8.4.4", None).await.is_err());
        let mut reopened = SavedProfileVault::open(vault.directory.clone()).unwrap();
        assert!(reopened
            .read_for_apply(&pool, &saved.id, &saved.hash)
            .await
            .is_err());
        assert!(reopened.snapshot(&pool).await.unwrap().profiles.is_empty());
    }

    #[tokio::test]
    async fn external_verdict_revocation_invalidates_the_lease_before_the_next_read() {
        let (_directory, pool, mut vault) = fixture().await;
        let saved = vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        vault
            .reserve(&pool, "worker-a", &saved.id, &saved.hash, None)
            .await
            .unwrap();
        sqlx::query("UPDATE vpn_gate_server_verdict SET verdict='fails'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(vault.read_lease(&pool, "worker-a").await.is_err());
        assert!(
            vault
                .lease(&pool, "worker-a")
                .await
                .unwrap()
                .unwrap()
                .revoked
        );
    }

    #[tokio::test]
    async fn oversized_or_malformed_index_metadata_never_allocates() {
        let (_directory, _pool, vault) = fixture().await;
        fs::create_dir_all(&vault.directory).unwrap();
        for bytes in [
            vec![b' '; MAX_INDEX_BYTES + 1],
            b"{\"version\":1,\"limit\":101,\"sequence\":0,\"profiles\":[],\"active\":null}"
                .to_vec(),
            b"not JSON".to_vec(),
        ] {
            fs::write(vault.directory.join(INDEX_FILE), bytes).unwrap();
            assert!(SavedProfileVault::open(vault.directory.clone()).is_err());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlinked_vault_directory_never_removes_external_files() {
        use std::os::unix::fs::symlink;
        let (directory, _pool, _vault) = fixture().await;
        let external = directory.path().join("external");
        fs::create_dir(&external).unwrap();
        let original = external.join("8.8.4.4.ovpn");
        fs::write(&original, profile("8.8.4.4", "udp")).unwrap();
        let link = directory.path().join("linked-vault");
        symlink(&external, &link).unwrap();
        assert!(SavedProfileVault::open(link).is_err());
        assert!(original.is_file());
    }

    #[tokio::test]
    async fn interrupted_index_publication_never_reverts_to_an_empty_unrestricted_vault() {
        let (_directory, pool, mut vault) = fixture().await;
        let bytes = profile("8.8.4.4", "udp");
        let saved = vault
            .capture(&pool, "8.8.4.4", &bytes)
            .await
            .unwrap()
            .saved_profile
            .unwrap();
        vault
            .set_active(Some(SavedVpnProfileSelection {
                id: saved.id,
                hash: saved.hash,
            }))
            .unwrap();
        fs::rename(
            vault.directory.join(INDEX_FILE),
            vault.directory.join("index.json.backup"),
        )
        .unwrap();
        assert!(SavedProfileVault::open(vault.directory).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn private_files_and_metadata_are_not_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let (_directory, pool, mut vault) = fixture().await;
        vault
            .capture(&pool, "8.8.4.4", &profile("8.8.4.4", "udp"))
            .await
            .unwrap();
        assert_eq!(
            fs::metadata(&vault.directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in ["index.json", "8.8.4.4.ovpn"] {
            assert_eq!(
                fs::metadata(vault.directory.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
