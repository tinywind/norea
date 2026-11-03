//! Automatically tested VPN Gate servers. They are stored apart from O-approved files, never
//! carry or change a user verdict, and leave the pool once the IP receives any verdict.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    profile_hash, publish_private_file, read_private_file, remove_private_file, validate_ip,
    validate_saved_profile, SavedVpnProfile, MAX_INDEX_BYTES, MAX_PROFILE_BYTES,
};
use crate::plugin_vpn::finder::VpnGateProtocol;

const INDEX_FILE: &str = "index.json";
/// Consecutive worker tunnel failures after which an automatic server retires.
pub(crate) const RETIRE_AFTER_FAILURES: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AutomaticVpnProfile {
    pub(crate) id: String,
    pub(crate) ip: String,
    pub(crate) protocol: VpnGateProtocol,
    pub(crate) hash: String,
    pub(crate) score: u64,
    pub(crate) tested_at: i64,
    pub(crate) failures: u32,
}

impl AutomaticVpnProfile {
    /// Leases share the saved-profile shape; approval sequence 0 is never used by an approved profile.
    pub(crate) fn lease_profile(&self) -> SavedVpnProfile {
        SavedVpnProfile {
            id: self.id.clone(),
            ip: self.ip.clone(),
            protocol: self.protocol,
            hash: self.hash.clone(),
            approved_at: self.tested_at,
            approval_sequence: 0,
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomaticIndex {
    version: u8,
    profiles: Vec<AutomaticVpnProfile>,
}

pub(crate) struct AutomaticProfilePool {
    directory: PathBuf,
    index: AutomaticIndex,
}

impl AutomaticProfilePool {
    /// The pool is rediscoverable data: an unreadable index starts an empty pool instead of
    /// disabling approved profiles, and the next publication removes its unindexed files.
    pub(crate) fn open(directory: PathBuf) -> Self {
        let index = read_private_file(&directory.join(INDEX_FILE), MAX_INDEX_BYTES)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AutomaticIndex>(&bytes).ok())
            .filter(|index| index.version == 1 && valid_entries(&index.profiles))
            .unwrap_or(AutomaticIndex { version: 1, profiles: Vec::new() });
        Self { directory, index }
    }

    pub(crate) fn profiles(&self) -> Vec<AutomaticVpnProfile> {
        let mut profiles = self.index.profiles.clone();
        profiles.sort_by(|left, right| right.score.cmp(&left.score).then(right.tested_at.cmp(&left.tested_at)));
        profiles
    }

    pub(crate) fn contains_ip(&self, ip: &str) -> bool {
        self.index.profiles.iter().any(|profile| profile.ip == ip)
    }

    /// Drops entries whose IP has any O/X verdict or whose file no longer matches. Returns dropped IPs.
    pub(crate) fn reconcile(&mut self, marked_ips: &HashSet<String>) -> Result<Vec<String>, String> {
        let directory = self.directory.clone();
        let dropped: Vec<String> = self
            .index
            .profiles
            .iter()
            .filter(|profile| marked_ips.contains(&profile.ip) || read_matching(&directory, profile).is_err())
            .map(|profile| profile.ip.clone())
            .collect();
        if !dropped.is_empty() {
            self.index.profiles.retain(|profile| !dropped.contains(&profile.ip));
            self.persist()?;
        }
        Ok(dropped)
    }

    /// Adds a server that passed its test, replacing an older entry for the same IP. Beyond `limit`,
    /// the lowest-scored entries leave first. Returns the new entry and every IP that left the pool.
    pub(crate) fn add(
        &mut self,
        ip: &str,
        bytes: &[u8],
        score: u64,
        tested_at: i64,
        limit: usize,
        marked_ips: &HashSet<String>,
    ) -> Result<(AutomaticVpnProfile, Vec<String>), String> {
        if marked_ips.contains(ip) {
            return Err("a VPN Gate server with a user verdict cannot join the automatic pool".to_string());
        }
        let protocol = validate_saved_profile(ip, bytes)?;
        let hash = profile_hash(bytes);
        let profile = AutomaticVpnProfile { id: hash.clone(), ip: ip.to_string(), protocol, hash, score, tested_at, failures: 0 };
        let mut removed: Vec<String> = Vec::new();
        if self.contains_ip(ip) {
            self.index.profiles.retain(|existing| existing.ip != ip);
            removed.push(ip.to_string());
            // Commit the absence before publishing bytes so an interrupted replacement cannot keep a stale index entry.
            self.persist()?;
        }
        publish_private_file(&self.directory.join(format!("{ip}.ovpn")), bytes)?;
        self.index.profiles.push(profile.clone());
        removed.extend(self.evict(limit));
        self.persist()?;
        Ok((profile, removed))
    }

    pub(crate) fn set_limit(&mut self, limit: usize) -> Result<Vec<String>, String> {
        let evicted = self.evict(limit);
        if !evicted.is_empty() { self.persist()?; }
        Ok(evicted)
    }

    /// Records a worker tunnel outcome. Returns the IP when repeated failures retired the entry.
    pub(crate) fn record_result(&mut self, id: &str, hash: &str, connected: bool) -> Result<Option<String>, String> {
        let Some(position) = self.index.profiles.iter().position(|profile| profile.id == id && profile.hash == hash) else {
            return Ok(None);
        };
        let profile = &mut self.index.profiles[position];
        if connected {
            if profile.failures == 0 { return Ok(None); }
            profile.failures = 0;
            self.persist()?;
            return Ok(None);
        }
        profile.failures += 1;
        let retired = (profile.failures >= RETIRE_AFTER_FAILURES).then(|| profile.ip.clone());
        if let Some(ip) = &retired { self.index.profiles.retain(|profile| &profile.ip != ip); }
        self.persist()?;
        Ok(retired)
    }

    pub(crate) fn read(&self, id: &str, hash: &str) -> Result<Option<(AutomaticVpnProfile, Vec<u8>)>, String> {
        let Some(profile) = self.index.profiles.iter().find(|profile| profile.id == id && profile.hash == hash) else {
            return Ok(None);
        };
        Ok(Some((profile.clone(), read_matching(&self.directory, profile)?)))
    }

    fn evict(&mut self, limit: usize) -> Vec<String> {
        self.index.profiles.sort_by(|left, right| right.score.cmp(&left.score).then(right.tested_at.cmp(&left.tested_at)));
        let mut evicted = Vec::new();
        while self.index.profiles.len() > limit {
            if let Some(profile) = self.index.profiles.pop() { evicted.push(profile.ip); }
        }
        evicted
    }

    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.index)
            .map_err(|error| format!("could not encode the automatic VPN server index: {error}"))?;
        if bytes.len() > MAX_INDEX_BYTES {
            return Err("automatic VPN server index exceeds its size limit".to_string());
        }
        publish_private_file(&self.directory.join(INDEX_FILE), &bytes)?;
        self.cleanup_orphans();
        Ok(())
    }

