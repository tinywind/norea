#[cfg(any(target_os = "android", target_os = "windows"))]
use std::time::Duration;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "android", target_os = "windows"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{DbInstances, DbPool};

use super::finder::{VpnGateFinder, VpnGateServer};
use super::saved_profiles::{
    ForegroundVpnProfile, SavedProfileVault, SavedVpnProfileCaptureSource, SavedVpnProfileLease,
    SavedVpnProfileSelection, SavedVpnProfileVaultSnapshot, VpnGateServerVerdictMutation,
    VpnGateServerVerdictValue, read_active_capture,
};
#[cfg(any(target_os = "android", target_os = "windows", test))]
use super::proxy::{LocalProxy, ProxyConnector};
use super::{
    MAX_PROFILE_BYTES, ValidatedProfile, is_vpn_gate_finder_profile,
    reject_reserved_vpn_gate_profile_marker, validate_profile,
};

const PROFILE_DIRECTORY: &str = "plugin-vpn";
const PROFILE_FILE: &str = "profile.ovpn";
const PROFILE_PART_FILE: &str = "profile.ovpn.part";
const PROFILE_BACKUP_FILE: &str = "profile.ovpn.backup";
const ACTIVE_CHANGE_DIRECTORY: &str = "profile-change";
const ACTIVE_CHANGE_METADATA: &str = "selection.json";
#[cfg(any(target_os = "android", target_os = "windows"))]
const PLUGIN_VPN_STATUS_EVENT: &str = "plugin-vpn-status";
const VPN_GATE_PUBLIC_CREDENTIAL: &str = "vpn";
#[cfg(any(target_os = "android", target_os = "windows"))]
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn managed_profile_path(app_data_directory: &Path) -> Result<PathBuf, String> {
    // Android's app namespace can alias /data/user/0. Resolve only the OS root,
    // so linked managed directories and restore checkpoints are still rejected.
    #[cfg(target_os = "android")]
    let app_data_directory = app_data_directory.canonicalize().map_err(|error| {
        format!("could not resolve the Android app data directory {}: {error}", app_data_directory.display())
    })?;
    Ok(app_data_directory.join(PROFILE_DIRECTORY).join(PROFILE_FILE))
}

#[derive(Clone)]
pub(crate) struct PluginVpnState {
    shared: Arc<PluginVpnShared>,
}

struct PluginVpnShared {
    #[cfg(any(target_os = "android", target_os = "windows", test))]
    proxy: LocalProxy,
    finder: VpnGateFinder,
    profile_path: OnceLock<PathBuf>,
    saved_profiles: OnceLock<Result<tokio::sync::Mutex<SavedProfileVault>, String>>,
    recovered_saved_profiles: OnceLock<tokio::sync::Mutex<SavedProfileVault>>,
    operation: tokio::sync::Mutex<()>,
    // Serializes foreground connect/disconnect without holding `operation` across a handshake.
    // Lock order: `foreground` before `operation`.
    foreground: tokio::sync::Mutex<()>,
    state: Mutex<PluginVpnRuntime>,
}

