//! Saved VPN profiles kept as `vpn-profiles/<host>.ovpn` in the user's storage folder, so they
//! survive an app uninstall, and the private store of manually imported profiles.
//!
//! The private vault and the manual store stay the working copies. A sync publishes every saved
//! profile into the folder, deletes the folder copies of profiles the user dropped, and imports
//! folder files the app has not published there, which restores them after a fresh install.
//! A host keeps one saved profile and one file: a newer profile for the same host replaces it.

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::{
    profile_hash, publish_private_file, read_private_file, remove_private_file, validate_ip,
    validate_profile, validate_saved_profile, SavedProfileVault, VpnGateServerVerdict,
    VpnGateServerVerdictMutation, VpnGateServerVerdictValue, MAX_INDEX_BYTES, MAX_PROFILE_BYTES,
};

/// The app-managed folder inside the storage root.
pub(crate) const STORED_PROFILE_FOLDER: &str = "vpn-profiles";
const INDEX_FILE: &str = "index.json";
const MAX_MANUAL_PROFILES: usize = 100;
static NEXT_SYNC: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManualVpnProfile {
    pub(crate) host: String,
    pub(crate) hash: String,
    pub(crate) saved_at: i64,
}

/// A file this device published into the storage folder of `StoredIndex::root`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishedFile {
    host: String,
    hash: String,
    manual: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredIndex {
    version: u8,
    root: Option<String>,
    published: Vec<PublishedFile>,
    manual: Vec<ManualVpnProfile>,
}

impl Default for StoredIndex {
    fn default() -> Self {
        Self { version: 1, root: None, published: Vec::new(), manual: Vec::new() }
    }
}

struct PlannedFile {
    host: String,
    hash: String,
    manual: bool,
    bytes: Vec<u8>,
}

struct PendingSync {
    token: String,
    root: String,
    staging: Option<PathBuf>,
    publish: Vec<PlannedFile>,
    delete: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredSyncPublish {
    pub(crate) file_name: String,
    /// The staged private copy that the Android storage bridge copies into the folder.
    pub(crate) input_path: Option<String>,
}

/// What a folder transport must do: delete and publish these files, then return every
/// `<host>.ovpn` file whose name is not in `known`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredSyncPlan {
    pub(crate) token: String,
    pub(crate) publish: Vec<StoredSyncPublish>,
    pub(crate) delete: Vec<String>,
    pub(crate) known: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSyncPublished {
    pub(crate) file_name: String,
    /// SHA-256 of the bytes read back from the folder after publication.
    pub(crate) sha256: String,
}

#[derive(Default)]
pub(crate) struct StoredFolderOutcome {
    /// False when the folder could not be reached; the publication record then stays unchanged.
    pub(crate) reachable: bool,
    pub(crate) published: Vec<StoredSyncPublished>,
    pub(crate) deleted: Vec<String>,
    pub(crate) inbound: Vec<(String, Vec<u8>)>,
    pub(crate) errors: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredSyncReport {
    pub(crate) imported: usize,
    pub(crate) errors: Vec<String>,
}

/// A stored host is the profile's first `remote`: a canonical IPv4 address or a lowercase DNS name.
pub(crate) fn validate_host(host: &str) -> Result<(), String> {
    let invalid = || Err(format!("VPN server host '{host}' must be an IPv4 address or a lowercase domain name"));
    if host.is_empty() || host.len() > 253 {
        return invalid();
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.iter().all(|label| !label.is_empty() && label.bytes().all(|byte| byte.is_ascii_digit())) {
        return match host.parse::<Ipv4Addr>() {
            Ok(address) if address.to_string() == host => Ok(()),
            _ => invalid(),
        };
    }
    let valid_label = |label: &str| {
        !label.is_empty() && label.len() <= 63 && !label.starts_with('-') && !label.ends_with('-')
            && label.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };
    if labels.into_iter().all(valid_label) { Ok(()) } else { invalid() }
}

pub(crate) fn stored_file_name(host: &str) -> String { format!("{host}.ovpn") }

fn is_stored_file_name(name: &str) -> bool {
    name.strip_suffix(".ovpn").is_some_and(|host| validate_host(host).is_ok())
}

fn stored_directory(vault_directory: &Path) -> PathBuf { vault_directory.with_file_name("stored-profiles") }

pub(crate) struct StoredProfiles {
    directory: PathBuf,
    index: StoredIndex,
    pending: Option<PendingSync>,
}

impl StoredProfiles {
    /// An unreadable index starts empty: the folder copies restore its manual profiles, and an
    /// empty publication record never deletes a folder file.
    pub(super) fn open(vault_directory: &Path) -> Self {
        let directory = stored_directory(vault_directory);
        let path = directory.join(INDEX_FILE);
        let index = match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredIndex::default(),
            _ => read_private_file(&path, MAX_INDEX_BYTES)
                .and_then(|bytes| serde_json::from_slice::<StoredIndex>(&bytes).map_err(|error| error.to_string()))
                .and_then(|index| valid_index(&index).then_some(index).ok_or_else(|| "invalid entries".to_string()))
                .unwrap_or_else(|error| {
                    log::warn!("stored VPN profile index is unusable and starts empty: {error}");
                    StoredIndex::default()
                }),
        };
        Self { directory, index, pending: None }
    }

    pub(crate) fn manual_profiles(&self) -> Vec<ManualVpnProfile> {
        let mut profiles = self.index.manual.clone();
        profiles.sort_by(|left, right| right.saved_at.cmp(&left.saved_at).then_with(|| left.host.cmp(&right.host)));
        profiles
    }

    fn manual(&self, host: &str) -> Option<&ManualVpnProfile> {
        self.index.manual.iter().find(|profile| profile.host == host)
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.index)
            .map_err(|error| format!("could not encode the stored VPN profile index: {error}"))?;
        if bytes.len() > MAX_INDEX_BYTES {
            return Err("stored VPN profile index exceeds its size limit".to_string());
        }
        publish_private_file(&self.directory.join(INDEX_FILE), &bytes)
    }

