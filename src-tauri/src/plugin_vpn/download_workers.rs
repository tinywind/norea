use std::{future::Future, pin::Pin, sync::{Arc, Mutex}, time::Duration};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use super::{proxy::{LocalProxy, ProxyConnector}, saved_profiles::{SavedVpnProfile, SavedVpnProfileLease}, state::{PluginVpnPhase, PluginVpnState}};

const MAX_SAFE_GENERATION: u64 = 9_007_199_254_740_991;
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
type WorkerStopFuture<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

trait WorkerEngineControl: Send + Sync {
    fn stop(&self) -> WorkerStopFuture<'_>;
    fn cancel(&self);
}

#[cfg(any(target_os = "android", target_os = "windows"))]
impl WorkerEngineControl for super::engine::EngineControl {
    fn stop(&self) -> WorkerStopFuture<'_> { Box::pin(self.stop()) }
    fn cancel(&self) { self.cancel(); }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadVpnWorkerRef {
    range_id: String,
    slot: u8,
    generation: u64,
}

impl DownloadVpnWorkerRef {
    fn validate(&self) -> Result<(), String> {
        if self.slot > 1 || self.generation == 0 || self.generation > MAX_SAFE_GENERATION ||
            self.range_id.is_empty() || self.range_id.len() > 80 ||
            !self.range_id.bytes().all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_')) {
            return Err("VPN download worker identity is invalid".into());
        }
        Ok(())
    }
    fn lease_owner(&self) -> String { format!("download:{}:{}:{}", self.slot, self.generation, self.range_id) }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadVpnWorkerStatus {
    supported: bool,
    worker: DownloadVpnWorkerRef,
    phase: PluginVpnPhase,
    proxy_port: u16,
    profile: Option<SavedVpnProfile>,
    error: Option<String>,
}

#[derive(Clone)]
struct WorkerSession {
    worker: DownloadVpnWorkerRef,
    control: Arc<dyn WorkerEngineControl>,
    completion: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
    published: bool,
}

#[derive(Clone)]
struct WorkerResources {
    lease: SavedVpnProfileLease,
    session: Option<WorkerSession>,
}

struct WorkerRuntime {
    high_water: u64,
    failure_code: Option<&'static str>,
    current: Option<DownloadVpnWorkerRef>,
    requested: bool,
    cancellation: Option<tokio::sync::watch::Sender<bool>>,
    network_revision: u64,
    phase: PluginVpnPhase,
    stopped_phase: PluginVpnPhase,
    error: Option<String>,
    resources: Option<WorkerResources>,
}

struct DownloadWorkerSlot {
    proxy: LocalProxy,
    operation: tokio::sync::Mutex<()>,
    runtime: Mutex<WorkerRuntime>,
}

impl DownloadWorkerSlot {
    fn bind() -> Result<Arc<Self>, String> {
        let proxy = LocalProxy::bind()?;
        proxy.block("The VPN download worker is not connected");
        proxy.start()?;
        Ok(Arc::new(Self { proxy, operation: tokio::sync::Mutex::new(()), runtime: Mutex::new(WorkerRuntime {
            high_water: 0, failure_code: None, current: None, requested: false, cancellation: None, network_revision: 0,
            phase: PluginVpnPhase::Disabled, stopped_phase: PluginVpnPhase::Disabled, error: None, resources: None,
        }) }))
    }

    fn invalidate(&self, runtime: &mut WorkerRuntime) {
        self.proxy.block("The VPN download worker route is blocked");
        runtime.requested = false;
        if let Some(cancellation) = runtime.cancellation.take() { cancellation.send_replace(true); }
        if let Some(session) = runtime.resources.as_ref().and_then(|resources| resources.session.as_ref()) { session.control.cancel(); }
    }

    fn request_connect(&self, worker: &DownloadVpnWorkerRef, revision: u64) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        worker.validate()?;
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if worker.generation <= runtime.high_water { return Err("VPN download worker generation is stale".into()); }
        self.invalidate(&mut runtime);
        let (sender, receiver) = tokio::sync::watch::channel(false);
        runtime.high_water = worker.generation;
        runtime.current = Some(worker.clone());
        runtime.requested = true;
        runtime.cancellation = Some(sender);
        runtime.network_revision = revision;
        runtime.phase = PluginVpnPhase::Connecting;
        runtime.error = None;
        runtime.failure_code = None;
        Ok(receiver)
    }

    fn is_requested(&self, worker: &DownloadVpnWorkerRef) -> bool {
        let runtime = self.runtime.lock().expect("VPN worker lock");
        runtime.requested && runtime.current.as_ref() == Some(worker)
    }

    fn install_lease(&self, worker: &DownloadVpnWorkerRef, lease: SavedVpnProfileLease) -> Result<bool, String> {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if !runtime.requested || runtime.current.as_ref() != Some(worker) { return Ok(false); }
        if runtime.resources.is_some() { return Err("The previous VPN worker lease has not settled".into()); }
        runtime.resources = Some(WorkerResources { lease, session: None });
        Ok(true)
    }

    fn resources(&self) -> Option<WorkerResources> { self.runtime.lock().expect("VPN worker lock").resources.clone() }