struct PluginVpnRuntime {
    generation: u64,
    network_revision: u64,
    connection_requested: bool,
    phase: PluginVpnPhase,
    profile: Option<PluginVpnProfile>,
    error: Option<String>,
    connecting_cancellation: Option<tokio::sync::watch::Sender<bool>>,
    #[cfg(any(target_os = "android", target_os = "windows"))]
    control: Option<super::engine::EngineControl>,
    #[cfg(any(target_os = "android", target_os = "windows"))]
    session_completion: Option<tokio::sync::oneshot::Receiver<()>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PluginVpnPhase {
    Disabled,
    Connecting,
    Connected,
    Reconnecting,
    Disconnecting,
    WaitingForNetwork,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginVpnProfile {
    hash: String,
    is_vpn_gate_finder: bool,
    remote_host: String,
    #[serde(skip)]
    remote_hosts: Vec<String>,
    requires_username_password: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginVpnStatus {
    supported: bool,
    proxy_port: u16,
    phase: PluginVpnPhase,
    profile: Option<PluginVpnProfile>,
    error: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "windows"))]
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PluginVpnStatusEventKind {
    Error,
    Reconnected,
    Reconnecting,
    NetworkChanged,
}

#[cfg(any(target_os = "android", target_os = "windows"))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginVpnStatusEvent {
    kind: PluginVpnStatusEventKind,
    status: PluginVpnStatus,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginVpnCredentials {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    private_key_password: String,
    #[serde(default)]
    challenge_response: String,
}

impl PluginVpnCredentials {
    fn resolve_for_profile(mut self, profile: &str) -> Self {
        if is_vpn_gate_finder_profile(profile) {
            self.username = VPN_GATE_PUBLIC_CREDENTIAL.to_string();
            self.password = VPN_GATE_PUBLIC_CREDENTIAL.to_string();
        }
        self
    }
}

impl PluginVpnState {
    pub(crate) fn watch_network(&self, app: &AppHandle) {
        #[cfg(any(target_os = "android", target_os = "windows"))]
        {
            let state = self.clone();
            let app = app.clone();
            let mut network = crate::network::subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    network.borrow_and_update();
                    match disconnect(&state, None).await {
                        Ok(status) => emit_status_event(
                            &app, status, PluginVpnStatusEventKind::NetworkChanged,
                        ),
                        Err(error) => log::warn!("could not suspend plugin VPN: {error}"),
                    }
                    if network.changed().await.is_err() { break; }
                }
            });
        }
        #[cfg(not(any(target_os = "android", target_os = "windows")))]
        let _ = app;
    }

    pub(crate) fn bind() -> Result<Self, String> {
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        let proxy = LocalProxy::bind()?;
        let state = Self {
            shared: Arc::new(PluginVpnShared {
                #[cfg(any(target_os = "android", target_os = "windows", test))]
                proxy,
                finder: VpnGateFinder::new()?,
                profile_path: OnceLock::new(),
                saved_profiles: OnceLock::new(),
                recovered_saved_profiles: OnceLock::new(),
                operation: tokio::sync::Mutex::new(()),
                foreground: tokio::sync::Mutex::new(()),
                state: Mutex::new(PluginVpnRuntime {
                    generation: 0,
                    network_revision: 0,
                    connection_requested: false,
                    phase: PluginVpnPhase::Disabled,
                    profile: None,
                    error: None,
                    connecting_cancellation: None,
                    #[cfg(any(target_os = "android", target_os = "windows"))]
                    control: None,
                    #[cfg(any(target_os = "android", target_os = "windows"))]
                    session_completion: None,
                }),
            }),
        };
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        state.shared.proxy.start()?;
        Ok(state)
    }

    pub(crate) fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        let app_data_directory = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("could not resolve the app data directory: {error}"))?;
        let profile_path = managed_profile_path(&app_data_directory)?;
        crate::device_backup::restore_checkpoint::require_complete(&profile_path)?;
        self.shared
            .profile_path
            .set(profile_path.clone())
            .map_err(|_| "plugin VPN state is already initialized".to_string())?;

        let mut vault = SavedProfileVault::open(profile_path.parent().expect("profile directory").join("saved-profiles"));
        let recovery_error = vault.as_mut().ok().and_then(|vault| recover_active_profile_change(&profile_path, vault).err());
        let vault_error = vault.as_ref().err().cloned();
        self.shared.saved_profiles.set(vault.map(tokio::sync::Mutex::new))
            .map_err(|_| "saved VPN profile vault is already initialized".to_string())?;

        let loaded = load_stored_profile(&profile_path);
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        match loaded {
            Ok(profile) => state.profile = profile,
            Err(error) => state.error = Some(error),
        }
        if let Some(error) = vault_error { state.error = Some(error); }
        if let Some(error) = recovery_error { state.error = Some(error); }
        Ok(())
    }

    pub(crate) fn export_backup_profile(&self) -> Result<Option<Vec<u8>>, String> {
        let _operation = self
            .shared
            .operation
            .try_lock()
            .map_err(|_| "wait for the current plugin VPN operation before backing up".to_string())?;
        let path = self.profile_path()?;
        recover_profile_publication(&path)?;
        match fs::metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("could not inspect the stored OpenVPN profile: {error}")),
            Ok(_) => {}
        }
        let bytes = read_profile_source(&path)?;
        validate_profile(&bytes)?;
        Ok(Some(bytes))
    }

    pub(crate) async fn restore_backup_profile(
        &self,
        _app: &AppHandle,
        bytes: Option<Vec<u8>>,
    ) -> Result<(), String> {
        let profile = bytes
            .as_deref()
            .map(validate_profile)
            .transpose()?
            .map(PluginVpnProfile::from);
        disconnect(self, Some(false)).await?;
        let _operation = self.shared.operation.lock().await;
        self.require_disabled("restore a backup profile")?;
        let path = self.profile_path()?;
        {
            let mut runtime = self.shared.state.lock().expect("plugin VPN state lock");
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.connection_requested = false;
            runtime.connecting_cancellation = None;
            #[cfg(any(target_os = "android", target_os = "windows", test))]
            self.set_disconnected_proxy(false);
        }
        tauri::async_runtime::spawn_blocking(move || match bytes {
            Some(bytes) => store_profile(&path, &bytes),
            None => remove_stored_profile(&path),
        })
        .await
        .map_err(|error| format!("could not restore the OpenVPN profile: {error}"))??;
        let mut runtime = self.shared.state.lock().expect("plugin VPN state lock");
        runtime.profile = profile;
        runtime.phase = PluginVpnPhase::Disabled;
        runtime.error = None;
        Ok(())
    }

    pub(crate) fn proxy_port(&self) -> u16 {
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        {
            self.shared.proxy.address().port()
        }
        #[cfg(not(any(target_os = "android", target_os = "windows", test)))]
        {
            0
        }
    }

    #[cfg(any(target_os = "android", target_os = "windows", test))]
    pub(crate) fn proxy_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.proxy_port())
    }

    fn profile_path(&self) -> Result<PathBuf, String> {
        self.shared
            .profile_path
            .get()
            .cloned()
            .ok_or_else(|| "plugin VPN state is not initialized".to_string())
    }

    fn saved_profiles(&self) -> Result<&tokio::sync::Mutex<SavedProfileVault>, String> {
        if let Some(vault) = self.shared.recovered_saved_profiles.get() { return Ok(vault); }
        self.shared.saved_profiles.get().ok_or_else(|| "saved VPN profile vault is not initialized".to_string())?
            .as_ref().map_err(Clone::clone)
    }

    async fn prepare_manual_vault(&self) -> Result<(), String> {
        let directory = self.profile_path()?.parent().expect("profile directory").join("saved-profiles");
        let pin_current = self.status().profile.filter(|profile| profile.is_vpn_gate_finder)
            .map(|profile| SavedVpnProfileSelection { id: profile.hash.clone(), hash: profile.hash });
        match self.saved_profiles() {
            Ok(vault) => {
                let mut vault = vault.lock().await;
                if !vault.needs_recovery() || vault.has_leases() { return Ok(()); }
                let recovered = SavedProfileVault::quarantine_and_open(directory, pin_current)?;
                *vault = recovered;
            }
            Err(_) => {
                let recovered = SavedProfileVault::quarantine_and_open(directory, pin_current)?;
                self.shared.recovered_saved_profiles.set(tokio::sync::Mutex::new(recovered))
                    .map_err(|_| "saved VPN profile recovery was already initialized".to_string())?;
            }
        }
        Ok(())
    }

    pub(crate) async fn reserve_saved_profile(
        &self, pool: &sqlx::SqlitePool, owner: &str, id: &str, expected_hash: &str,
    ) -> Result<SavedVpnProfileLease, String> {
        let _operation = self.shared.operation.lock().await;
        let foreground = {
            let runtime = self.shared.state.lock().expect("plugin VPN state lock");
            let mut unsettled = runtime.connecting_cancellation.is_some();
            #[cfg(any(target_os = "android", target_os = "windows"))]
            { unsettled |= runtime.control.is_some() || runtime.session_completion.is_some(); }
            foreground_profile_exclusion(runtime.profile.as_ref(), runtime.phase, runtime.connection_requested, unsettled)
        };
        self.saved_profiles()?.lock().await.reserve(pool, owner, id, expected_hash, foreground.as_ref()).await
    }

    /// Revocation during the caller's handshake stays visible through the lease flag; recheck it before publishing a route.
    pub(crate) async fn read_saved_profile_lease(
        &self, pool: &sqlx::SqlitePool, owner: &str,
    ) -> Result<(SavedVpnProfileLease, Vec<u8>), String> {
        let _operation = self.shared.operation.lock().await;
        self.saved_profiles()?.lock().await.read_lease(pool, owner).await
    }

    pub(crate) async fn saved_profile_lease(
        &self, pool: &sqlx::SqlitePool, owner: &str,
    ) -> Result<Option<SavedVpnProfileLease>, String> {
        let _operation = self.shared.operation.lock().await;
        self.saved_profiles()?.lock().await.lease(pool, owner).await
    }

    pub(crate) async fn release_saved_profile(&self, owner: &str) -> Result<(), String> {
        let _operation = self.shared.operation.lock().await;
        self.saved_profiles()?.lock().await.release(owner)
    }

    fn status(&self) -> PluginVpnStatus {
        let state = self.shared.state.lock().expect("plugin VPN state lock");
        self.status_from_runtime(&state)
    }

    fn status_from_runtime(&self, state: &PluginVpnRuntime) -> PluginVpnStatus {
        PluginVpnStatus {
            supported: plugin_vpn_supported(),
            proxy_port: self.proxy_port(),
            phase: if !cfg!(test) && state.connection_requested && crate::network::require_online().is_err() {
                PluginVpnPhase::WaitingForNetwork
            } else { state.phase },
            profile: state.profile.clone(),
            error: state.error.clone(),
        }
    }

    fn require_disabled(&self, action: &str) -> Result<(), String> {
        let state = self.shared.state.lock().expect("plugin VPN state lock");
        if state.phase != PluginVpnPhase::Disabled {
            return Err(format!(
                "disconnect the plugin VPN before attempting to {action}"
            ));
        }
        Ok(())
    }

    fn request_connection(&self) -> u64 {
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        state.connection_requested = true;
        // Block before waiting for an older teardown to release the operation lock.
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        if state.phase != PluginVpnPhase::Connected {
            self.shared.proxy.block("The plugin VPN connection is starting");
        }
        state.generation
    }

    fn begin_connection(
        &self,
        request_generation: u64,
    ) -> Result<(u64, tokio::sync::watch::Receiver<bool>), String> {
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        if state.generation != request_generation {
            return Err("plugin VPN connection request was superseded".to_string());
        }
        if state.phase != PluginVpnPhase::Disabled {
            return Err("disconnect the plugin VPN before attempting to connect".to_string());
        }
        if state.profile.is_none() {
            return Err("import an OpenVPN profile before connecting".to_string());
        }
        let (cancellation, cancellation_receiver) = tokio::sync::watch::channel(false);
        state.connection_requested = true;
        state.generation = state.generation.wrapping_add(1);
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        self.shared
            .proxy
            .block("The plugin VPN connection is starting");
        state.phase = PluginVpnPhase::Connecting;
        state.network_revision = crate::network::network_status().revision;
        state.error = None;
        state.connecting_cancellation = Some(cancellation);
        let generation = state.generation;
        Ok((generation, cancellation_receiver))
    }

    fn set_connection_error(&self, generation: u64, error: String) {
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        if state.generation != generation {
            return;
        }
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        self.shared.proxy.block("The plugin VPN connection is unavailable");
        state.phase = PluginVpnPhase::Error;
        state.error = Some(error);
        state.connecting_cancellation = None;
        #[cfg(any(target_os = "android", target_os = "windows"))]
        {
            state.control = None;
            state.session_completion = None;
        }
    }

    #[cfg(any(target_os = "android", target_os = "windows", test))]
    fn set_tunnel_reconnecting(
        &self,
        generation: u64,
        error: Option<String>,
    ) -> Option<PluginVpnStatus> {
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        if state.generation != generation
            || !matches!(
                state.phase,
                PluginVpnPhase::Connected | PluginVpnPhase::Reconnecting
            )
        {
            return None;
        }
        self.shared
            .proxy
            .block("The plugin VPN connection is reconnecting");
        if let Some(error) = error {
            state.error = Some(error);
        } else if state.phase == PluginVpnPhase::Connected {
            state.error = None;
        }
        state.phase = PluginVpnPhase::Reconnecting;
        Some(self.status_from_runtime(&state))
    }

    #[cfg(any(target_os = "android", target_os = "windows", test))]
    fn set_tunnel_reconnected(
        &self,
        generation: u64,
        connector: Arc<dyn ProxyConnector>,
    ) -> Option<PluginVpnStatus> {
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        if state.generation != generation || state.phase != PluginVpnPhase::Reconnecting {
            return None;
        }
        self.shared.proxy.tunnel(connector);
        state.phase = PluginVpnPhase::Connected;
        state.error = None;
        Some(self.status_from_runtime(&state))
    }

    #[cfg(any(target_os = "android", target_os = "windows", test))]
    fn set_disconnected_proxy(&self, preserve_block: bool) {
        if preserve_block {
            self.shared
                .proxy
                .block("The plugin VPN connection is switching");
        } else {
            self.shared.proxy.direct();
        }
    }
}

fn plugin_vpn_supported() -> bool {
    cfg!(any(target_os = "android", target_os = "windows"))
}

#[cfg(any(target_os = "android", target_os = "windows"))]
fn emit_status_event(app: &AppHandle, status: PluginVpnStatus, kind: PluginVpnStatusEventKind) {
    if let Err(error) = app.emit(
        PLUGIN_VPN_STATUS_EVENT,
        PluginVpnStatusEvent {
            kind,
            status,
        },
    ) {
        log::warn!("could not emit plugin VPN status event: {error}");
    }
}

#[tauri::command]
pub(crate) fn plugin_vpn_status(state: State<'_, PluginVpnState>) -> PluginVpnStatus {
    state.status()
}

#[tauri::command]
pub(crate) fn plugin_vpn_cancel_finder_query(
    query_id: String,
    state: State<'_, PluginVpnState>,
) -> Result<(), String> {
    ensure_supported()?;
    state.shared.finder.cancel_query(&query_id)
}