    fn save_manual(&mut self, host: &str, bytes: &[u8], saved_at: i64) -> Result<ManualVpnProfile, String> {
        validate_host(host)?;
        if self.manual(host).is_none() && self.index.manual.len() >= MAX_MANUAL_PROFILES {
            return Err(format!("at most {MAX_MANUAL_PROFILES} imported VPN profiles can be saved"));
        }
        publish_private_file(&self.directory.join(stored_file_name(host)), bytes)?;
        let profile = ManualVpnProfile { host: host.to_string(), hash: profile_hash(bytes), saved_at };
        self.index.manual.retain(|existing| existing.host != host);
        self.index.manual.push(profile.clone());
        self.persist()?;
        Ok(profile)
    }

    fn remove_manual(&mut self, host: &str) -> Result<bool, String> {
        if self.manual(host).is_none() {
            return Ok(false);
        }
        self.index.manual.retain(|profile| profile.host != host);
        self.persist()?;
        remove_private_file(&self.directory.join(stored_file_name(host)))?;
        Ok(true)
    }

    fn read_manual(&self, profile: &ManualVpnProfile) -> Result<Vec<u8>, String> {
        let bytes = read_private_file(&self.directory.join(stored_file_name(&profile.host)), MAX_PROFILE_BYTES)?;
        if profile_hash(&bytes) != profile.hash {
            return Err(format!("saved imported VPN profile for {} changed", profile.host));
        }
        Ok(bytes)
    }

    fn published_for(&self, root: &str) -> Vec<PublishedFile> {
        if self.index.root.as_deref() == Some(root) { self.index.published.clone() } else { Vec::new() }
    }
}

fn valid_index(index: &StoredIndex) -> bool {
    let valid_hash = |hash: &str| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    let mut manual_hosts = HashSet::new();
    let mut published_hosts = HashSet::new();
    index.version == 1
        && index.manual.len() <= MAX_MANUAL_PROFILES
        && index.manual.iter().all(|profile| validate_host(&profile.host).is_ok() && valid_hash(&profile.hash)
            && profile.saved_at >= 0 && manual_hosts.insert(profile.host.as_str()))
        && index.published.iter().all(|file| validate_host(&file.host).is_ok() && valid_hash(&file.hash)
            && published_hosts.insert(file.host.as_str()))
}

async fn host_verdicts(pool: &SqlitePool) -> Result<HashMap<String, String>, String> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT ip, verdict FROM vpn_gate_server_verdict")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("could not read VPN server verdicts: {error}"))?;
    Ok(rows.into_iter().collect())
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

/// Reads the active manually imported profile for "Add to Preferred" on the current profile.
pub(crate) fn read_active_manual_capture(path: &Path, host: &str, expected_hash: &str) -> Result<Vec<u8>, String> {
    let bytes = read_private_file(path, MAX_PROFILE_BYTES)?;
    let validated = validate_profile(&bytes)?;
    if validated.hash != expected_hash || validated.remote_host != host || validated.is_vpn_gate_finder {
        return Err("active VPN profile changed before it was saved".to_string());
    }
    Ok(bytes)
}

impl SavedProfileVault {
    pub(crate) fn manual_profiles(&self) -> Vec<ManualVpnProfile> { self.stored.manual_profiles() }