    fn register_session(&self, worker: &DownloadVpnWorkerRef, control: Arc<dyn WorkerEngineControl>, completion: tokio::sync::watch::Receiver<Option<Result<(), String>>>) -> bool {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if !runtime.resources.as_ref().is_some_and(|resources| resources.lease.owner == worker.lease_owner()) {
            control.cancel(); return false;
        }
        let current = runtime.requested && runtime.current.as_ref() == Some(worker);
        runtime.resources.as_mut().expect("worker lease").session = Some(WorkerSession { worker: worker.clone(), control, completion, published: false });
        if !current { runtime.resources.as_ref().expect("worker lease").session.as_ref().expect("worker session").control.cancel(); }
        current
    }

    fn publish(&self, worker: &DownloadVpnWorkerRef, connector: Arc<dyn ProxyConnector>, revision: u64, online: bool) -> bool {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if !online || !runtime.requested || runtime.current.as_ref() != Some(worker) || runtime.network_revision != revision ||
            !runtime.resources.as_ref().is_some_and(|resources| !resources.lease.is_revoked() && resources.lease.owner == worker.lease_owner() && resources.session.is_some()) { return false; }
        runtime.phase = PluginVpnPhase::Connected;
        runtime.error = None;
        runtime.resources.as_mut().expect("worker lease").session.as_mut().expect("worker session").published = true;
        self.proxy.tunnel(connector);
        true
    }

    fn reconnecting(&self, worker: &DownloadVpnWorkerRef, error: Option<String>) -> bool {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if !runtime.requested || runtime.current.as_ref() != Some(worker) ||
            !matches!(runtime.phase, PluginVpnPhase::Connected | PluginVpnPhase::Reconnecting) { return false; }
        self.proxy.block("The VPN download worker is reconnecting");
        runtime.phase = PluginVpnPhase::Reconnecting; runtime.error = error;
        true
    }
    fn reconnected(&self, worker: &DownloadVpnWorkerRef, connector: Arc<dyn ProxyConnector>, revision: u64, online: bool) -> bool {
        self.publish(worker, connector, revision, online)
    }
    fn fail(&self, worker: &DownloadVpnWorkerRef, error: DownloadVpnWorkerError) -> bool {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if !runtime.requested || runtime.current.as_ref() != Some(worker) { return false; }
        self.invalidate(&mut runtime);
        runtime.phase = PluginVpnPhase::Error; runtime.stopped_phase = PluginVpnPhase::Error;
        runtime.failure_code = Some(error.code); runtime.error = Some(error.message);
        true
    }

    fn request_stop(&self, worker: &DownloadVpnWorkerRef, phase: PluginVpnPhase, error: Option<String>) -> Result<(), String> {
        worker.validate()?;
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if runtime.current.as_ref() != Some(worker) { return Err("VPN download worker generation is stale".into()); }
        self.invalidate(&mut runtime);
        runtime.stopped_phase = phase;
        runtime.phase = if runtime.resources.is_some() && phase == PluginVpnPhase::Disabled { PluginVpnPhase::Disconnecting } else { phase };
        runtime.error = error;
        Ok(())
    }
    fn complete_stop(&self, worker: &DownloadVpnWorkerRef) {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if runtime.current.as_ref() == Some(worker) && !runtime.requested && runtime.resources.is_none() { runtime.phase = runtime.stopped_phase; }
    }
    fn clear_resources(&self, owner: &str) {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if runtime.resources.as_ref().is_some_and(|resources| resources.lease.owner == owner) { runtime.resources = None; }
        if !runtime.requested && runtime.resources.is_none() { runtime.phase = runtime.stopped_phase; }
    }
    fn network_stop(&self, revision: u64, online: bool) -> Option<DownloadVpnWorkerRef> {
        let mut runtime = self.runtime.lock().expect("VPN worker lock");
        if !runtime.requested || revision < runtime.network_revision || (online && revision == runtime.network_revision) { return None; }
        let worker = runtime.current.clone()?;
        self.invalidate(&mut runtime);
        runtime.stopped_phase = PluginVpnPhase::WaitingForNetwork;
        runtime.phase = PluginVpnPhase::WaitingForNetwork;
        Some(worker)
    }
    fn snapshot(&self, worker: &DownloadVpnWorkerRef) -> Result<DownloadVpnWorkerStatus, String> {
        worker.validate()?;
        let runtime = self.runtime.lock().expect("VPN worker lock");
        if runtime.current.as_ref() != Some(worker) { return Err("VPN download worker generation is stale".into()); }
        let revoked = runtime.resources.as_ref().is_some_and(|resources| resources.lease.is_revoked());
        Ok(DownloadVpnWorkerStatus { supported: cfg!(target_os = "android"), worker: worker.clone(), phase: if revoked { PluginVpnPhase::Error } else { runtime.phase },
            proxy_port: self.proxy.address().port(), profile: runtime.resources.as_ref().map(|resources| resources.lease.profile.clone()), error: runtime.error.clone() })
    }
}

#[derive(Clone)]
pub(crate) struct DownloadVpnWorkers { slots: [Arc<DownloadWorkerSlot>; 2] }