#[tauri::command]
pub(crate) async fn plugin_vpn_load_finder_servers(
    force_refresh: bool,
    query_id: String,
    state: State<'_, PluginVpnState>,
) -> Result<Vec<VpnGateServer>, String> {
    ensure_supported()?;
    crate::network::require_online()?;
    state
        .shared
        .finder
        .load_servers(force_refresh, &query_id)
        .await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_apply_finder_profile(
    candidate_id: String,
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    state.require_disabled("apply a Finder profile")?;
    let bytes = state.shared.finder.profile_bytes(&candidate_id)?;
    let _operation = state.shared.operation.lock().await;
    import_profile_bytes(state.inner(), bytes, "apply a Finder profile", None).await
}

pub(crate) async fn saved_profile_database<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<sqlx::SqlitePool, String> {
    let instances = app.state::<DbInstances>();
    let databases = instances.0.read().await;
    match databases.get("sqlite:norea.db") {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("app database is not initialized for saved VPN profiles".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn plugin_vpn_list_saved_profiles(
    app: AppHandle, state: State<'_, PluginVpnState>,
) -> Result<SavedVpnProfileVaultSnapshot, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    let pool = saved_profile_database(&app).await?;
    state.saved_profiles()?.lock().await.snapshot(&pool).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_capture_saved_profile(
    ip: String, source: SavedVpnProfileCaptureSource, app: AppHandle, state: State<'_, PluginVpnState>,
) -> Result<VpnGateServerVerdictMutation, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    let bytes = match source {
        SavedVpnProfileCaptureSource::Finder { candidate_id } => state.shared.finder.profile_bytes(&candidate_id)?,
        SavedVpnProfileCaptureSource::Active { expected_hash } => {
            let current = state.status().profile.ok_or_else(|| "active VPN profile is unavailable".to_string())?;
            if current.hash != expected_hash || current.remote_host != ip || !current.is_vpn_gate_finder {
                return Err("active VPN profile changed before approval".to_string());
            }
            read_active_capture(&state.profile_path()?, &ip, &expected_hash)?
        }
    };
    let pool = saved_profile_database(&app).await?;
    state.saved_profiles()?.lock().await.capture(&pool, &ip, &bytes).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_revoke_saved_profile(
    ip: String, verdict: Option<VpnGateServerVerdictValue>, app: AppHandle, state: State<'_, PluginVpnState>,
) -> Result<VpnGateServerVerdictMutation, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    let pool = saved_profile_database(&app).await?;
    state.saved_profiles()?.lock().await.revoke(&pool, &ip, verdict).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_set_saved_profile_limit(
    limit: usize, app: AppHandle, state: State<'_, PluginVpnState>,
) -> Result<SavedVpnProfileVaultSnapshot, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    let pool = saved_profile_database(&app).await?;
    state.saved_profiles()?.lock().await.set_limit(&pool, limit).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_apply_saved_profile(
    id: String, expected_hash: String, app: AppHandle, state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    state.require_disabled("apply a saved profile")?;
    let pool = saved_profile_database(&app).await?;
    let (_, bytes) = state.saved_profiles()?.lock().await.read_for_apply(&pool, &id, &expected_hash).await?;
    import_profile_bytes(state.inner(), bytes, "apply a saved profile", Some(SavedVpnProfileSelection { id, hash: expected_hash })).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_import_profile(
    path: String,
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    state.require_disabled("import a profile")?;

    let bytes = tauri::async_runtime::spawn_blocking(move || read_profile_source(Path::new(&path)))
        .await
        .map_err(|error| format!("could not read the OpenVPN profile: {error}"))??;
    reject_reserved_vpn_gate_profile_marker(&bytes)?;
    import_profile_bytes(state.inner(), bytes, "import a profile", None).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_remove_profile(
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    state.require_disabled("remove the profile")?;
    state.prepare_manual_vault().await?;
    let profile_path = state.profile_path()?;
    {
        let mut vault = state.saved_profiles()?.lock().await;
        publish_active_profile(&profile_path, &mut vault, None, None)?;
    }

    {
        let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
        runtime.profile = None;
        runtime.error = None;
    }
    Ok(state.status())
}

#[tauri::command]
pub(crate) async fn plugin_vpn_connect(
    credentials: PluginVpnCredentials,
    app: AppHandle,
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    let request_generation = state.request_connection();
    let _foreground = state.shared.foreground.lock().await;
    let operation = state.shared.operation.lock().await;
    crate::network::require_online()?;
    let profile_path = state.profile_path()?;
    if state.status().profile.as_ref().is_some_and(|profile| !profile.is_vpn_gate_finder) {
        state.prepare_manual_vault().await?;
    }
    {
        let mut vault = state.saved_profiles()?.lock().await;
        recover_active_profile_change(&profile_path, &mut vault)?;
    }
    let (generation, cancellation) = state.begin_connection(request_generation)?;
    let profile =
        tauri::async_runtime::spawn_blocking(move || read_profile_for_connection(&profile_path))
            .await
            .map_err(|error| format!("could not read the OpenVPN profile: {error}"));
    let profile = match profile {
        Ok(Ok(profile)) => profile,
        Ok(Err(error)) | Err(error) => {
            state.set_connection_error(generation, error.clone());
            return Err(error);
        }
    };
    {
        let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
        if runtime.generation == generation { runtime.profile = Some(PluginVpnProfile::from(validate_profile(profile.as_bytes())?)); }
    }
    let pool = saved_profile_database(&app).await?;
    if let Err(error) = state.saved_profiles()?.lock().await.validate_active(&pool, profile.as_bytes()).await {
        state.set_connection_error(generation, error.clone());
        return Err(error);
    }
    let credentials = credentials.resolve_for_profile(&profile);
    {
        let runtime = state.shared.state.lock().expect("plugin VPN state lock");
        if runtime.generation != generation || runtime.phase != PluginVpnPhase::Connecting {
            return Err("plugin VPN connection was superseded".to_string());
        }
    }
    // The Connecting phase now excludes this profile from worker leases, so worker
    // handshakes need not wait behind this one.
    drop(operation);

    #[cfg(any(target_os = "android", target_os = "windows"))]
    let connection = match super::engine::connect(
        profile,
        super::engine::EngineCredentials {
            username: credentials.username,
            password: credentials.password,
            private_key_password: credentials.private_key_password,
            challenge_response: credentials.challenge_response,
        },
        cancellation,
    )
    .await
    {
        Ok(connection) => connection,
        Err(error) => {
            state.set_connection_error(generation, error.clone());
            return Err(error);
        }
    };

    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    let _ = (app, credentials, profile, cancellation);

    #[cfg(any(target_os = "android", target_os = "windows"))]
    {
        let super::engine::EngineConnection {
            connector,
            control,
            lifecycle,
            completion,
        } = connection;
        let (completion_sender, completion_receiver) = tokio::sync::oneshot::channel();
        let committed = {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            if runtime.generation != generation || runtime.phase != PluginVpnPhase::Connecting {
                false
            } else {
                runtime.connecting_cancellation = None;
                runtime.control = Some(control.clone());
                runtime.session_completion = Some(completion_receiver);
                runtime.phase = PluginVpnPhase::Connected;
                runtime.error = None;
                state.shared.proxy.tunnel(connector.clone());
                true
            }
        };
        if !committed {
            control.cancel();
            let _ = completion.await;
            return Err("plugin VPN connection was superseded".to_string());
        }

        let monitor_state = state.inner().clone();
        tauri::async_runtime::spawn(async move {
            let mut completion = completion;
            let mut lifecycle = lifecycle;
            let result = loop {
                tokio::select! {
                    result = &mut completion => break result,
                    event = lifecycle.recv() => match event {
                        Some(super::engine::EngineLifecycle::Reconnecting(error)) => {
                            if let Some(status) =
                                monitor_state.set_tunnel_reconnecting(generation, error)
                            {
                                emit_status_event(
                                    &app,
                                    status,
                                    PluginVpnStatusEventKind::Reconnecting,
                                );
                            }
                        }
                        Some(super::engine::EngineLifecycle::Reconnected) => {
                            if let Some(status) = monitor_state
                                .set_tunnel_reconnected(generation, connector.clone())
                            {
                                emit_status_event(
                                    &app,
                                    status,
                                    PluginVpnStatusEventKind::Reconnected,
                                );
                            }
                        }
                        None => break completion.await,
                    }
                }
            };
            let error = match result {
                Ok(()) => "OpenVPN disconnected unexpectedly".to_string(),
                Err(error) => error,
            };
            let _ = completion_sender.send(());
            let mut runtime = monitor_state
                .shared
                .state
                .lock()
                .expect("plugin VPN state lock");
            let status = if runtime.generation == generation {
                monitor_state
                    .shared
                    .proxy
                    .block("The plugin VPN connection is unavailable");
                runtime.phase = PluginVpnPhase::Error;
                runtime.error = Some(error);
                runtime.connecting_cancellation = None;
                runtime.control = None;
                Some(monitor_state.status_from_runtime(&runtime))
            } else {
                None
            };
            drop(runtime);
            if let Some(status) = status {
                emit_status_event(&app, status, PluginVpnStatusEventKind::Error);
            }
        });
    }

    Ok(state.status())
}

#[tauri::command]
pub(crate) async fn plugin_vpn_disconnect(
    preserve_block: bool,
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    disconnect(state.inner(), Some(preserve_block)).await
}

/// Ends automatic recovery: download workers may lease the profile again, but plugin
/// traffic stays blocked until the user connects or turns the VPN off.
#[tauri::command]
pub(crate) async fn plugin_vpn_release_profile(
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    release_profile(state.inner()).await
}

async fn release_profile(state: &PluginVpnState) -> Result<PluginVpnStatus, String> {
    disconnect(state, Some(true)).await?;
    let _foreground = state.shared.foreground.lock().await;
    let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
    // A connection the user started after the disconnect keeps its request.
    if runtime.phase == PluginVpnPhase::Disabled && runtime.connection_requested {
        runtime.connection_requested = false;
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        state.set_disconnected_proxy(true);
    }
    Ok(state.status_from_runtime(&runtime))
}

async fn disconnect(
    state: &PluginVpnState,
    preserve_block: Option<bool>,
) -> Result<PluginVpnStatus, String> {
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    let _ = preserve_block;

    #[cfg(any(target_os = "android", target_os = "windows"))]
    let (request_generation, cancellation) = {
        let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
        if preserve_block.is_none() {
            let network = crate::network::network_status();
            // A delayed network event must not stop a connection already using the new route.
            if runtime.phase == PluginVpnPhase::Disabled ||
                (network.connectivity == crate::network::Connectivity::Online &&
                 runtime.network_revision == network.revision) {
                return Ok(state.status_from_runtime(&runtime));
            }
        }
        runtime.generation = runtime.generation.wrapping_add(1);
        if let Some(preserve_block) = preserve_block {
            runtime.connection_requested = preserve_block;
        }
        if !runtime.connection_requested {
            runtime.error = None;
        }
        if runtime.phase == PluginVpnPhase::Disabled {
            runtime.connecting_cancellation = None;
            state.set_disconnected_proxy(runtime.connection_requested);
            drop(runtime);
            return Ok(state.status());
        }
        let cancellation = if runtime.phase == PluginVpnPhase::Disconnecting {
            None
        } else {
            state
                .shared
                .proxy
                .block("The plugin VPN connection is stopping");
            runtime.phase = PluginVpnPhase::Disconnecting;
            runtime.connecting_cancellation.take()
        };
        (runtime.generation, cancellation)
    };
    #[cfg(any(target_os = "android", target_os = "windows"))]
    if let Some(cancellation) = cancellation {
        let _ = cancellation.send(true);
    }

    let _foreground = state.shared.foreground.lock().await;
    let _operation = state.shared.operation.lock().await;

    #[cfg(any(target_os = "android", target_os = "windows"))]
    let (control, completion) = {
        let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
        if runtime.generation != request_generation {
            return Ok(state.status_from_runtime(&runtime));
        }
        if runtime.phase == PluginVpnPhase::Disabled {
            state.set_disconnected_proxy(runtime.connection_requested);
            drop(runtime);
            return Ok(state.status());
        }
        (runtime.control.take(), runtime.session_completion.take())
    };

    #[cfg(any(target_os = "android", target_os = "windows"))]
    if let Some(control) = control {
        match tokio::time::timeout(DISCONNECT_TIMEOUT, control.stop()).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                log::warn!("plugin VPN stop failed: {error}");
                control.cancel();
            }
            Err(_) => {
                log::warn!("plugin VPN stop timed out");
                control.cancel();
            }
        }
    }

    #[cfg(any(target_os = "android", target_os = "windows"))]
    if let Some(mut completion) = completion {
        if tokio::time::timeout(DISCONNECT_TIMEOUT, &mut completion)
            .await
            .is_err()
        {
            let error =
                "OpenVPN session cleanup timed out; plugin traffic remains blocked".to_string();
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            if runtime.generation != request_generation {
                // The newer disconnect still has to wait for this session to end.
                runtime.session_completion = Some(completion);
                return Ok(state.status_from_runtime(&runtime));
            }
            state
                .shared
                .proxy
                .block("The plugin VPN connection is unavailable");
            runtime.phase = PluginVpnPhase::Error;
            runtime.error = Some(error.clone());
            runtime.session_completion = Some(completion);
            return Err(error);
        }
    }

    let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
    #[cfg(any(target_os = "android", target_os = "windows"))]
    if runtime.generation != request_generation {
        return Ok(state.status_from_runtime(&runtime));
    }
    runtime.phase = PluginVpnPhase::Disabled;
    if !runtime.connection_requested {
        runtime.error = None;
    }
    runtime.connecting_cancellation = None;
    #[cfg(any(target_os = "android", target_os = "windows"))]
    {
        runtime.control = None;
        runtime.session_completion = None;
        state.set_disconnected_proxy(runtime.connection_requested);
    }
    drop(runtime);
    Ok(state.status())
}

fn ensure_supported() -> Result<(), String> {
    if plugin_vpn_supported() {
        Ok(())
    } else {
        Err("plugin VPN is supported only on Windows and Android".to_string())
    }
}

async fn import_profile_bytes(
    state: &PluginVpnState,
    bytes: Vec<u8>,
    action: &str,
    retained: Option<SavedVpnProfileSelection>,
) -> Result<PluginVpnStatus, String> {
    state.require_disabled(action)?;
    validate_profile(&bytes)?;
    if retained.is_none() { state.prepare_manual_vault().await?; }
    let profile_path = state.profile_path()?;
    let profile = {
        let mut vault = state.saved_profiles()?.lock().await;
        publish_active_profile(&profile_path, &mut vault, Some(&bytes), retained)?
            .map(PluginVpnProfile::from).expect("published profile")
    };

    let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
    runtime.profile = Some(profile);
    runtime.error = None;
    drop(runtime);
    Ok(state.status())
}

impl From<ValidatedProfile> for PluginVpnProfile {
    fn from(profile: ValidatedProfile) -> Self {
        Self {
            hash: profile.hash,
            is_vpn_gate_finder: profile.is_vpn_gate_finder,
            remote_host: profile.remote_host,
            remote_hosts: profile.remote_hosts,
            requires_username_password: profile.requires_username_password,
        }
    }
}

fn foreground_profile_exclusion(
    profile: Option<&PluginVpnProfile>, phase: PluginVpnPhase, requested: bool, unsettled: bool,
) -> Option<ForegroundVpnProfile> {
    if !requested && !unsettled && !matches!(phase, PluginVpnPhase::Connecting | PluginVpnPhase::Connected | PluginVpnPhase::Reconnecting | PluginVpnPhase::Disconnecting) {
        return None;
    }
    profile.map(|profile| ForegroundVpnProfile { remote_hosts: profile.remote_hosts.clone(), hash: profile.hash.clone() })
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveProfileChange {
    version: u8,
    previous_hash: Option<String>,
    previous_selection: Option<SavedVpnProfileSelection>,
    next_hash: Option<String>,
    next_selection: Option<SavedVpnProfileSelection>,
    committed: bool,
}

fn active_change_directory(path: &Path) -> Result<PathBuf, String> {
    Ok(path.parent().ok_or_else(|| "OpenVPN profile directory is invalid".to_string())?.join(ACTIVE_CHANGE_DIRECTORY))
}

fn optional_profile_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => read_profile_source(path).map(Some),
        Ok(_) => Err("OpenVPN profile is not a regular file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not inspect the OpenVPN profile: {error}")),
    }
}

fn write_active_change(directory: &Path, change: &ActiveProfileChange) -> Result<(), String> {
    let bytes = serde_json::to_vec(change).map_err(|error| format!("could not encode OpenVPN profile publication: {error}"))?;
    super::saved_profiles::publish_private_file(&directory.join(ACTIVE_CHANGE_METADATA), &bytes)
}

fn clean_active_change(directory: &Path) -> Result<(), String> {
    for name in [PROFILE_FILE, PROFILE_PART_FILE, PROFILE_BACKUP_FILE, "selection.json.part", "selection.json.backup", ACTIVE_CHANGE_METADATA] {
        remove_file_if_exists(&directory.join(name))?;
    }
    match fs::remove_dir(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove the OpenVPN profile publication checkpoint: {error}")),
    }
}

fn prepare_active_profile_change(
    path: &Path, vault: &SavedProfileVault, bytes: Option<&[u8]>, next_selection: Option<SavedVpnProfileSelection>,
) -> Result<ActiveProfileChange, String> {
    let previous = optional_profile_bytes(path)?;
    let directory = active_change_directory(path)?;
    if let Some(previous) = &previous { store_profile(&directory.join(PROFILE_FILE), previous)?; }
    let change = ActiveProfileChange { version: 1, previous_hash: previous.as_deref().map(super::saved_profiles::profile_hash), previous_selection: vault.active_selection(), next_hash: bytes.map(super::saved_profiles::profile_hash), next_selection, committed: false };
    write_active_change(&directory, &change)?;
    sync_directory(directory.parent().expect("profile directory"))?;
    Ok(change)
}

fn recover_active_profile_change(path: &Path, vault: &mut SavedProfileVault) -> Result<(), String> {
    let directory = active_change_directory(path)?;
    let metadata = directory.join(ACTIVE_CHANGE_METADATA);
    let source = if metadata.try_exists().map_err(|error| error.to_string())? { metadata }
        else { directory.join("selection.json.backup") };
    let Some(bytes) = optional_profile_bytes(&source)? else {
        if directory.try_exists().map_err(|error| error.to_string())? { clean_active_change(&directory)?; }
        return Ok(());
    };
    if bytes.len() > 4096 { return Err("OpenVPN profile publication checkpoint is too large".to_string()); }
    let change: ActiveProfileChange = serde_json::from_slice(&bytes).map_err(|error| format!("could not read OpenVPN profile publication: {error}"))?;
    if change.version != 1 { return Err("OpenVPN profile publication version is unsupported".to_string()); }
    let current = optional_profile_bytes(path)?;
    let hash = current.as_deref().map(super::saved_profiles::profile_hash);
    if change.committed {
        let selection = vault.active_selection();
        if hash == change.next_hash && selection == change.next_selection {
            return clean_active_change(&directory);
        }
        if (hash != change.previous_hash && hash != change.next_hash) || (selection != change.previous_selection && selection != change.next_selection) {
            return Err("committed OpenVPN profile file and retained selection do not match".to_string());
        }
    }
    rollback_active_profile_change(path, vault, &change)?;
    clean_active_change(&directory)
}

fn rollback_active_profile_change(path: &Path, vault: &mut SavedProfileVault, change: &ActiveProfileChange) -> Result<(), String> {
        let directory = active_change_directory(path)?;
        let hash = optional_profile_bytes(path)?.as_deref().map(super::saved_profiles::profile_hash);
        if hash != change.previous_hash {
            if let Some(expected) = &change.previous_hash {
                let previous = read_profile_source(&directory.join(PROFILE_FILE))?;
                if super::saved_profiles::profile_hash(&previous) != *expected { return Err("previous OpenVPN profile checkpoint hash does not match".to_string()); }
                store_profile(path, &previous)?;
            } else { remove_stored_profile(path)?; }
        }
        if vault.active_selection() != change.previous_selection || vault.needs_recovery() {
            vault.restore_active_selection(change.previous_selection.clone())?;
        }
    Ok(())
}

fn publish_active_profile(
    path: &Path, vault: &mut SavedProfileVault, bytes: Option<&[u8]>, retained: Option<SavedVpnProfileSelection>,
) -> Result<Option<ValidatedProfile>, String> {
    recover_active_profile_change(path, vault)?;
    let validated = bytes.map(validate_profile).transpose()?;
    if let Some(profile) = &validated {
        for host in &profile.remote_hosts { vault.ensure_foreground_available(host, &profile.hash)?; }
    }
    if let Some(selection) = &retained {
        if !validated.as_ref().is_some_and(|profile| profile.is_vpn_gate_finder && profile.hash == selection.hash && selection.id == selection.hash) {
            return Err("retained OpenVPN selection does not match the active profile bytes".to_string());
        }
    }
    let mut change = prepare_active_profile_change(path, vault, bytes, retained.clone())?;
    let result = (|| {
        if vault.active_selection() != retained { vault.set_active(retained)?; }
        match bytes { Some(bytes) => store_profile(path, bytes)?, None => remove_stored_profile(path)? }
        change.committed = true;
        write_active_change(&active_change_directory(path)?, &change)
    })();
    if let Err(error) = result {
        change.committed = false;
        let _ = write_active_change(&active_change_directory(path)?, &change);
        if let Err(rollback) = rollback_active_profile_change(path, vault, &change).and_then(|()| clean_active_change(&active_change_directory(path)?)) {
            return Err(format!("{error}; previous profile recovery remains pending: {rollback}"));
        }
        return Err(error);
    }
    if let Err(error) = clean_active_change(&active_change_directory(path)?) {
        log::warn!("OpenVPN profile was committed but checkpoint cleanup failed: {error}");
    }
    Ok(validated)
}

fn read_profile_source(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("could not inspect the OpenVPN profile: {error}"))?;
    if !metadata.is_file() {
        return Err("OpenVPN profile is not a regular file".to_string());
    }
    if metadata.len() > MAX_PROFILE_BYTES as u64 {
        return Err(format!(
            "OpenVPN profile exceeds the {MAX_PROFILE_BYTES}-byte limit"
        ));
    }
    fs::read(path).map_err(|error| format!("could not read the OpenVPN profile: {error}"))
}

fn read_profile_for_connection(path: &Path) -> Result<String, String> {
    let bytes = read_profile_source(path)?;
    validate_profile(&bytes)?;
    String::from_utf8(bytes).map_err(|_| "OpenVPN profile must be UTF-8 text".to_string())
}

fn load_stored_profile(path: &Path) -> Result<Option<PluginVpnProfile>, String> {
    recover_profile_publication(path)?;
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not read the stored OpenVPN profile: {error}"
            ))
        }
    };
    validate_profile(&bytes)
        .map(PluginVpnProfile::from)
        .map(Some)
}