    /// Saves a manually imported profile under its remote host and adds the host to Preferred.
    /// An approved VPN Gate profile for the same host is replaced, as its folder file would be.
    pub(crate) async fn save_manual_profile(
        &mut self,
        pool: &SqlitePool,
        bytes: &[u8],
    ) -> Result<VpnGateServerVerdictMutation, String> {
        self.require_healthy()?;
        let validated = validate_profile(bytes)?;
        if validated.is_vpn_gate_finder {
            return Err("VPN Gate Finder profiles are saved through their server approval".to_string());
        }
        let host = validated.remote_host;
        validate_host(&host)?;
        if self.index.profiles.iter().any(|profile| profile.ip == host) {
            self.forget(&host);
            self.persist()?;
        }
        self.stored.save_manual(&host, bytes, unix_now())?;
        // Keep an existing Preferred timestamp so the host's verdict row does not change needlessly.
        let updated_at: i64 = sqlx::query_scalar("INSERT INTO vpn_gate_server_verdict (ip, verdict) VALUES (?, 'works') ON CONFLICT(ip) DO UPDATE SET updated_at = CASE WHEN verdict = 'works' THEN updated_at ELSE unixepoch() END, verdict = 'works' RETURNING updated_at")
            .bind(&host).fetch_one(pool).await.map_err(|error| format!("could not save the VPN profile preference: {error}"))?;
        Ok(VpnGateServerVerdictMutation {
            verdict: Some(VpnGateServerVerdict { ip: host, verdict: VpnGateServerVerdictValue::Works, updated_at }),
            saved_profile: None,
            cleanup_error: None,
        })
    }

    /// Reads an imported profile by host for a URL test; it must still have the hash the list showed.
    pub(crate) fn read_manual_profile(&self, host: &str, expected_hash: &str) -> Result<Vec<u8>, String> {
        validate_host(host)?;
        let profile = self.stored.manual(host).filter(|profile| profile.hash == expected_hash)
            .ok_or_else(|| format!("saved imported VPN profile for {host} is no longer available"))?;
        self.stored.read_manual(profile)
    }

    /// Clears or sets "Not used" for any stored host. VPN Gate IPs also leave the approved vault.
    pub(crate) async fn revoke_host(
        &mut self,
        pool: &SqlitePool,
        host: &str,
        verdict: Option<VpnGateServerVerdictValue>,
    ) -> Result<VpnGateServerVerdictMutation, String> {
        if verdict == Some(VpnGateServerVerdictValue::Works) {
            return Err("approval requires capture of an exact VPN profile".to_string());
        }
        validate_host(host)?;
        let manual_error = self.stored.remove_manual(host).err();
        if validate_ip(host).is_ok() {
            let mut result = self.revoke(pool, host, verdict).await?;
            if let Some(error) = manual_error {
                result.cleanup_error = Some(match result.cleanup_error {
                    Some(cleanup) => format!("{cleanup}; {error}"),
                    None => error,
                });
            }
            return Ok(result);
        }
        let verdict = if verdict.is_some() {
            let updated_at: i64 = sqlx::query_scalar("INSERT INTO vpn_gate_server_verdict (ip, verdict) VALUES (?, 'fails') ON CONFLICT(ip) DO UPDATE SET verdict = excluded.verdict, updated_at = unixepoch() RETURNING updated_at")
                .bind(host).fetch_one(pool).await.map_err(|error| format!("could not save the VPN profile preference: {error}"))?;
            Some(VpnGateServerVerdict { ip: host.to_string(), verdict: VpnGateServerVerdictValue::Fails, updated_at })
        } else {
            sqlx::query("DELETE FROM vpn_gate_server_verdict WHERE ip = ?")
                .bind(host).execute(pool).await.map_err(|error| format!("could not clear the VPN profile preference: {error}"))?;
            None
        };
        Ok(VpnGateServerVerdictMutation { verdict, saved_profile: None, cleanup_error: manual_error })
    }

