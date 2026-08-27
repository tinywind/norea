#[cfg(any(target_os = "android", target_os = "windows"))]
use std::time::Duration;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[cfg(any(target_os = "android", target_os = "windows", test))]
use super::proxy::LocalProxy;
use super::{validate_profile, ValidatedProfile, MAX_PROFILE_BYTES};

const PROFILE_DIRECTORY: &str = "plugin-vpn";
const PROFILE_FILE: &str = "profile.ovpn";
const PROFILE_PART_FILE: &str = "profile.ovpn.part";
const PROFILE_BACKUP_FILE: &str = "profile.ovpn.backup";
#[cfg(any(target_os = "android", target_os = "windows"))]
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub(crate) struct PluginVpnState {
    shared: Arc<PluginVpnShared>,
}

struct PluginVpnShared {
    #[cfg(any(target_os = "android", target_os = "windows", test))]
    proxy: LocalProxy,
    profile_path: OnceLock<PathBuf>,
    operation: tokio::sync::Mutex<()>,
    state: Mutex<PluginVpnRuntime>,
}

struct PluginVpnRuntime {
    generation: u64,
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
    Disconnecting,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginVpnProfile {
    remote_host: String,
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

impl PluginVpnState {
    pub(crate) fn bind() -> Result<Self, String> {
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        let proxy = LocalProxy::bind()?;
        let state = Self {
            shared: Arc::new(PluginVpnShared {
                #[cfg(any(target_os = "android", target_os = "windows", test))]
                proxy,
                profile_path: OnceLock::new(),
                operation: tokio::sync::Mutex::new(()),
                state: Mutex::new(PluginVpnRuntime {
                    generation: 0,
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
        let profile_path = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("could not resolve the app data directory: {error}"))?
            .join(PROFILE_DIRECTORY)
            .join(PROFILE_FILE);
        self.shared
            .profile_path
            .set(profile_path.clone())
            .map_err(|_| "plugin VPN state is already initialized".to_string())?;

        let loaded = load_stored_profile(&profile_path);
        let mut state = self.shared.state.lock().expect("plugin VPN state lock");
        match loaded {
            Ok(profile) => state.profile = profile,
            Err(error) => state.error = Some(error),
        }
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

    fn status(&self) -> PluginVpnStatus {
        let state = self.shared.state.lock().expect("plugin VPN state lock");
        PluginVpnStatus {
            supported: plugin_vpn_supported(),
            proxy_port: self.proxy_port(),
            phase: state.phase,
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
        state.generation = state.generation.wrapping_add(1);
        #[cfg(any(target_os = "android", target_os = "windows", test))]
        self.shared
            .proxy
            .block("The plugin VPN connection is starting");
        state.phase = PluginVpnPhase::Connecting;
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
        self.shared
            .proxy
            .block("The plugin VPN connection is unavailable");
        state.phase = PluginVpnPhase::Error;
        state.error = Some(error);
        state.connecting_cancellation = None;
        #[cfg(any(target_os = "android", target_os = "windows"))]
        {
            state.control = None;
            state.session_completion = None;
        }
    }
}

fn plugin_vpn_supported() -> bool {
    cfg!(any(target_os = "android", target_os = "windows"))
}

#[tauri::command]
pub(crate) fn plugin_vpn_status(state: State<'_, PluginVpnState>) -> PluginVpnStatus {
    state.status()
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
    let profile = PluginVpnProfile::from(validate_profile(&bytes)?);
    let profile_path = state.profile_path()?;
    tauri::async_runtime::spawn_blocking(move || store_profile(&profile_path, &bytes))
        .await
        .map_err(|error| format!("could not save the OpenVPN profile: {error}"))??;

    let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
    runtime.profile = Some(profile);
    runtime.error = None;
    drop(runtime);
    Ok(state.status())
}

#[tauri::command]
pub(crate) async fn plugin_vpn_remove_profile(
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    let _operation = state.shared.operation.lock().await;
    state.require_disabled("remove the profile")?;
    let profile_path = state.profile_path()?;
    tauri::async_runtime::spawn_blocking(move || remove_stored_profile(&profile_path))
        .await
        .map_err(|error| format!("could not remove the OpenVPN profile: {error}"))??;

    let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
    runtime.profile = None;
    runtime.error = None;
    drop(runtime);
    Ok(state.status())
}

#[tauri::command]
pub(crate) async fn plugin_vpn_connect(
    credentials: PluginVpnCredentials,
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;
    let request_generation = state
        .shared
        .state
        .lock()
        .expect("plugin VPN state lock")
        .generation;
    let _operation = state.shared.operation.lock().await;
    let profile_path = state.profile_path()?;
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
        let runtime = state.shared.state.lock().expect("plugin VPN state lock");
        if runtime.generation != generation || runtime.phase != PluginVpnPhase::Connecting {
            return Err("plugin VPN connection was superseded".to_string());
        }
    }

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
    let _ = (credentials, profile, cancellation);

    #[cfg(any(target_os = "android", target_os = "windows"))]
    {
        let super::engine::EngineConnection {
            connector,
            control,
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
                state.shared.proxy.tunnel(connector);
                true
            }
        };
        if !committed {
            control.cancel();
            let _ = completion.await;
            return Err("plugin VPN connection was superseded".to_string());
        }

        let shared = state.shared.clone();
        tauri::async_runtime::spawn(async move {
            let error = match completion.await {
                Ok(()) => "OpenVPN disconnected unexpectedly".to_string(),
                Err(error) => error,
            };
            let _ = completion_sender.send(());
            let mut runtime = shared.state.lock().expect("plugin VPN state lock");
            if runtime.generation == generation {
                shared
                    .proxy
                    .block("The plugin VPN connection is unavailable");
                runtime.phase = PluginVpnPhase::Error;
                runtime.error = Some(error);
                runtime.connecting_cancellation = None;
                runtime.control = None;
            }
        });
    }

    Ok(state.status())
}

#[tauri::command]
pub(crate) async fn plugin_vpn_disconnect(
    state: State<'_, PluginVpnState>,
) -> Result<PluginVpnStatus, String> {
    ensure_supported()?;

    #[cfg(any(target_os = "android", target_os = "windows"))]
    let cancellation = {
        let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
        runtime.generation = runtime.generation.wrapping_add(1);
        if runtime.phase == PluginVpnPhase::Disabled {
            runtime.connecting_cancellation = None;
            state.shared.proxy.direct();
            drop(runtime);
            return Ok(state.status());
        }
        if runtime.phase == PluginVpnPhase::Disconnecting {
            None
        } else {
            state
                .shared
                .proxy
                .block("The plugin VPN connection is stopping");
            runtime.phase = PluginVpnPhase::Disconnecting;
            runtime.connecting_cancellation.take()
        }
    };
    #[cfg(any(target_os = "android", target_os = "windows"))]
    if let Some(cancellation) = cancellation {
        let _ = cancellation.send(true);
    }

    let _operation = state.shared.operation.lock().await;

    #[cfg(any(target_os = "android", target_os = "windows"))]
    let (control, completion) = {
        let mut runtime = state.shared.state.lock().expect("plugin VPN state lock");
        if runtime.phase == PluginVpnPhase::Disabled {
            state.shared.proxy.direct();
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
    runtime.phase = PluginVpnPhase::Disabled;
    runtime.error = None;
    runtime.connecting_cancellation = None;
    #[cfg(any(target_os = "android", target_os = "windows"))]
    {
        runtime.control = None;
        runtime.session_completion = None;
        state.shared.proxy.direct();
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

impl From<ValidatedProfile> for PluginVpnProfile {
    fn from(profile: ValidatedProfile) -> Self {
        Self {
            remote_host: profile.remote_host,
            requires_username_password: profile.requires_username_password,
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILE: &[u8] = b"client\ndev tun\nremote vpn.example.test 1194\n";

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
}