impl DownloadVpnWorkers {
    pub(crate) fn bind() -> Result<Self, String> { Ok(Self { slots: [DownloadWorkerSlot::bind()?, DownloadWorkerSlot::bind()?] }) }
    fn generation_floor(&self) -> u64 {
        self.slots.iter().map(|slot| slot.runtime.lock().expect("VPN worker lock").high_water).max().unwrap_or(0)
    }
    pub(crate) async fn stop_all(&self, state: &PluginVpnState) -> Result<(), String> {
        let invalidated = self.invalidate_all();
        let mut failure = None;
        for (slot, worker) in invalidated {
            if let Err(error) = cleanup_slot(&slot, state, &worker).await { failure = Some(error); }
            slot.complete_stop(&worker);
        }
        failure.map_or(Ok(()), Err)
    }
    fn worker_slot(&self, worker: &DownloadVpnWorkerRef) -> Result<Arc<DownloadWorkerSlot>, String> { worker.validate()?; Ok(self.slots[worker.slot as usize].clone()) }
    fn invalidate_all(&self) -> Vec<(Arc<DownloadWorkerSlot>, DownloadVpnWorkerRef)> {
        self.slots.iter().filter_map(|slot| {
            let worker = slot.runtime.lock().expect("VPN worker lock").current.clone()?;
            slot.request_stop(&worker, PluginVpnPhase::Disabled, None).ok()?;
            Some((slot.clone(), worker))
        }).collect()
    }
    pub(crate) fn watch_network(&self, app: &AppHandle) {
        let workers = self.clone(); let app = app.clone(); let mut network = crate::network::subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                let status = network.borrow_and_update().clone();
                for slot in &workers.slots {
                    if let Some(worker) = slot.network_stop(status.revision, status.connectivity == crate::network::Connectivity::Online) {
                        let slot = slot.clone(); let state = app.state::<PluginVpnState>().inner().clone();
                        tauri::async_runtime::spawn(async move { if let Err(error) = cleanup_slot(&slot, &state, &worker).await { log::warn!("VPN worker network cleanup failed: {error}"); } slot.complete_stop(&worker); });
                    }
                }
                if network.changed().await.is_err() { break; }
            }
        });
    }
}

async fn settle_session(session: &WorkerSession, timeout: Duration) -> Result<(), String> {
    session.control.cancel();
    let mut completion = session.completion.clone();
    tokio::time::timeout(timeout, async {
        loop {
            if completion.borrow().is_some() { return Ok(()); }
            completion.changed().await.map_err(|_| "VPN worker cleanup monitor closed; lease retained".to_string())?;
        }
    }).await.map_err(|_| "VPN worker cleanup timed out; lease retained and route blocked".to_string())?
}

async fn cleanup_locked(slot: &DownloadWorkerSlot, state: &PluginVpnState) -> Result<(), String> {
    if let Some(resources) = slot.resources() {
        if let Some(session) = &resources.session {
            if !matches!(*session.completion.borrow(), Some(_)) {
                if !matches!(tokio::time::timeout(STOP_TIMEOUT, session.control.stop()).await, Ok(Ok(()))) { session.control.cancel(); }
                settle_session(session, STOP_TIMEOUT).await?;
            }
        }
        state.release_saved_profile(&resources.lease.owner).await?;
        slot.clear_resources(&resources.lease.owner);
    }
    Ok(())
}
async fn cleanup_slot(slot: &DownloadWorkerSlot, state: &PluginVpnState, worker: &DownloadVpnWorkerRef) -> Result<(), String> {
    let _operation = slot.operation.lock().await;
    if slot.runtime.lock().expect("VPN worker lock").current.as_ref() != Some(worker) { return Ok(()); }
    cleanup_locked(slot, state).await
}