    /// Plans one folder sync for `root`. With `staging`, the files to publish are copied there for
    /// the Android storage bridge; the private copies themselves are never handed out.
    pub(crate) async fn plan_stored_sync(
        &mut self,
        pool: &SqlitePool,
        root: &str,
        staging: Option<&Path>,
    ) -> Result<StoredSyncPlan, String> {
        self.reconcile(pool).await?;
        if let Some(previous) = self.stored.pending.take() {
            remove_staging(previous.staging.as_deref());
        }
        let verdicts = host_verdicts(pool).await?;
        let vault_hosts: HashSet<String> = self.index.profiles.iter().map(|profile| profile.ip.clone()).collect();
        let duplicated: Vec<String> = self.stored.index.manual.iter()
            .filter(|profile| vault_hosts.contains(&profile.host))
            .map(|profile| profile.host.clone())
            .collect();
        for host in duplicated { self.stored.remove_manual(&host)?; }

        let published = self.stored.published_for(root);
        let is_published = |host: &str, hash: &str, manual: bool| published.iter()
            .any(|file| file.host == host && file.hash == hash && file.manual == manual);
        let mut publish = Vec::new();
        for profile in &self.index.profiles {
            if is_published(&profile.ip, &profile.hash, false) { continue; }
            match read_private_file(&self.directory.join(format!("{}.ovpn", profile.ip)), MAX_PROFILE_BYTES) {
                Ok(bytes) if profile_hash(&bytes) == profile.hash => publish.push(PlannedFile {
                    host: profile.ip.clone(), hash: profile.hash.clone(), manual: false, bytes,
                }),
                Ok(_) => log::warn!("saved VPN profile for {} changed before folder publication", profile.ip),
                Err(error) => log::warn!("{error}"),
            }
        }
        for profile in &self.stored.index.manual {
            if is_published(&profile.host, &profile.hash, true) { continue; }
            match self.stored.read_manual(profile) {
                Ok(bytes) => publish.push(PlannedFile { host: profile.host.clone(), hash: profile.hash.clone(), manual: true, bytes }),
                Err(error) => log::warn!("{error}"),
            }
        }

        let retained: HashSet<&str> = self.index.profiles.iter().map(|profile| profile.ip.as_str())
            .chain(self.stored.index.manual.iter().map(|profile| profile.host.as_str()))
            .collect();
        let room = self.index.profiles.len() < self.index.limit;
        let mut delete = Vec::new();
        let mut restage = HashSet::new();
        for file in published.iter().filter(|file| !retained.contains(file.host.as_str())) {
            // A Preferred host without its working copy lost it (an unusable vault or a restore), not by
            // the user's choice: import the folder copy again while the vault has room for it.
            if verdicts.get(&file.host).map(String::as_str) == Some("works") && (file.manual || room) {
                restage.insert(file.host.clone());
            } else {
                delete.push(file.host.clone());
            }
        }

        let known: Vec<String> = published.iter()
            .filter(|file| !restage.contains(&file.host) && !delete.contains(&file.host))
            .map(|file| file.host.clone())
            .chain(publish.iter().map(|file| file.host.clone()))
            .collect::<HashSet<_>>()
            .into_iter()
            .map(|host| stored_file_name(&host))
            .collect();
        let token = format!("{}-{}", unix_now(), NEXT_SYNC.fetch_add(1, Ordering::Relaxed));
        let staged_directory = staging.map(|directory| directory.join(&token));
        let mut planned = Vec::new();
        for file in &publish {
            let input_path = match &staged_directory {
                Some(directory) => {
                    let path = directory.join(stored_file_name(&file.host));
                    if let Err(error) = publish_private_file(&path, &file.bytes) {
                        remove_staging(Some(directory.as_path()));
                        return Err(error);
                    }
                    Some(path.to_string_lossy().into_owned())
                }
                None => None,
            };
            planned.push(StoredSyncPublish { file_name: stored_file_name(&file.host), input_path });
        }
        let plan = StoredSyncPlan {
            token: token.clone(),
            publish: planned,
            delete: delete.iter().map(|host| stored_file_name(host)).collect(),
            known,
        };
        self.stored.pending = Some(PendingSync { token, root: root.to_string(), staging: staged_directory, publish, delete });
        Ok(plan)
    }