fn store_profile(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "OpenVPN profile directory is invalid".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("could not create the OpenVPN profile directory: {error}"))?;
    set_private_directory_permissions(directory)?;
    recover_profile_publication(path)?;

    let part = directory.join(PROFILE_PART_FILE);
    remove_file_if_exists(&part)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&part)
        .map_err(|error| format!("could not create the OpenVPN profile staging file: {error}"))?;
    set_private_file_permissions(&part)?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&part);
        return Err(format!("could not write the OpenVPN profile: {error}"));
    }
    drop(file);

    let backup = directory.join(PROFILE_BACKUP_FILE);
    remove_file_if_exists(&backup)?;
    let had_profile = match fs::rename(path, &backup) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = fs::remove_file(&part);
            return Err(format!(
                "could not stage the previous OpenVPN profile: {error}"
            ));
        }
    };
    if let Err(error) = fs::rename(&part, path) {
        if had_profile {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&part);
        return Err(format!("could not publish the OpenVPN profile: {error}"));
    }
    if had_profile {
        remove_file_if_exists(&backup)?;
    }
    sync_directory(directory)
}

fn recover_profile_publication(path: &Path) -> Result<(), String> {
    let Some(directory) = path.parent() else {
        return Err("OpenVPN profile directory is invalid".to_string());
    };
    let backup = directory.join(PROFILE_BACKUP_FILE);
    if path.exists() {
        remove_file_if_exists(&backup)?;
    } else if backup.exists() {
        fs::rename(&backup, path)
            .map_err(|error| format!("could not recover the OpenVPN profile: {error}"))?;
    }
    remove_file_if_exists(&directory.join(PROFILE_PART_FILE))
}