    fn cleanup_orphans(&self) {
        let Ok(entries) = fs::read_dir(&self.directory) else { return };
        let retained: HashSet<String> = self.index.profiles.iter().map(|profile| format!("{}.ovpn", profile.ip)).collect();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != INDEX_FILE && !retained.contains(&name) &&
                (name.ends_with(".ovpn") || name.ends_with(".part") || name.ends_with(".backup")) {
                if let Err(error) = remove_private_file(&entry.path()) { log::warn!("{error}"); }
            }
        }
    }
}

fn valid_entries(profiles: &[AutomaticVpnProfile]) -> bool {
    let mut ips = HashSet::new();
    profiles.iter().all(|profile| validate_ip(&profile.ip).is_ok() && profile.id == profile.hash &&
        profile.hash.len() == 64 && profile.tested_at >= 0 && ips.insert(profile.ip.as_str()))
}

fn read_matching(directory: &Path, profile: &AutomaticVpnProfile) -> Result<Vec<u8>, String> {
    let bytes = read_private_file(&directory.join(format!("{}.ovpn", profile.ip)), MAX_PROFILE_BYTES)?;
    if profile_hash(&bytes) != profile.hash || validate_saved_profile(&profile.ip, &bytes)? != profile.protocol {
        return Err("automatic VPN server file changed".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(ip: &str) -> Vec<u8> {
        format!("client\ndev tun\nproto tcp-client\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n{}\nauth-user-pass\n", crate::plugin_vpn::VPN_GATE_PROFILE_MARKER).into_bytes()
    }

    fn pool() -> (tempfile::TempDir, AutomaticProfilePool) {
        let directory = tempfile::tempdir().unwrap();
        let pool = AutomaticProfilePool::open(directory.path().join("automatic-profiles"));
        (directory, pool)
    }

    #[test]
    fn stores_tested_servers_and_reopens_them_without_any_verdict() {
        let (directory, mut pool) = pool();
        let (added, removed) = pool.add("8.8.8.8", &profile("8.8.8.8"), 10, 1, 5, &HashSet::new()).unwrap();
        assert!(removed.is_empty());
        assert_eq!(added.lease_profile().approval_sequence, 0);
        let reopened = AutomaticProfilePool::open(directory.path().join("automatic-profiles"));
        assert_eq!(reopened.profiles(), vec![added.clone()]);
        assert_eq!(reopened.read(&added.id, &added.hash).unwrap().unwrap().1, profile("8.8.8.8"));
    }

    #[test]
    fn refuses_marked_ips_and_drops_entries_once_the_user_marks_them() {
        let (_directory, mut pool) = pool();
        let marked = HashSet::from(["1.1.1.1".to_string()]);
        assert!(pool.add("1.1.1.1", &profile("1.1.1.1"), 10, 1, 5, &marked).is_err());
        pool.add("8.8.8.8", &profile("8.8.8.8"), 10, 1, 5, &marked).unwrap();
        pool.add("8.8.4.4", &profile("8.8.4.4"), 10, 1, 5, &marked).unwrap();
        let dropped = pool.reconcile(&HashSet::from(["8.8.8.8".to_string()])).unwrap();
        assert_eq!(dropped, vec!["8.8.8.8".to_string()]);
        assert_eq!(pool.profiles().iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), vec!["8.8.4.4"]);
    }

    #[test]
    fn retires_after_repeated_failures_and_a_success_resets_the_count() {
        let (_directory, mut pool) = pool();
        let (added, _) = pool.add("8.8.8.8", &profile("8.8.8.8"), 10, 1, 5, &HashSet::new()).unwrap();
        assert_eq!(pool.record_result(&added.id, &added.hash, false).unwrap(), None);
        assert_eq!(pool.record_result(&added.id, &added.hash, false).unwrap(), None);
        assert_eq!(pool.record_result(&added.id, &added.hash, true).unwrap(), None);
        for _ in 1..RETIRE_AFTER_FAILURES { assert_eq!(pool.record_result(&added.id, &added.hash, false).unwrap(), None); }
        assert_eq!(pool.record_result(&added.id, &added.hash, false).unwrap(), Some("8.8.8.8".to_string()));
        assert!(pool.profiles().is_empty());
        assert!(pool.read(&added.id, &added.hash).unwrap().is_none());
        assert!(!pool.directory.join("8.8.8.8.ovpn").exists());
    }

    #[test]
    fn keeps_the_best_scored_servers_within_the_retention_capacity() {
        let (_directory, mut pool) = pool();
        pool.add("8.8.8.8", &profile("8.8.8.8"), 30, 1, 2, &HashSet::new()).unwrap();
        pool.add("8.8.4.4", &profile("8.8.4.4"), 10, 1, 2, &HashSet::new()).unwrap();
        let (_, removed) = pool.add("1.1.1.1", &profile("1.1.1.1"), 20, 1, 2, &HashSet::new()).unwrap();
        assert_eq!(removed, vec!["8.8.4.4".to_string()]);
        assert_eq!(pool.profiles().iter().map(|profile| profile.ip.as_str()).collect::<Vec<_>>(), vec!["8.8.8.8", "1.1.1.1"]);
        assert_eq!(pool.set_limit(1).unwrap(), vec!["1.1.1.1".to_string()]);
        assert!(!pool.directory.join("1.1.1.1.ovpn").exists());
    }

    #[test]
    fn an_unreadable_index_starts_empty_instead_of_failing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("automatic-profiles");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join(INDEX_FILE), b"not json").unwrap();
        assert!(AutomaticProfilePool::open(path).profiles().is_empty());
    }
}