    /// Records a folder transport outcome for the pending plan and imports its inbound files.
    /// Only a publication whose read-back hash matches is recorded as present in the folder.
    pub(crate) async fn finish_stored_sync(
        &mut self,
        pool: &SqlitePool,
        token: &str,
        outcome: StoredFolderOutcome,
    ) -> Result<StoredSyncReport, String> {
        let pending = match self.stored.pending.take() {
            Some(pending) if pending.token == token => pending,
            other => {
                self.stored.pending = other;
                return Err("VPN profile folder sync is no longer current".to_string());
            }
        };
        remove_staging(pending.staging.as_deref());
        let mut report = StoredSyncReport { imported: 0, errors: outcome.errors };
        if !outcome.reachable {
            return Ok(report);
        }
        let mut published = self.stored.published_for(&pending.root);
        for file in &pending.publish {
            let name = stored_file_name(&file.host);
            match outcome.published.iter().find(|result| result.file_name == name) {
                Some(result) if result.sha256 == file.hash => {
                    published.retain(|existing| existing.host != file.host);
                    published.push(PublishedFile { host: file.host.clone(), hash: file.hash.clone(), manual: file.manual });
                }
                Some(_) => report.errors.push(format!("{name} did not match its saved profile after publication")),
                None => {}
            }
        }
        for host in &pending.delete {
            if outcome.deleted.contains(&stored_file_name(host)) {
                published.retain(|existing| &existing.host != host);
            }
        }
        let verdicts = host_verdicts(pool).await?;
        for (name, bytes) in outcome.inbound {
            match self.import_stored_file(pool, &name, &bytes, &verdicts).await {
                Ok(Some((file, imported))) => {
                    published.retain(|existing| existing.host != file.host);
                    published.push(file);
                    if imported { report.imported += 1; }
                }
                Ok(None) => {}
                Err(error) => report.errors.push(format!("{name}: {error}")),
            }
        }
        self.stored.index.root = Some(pending.root);
        self.stored.index.published = published;
        self.stored.persist()?;
        Ok(report)
    }

    /// Imports one folder file. Returns its publication record, and whether it added a profile,
    /// when the file is the current copy of a saved profile; foreign or declined files stay unknown.
    async fn import_stored_file(
        &mut self,
        pool: &SqlitePool,
        name: &str,
        bytes: &[u8],
        verdicts: &HashMap<String, String>,
    ) -> Result<Option<(PublishedFile, bool)>, String> {
        let Ok(validated) = validate_profile(bytes) else { return Ok(None) };
        let host = validated.remote_host.clone();
        if validate_host(&host).is_err() || stored_file_name(&host) != name {
            return Ok(None);
        }
        let hash = profile_hash(bytes);
        let not_used = verdicts.get(&host).map(String::as_str) == Some("fails");
        let in_vault = self.index.profiles.iter().find(|profile| profile.ip == host).map(|profile| profile.hash.clone());
        let in_manual = self.stored.manual(&host).map(|profile| profile.hash.clone());
        let finder = validated.is_vpn_gate_finder;
        let record = PublishedFile { host: host.clone(), hash: hash.clone(), manual: !finder };
        let (own, other) = if finder { (in_vault, in_manual) } else { (in_manual, in_vault) };
        if own.as_deref() == Some(hash.as_str()) {
            return Ok(Some((record, false)));
        }
        if own.is_some() || other.is_some() || not_used {
            return Ok(None);
        }
        if finder {
            if self.index.profiles.len() >= self.index.limit || validate_saved_profile(&host, bytes).is_err() {
                return Ok(None);
            }
            self.capture(pool, &host, bytes).await?;
        } else {
            self.save_manual_profile(pool, bytes).await?;
        }
        Ok(Some((record, true)))
    }
}

fn remove_staging(directory: Option<&Path>) {
    if let Some(directory) = directory {
        if let Err(error) = fs::remove_dir_all(directory) {
            if error.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove staged VPN profile copies: {error}");
            }
        }
    }
}

/// Removes staged copies left by an interrupted Android sync.
pub(crate) fn clear_staging(directory: &Path) { remove_staging(Some(directory)); }