fn remove_stored_profile(path: &Path) -> Result<(), String> {
    let Some(directory) = path.parent() else {
        return Err("OpenVPN profile directory is invalid".to_string());
    };
    if !directory.exists() {
        return Ok(());
    }
    remove_file_if_exists(path)?;
    remove_file_if_exists(&directory.join(PROFILE_PART_FILE))?;
    remove_file_if_exists(&directory.join(PROFILE_BACKUP_FILE))?;
    sync_directory(directory)
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove an OpenVPN profile file: {error}")),
    }
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("could not secure the OpenVPN profile directory: {error}"))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("could not secure the OpenVPN profile: {error}"))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not sync the OpenVPN profile directory: {error}"))
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) struct DeviceBackupVpnGuard<'a> {
    state: &'a PluginVpnState,
    vault: tokio::sync::MutexGuard<'a, SavedProfileVault>,
    _operation: tokio::sync::MutexGuard<'a, ()>,
}

impl PluginVpnState {
    pub(crate) async fn lock_device_backup(&self) -> Result<DeviceBackupVpnGuard<'_>, String> {
        let operation = self.shared.operation.lock().await;
        let vault = self.saved_profiles()?.lock().await;
        let mut guard = DeviceBackupVpnGuard { state: self, vault, _operation: operation };
        let path = guard.profile_path()?;
        let checkpoint = active_change_directory(&path)?;
        match fs::symlink_metadata(&checkpoint) {
            Ok(metadata) if !metadata.is_dir() => return Err("VPN profile publication checkpoint is not a regular directory".into()),
            Ok(_) => recover_active_profile_change(&path, &mut guard.vault)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.to_string()),
        }
        Ok(guard)
    }

    pub(crate) async fn lock_device_backup_restore(&self, workers: &super::download_workers::DownloadVpnWorkers) -> Result<DeviceBackupVpnGuard<'_>, String> {
        workers.stop_all(self).await?;
        disconnect(self, Some(false)).await?;
        {
            let _operation = self.shared.operation.lock().await;
            self.require_disabled("restore a device backup")?;
            crate::device_backup::restore_checkpoint::require_complete(&self.profile_path()?)?;
            self.prepare_manual_vault().await?;
        }
        let guard = self.lock_device_backup().await?;
        self.require_disabled("restore a device backup")?;
        guard.vault.require_idle_device_backup_restore()?;
        Ok(guard)
    }
}

impl DeviceBackupVpnGuard<'_> {
    pub(crate) fn profile_path(&self) -> Result<PathBuf, String> {
        let path = self.state.profile_path()?;
        let root = path.parent().and_then(Path::parent).ok_or_else(|| "invalid managed VPN profile path".to_string())?;
        fs::create_dir_all(root).map_err(|error| error.to_string())?;
        Ok(root.canonicalize().map_err(|error| error.to_string())?.join(PROFILE_DIRECTORY).join(PROFILE_FILE))
    }

    pub(crate) async fn export_vault(
        &self, pool: &sqlx::SqlitePool, directory: &Path,
    ) -> Result<(Option<Vec<u8>>, super::saved_profiles::backup::VpnVaultBackupManifest), String> {
        let profile = super::saved_profiles::backup::read_backup_active_profile(&self.profile_path()?)?;
        let manifest = self.vault.export_device_backup(pool, profile.as_deref(), directory).await?;
        Ok((profile, manifest))
    }

    pub(crate) fn reload_published_files(&mut self) -> Result<(), String> {
        let path = self.profile_path()?;
        let bytes = super::saved_profiles::backup::read_backup_active_profile(&path)?;
        let profile = bytes.as_deref().map(validate_profile).transpose()?.map(PluginVpnProfile::from);
        let vault = SavedProfileVault::open(path.parent().expect("profile directory").join("saved-profiles"))?;
        *self.vault = vault;
        let mut runtime = self.state.shared.state.lock().expect("plugin VPN state lock");
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.connection_requested = false;
        runtime.connecting_cancellation = None;
        runtime.profile = profile;
        runtime.phase = PluginVpnPhase::Disabled;
        runtime.error = None;
        Ok(())
    }
}

#[cfg(test)]
mod active_profile_tests {
    use super::*;
    use super::super::saved_profiles::profile_hash;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    #[cfg(target_os = "android")]
    #[test]
    fn android_managed_profile_path_allows_the_platform_app_data_alias() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        fs::create_dir(&app_data).unwrap();
        let alias = directory.path().join("platform-alias");
        symlink(&app_data, &alias).unwrap();