#[tauri::command]
pub(crate) fn plugin_vpn_download_workers_generation_floor(workers: State<'_, DownloadVpnWorkers>) -> u64 {
    workers.generation_floor()
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct DownloadVpnWorkerError {
    code: &'static str,
    message: String,
}

impl From<String> for DownloadVpnWorkerError {
    fn from(message: String) -> Self { Self { code: "vpn-worker-runtime-error", message } }
}

impl From<&str> for DownloadVpnWorkerError {
    fn from(message: &str) -> Self { message.to_string().into() }
}

#[tauri::command]
pub(crate) fn plugin_vpn_download_worker_status(worker: DownloadVpnWorkerRef, workers: State<'_, DownloadVpnWorkers>) -> Result<DownloadVpnWorkerStatus, String> {
    workers.worker_slot(&worker)?.snapshot(&worker)
}

#[tauri::command]
pub(crate) async fn plugin_vpn_download_worker_validate(worker: DownloadVpnWorkerRef, app: AppHandle, workers: State<'_, DownloadVpnWorkers>, state: State<'_, PluginVpnState>) -> Result<DownloadVpnWorkerStatus, DownloadVpnWorkerError> {
    let slot = workers.worker_slot(&worker)?;
    slot.snapshot(&worker)?;
    let lease = state.saved_profile_lease(&app, &worker.lease_owner()).await?;
    if !lease.as_ref().is_some_and(|lease| !lease.is_revoked()) { return Err("The retained VPN profile is no longer approved or available".into()); }
    let status = slot.snapshot(&worker)?;
    if status.phase != PluginVpnPhase::Connected {
        let runtime = slot.runtime.lock().expect("VPN worker lock");
        if runtime.current.as_ref() != Some(&worker) { return Err("VPN download worker generation is stale".into()); }
        return Err(DownloadVpnWorkerError { code: runtime.failure_code.unwrap_or("vpn-worker-runtime-error"),
            message: status.error.unwrap_or_else(|| "VPN download worker is not connected".into()) });
    }
    if !slot.is_requested(&worker) { return Err("VPN download worker is not active".into()); }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn plugin_vpn_download_worker_disconnect(worker: DownloadVpnWorkerRef, workers: State<'_, DownloadVpnWorkers>, state: State<'_, PluginVpnState>) -> Result<DownloadVpnWorkerStatus, String> {
    let slot = workers.worker_slot(&worker)?;
    // A delayed teardown of an old generation is harmless, not permission to stop its replacement.
    if slot.request_stop(&worker, PluginVpnPhase::Disabled, None).is_ok() { cleanup_slot(&slot, state.inner(), &worker).await?; slot.complete_stop(&worker); }
    Ok(slot.snapshot(&worker).unwrap_or(DownloadVpnWorkerStatus { supported: cfg!(target_os = "android"), worker, phase: PluginVpnPhase::Disabled, proxy_port: slot.proxy.address().port(), profile: None, error: None }))
}

#[tauri::command]
pub(crate) async fn plugin_vpn_download_workers_stop(workers: State<'_, DownloadVpnWorkers>, state: State<'_, PluginVpnState>) -> Result<(), String> {
    workers.stop_all(state.inner()).await
}

#[tauri::command]
pub(crate) async fn plugin_vpn_download_worker_connect(worker: DownloadVpnWorkerRef, profile_id: String, expected_hash: String, app: AppHandle, workers: State<'_, DownloadVpnWorkers>, state: State<'_, PluginVpnState>) -> Result<DownloadVpnWorkerStatus, DownloadVpnWorkerError> {
    if !cfg!(target_os = "android") { return Err("Isolated VPN download workers are supported only on Android".into()); }
    let slot = workers.worker_slot(&worker)?;
    let cancellation = slot.request_connect(&worker, crate::network::network_status().revision)?;
    let _operation = slot.operation.lock().await;
    cleanup_locked(&slot, state.inner()).await?;
    if !slot.is_requested(&worker) { return Err("VPN download connection was cancelled".into()); }
    let result = connect_locked(&slot, &worker, &profile_id, &expected_hash, &app, state.inner(), cancellation).await;
    if let Err(error) = &result { slot.fail(&worker, error.clone()); cleanup_locked(&slot, state.inner()).await?; }
    result?;
    slot.snapshot(&worker).map_err(Into::into)
}

#[cfg(any(target_os = "android", target_os = "windows"))]
async fn connect_locked(slot: &Arc<DownloadWorkerSlot>, worker: &DownloadVpnWorkerRef, id: &str, hash: &str, app: &AppHandle, state: &PluginVpnState, cancellation: tokio::sync::watch::Receiver<bool>) -> Result<(), DownloadVpnWorkerError> {
    crate::network::require_online()?;
    let owner = worker.lease_owner();
    let lease = state.reserve_saved_profile(app, &owner, id, hash).await?;
    if !slot.install_lease(worker, lease)? { state.release_saved_profile(&owner).await?; return Err("VPN download connection was cancelled".into()); }
    let mut allocation = state.read_saved_profile_lease(app, &owner).await?;
    if !slot.is_requested(worker) { return Err("VPN download connection was cancelled".into()); }
    let profile = String::from_utf8(allocation.take_bytes()).map_err(|_| "Saved VPN profile must be UTF-8".to_string())?;
    let connection = super::engine::connect(profile, super::engine::EngineCredentials { username: "vpn".into(), password: "vpn".into(), private_key_password: String::new(), challenge_response: String::new() }, cancellation).await;
    drop(allocation);
    let super::engine::EngineConnection { connector, control, lifecycle, completion } = connection.map_err(|message| DownloadVpnWorkerError { code: "vpn-worker-connection-failed", message })?;
    let (sender, receiver) = tokio::sync::watch::channel(None);
    let control: Arc<dyn WorkerEngineControl> = Arc::new(control);
    // Even an obsolete success remains reserved until its engine actually terminates.
    let registered = slot.register_session(worker, control.clone(), receiver.clone());
    let monitor = slot.clone(); let monitored_worker = worker.clone(); let route = connector.clone();
    tauri::async_runtime::spawn(async move {
        let mut lifecycle = lifecycle; let mut completion = completion;
        let result = loop { tokio::select! {
            result = &mut completion => break result,
            event = lifecycle.recv() => match event {
                Some(super::engine::EngineLifecycle::Reconnecting(error)) => { monitor.reconnecting(&monitored_worker, error); },
                Some(super::engine::EngineLifecycle::Reconnected) => {
                    let network = crate::network::network_status();
                    monitor.reconnected(&monitored_worker, route.clone(), network.revision, network.connectivity == crate::network::Connectivity::Online);
                },
                None => break completion.await,
            }
        }};
        monitor.fail(&monitored_worker, DownloadVpnWorkerError { code: "vpn-worker-tunnel-lost",
            message: result.as_ref().err().cloned().unwrap_or_else(|| "OpenVPN disconnected unexpectedly".into()) });
        sender.send_replace(Some(result));
    });
    if !registered {
        let session = WorkerSession { worker: worker.clone(), control, completion: receiver, published: false };
        settle_session(&session, STOP_TIMEOUT).await?;
        return Err("VPN download connection was superseded".into());
    }
    let lease = state.saved_profile_lease(app, &owner).await?;
    let network = crate::network::network_status();
    if !lease.is_some_and(|lease| !lease.is_revoked() && lease.profile.id == id && lease.profile.hash == hash) ||
        !slot.publish(worker, connector, network.revision, network.connectivity == crate::network::Connectivity::Online) {
        return Err("VPN download connection was cancelled or its profile was revoked".into());
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "windows")))]
async fn connect_locked(_: &Arc<DownloadWorkerSlot>, _: &DownloadVpnWorkerRef, _: &str, _: &str, _: &AppHandle, _: &PluginVpnState, _: tokio::sync::watch::Receiver<bool>) -> Result<(), DownloadVpnWorkerError> { Err("Isolated VPN download workers are unsupported".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use super::super::{finder::VpnGateProtocol, proxy::{ConnectFuture, ProxyStream, ProxyTarget}};

    #[derive(Default)]
    struct TestEngineControl {
        cancellations: AtomicUsize,
        stop_gate: Option<tokio::sync::watch::Receiver<bool>>,
    }

    impl WorkerEngineControl for TestEngineControl {
        fn stop(&self) -> WorkerStopFuture<'_> {
            let gate = self.stop_gate.clone();
            Box::pin(async move {
                if let Some(mut gate) = gate {
                    while !*gate.borrow() {
                        gate.changed().await.map_err(|_| "test engine stop gate closed".to_string())?;
                    }
                }
                Ok(())
            })
        }

        fn cancel(&self) { self.cancellations.fetch_add(1, Ordering::SeqCst); }
    }

    struct TestEngineConnector(&'static str);

    impl ProxyConnector for TestEngineConnector {
        fn connect<'a>(&'a self, _: &'a ProxyTarget) -> ConnectFuture<'a> {
            let marker = self.0;
            Box::pin(async move {
                let (client, mut server) = tokio::io::duplex(4096);
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    loop {
                        let mut byte = [0];
                        if server.read_exact(&mut byte).await.is_err() { return; }
                        request.push(byte[0]);
                        if request.ends_with(b"\r\n\r\n") { break; }
                    }
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{marker}", marker.len());
                    let _ = server.write_all(response.as_bytes()).await;
                });
                Ok(Box::new(client) as ProxyStream)
            })
        }
    }

    fn worker(range: &str, slot: u8, generation: u64) -> DownloadVpnWorkerRef {
        DownloadVpnWorkerRef { range_id: range.to_string(), slot, generation }
    }

    #[tokio::test]
    async fn generation_floor_and_tunnel_failure_survive_browser_reload_without_weakening_stale_guards() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let old = worker("old", 0, 71);
        let slot = workers.worker_slot(&old).unwrap();
        let _cancellation = slot.request_connect(&old, 0).unwrap();
        assert!(slot.fail(&old, DownloadVpnWorkerError { code: "vpn-worker-tunnel-lost", message: "Engine exited".into() }));
        assert_eq!(slot.runtime.lock().unwrap().failure_code, Some("vpn-worker-tunnel-lost"));
        assert_eq!(workers.generation_floor(), 71);
        workers.invalidate_all();
        assert_eq!(workers.generation_floor(), 71);
        assert!(slot.request_connect(&worker("reloaded", 0, 1), 0).is_err());
        let replacement = worker("replacement", 0, 72);
        let _replacement_cancellation = slot.request_connect(&replacement, 0).unwrap();
        assert_eq!(slot.runtime.lock().unwrap().failure_code, None);
        assert!(!slot.fail(&old, DownloadVpnWorkerError { code: "vpn-worker-tunnel-lost", message: "Late exit".into() }));
        assert_eq!(slot.snapshot(&replacement).unwrap().phase, PluginVpnPhase::Connecting);
        assert_eq!(workers.generation_floor(), 72);
    }

    fn lease(worker: &DownloadVpnWorkerRef) -> SavedVpnProfileLease {
        let hash = if worker.slot == 0 { "a" } else { "b" }.repeat(64);
        SavedVpnProfileLease {
            owner: worker.lease_owner(),
            profile: SavedVpnProfile { id: hash.clone(), hash, ip: if worker.slot == 0 { "8.8.4.4" } else { "1.1.1.1" }.into(), protocol: VpnGateProtocol::Tcp, approved_at: 10, approval_sequence: 1 },
            revoked: false,
            revocation: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    fn attach(
        slot: &DownloadWorkerSlot, worker: &DownloadVpnWorkerRef, marker: &'static str, revision: u64,
    ) -> (Arc<TestEngineControl>, tokio::sync::watch::Sender<Option<Result<(), String>>>) {
        assert!(slot.install_lease(worker, lease(worker)).unwrap());
        let control = Arc::new(TestEngineControl::default());
        let (completion, receiver) = tokio::sync::watch::channel(None);
        assert!(slot.register_session(worker, control.clone(), receiver));
        assert!(slot.publish(worker, Arc::new(TestEngineConnector(marker)), revision, true));
        (control, completion)
    }

    struct RestoreWorkers {
        _directory: tempfile::TempDir,
        state: PluginVpnState,
        workers: DownloadVpnWorkers,
        completions: Vec<tokio::sync::watch::Sender<Option<Result<(), String>>>>,
        cancellations: Vec<tokio::sync::watch::Receiver<bool>>,
        profile_path: std::path::PathBuf,
        original: Vec<u8>,
    }

    async fn restore_workers() -> RestoreWorkers {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        use super::super::saved_profiles::SavedProfileVault;
        let directory = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(
            SqliteConnectOptions::new().filename(directory.path().join("verdicts.db")).create_if_missing(true),
        ).await.unwrap();
        sqlx::query("CREATE TABLE vpn_gate_server_verdict(ip TEXT PRIMARY KEY,verdict TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT(unixepoch()))").execute(&pool).await.unwrap();
        let profile_path = directory.path().join("plugin-vpn/profile.ovpn");
        let mut vault = SavedProfileVault::open(directory.path().join("plugin-vpn/saved-profiles")).unwrap();
        let workers = DownloadVpnWorkers::bind().unwrap();
        let mut completions = Vec::new();
        let mut cancellations = Vec::new();
        let mut original = Vec::new();
        for (index, ip) in ["8.8.4.4", "1.1.1.1"].into_iter().enumerate() {
            let bytes = format!("client\ndev tun\nproto tcp\nremote {ip} 443\n<ca>\ncertificate\n</ca>\n{}\nauth-user-pass\n", super::super::VPN_GATE_PROFILE_MARKER).into_bytes();
            let saved = vault.capture(&pool, ip, &bytes).await.unwrap().saved_profile.unwrap();
            let worker = worker(&format!("range-{index}"), index as u8, index as u64 + 1);
            let lease = vault.reserve(&pool, &worker.lease_owner(), &saved.id, &saved.hash, None).await.unwrap();
            let slot = workers.worker_slot(&worker).unwrap();
            cancellations.push(slot.request_connect(&worker, 1).unwrap());
            assert!(slot.install_lease(&worker, lease).unwrap());
            let (completion, receiver) = tokio::sync::watch::channel(None);
            assert!(slot.register_session(&worker, Arc::new(TestEngineControl::default()), receiver));
            assert!(slot.publish(&worker, Arc::new(TestEngineConnector("restore-worker")), 1, true));
            completions.push(completion);
            if index == 0 { original = bytes; }
        }
        std::fs::write(&profile_path, &original).unwrap();
        pool.close().await;
        let state = super::super::state::tests::backup_worker_test_state(profile_path.clone(), Ok(vault));
        RestoreWorkers { _directory: directory, state, workers, completions, cancellations, profile_path, original }
    }

    #[tokio::test]
    async fn backup_restore_stops_both_workers_before_taking_the_vault_operation_lock() {
        let mut fixture = restore_workers().await;
        let state = fixture.state.clone();
        let workers = fixture.workers.clone();
        let restoring = tokio::spawn(async move {
            let _guard = state.lock_device_backup_restore(&workers).await?;
            Ok::<(), String>(())
        });
        assert!(tokio::time::timeout(Duration::from_millis(100), fixture.cancellations[0].changed()).await.is_ok(), "restore did not invalidate the first worker");
        assert!(*fixture.cancellations[0].borrow());
        assert!(*fixture.cancellations[1].borrow());
        assert!(!restoring.is_finished());
        assert_eq!(std::fs::read(&fixture.profile_path).unwrap(), fixture.original);
        let guard = tokio::time::timeout(Duration::from_millis(100), fixture.state.lock_device_backup()).await
            .expect("restore held the vault operation lock before worker cleanup").unwrap();
        drop(guard);
        fixture.completions[1].send_replace(Some(Ok(())));
        assert!(!restoring.is_finished());
        fixture.completions[0].send_replace(Some(Ok(())));
        tokio::time::timeout(Duration::from_secs(2), restoring).await.unwrap().unwrap().unwrap();
        for slot in &fixture.workers.slots { assert!(slot.resources().is_none()); }
        assert_eq!(std::fs::read(&fixture.profile_path).unwrap(), fixture.original);
        fixture.state.lock_device_backup_restore(&fixture.workers).await.unwrap();
    }

    #[tokio::test]
    async fn backup_restore_refuses_a_closed_worker_monitor_and_preserves_its_lease_and_files() {
        let mut fixture = restore_workers().await;
        drop(fixture.completions.remove(0));
        fixture.completions[0].send_replace(Some(Ok(())));
        let result = fixture.state.lock_device_backup_restore(&fixture.workers).await;
        let error = match result { Ok(_) => panic!("restore accepted an unsettled worker"), Err(error) => error };
        assert!(error.contains("lease retained"), "{error}");
        assert!(fixture.workers.slots[0].resources().is_some());
        assert!(fixture.workers.slots[1].resources().is_none());
        assert_eq!(std::fs::read(&fixture.profile_path).unwrap(), fixture.original);
    }

    async fn origin() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut request = [0; 4096];
                    let _ = stream.read(&mut request).await;
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nDIRECT").await;
                });
            }
        });
        (address, task)
    }

    async fn request(proxy: &LocalProxy, origin: std::net::SocketAddr) -> String {
        let mut client = tokio::net::TcpStream::connect(proxy.address()).await.unwrap();
        client.write_all(format!("GET http://{origin}/chapter HTTP/1.1\r\nHost: {origin}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut response)).await.unwrap().unwrap();
        String::from_utf8(response).unwrap()
    }

    #[tokio::test]
    async fn two_worker_proxies_start_blocked_instead_of_reaching_a_real_direct_origin() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let a = workers.worker_slot(&worker("range-a", 0, 1)).unwrap();
        let b = workers.worker_slot(&worker("range-b", 1, 1)).unwrap();
        assert_ne!(a.proxy.address().port(), b.proxy.address().port());
        assert!(a.proxy.address().ip().is_loopback());
        assert!(b.proxy.address().ip().is_loopback());
        let (address, server) = origin().await;
        for slot in [&a, &b] {
            assert!(request(&slot.proxy, address).await.starts_with("HTTP/1.1 502"));
        }
        server.abort();
    }

    #[tokio::test]
    async fn invalid_worker_identity_cannot_claim_a_slot_or_advance_its_generation() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        for invalid in [worker("", 0, 1), worker("bad/id", 0, 1), worker(&"a".repeat(81), 0, 1), worker("range", 2, 1), worker("range", 0, 0), worker("range", 0, MAX_SAFE_GENERATION + 1)] {
            assert!(workers.worker_slot(&invalid).is_err());
        }
        let valid = worker("range-a", 0, 1);
        let slot = workers.worker_slot(&valid).unwrap();
        assert!(slot.request_connect(&valid, 1).is_ok());
    }

    #[tokio::test]
    async fn slot_generation_high_water_survives_release_and_rejects_old_range_commands() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let old = worker("range-a", 0, 7);
        let slot = workers.worker_slot(&old).unwrap();
        let cancellation = slot.request_connect(&old, 1).unwrap();
        slot.request_stop(&old, PluginVpnPhase::Disabled, None).unwrap();
        assert!(*cancellation.borrow());
        slot.complete_stop(&old);
        assert_eq!(slot.snapshot(&old).unwrap().phase, PluginVpnPhase::Disabled);
        for stale in [old.clone(), worker("range-b", 0, 7), worker("range-a", 0, 6)] {
            assert!(slot.request_connect(&stale, 1).is_err());
        }
        let next = worker("range-b", 0, 8);
        let next_cancellation = slot.request_connect(&next, 2).unwrap();
        assert!(slot.request_stop(&old, PluginVpnPhase::Disabled, None).is_err());
        assert!(slot.snapshot(&old).is_err());
        assert!(!*next_cancellation.borrow());
        assert!(slot.is_requested(&next));
    }

    #[tokio::test]
    async fn explicit_off_cancels_both_pending_slots_before_waiting_for_any_operation_lock() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let a = worker("range-a", 0, 1);
        let b = worker("range-b", 1, 1);
        let first = workers.worker_slot(&a).unwrap();
        let second = workers.worker_slot(&b).unwrap();
        let cancel_a = first.request_connect(&a, 1).unwrap();
        let cancel_b = second.request_connect(&b, 1).unwrap();
        let _held = first.operation.lock().await;
        assert_eq!(workers.invalidate_all().len(), 2);
        assert!(*cancel_a.borrow());
        assert!(*cancel_b.borrow());
        assert!(!first.is_requested(&a));
        assert!(!second.is_requested(&b));
    }

    #[tokio::test]
    async fn replacing_or_stopping_one_slot_never_changes_the_other_or_foreground_route() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let a = worker("range-a", 0, 1);
        let b = worker("range-b", 1, 1);
        let first = workers.worker_slot(&a).unwrap();
        let second = workers.worker_slot(&b).unwrap();
        let _cancel_a = first.request_connect(&a, 1).unwrap();
        let _cancel_b = second.request_connect(&b, 1).unwrap();
        let (control_a, _completion_a) = attach(&first, &a, "tunnel-a", 1);
        let (_control_b, _completion_b) = attach(&second, &b, "tunnel-b", 1);
        let foreground = LocalProxy::bind().unwrap();
        foreground.tunnel(Arc::new(TestEngineConnector("foreground")));
        foreground.start().unwrap();
        let (address, server) = origin().await;
        assert!(request(&first.proxy, address).await.ends_with("tunnel-a"));
        assert!(request(&second.proxy, address).await.ends_with("tunnel-b"));
        first.request_stop(&a, PluginVpnPhase::Disabled, None).unwrap();
        assert!(control_a.cancellations.load(Ordering::SeqCst) > 0);
        assert!(request(&first.proxy, address).await.starts_with("HTTP/1.1 502"));
        assert!(request(&second.proxy, address).await.ends_with("tunnel-b"));
        assert!(request(&foreground, address).await.ends_with("foreground"));
        server.abort();
    }

    #[tokio::test]
    async fn a_cancelled_success_cannot_publish_or_replace_its_retained_owner() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let old = worker("range-a", 0, 1);
        let slot = workers.worker_slot(&old).unwrap();
        let cancellation = slot.request_connect(&old, 1).unwrap();
        assert!(slot.install_lease(&old, lease(&old)).unwrap());
        let next = worker("range-b", 0, 2);
        let _next_cancel = slot.request_connect(&next, 2).unwrap();
        assert!(*cancellation.borrow());
        let control = Arc::new(TestEngineControl::default());
        let (_completion, receiver) = tokio::sync::watch::channel(None);
        assert!(!slot.register_session(&old, control.clone(), receiver));
        assert!(slot.resources().unwrap().session.is_some());
        assert!(!slot.publish(&old, Arc::new(TestEngineConnector("stale")), 1, true));
        assert_eq!(slot.resources().unwrap().lease.owner, old.lease_owner());
        assert!(control.cancellations.load(Ordering::SeqCst) > 0);
        assert!(slot.install_lease(&next, lease(&next)).is_err());
    }

    #[tokio::test]
    async fn reconnect_lifecycle_never_reopens_a_stopped_or_superseded_route() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let old = worker("range-a", 0, 1);
        let slot = workers.worker_slot(&old).unwrap();
        let _old_cancel = slot.request_connect(&old, 1).unwrap();
        let (_control, completion) = attach(&slot, &old, "old", 1);
        assert!(slot.reconnecting(&old, Some("transport changed".into())));
        let (address, server) = origin().await;
        assert!(request(&slot.proxy, address).await.starts_with("HTTP/1.1 502"));
        assert!(slot.reconnected(&old, Arc::new(TestEngineConnector("recovered")), 1, true));
        assert!(request(&slot.proxy, address).await.ends_with("recovered"));
        slot.request_stop(&old, PluginVpnPhase::Disabled, None).unwrap();
        assert!(!slot.reconnected(&old, Arc::new(TestEngineConnector("stale")), 1, true));
        completion.send_replace(Some(Ok(())));
        settle_session(&slot.resources().unwrap().session.unwrap(), Duration::from_millis(10)).await.unwrap();
        slot.clear_resources(&old.lease_owner());
        let next = worker("range-b", 0, 2);
        let _next_cancel = slot.request_connect(&next, 2).unwrap();
        let (_next_control, _next_completion) = attach(&slot, &next, "next", 2);
        assert!(!slot.reconnecting(&old, None));
        assert!(!slot.reconnected(&old, Arc::new(TestEngineConnector("stale")), 1, true));
        assert!(!slot.fail(&old, "old completion".into()));
        slot.clear_resources(&old.lease_owner());
        assert_eq!(slot.resources().unwrap().lease.owner, next.lease_owner());
        assert!(request(&slot.proxy, address).await.ends_with("next"));
        server.abort();
    }

    #[tokio::test]
    async fn delayed_network_events_do_not_stop_a_worker_on_a_newer_route() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let current = worker("range-a", 0, 1);
        let slot = workers.worker_slot(&current).unwrap();
        let _cancel = slot.request_connect(&current, 12).unwrap();
        let (_control, _completion) = attach(&slot, &current, "current", 12);
        assert!(slot.network_stop(11, true).is_none());
        assert!(slot.network_stop(11, false).is_none());
        assert!(slot.network_stop(12, true).is_none());
        assert_eq!(slot.snapshot(&current).unwrap().phase, PluginVpnPhase::Connected);
        assert_eq!(slot.network_stop(13, true), Some(current.clone()));
        assert!(!slot.reconnected(&current, Arc::new(TestEngineConnector("stale")), 13, true));
        assert_eq!(slot.snapshot(&current).unwrap().phase, PluginVpnPhase::WaitingForNetwork);
    }

    #[tokio::test]
    async fn delayed_cleanup_does_not_release_the_newer_generations_resources() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let previous = worker("previous", 0, 1);
        let current = worker("current", 0, 2);
        let slot = workers.worker_slot(&current).unwrap();
        let _cancel = slot.request_connect(&current, 1).unwrap();
        let (control, completion) = attach(&slot, &current, "current", 1);
        completion.send_replace(Some(Ok(())));
        let foreground = PluginVpnState::bind().unwrap();
        cleanup_slot(&slot, &foreground, &previous).await.unwrap();
        assert_eq!(control.cancellations.load(Ordering::SeqCst), 0);
        assert_eq!(slot.resources().unwrap().lease.owner, current.lease_owner());
        assert!(slot.is_requested(&current));
    }

    #[tokio::test]
    async fn cleanup_timeout_retains_the_session_and_lease_until_actual_completion() {
        let workers = DownloadVpnWorkers::bind().unwrap();
        let current = worker("range-a", 0, 1);
        let slot = workers.worker_slot(&current).unwrap();
        let _cancel = slot.request_connect(&current, 1).unwrap();
        let (_control, completion) = attach(&slot, &current, "current", 1);
        slot.request_stop(&current, PluginVpnPhase::Disabled, None).unwrap();
        let resources = slot.resources().unwrap();
        let error = settle_session(resources.session.as_ref().unwrap(), Duration::from_millis(1)).await.unwrap_err();
        assert!(error.contains("lease retained"));
        assert!(slot.resources().unwrap().session.is_some());
        assert_eq!(slot.resources().unwrap().lease.owner, current.lease_owner());
        slot.complete_stop(&current);
        assert_ne!(slot.snapshot(&current).unwrap().phase, PluginVpnPhase::Disabled);
        completion.send_replace(Some(Ok(())));
        settle_session(resources.session.as_ref().unwrap(), Duration::from_millis(10)).await.unwrap();
        slot.clear_resources(&current.lease_owner());
        assert!(slot.resources().is_none());
        assert_eq!(slot.snapshot(&current).unwrap().phase, PluginVpnPhase::Disabled);
    }

    #[tokio::test]
    async fn a_closed_completion_monitor_does_not_prove_engine_cleanup() {
        let control = Arc::new(TestEngineControl::default());
        let (completion, receiver) = tokio::sync::watch::channel(None);
        let session = WorkerSession { worker: worker("range-a", 0, 1), control, completion: receiver, published: false };
        drop(completion);
        assert!(settle_session(&session, Duration::from_millis(10)).await.unwrap_err().contains("lease retained"));
    }
}