/// Desktop folder transport: the storage root is an ordinary directory.
pub(crate) fn sync_directory_folder(root: &Path, plan: &StoredSyncPlan, publish: &[(String, Vec<u8>)]) -> StoredFolderOutcome {
    let mut outcome = StoredFolderOutcome::default();
    if !root.is_dir() {
        outcome.errors.push(format!("storage folder is unavailable: {}", root.display()));
        return outcome;
    }
    outcome.reachable = true;
    let folder = root.join(STORED_PROFILE_FOLDER);
    for name in &plan.delete {
        match fs::remove_file(folder.join(name)) {
            Ok(()) => outcome.deleted.push(name.clone()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => outcome.deleted.push(name.clone()),
            Err(error) => outcome.errors.push(format!("could not remove {name} from the storage folder: {error}")),
        }
    }
    if !publish.is_empty() {
        if let Err(error) = fs::create_dir_all(&folder) {
            outcome.errors.push(format!("could not create the VPN profile folder: {error}"));
            return outcome;
        }
    }
    for (name, bytes) in publish {
        match write_folder_file(&folder, name, bytes) {
            Ok(sha256) => outcome.published.push(StoredSyncPublished { file_name: name.clone(), sha256 }),
            Err(error) => outcome.errors.push(error),
        }
    }
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return outcome,
        Err(error) => {
            outcome.errors.push(format!("could not list the VPN profile folder: {error}"));
            return outcome;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_stored_file_name(&name) || plan.known.contains(&name) { continue; }
        match read_private_file(&entry.path(), MAX_PROFILE_BYTES) {
            Ok(bytes) => outcome.inbound.push((name, bytes)),
            Err(error) => outcome.errors.push(format!("{name}: {error}")),
        }
    }
    outcome
}

/// Writes through a temporary name and returns the SHA-256 of the bytes read back.
fn write_folder_file(folder: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    let part = folder.join(format!(".{name}.part"));
    let target = folder.join(name);
    let result = (|| -> std::io::Result<Vec<u8>> {
        let mut file = fs::File::create(&part)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&part, &target)?;
        fs::read(&target)
    })();
    match result {
        Ok(written) => Ok(profile_hash(&written)),
        Err(error) => {
            let _ = fs::remove_file(&part);
            Err(format!("could not write {name} to the storage folder: {error}"))
        }
    }
}