        let profile = managed_profile_path(&alias).unwrap();
        crate::device_backup::restore_checkpoint::require_complete(&profile).unwrap();
        assert_eq!(profile, app_data.join("plugin-vpn/profile.ovpn"));
        assert!(!app_data.join("plugin-vpn").exists());
        assert!(fs::symlink_metadata(&alias).unwrap().file_type().is_symlink());
    }

    #[cfg(target_os = "android")]
    #[test]
    fn android_managed_profile_path_keeps_the_restore_acknowledgement_fence() {
        use std::os::unix::fs::symlink;
        use crate::device_backup::restore_checkpoint::{self, RestoreCheckpoint};
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        fs::create_dir(&app_data).unwrap();
        fs::write(app_data.join("original-content"), "preserve").unwrap();
        let alias = directory.path().join("platform-alias");
        symlink(&app_data, &alias).unwrap();

        let profile = managed_profile_path(&alias).unwrap();
        let mut checkpoint = RestoreCheckpoint::begin(&profile, None, Vec::new()).unwrap();
        let publication = app_data.join("plugin-vpn/.device-backup-1");
        fs::create_dir(&publication).unwrap();
        fs::write(publication.join("old-profile.ovpn"), "retained original").unwrap();
        let receipt = checkpoint.committed(".device-backup-1".into()).unwrap();
        assert!(restore_checkpoint::require_complete(&profile).unwrap_err().contains("unfinished device restore"));
        assert!(restore_checkpoint::complete(&profile, &"0".repeat(64)).is_err());
        assert_eq!(fs::read_to_string(publication.join("old-profile.ovpn")).unwrap(), "retained original");

        restore_checkpoint::complete(&profile, &receipt.id).unwrap();
        restore_checkpoint::require_complete(&profile).unwrap();
        assert!(!publication.exists());
        assert!(!app_data.join("plugin-vpn/.device-restore").exists());
        assert_eq!(fs::read_to_string(app_data.join("original-content")).unwrap(), "preserve");
    }

    #[cfg(target_os = "android")]
    #[test]
    fn android_managed_profile_path_still_rejects_a_linked_managed_directory() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let app_data = directory.path().join("app-data");
        let external = directory.path().join("external");
        fs::create_dir(&app_data).unwrap();
        fs::create_dir(&external).unwrap();
        fs::write(external.join("original"), "preserve").unwrap();
        let alias = directory.path().join("platform-alias");
        symlink(&app_data, &alias).unwrap();
        symlink(&external, app_data.join("plugin-vpn")).unwrap();

        let profile = managed_profile_path(&alias).unwrap();
        assert!(crate::device_backup::restore_checkpoint::require_complete(&profile).is_err());
        assert!(fs::symlink_metadata(app_data.join("plugin-vpn")).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(external.join("original")).unwrap(), "preserve");
    }

    fn profile(ip: &str) -> Vec<u8> {
        format!("client\ndev tun\nproto tcp\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n{}\nauth-user-pass\n", super::super::VPN_GATE_PROFILE_MARKER).into_bytes()
    }

    async fn fixture() -> (tempfile::TempDir, sqlx::SqlitePool, SavedProfileVault, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true)).await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict (ip TEXT PRIMARY KEY NOT NULL, verdict TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))").execute(&pool).await.unwrap();
        let vault = SavedProfileVault::open(directory.path().join("saved-profiles")).unwrap();
        let path = directory.path().join(PROFILE_FILE);
        (directory, pool, vault, path)
    }

    #[tokio::test]
    async fn failed_active_file_publication_rolls_back_the_previous_retained_selector() {
        let (_directory, pool, mut vault, path) = fixture().await;
        let a = profile("8.8.4.4");
        let b = profile("8.8.8.8");
        let saved_a = vault.capture(&pool, "8.8.4.4", &a).await.unwrap().saved_profile.unwrap();
        let saved_b = vault.capture(&pool, "8.8.8.8", &b).await.unwrap().saved_profile.unwrap();
        store_profile(&path, &a).unwrap();
        vault.set_active(Some(SavedVpnProfileSelection { id: saved_a.id, hash: saved_a.hash })).unwrap();
        let fault = path.parent().unwrap().join(PROFILE_PART_FILE);
        fs::create_dir(&fault).unwrap();
        assert!(publish_active_profile(&path, &mut vault, Some(&b), Some(SavedVpnProfileSelection { id: saved_b.id, hash: saved_b.hash })).is_err());
        assert_eq!(fs::read(&path).unwrap(), a);
        vault.validate_active(&pool, &a).await.unwrap();
        fs::remove_dir(fault).unwrap();
        let mut reopened = SavedProfileVault::open(path.parent().unwrap().join("saved-profiles")).unwrap();
        recover_active_profile_change(&path, &mut reopened).unwrap();
        reopened.validate_active(&pool, &a).await.unwrap();
    }

    #[tokio::test]
    async fn failed_manual_replacement_preserves_the_old_retained_file_and_selector() {
        let (_directory, pool, mut vault, path) = fixture().await;
        let a = profile("8.8.4.4");
        let saved = vault.capture(&pool, "8.8.4.4", &a).await.unwrap().saved_profile.unwrap();
        store_profile(&path, &a).unwrap();
        vault.set_active(Some(SavedVpnProfileSelection { id: saved.id, hash: saved.hash })).unwrap();
        fs::create_dir(path.parent().unwrap().join(PROFILE_PART_FILE)).unwrap();
        assert!(publish_active_profile(&path, &mut vault, Some(b"client\ndev tun\nremote 8.8.8.8 443\n"), None).is_err());
        assert_eq!(fs::read(&path).unwrap(), a);
        vault.validate_active(&pool, &a).await.unwrap();
    }

    #[tokio::test]
    async fn interrupted_active_change_recovers_the_last_committed_selection_and_file() {
        let (_directory, pool, mut vault, path) = fixture().await;
        let a = profile("8.8.4.4");
        let b = profile("8.8.8.8");
        let saved_a = vault.capture(&pool, "8.8.4.4", &a).await.unwrap().saved_profile.unwrap();
        let saved_b = vault.capture(&pool, "8.8.8.8", &b).await.unwrap().saved_profile.unwrap();
        store_profile(&path, &a).unwrap();
        vault.set_active(Some(SavedVpnProfileSelection { id: saved_a.id, hash: saved_a.hash })).unwrap();
        let next = Some(SavedVpnProfileSelection { id: saved_b.id, hash: saved_b.hash });
        prepare_active_profile_change(&path, &vault, Some(&b), next.clone()).unwrap();
        vault.set_active(next).unwrap();
        store_profile(&path, &b).unwrap();
        let mut reopened = SavedProfileVault::open(path.parent().unwrap().join("saved-profiles")).unwrap();
        recover_active_profile_change(&path, &mut reopened).unwrap();
        assert_eq!(fs::read(&path).unwrap(), a);
        reopened.validate_active(&pool, &a).await.unwrap();
    }

    #[tokio::test]
    async fn recovery_accepts_a_verified_previous_pair_after_an_interrupted_rollback() {
        let (_directory, pool, mut vault, path) = fixture().await;
        let a = profile("8.8.4.4");
        let b = profile("8.8.8.8");
        let saved_a = vault.capture(&pool, "8.8.4.4", &a).await.unwrap().saved_profile.unwrap();
        let saved_b = vault.capture(&pool, "8.8.8.8", &b).await.unwrap().saved_profile.unwrap();
        let previous = Some(SavedVpnProfileSelection { id: saved_a.id, hash: saved_a.hash });
        store_profile(&path, &a).unwrap();
        vault.set_active(previous.clone()).unwrap();
        let next = Some(SavedVpnProfileSelection { id: saved_b.id, hash: saved_b.hash });
        let mut change = prepare_active_profile_change(&path, &vault, Some(&b), next.clone()).unwrap();
        vault.set_active(next).unwrap();
        store_profile(&path, &b).unwrap();
        change.committed = true;
        write_active_change(&active_change_directory(&path).unwrap(), &change).unwrap();
        store_profile(&path, &a).unwrap();
        vault.restore_active_selection(previous).unwrap();
        recover_active_profile_change(&path, &mut vault).unwrap();
        vault.validate_active(&pool, &a).await.unwrap();
    }

    #[tokio::test]
    async fn disabled_foreground_configuration_is_leasable_but_live_or_requested_remotes_are_not() {
        let (_directory, pool, mut vault, _path) = fixture().await;
        let saved = vault.capture(&pool, "8.8.4.4", &profile("8.8.4.4")).await.unwrap().saved_profile.unwrap();
        let configured = PluginVpnProfile::from(validate_profile(b"client\ndev tun\nremote 8.8.8.8 443\n<connection>\nremote 8.8.4.4 443\n</connection>\n").unwrap());
        for (phase, requested, resources, available) in [(PluginVpnPhase::Disabled, false, false, true), (PluginVpnPhase::Disabled, true, false, false), (PluginVpnPhase::Connecting, false, false, false), (PluginVpnPhase::Connected, false, true, false), (PluginVpnPhase::Disconnecting, false, true, false), (PluginVpnPhase::WaitingForNetwork, true, false, false), (PluginVpnPhase::Error, false, true, false)] {
            let foreground = foreground_profile_exclusion(Some(&configured), phase, requested, resources);
            let reserved = vault.reserve(&pool, "worker-a", &saved.id, &saved.hash, foreground.as_ref()).await;
            assert_eq!(reserved.is_ok(), available, "{phase:?}, requested={requested}");
            if reserved.is_ok() { vault.release("worker-a").unwrap(); }
        }
        assert_eq!(configured.hash, profile_hash(b"client\ndev tun\nremote 8.8.8.8 443\n<connection>\nremote 8.8.4.4 443\n</connection>\n"));
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::VPN_GATE_PROFILE_MARKER;
    use super::super::saved_profiles::profile_hash;
    use super::*;
    use crate::plugin_vpn::proxy::{ConnectFuture, ProxyConnector, ProxyTarget};

    const PROFILE: &[u8] = b"client\ndev tun\nremote vpn.example.test 1194\n";

    pub(crate) async fn revoke_saved_profile_for_test(state: &PluginVpnState, pool: &sqlx::SqlitePool, ip: &str) {
        let _operation = state.shared.operation.lock().await;
        state.saved_profiles().unwrap().lock().await.revoke(pool, ip, None).await.unwrap();
    }

    pub(crate) fn backup_worker_test_state(path: PathBuf, vault: Result<SavedProfileVault, String>) -> PluginVpnState {
        let state = PluginVpnState::bind().unwrap();
        state.shared.profile_path.set(path).unwrap();
        assert!(state.shared.saved_profiles.set(vault.map(tokio::sync::Mutex::new)).is_ok());
        state
    }

    #[tokio::test]
    async fn manual_vault_quarantine_preserves_revoked_active_identity_on_both_recovery_paths() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        for failed_initialization in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
                SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true)
            ).await.unwrap();
            sqlx::query("CREATE TABLE vpn_gate_server_verdict(ip TEXT PRIMARY KEY,verdict TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT(unixepoch()))").execute(&pool).await.unwrap();
            let path = directory.path().join("plugin-vpn/profile.ovpn");
            let vault_path = path.parent().unwrap().join("saved-profiles");
            let bytes = format!("client\ndev tun\nproto tcp\nremote 8.8.4.4 443\n<ca>\ncertificate\n</ca>\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n").into_bytes();
            let mut vault = SavedProfileVault::open(vault_path.clone()).unwrap();
            let saved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
            let active = Some(SavedVpnProfileSelection { id: saved.id, hash: saved.hash });
            vault.set_active(active.clone()).unwrap();
            vault.revoke(&pool, "8.8.4.4", None).await.unwrap();
            fs::write(&path, &bytes).unwrap();
            let state = PluginVpnState::bind().unwrap();
            state.shared.profile_path.set(path.clone()).unwrap();
            state.shared.state.lock().unwrap().profile = Some(PluginVpnProfile::from(validate_profile(&bytes).unwrap()));
            if failed_initialization {
                fs::write(vault_path.join("index.json"), b"invalid index").unwrap();
                assert!(state.shared.saved_profiles.set(Err("invalid index".into())).is_ok());
            } else {
                fs::create_dir(vault_path.join("index.json.part")).unwrap();
                assert!(vault.set_limit(&pool, 1).await.is_err());
                assert!(state.shared.saved_profiles.set(Ok(tokio::sync::Mutex::new(vault))).is_ok());
            }
            state.prepare_manual_vault().await.unwrap();
            assert_eq!(state.saved_profiles().unwrap().lock().await.active_selection(), active);
            drop(state);
            let mut restarted = SavedProfileVault::open(vault_path).unwrap();
            assert_eq!(restarted.active_selection(), active);
            assert!(restarted.snapshot(&pool).await.unwrap().profiles.is_empty());
            assert!(restarted.validate_active(&pool, &bytes).await.is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn device_backup_guard_serializes_export_and_refuses_unsettled_worker_leases() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true)
        ).await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict(ip TEXT PRIMARY KEY,verdict TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT(unixepoch()))").execute(&pool).await.unwrap();
        let path = directory.path().join("plugin-vpn/profile.ovpn");
        let bytes = format!("client\ndev tun\nproto tcp-client\nremote 8.8.4.4 443\n<ca>\ncertificate\n</ca>\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n").into_bytes();
        let mut vault = SavedProfileVault::open(directory.path().join("plugin-vpn/saved-profiles")).unwrap();
        let saved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
        vault.reserve(&pool, "live-worker", &saved.id, &saved.hash, None).await.unwrap();
        fs::write(&path, &bytes).unwrap();
        prepare_active_profile_change(&path, &vault, Some(PROFILE), None).unwrap();
        store_profile(&path, PROFILE).unwrap();
        let state = PluginVpnState::bind().unwrap();
        state.shared.profile_path.set(path.clone()).unwrap();
        assert!(state.shared.saved_profiles.set(Ok(tokio::sync::Mutex::new(vault))).is_ok());
        let guard = state.lock_device_backup().await.unwrap();
        let (profile, manifest) = guard.export_vault(&pool, &directory.path().join("export")).await.unwrap();
        assert_eq!(profile.unwrap(), bytes);
        assert_eq!(manifest.profiles.len(), 1);
        assert!(state.shared.operation.try_lock().is_err());
        drop(guard);
        let workers = super::super::download_workers::DownloadVpnWorkers::bind().unwrap();
        assert!(state.lock_device_backup_restore(&workers).await.is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        state.release_saved_profile("live-worker").await.unwrap();
        let mut guard = state.lock_device_backup_restore(&workers).await.unwrap();
        guard.reload_published_files().unwrap();
        assert_eq!(state.status().phase, PluginVpnPhase::Disabled);
    }

    #[tokio::test]
    async fn worker_lease_reads_and_revocation_do_not_wait_for_a_connecting_handshake() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true)
        ).await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict (ip TEXT PRIMARY KEY NOT NULL, verdict TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))").execute(&pool).await.unwrap();
        let bytes = format!("client\ndev tun\nproto tcp\nremote 8.8.4.4 443\n<ca>\ncertificate\n</ca>\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n").into_bytes();
        let mut vault = SavedProfileVault::open(directory.path().join("profiles")).unwrap();
        let saved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
        let state = PluginVpnState::bind().unwrap();
        assert!(state.shared.saved_profiles.set(Ok(tokio::sync::Mutex::new(vault))).is_ok());
        let (cancellation, _cancelled) = tokio::sync::watch::channel(false);
        {
            let mut runtime = state.shared.state.lock().unwrap();
            runtime.profile = Some(PluginVpnProfile::from(validate_profile(&bytes).unwrap()));
            runtime.phase = PluginVpnPhase::Connecting;
            runtime.connection_requested = true;
            runtime.connecting_cancellation = Some(cancellation);
        }
        // A foreground handshake holds only the foreground lock; its Connecting phase still excludes its profile.
        let foreground = state.shared.foreground.lock().await;
        let refused = tokio::time::timeout(std::time::Duration::from_millis(500), state.reserve_saved_profile(&pool, "occupied", &saved.id, &saved.hash)).await
            .expect("worker reservation waited for the foreground handshake");
        assert!(refused.unwrap_err().contains("current foreground profile"));
        drop(foreground);
        {
            let mut runtime = state.shared.state.lock().unwrap();
            runtime.phase = PluginVpnPhase::Disabled;
            runtime.connection_requested = false;
            runtime.connecting_cancellation = None;
        }
        let lease = state.reserve_saved_profile(&pool, "worker-a", &saved.id, &saved.hash).await.unwrap();
        assert_eq!(lease.owner, "worker-a");
        let (read, read_bytes) = state.read_saved_profile_lease(&pool, "worker-a").await.unwrap();
        assert_eq!(read_bytes, bytes);
        assert_eq!(read.profile.hash, saved.hash);
        // The worker handshake runs after the read returns, without the operation lock.
        assert!(state.shared.operation.try_lock().is_ok());
        let revoke = {
            let state = state.clone();
            let pool = pool.clone();
            tokio::spawn(async move {
                let _operation = state.shared.operation.lock().await;
                state.saved_profiles().unwrap().lock().await.revoke(&pool, "8.8.4.4", None).await.unwrap();
            })
        };
        tokio::time::timeout(std::time::Duration::from_millis(500), revoke).await.expect("revocation waited for a worker handshake").unwrap();
        assert!(lease.is_revoked());
        assert!(state.saved_profile_lease(&pool, "worker-a").await.unwrap().unwrap().revoked);
        assert!(state.read_saved_profile_lease(&pool, "worker-a").await.is_err());
        state.release_saved_profile("worker-a").await.unwrap();
        assert!(state.saved_profile_lease(&pool, "worker-a").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn releasing_a_failed_foreground_profile_lets_workers_lease_it_while_plugin_traffic_stays_blocked() {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true)
        ).await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict (ip TEXT PRIMARY KEY NOT NULL, verdict TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()))").execute(&pool).await.unwrap();
        let bytes = format!("client\ndev tun\nproto tcp\nremote 8.8.4.4 443\n<ca>\ncertificate\n</ca>\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n").into_bytes();
        let mut vault = SavedProfileVault::open(directory.path().join("profiles")).unwrap();
        let saved = vault.capture(&pool, "8.8.4.4", &bytes).await.unwrap().saved_profile.unwrap();
        let state = PluginVpnState::bind().unwrap();
        assert!(state.shared.saved_profiles.set(Ok(tokio::sync::Mutex::new(vault))).is_ok());
        state.shared.state.lock().unwrap().profile = Some(PluginVpnProfile::from(validate_profile(&bytes).unwrap()));
        let (generation, _cancellation) = state.begin_connection(0).unwrap();
        state.set_connection_error(generation, "OpenVPN connection failed (CONNECTION_TIMEOUT)".to_string());
        assert!(state.reserve_saved_profile(&pool, "worker", &saved.id, &saved.hash).await.is_err());

        let status = release_profile(&state).await.unwrap();
        assert_eq!(status.phase, PluginVpnPhase::Disabled);
        assert!(!state.shared.state.lock().unwrap().connection_requested);
        let destination = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = destination.local_addr().unwrap();
        let mut client = tokio::net::TcpStream::connect(state.shared.proxy.address()).await.unwrap();
        client.write_all(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = [0u8; 256];
        let size = tokio::time::timeout(std::time::Duration::from_secs(3), client.read(&mut response)).await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 502"));
        let lease = state.reserve_saved_profile(&pool, "worker", &saved.id, &saved.hash).await.unwrap();
        assert_eq!(lease.owner, "worker");

        state.release_saved_profile("worker").await.unwrap();
        disconnect(&state, Some(true)).await.unwrap();
        assert!(state.reserve_saved_profile(&pool, "worker", &saved.id, &saved.hash).await.is_err());
        disconnect(&state, Some(false)).await.unwrap();
        assert!(!state.shared.state.lock().unwrap().connection_requested);
    }

    #[test]
    fn exports_original_profile_bytes_and_preserves_finder_classification() {
        let directory = tempfile::tempdir().expect("temporary profile directory");
        let path = directory.path().join(PROFILE_FILE);
        let state = PluginVpnState::bind().expect("plugin VPN state");
        state.shared.profile_path.set(path.clone()).expect("profile path");
        assert_eq!(state.export_backup_profile().expect("empty backup"), None);
        let profile = format!(
            "client\ndev tun\nremote 203.0.113.10 443\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n"
        ).into_bytes();
        store_profile(&path, &profile).expect("store Finder profile");
        let exported = state.export_backup_profile().expect("export profile").expect("profile bytes");
        assert_eq!(exported, profile);
        assert!(validate_profile(&exported).expect("validated profile").is_vpn_gate_finder);
        let operation = state.shared.operation.try_lock().expect("operation lock");
        assert!(state.export_backup_profile().is_err());
        drop(operation);
        fs::write(&path, b"client\nup run.sh\n").expect("invalid stored profile");
        assert!(state.export_backup_profile().is_err());
    }

    #[cfg(any(target_os = "android", target_os = "windows"))]
    #[test]
    fn explicit_off_clears_an_error_after_failed_connection_cleanup() {
        tauri::async_runtime::block_on(async {
            let state = PluginVpnState::bind().expect("plugin VPN state");
            {
                let mut runtime = state.shared.state.lock().expect("VPN state");
                runtime.phase = PluginVpnPhase::Disabled;
                runtime.connection_requested = true;
                runtime.error = Some("AUTH_FAILED".to_string());
            }
            let waiting = disconnect(&state, None).await.expect("network suspension");
            assert_eq!(waiting.error.as_deref(), Some("AUTH_FAILED"));
            assert!(state.shared.state.lock().expect("VPN state").connection_requested);
            let off = disconnect(&state, Some(false)).await.expect("explicit off");
            assert_eq!(off.phase, PluginVpnPhase::Disabled);
            assert_eq!(off.error, None);
            assert!(!state.shared.state.lock().expect("VPN state").connection_requested);
        });
    }

    struct RejectingConnector;

    impl ProxyConnector for RejectingConnector {
        fn connect<'a>(&'a self, _: &'a ProxyTarget) -> ConnectFuture<'a> {
            Box::pin(async { Err("not used by this test".to_string()) })
        }
    }

    #[test]
    fn failed_connection_remains_blocked_with_an_error() {
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.profile = Some(PluginVpnProfile {
                hash: profile_hash(PROFILE),
                is_vpn_gate_finder: false,
                remote_host: "vpn.example.test".to_string(),
                remote_hosts: vec!["vpn.example.test".to_string()],
                requires_username_password: false,
            });
        }
        let (generation, _cancellation) = state.begin_connection(0).expect("begin connection");

        state.set_connection_error(generation, "missing credentials".to_string());

        let status = state.status();
        assert_eq!(status.phase, PluginVpnPhase::Error);
        assert_eq!(status.error.as_deref(), Some("missing credentials"));
        assert_eq!(
            status.profile.as_ref().map(|profile| profile.remote_host.as_str()),
            Some("vpn.example.test")
        );
        let runtime = state.shared.state.lock().expect("plugin VPN state lock");
        assert!(runtime.connecting_cancellation.is_none());
    }

    #[test]
    fn failed_connection_proxy_rejects_traffic_until_explicit_off() {
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::time::Duration;

        let destination = TcpListener::bind("127.0.0.1:0").expect("destination listener");
        destination.set_nonblocking(true).expect("nonblocking destination");
        let target = destination.local_addr().expect("destination address");
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.profile = Some(PluginVpnProfile {
                hash: profile_hash(PROFILE),
                is_vpn_gate_finder: false,
                remote_host: "vpn.example.test".to_string(),
                remote_hosts: vec!["vpn.example.test".to_string()],
                requires_username_password: false,
            });
        }
        let (generation, _cancellation) = state.begin_connection(0).expect("begin connection");
        state.set_connection_error(generation, "authentication failed".to_string());

        let request = || {
            let mut client = TcpStream::connect(state.shared.proxy.address()).expect("proxy client");
            client.set_read_timeout(Some(Duration::from_secs(3))).expect("read timeout");
            write!(client, "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n")
                .expect("send proxy request");
            let mut response = [0u8; 256];
            let size = client.read(&mut response).expect("read proxy response");
            String::from_utf8_lossy(&response[..size]).into_owned()
        };
        assert!(request().starts_with("HTTP/1.1 502"));
        assert_eq!(destination.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        state.set_disconnected_proxy(true);
        assert!(request().starts_with("HTTP/1.1 502"));
        assert_eq!(destination.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
        state.set_disconnected_proxy(false);
        assert!(request().starts_with("HTTP/1.1 200"));
        assert!(destination.accept().is_ok());
    }

    #[test]
    fn a_pending_connect_keeps_an_older_teardown_from_enabling_direct_routing() {
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.generation = 3;
            runtime.phase = PluginVpnPhase::Disconnecting;
            runtime.connection_requested = false;
        }
        assert_eq!(state.request_connection(), 3);
        let runtime = state.shared.state.lock().expect("plugin VPN state lock");
        assert!(runtime.connection_requested);
        // Teardown publishes the latest native intent, not its stale Off argument.
        state.set_disconnected_proxy(runtime.connection_requested);
        assert_eq!(runtime.phase, PluginVpnPhase::Disconnecting);
    }

    #[test]
    fn stale_connection_failure_does_not_override_newer_state() {
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.profile = Some(PluginVpnProfile {
                hash: profile_hash(PROFILE),
                is_vpn_gate_finder: false,
                remote_host: "vpn.example.test".to_string(),
                remote_hosts: vec!["vpn.example.test".to_string()],
                requires_username_password: false,
            });
        }
        let (generation, _cancellation) = state.begin_connection(0).expect("begin connection");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.error = None;
        }

        state.set_connection_error(generation, "stale failure".to_string());

        let status = state.status();
        assert_eq!(status.phase, PluginVpnPhase::Connecting);
        assert_eq!(status.error, None);
    }

    #[test]
    fn recoverable_tunnel_loss_transitions_through_reconnecting() {
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.generation = 7;
            runtime.phase = PluginVpnPhase::Connected;
        }

        let reconnecting = state
            .set_tunnel_reconnecting(
                7,
                Some("OpenVPN transport is reconnecting".to_string()),
            )
            .expect("reconnecting status");
        assert_eq!(reconnecting.phase, PluginVpnPhase::Reconnecting);
        assert_eq!(
            reconnecting.error.as_deref(),
            Some("OpenVPN transport is reconnecting")
        );

        let reconnected = state
            .set_tunnel_reconnected(7, Arc::new(RejectingConnector))
            .expect("reconnected status");
        assert_eq!(reconnected.phase, PluginVpnPhase::Connected);
        assert_eq!(reconnected.error, None);
    }

    #[test]
    fn stale_tunnel_generation_does_not_reconnect() {
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.generation = 8;
            runtime.phase = PluginVpnPhase::Reconnecting;
        }

        assert!(state.set_tunnel_reconnecting(7, None).is_none());
        assert!(
            state
                .set_tunnel_reconnected(7, Arc::new(RejectingConnector))
                .is_none()
        );
        assert_eq!(state.status().phase, PluginVpnPhase::Reconnecting);
    }

    #[test]
    fn disconnecting_tunnel_does_not_reconnect() {
        let state = PluginVpnState::bind().expect("plugin VPN state");
        {
            let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
            runtime.generation = 7;
            runtime.phase = PluginVpnPhase::Disconnecting;
        }

        assert!(state.set_tunnel_reconnecting(7, None).is_none());
        assert!(
            state
                .set_tunnel_reconnected(7, Arc::new(RejectingConnector))
                .is_none()
        );
        assert_eq!(state.status().phase, PluginVpnPhase::Disconnecting);
    }

    #[test]
    fn stores_replaces_and_removes_a_profile() {
        let directory = tempfile::tempdir().expect("temporary profile directory");
        let path = directory.path().join(PROFILE_FILE);

        store_profile(&path, PROFILE).expect("store profile");
        assert_eq!(fs::read(&path).expect("read stored profile"), PROFILE);

        let replacement = b"client\ndev tun\nremote replacement.example.test 443\n";
        store_profile(&path, replacement).expect("replace profile");
        assert_eq!(
            fs::read(&path).expect("read replacement profile"),
            replacement
        );

        remove_stored_profile(&path).expect("remove profile");
        assert!(!path.exists());
    }

    #[test]
    fn recovers_a_staged_previous_profile() {
        let directory = tempfile::tempdir().expect("temporary profile directory");
        let path = directory.path().join(PROFILE_FILE);
        let backup = directory.path().join(PROFILE_BACKUP_FILE);
        fs::write(&backup, PROFILE).expect("write backup");

        let loaded = load_stored_profile(&path)
            .expect("recover profile")
            .expect("loaded profile");

        assert_eq!(loaded.remote_host, "vpn.example.test");
        assert_eq!(fs::read(path).expect("read recovered profile"), PROFILE);
    }

    #[test]
    fn restores_vpn_gate_finder_profile_classification() {
        let directory = tempfile::tempdir().expect("temporary profile directory");
        let path = directory.path().join(PROFILE_FILE);
        let profile = format!(
            "client\ndev tun\nremote 203.0.113.10 443\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n"
        );
        fs::write(&path, profile).expect("write Finder profile");

        let loaded = load_stored_profile(&path)
            .expect("load Finder profile")
            .expect("stored Finder profile");

        assert!(loaded.is_vpn_gate_finder);
        assert!(loaded.requires_username_password);
    }

    #[test]
    fn resolves_public_credentials_only_for_vpn_gate_finder_profiles() {
        let finder_profile = format!(
            "client\ndev tun\nremote 203.0.113.10 443\n{VPN_GATE_PROFILE_MARKER}\nauth-user-pass\n"
        );
        let external_profile = "client\ndev tun\nremote vpn.example.test 1194\nauth-user-pass\n";
        let credentials = || PluginVpnCredentials {
            challenge_response: "challenge".to_string(),
            password: "password".to_string(),
            private_key_password: "key-password".to_string(),
            username: "reader".to_string(),
        };

        let finder = credentials().resolve_for_profile(&finder_profile);
        assert_eq!(finder.username, "vpn");
        assert_eq!(finder.password, "vpn");
        assert_eq!(finder.private_key_password, "key-password");
        assert_eq!(finder.challenge_response, "challenge");

        let external = credentials().resolve_for_profile(external_profile);
        assert_eq!(external.username, "reader");
        assert_eq!(external.password, "password");
        assert_eq!(external.private_key_password, "key-password");
        assert_eq!(external.challenge_response, "challenge");
    }
}