impl StoredSyncPlan {
    /// Pairs each planned publication with its bytes for the desktop transport.
    pub(crate) fn desktop_files(&self, vault: &SavedProfileVault) -> Vec<(String, Vec<u8>)> {
        vault.stored.pending.as_ref().filter(|pending| pending.token == self.token)
            .map(|pending| pending.publish.iter().map(|file| (stored_file_name(&file.host), file.bytes.clone())).collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    fn finder(ip: &str) -> Vec<u8> {
        format!("client\ndev tun\nproto udp\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n{}\nauth-user-pass\n", crate::plugin_vpn::VPN_GATE_PROFILE_MARKER).into_bytes()
    }

    fn manual(host: &str, note: &str) -> Vec<u8> {
        format!("# {note}\nclient\ndev tun\nproto udp\nremote {host} 1194\n<ca>\ncertificate\n</ca>\n<key>\nprivate\n</key>\n").into_bytes()
    }

    async fn fixture() -> (tempfile::TempDir, SqlitePool, SavedProfileVault, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true))
            .await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict (ip TEXT PRIMARY KEY NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('works', 'fails')), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))").execute(&pool).await.unwrap();
        let vault = SavedProfileVault::open(directory.path().join("plugin-vpn/saved-profiles")).unwrap();
        let root = directory.path().join("storage");
        fs::create_dir_all(&root).unwrap();
        (directory, pool, vault, root)
    }

    async fn sync(vault: &mut SavedProfileVault, pool: &SqlitePool, root: &Path) -> StoredSyncReport {
        let plan = vault.plan_stored_sync(pool, &root.to_string_lossy(), None).await.unwrap();
        let files = plan.desktop_files(vault);
        let outcome = sync_directory_folder(root, &plan, &files);
        vault.finish_stored_sync(pool, &plan.token, outcome).await.unwrap()
    }

    async fn verdict(pool: &SqlitePool, host: &str) -> Option<String> {
        sqlx::query_scalar("SELECT verdict FROM vpn_gate_server_verdict WHERE ip = ?").bind(host).fetch_optional(pool).await.unwrap()
    }

    fn folder_names(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(root.join(STORED_PROFILE_FOLDER)).map(|entries| entries.flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn hosts_are_canonical_ipv4_addresses_or_lowercase_domains() {
        for host in ["8.8.8.8", "vpn.example.com", "a-1.example", "localhost"] {
            assert!(validate_host(host).is_ok(), "{host}");
        }
        for host in ["", "198.051.100.10", "999.1.1.1", "VPN.example.com", "-a.example", "a..b", "2001:db8::1", "../x", "a/b", "a_b.example"] {
            assert!(validate_host(host).is_err(), "{host}");
        }
        assert!(is_stored_file_name("vpn.example.com.ovpn"));
        assert!(!is_stored_file_name(".vpn.example.com.ovpn.part"));
        assert!(!is_stored_file_name("index.json"));
    }

    #[tokio::test]
    async fn existing_vault_profiles_are_copied_into_the_folder_without_touching_the_vault() {
        let (_directory, pool, mut vault, root) = fixture().await;
        let saved = vault.capture(&pool, "8.8.8.8", &finder("8.8.8.8")).await.unwrap().saved_profile.unwrap();

        assert_eq!(sync(&mut vault, &pool, &root).await, StoredSyncReport::default());

        assert_eq!(fs::read(root.join("vpn-profiles/8.8.8.8.ovpn")).unwrap(), finder("8.8.8.8"));
        assert_eq!(vault.read_for_apply(&pool, &saved.id, &saved.hash).await.unwrap().1, finder("8.8.8.8"));
        assert_eq!(verdict(&pool, "8.8.8.8").await.as_deref(), Some("works"));
        assert_eq!(sync(&mut vault, &pool, &root).await, StoredSyncReport::default());
    }

    #[tokio::test]
    async fn a_fresh_install_restores_finder_and_imported_profiles_from_the_folder() {
        let (directory, pool, mut vault, root) = fixture().await;
        vault.capture(&pool, "8.8.8.8", &finder("8.8.8.8")).await.unwrap();
        vault.save_manual_profile(&pool, &manual("vpn.example.com", "one")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        assert_eq!(folder_names(&root), ["8.8.8.8.ovpn", "vpn.example.com.ovpn"]);

        fs::remove_dir_all(directory.path().join("plugin-vpn")).unwrap();
        sqlx::query("DELETE FROM vpn_gate_server_verdict").execute(&pool).await.unwrap();
        let mut reinstalled = SavedProfileVault::open(directory.path().join("plugin-vpn/saved-profiles")).unwrap();

        assert_eq!(sync(&mut reinstalled, &pool, &root).await.imported, 2);

        let snapshot = reinstalled.snapshot(&pool).await.unwrap();
        assert_eq!(snapshot.profiles.iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), ["8.8.8.8"]);
        assert_eq!(reinstalled.manual_profiles().iter().map(|profile| profile.host.as_str()).collect::<Vec<_>>(), ["vpn.example.com"]);
        assert_eq!(verdict(&pool, "vpn.example.com").await.as_deref(), Some("works"));
        assert_eq!(sync(&mut reinstalled, &pool, &root).await.imported, 0);
    }

    #[tokio::test]
    async fn the_same_host_overwrites_its_file_and_dropped_profiles_leave_the_folder() {
        let (_directory, pool, mut vault, root) = fixture().await;
        vault.save_manual_profile(&pool, &manual("vpn.example.com", "first")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        vault.save_manual_profile(&pool, &manual("vpn.example.com", "second")).await.unwrap();
        vault.capture(&pool, "8.8.4.4", &finder("8.8.4.4")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        assert_eq!(fs::read(root.join("vpn-profiles/vpn.example.com.ovpn")).unwrap(), manual("vpn.example.com", "second"));
        assert_eq!(vault.manual_profiles().len(), 1);

        vault.revoke_host(&pool, "vpn.example.com", Some(VpnGateServerVerdictValue::Fails)).await.unwrap();
        vault.revoke_host(&pool, "8.8.4.4", None).await.unwrap();
        sync(&mut vault, &pool, &root).await;

        assert!(folder_names(&root).is_empty());
        assert!(vault.manual_profiles().is_empty());
        assert_eq!(verdict(&pool, "vpn.example.com").await.as_deref(), Some("fails"));
        assert_eq!(verdict(&pool, "8.8.4.4").await, None);
    }

    #[tokio::test]
    async fn capacity_eviction_removes_the_oldest_folder_copy() {
        let (_directory, pool, mut vault, root) = fixture().await;
        vault.set_limit(&pool, 1).await.unwrap();
        vault.capture(&pool, "8.8.8.8", &finder("8.8.8.8")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        vault.capture(&pool, "8.8.4.4", &finder("8.8.4.4")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        assert_eq!(folder_names(&root), ["8.8.4.4.ovpn"]);
    }

    #[tokio::test]
    async fn a_lost_working_copy_is_restored_from_the_folder_instead_of_deleted() {
        let (directory, pool, mut vault, root) = fixture().await;
        vault.capture(&pool, "8.8.8.8", &finder("8.8.8.8")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        fs::remove_dir_all(directory.path().join("plugin-vpn/saved-profiles")).unwrap();
        let mut reopened = SavedProfileVault::open(directory.path().join("plugin-vpn/saved-profiles")).unwrap();

        assert_eq!(sync(&mut reopened, &pool, &root).await.imported, 1);
        assert_eq!(folder_names(&root), ["8.8.8.8.ovpn"]);
        assert_eq!(reopened.snapshot(&pool).await.unwrap().profiles.len(), 1);
    }

    #[tokio::test]
    async fn not_used_foreign_and_mismatched_files_are_left_alone() {
        let (_directory, pool, mut vault, root) = fixture().await;
        let folder = root.join(STORED_PROFILE_FOLDER);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("1.1.1.1.ovpn"), finder("1.1.1.1")).unwrap();
        fs::write(folder.join("other.example.ovpn"), manual("vpn.example.com", "renamed")).unwrap();
        fs::write(folder.join("notes.txt"), b"keep").unwrap();
        sqlx::query("INSERT INTO vpn_gate_server_verdict (ip, verdict) VALUES ('1.1.1.1', 'fails')").execute(&pool).await.unwrap();

        assert_eq!(sync(&mut vault, &pool, &root).await.imported, 0);

        assert_eq!(folder_names(&root), ["1.1.1.1.ovpn", "notes.txt", "other.example.ovpn"]);
        assert!(vault.snapshot(&pool).await.unwrap().profiles.is_empty());
        assert!(vault.manual_profiles().is_empty());
    }

    #[tokio::test]
    async fn an_unavailable_folder_keeps_the_private_copies_for_a_later_sync() {
        let (_directory, pool, mut vault, root) = fixture().await;
        vault.save_manual_profile(&pool, &manual("vpn.example.com", "one")).await.unwrap();
        let missing = root.join("missing");
        let report = sync(&mut vault, &pool, &missing).await;
        assert_eq!(report.errors.len(), 1);
        assert_eq!(vault.manual_profiles().len(), 1);

        sync(&mut vault, &pool, &root).await;
        assert_eq!(folder_names(&root), ["vpn.example.com.ovpn"]);
    }

    #[tokio::test]
    async fn a_new_storage_folder_receives_every_profile_and_keeps_the_old_copies() {
        let (_directory, pool, mut vault, root) = fixture().await;
        vault.save_manual_profile(&pool, &manual("vpn.example.com", "one")).await.unwrap();
        sync(&mut vault, &pool, &root).await;
        let next = root.with_file_name("next-storage");
        fs::create_dir_all(&next).unwrap();

        sync(&mut vault, &pool, &next).await;
        vault.revoke_host(&pool, "vpn.example.com", None).await.unwrap();
        sync(&mut vault, &pool, &next).await;

        assert!(folder_names(&next).is_empty());
        assert_eq!(folder_names(&root), ["vpn.example.com.ovpn"]);
    }

    #[tokio::test]
    async fn android_plans_stage_copies_and_require_a_matching_read_back() {
        let (directory, pool, mut vault, _root) = fixture().await;
        vault.save_manual_profile(&pool, &manual("vpn.example.com", "one")).await.unwrap();
        let staging = directory.path().join("cache/vpn-profile-sync");
        let plan = vault.plan_stored_sync(&pool, "content://tree/primary%3ANorea", Some(&staging)).await.unwrap();
        let input = plan.publish[0].input_path.clone().unwrap();
        assert_eq!(fs::read(&input).unwrap(), manual("vpn.example.com", "one"));

        let outcome = StoredFolderOutcome {
            reachable: true,
            published: vec![StoredSyncPublished { file_name: "vpn.example.com.ovpn".into(), sha256: "0".repeat(64) }],
            ..StoredFolderOutcome::default()
        };
        let report = vault.finish_stored_sync(&pool, &plan.token, outcome).await.unwrap();
        assert_eq!(report.errors.len(), 1);
        assert!(!Path::new(&input).exists());
        assert!(vault.finish_stored_sync(&pool, &plan.token, StoredFolderOutcome::default()).await.is_err());

        let retry = vault.plan_stored_sync(&pool, "content://tree/primary%3ANorea", Some(&staging)).await.unwrap();
        assert_eq!(retry.publish.len(), 1);
    }

    #[tokio::test]
    async fn active_manual_capture_reads_only_the_expected_imported_profile() {
        let (directory, _pool, _vault, _root) = fixture().await;
        let path = directory.path().join("profile.ovpn");
        let bytes = manual("vpn.example.com", "one");
        fs::write(&path, &bytes).unwrap();
        let hash = profile_hash(&bytes);
        assert_eq!(read_active_manual_capture(&path, "vpn.example.com", &hash).unwrap(), bytes);
        assert!(read_active_manual_capture(&path, "other.example", &hash).is_err());
        assert!(read_active_manual_capture(&path, "vpn.example.com", &"0".repeat(64)).is_err());
    }
}
