use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock},
};

use openvpn_connect::{
    tokio::{Client, SessionHandle},
    Config, Credentials, Event, EventHandler, ExternalTun, ExternalTunConfig, ExternalTunInfo,
    ExternalTunIo, ExternalTunStartConfig,
};
use tokio::{
    runtime::Handle,
    sync::{mpsc, watch},
};

use super::{
    netstack::{PacketSink, UserSpaceNetwork},
    proxy::{ConnectFuture, ProxyConnector, ProxyTarget},
    tunnel_config::{parse_tunnel_configuration, TunnelConfiguration},
};

pub(super) struct EngineCredentials {
    pub(super) username: String,
    pub(super) password: String,
    pub(super) private_key_password: String,
    pub(super) challenge_response: String,
}

pub(super) struct EngineConnection {
    pub(super) connector: Arc<dyn ProxyConnector>,
    pub(super) control: EngineControl,
    pub(super) lifecycle: mpsc::UnboundedReceiver<EngineLifecycle>,
    pub(super) completion: Pin<Box<dyn Future<Output = Result<(), String>> + Send>>,
}

pub(super) enum EngineLifecycle {
    Reconnected,
    Reconnecting(Option<String>),
}

#[derive(Clone)]
pub(super) struct EngineControl {
    handle: SessionHandle,
}

impl EngineControl {
    pub(super) async fn stop(&self) -> Result<(), String> {
        self.handle
            .stop()
            .await
            .map_err(|error| format!("could not stop OpenVPN: {error}"))
    }

    pub(super) fn cancel(&self) {
        self.handle.cancel();
    }
}

struct SwitchingConnector {
    state: RwLock<SwitchingConnectorState>,
}

struct SwitchingConnectorState {
    generation: u64,
    current: Option<Arc<dyn ProxyConnector>>,
}

impl SwitchingConnector {
    fn new() -> Self {
        Self {
            state: RwLock::new(SwitchingConnectorState {
                generation: 0,
                current: None,
            }),
        }
    }

    fn reset(&self) -> u64 {
        let mut state = self.state.write().expect("OpenVPN connector lock");
        state.generation = state.generation.wrapping_add(1);
        state.current = None;
        state.generation
    }

    fn replace(&self, generation: u64, connector: Arc<dyn ProxyConnector>) -> bool {
        let mut state = self.state.write().expect("OpenVPN connector lock");
        if state.generation != generation {
            return false;
        }
        state.current = Some(connector);
        true
    }

    fn clear_if_current(&self, generation: u64) -> bool {
        let mut state = self.state.write().expect("OpenVPN connector lock");
        if state.generation != generation {
            return false;
        }
        state.current = None;
        true
    }

    fn is_current(&self, generation: u64) -> bool {
        self.state
            .read()
            .expect("OpenVPN connector lock")
            .generation
            == generation
    }
}

impl ProxyConnector for SwitchingConnector {
    fn connect<'a>(&'a self, target: &'a ProxyTarget) -> ConnectFuture<'a> {
        let connector = self
            .state
            .read()
            .expect("OpenVPN connector lock")
            .current
            .clone();
        Box::pin(async move {
            let connector = connector.ok_or_else(|| "OpenVPN tunnel is not ready".to_string())?;
            connector.connect(target).await
        })
    }
}

enum EngineEvent {
    CoreConnected,
    Reconnecting,
    TunnelReady(u64),
    TunnelInterrupted(String),
    TunnelFailure(String),
    Failure(String),
}

#[derive(Default)]
struct EngineRecovery {
    active: bool,
    core_connected: bool,
    tunnel_ready: bool,
}

impl EngineRecovery {
    fn restart(&mut self) -> bool {
        let was_inactive = !self.active;
        self.active = true;
        self.core_connected = false;
        self.tunnel_ready = false;
        was_inactive
    }

    fn mark_core_connected(&mut self) -> bool {
        if !self.active {
            return false;
        }
        self.core_connected = true;
        self.finish_if_ready()
    }

    fn mark_tunnel_ready(&mut self) -> bool {
        if !self.active {
            return false;
        }
        self.tunnel_ready = true;
        self.finish_if_ready()
    }

    fn finish_if_ready(&mut self) -> bool {
        if !self.core_connected || !self.tunnel_ready {
            return false;
        }
        self.active = false;
        true
    }
}

pub(super) async fn connect(
    profile: String,
    credentials: EngineCredentials,
    mut cancellation: watch::Receiver<bool>,
) -> Result<EngineConnection, String> {
    let runtime = Handle::current();
    let (events, mut event_receiver) = mpsc::unbounded_channel();
    let connector = Arc::new(SwitchingConnector::new());
    let tun = Arc::new(NoreaExternalTun::new(
        runtime,
        events.clone(),
        connector.clone(),
    ));
    let client = Client::builder()
        .handler(NoreaEventHandler {
            tun: tun.clone(),
            events: events.clone(),
        })
        .build()
        .map_err(|error| format!("could not initialize OpenVPN: {error}"))?;

    let use_vpn_gate_android_peer_compatibility =
        super::needs_vpn_gate_android_peer_compatibility(&profile, std::env::consts::OS);
    let mut config = Config::new(profile);
    if use_vpn_gate_android_peer_compatibility {
        config
            .content_list
            .push(("push-peer-info".to_string(), String::new()));
        config
            .peer_info
            .push(("IV_PLAT".to_string(), "linux".to_string()));
    }
    config.gui_version = format!("Norea {}", env!("CARGO_PKG_VERSION"));
    config.platform_version = std::env::consts::OS.to_string();
    config.allow_unused_addr_families = "no".to_string();
    config.compression_mode = "no".to_string();
    config.private_key_password = credentials.private_key_password.clone();
    config.connection_timeout_seconds = 30;
    config.tun_persist = false;
    config.google_dns_fallback = false;
    config.allow_local_lan_access = false;
    config.enable_route_emulation = false;
    config.dco = false;
    config.wintun = false;
    config.allow_local_dns_resolvers = false;
    config.retry_on_auth_failed = false;

    let evaluation = client
        .evaluate(config)
        .await
        .map_err(|error| format!("OpenVPN profile evaluation failed: {error}"))?;
    if cancellation_requested(&cancellation) {
        return Err("OpenVPN connection was cancelled".to_string());
    }
    if evaluation.external_pki {
        return Err("OpenVPN profiles that require external PKI are not supported".to_string());
    }
    if evaluation.private_key_password_required && credentials.private_key_password.is_empty() {
        return Err("The OpenVPN private key password is required".to_string());
    }
    if !evaluation.static_challenge.is_empty() && credentials.challenge_response.is_empty() {
        return Err("The OpenVPN static challenge response is required".to_string());
    }

    let username = if evaluation.userlocked_username.is_empty() {
        credentials.username
    } else {
        evaluation.userlocked_username
    };
    if !evaluation.autologin && username.is_empty() {
        return Err("The OpenVPN username is required".to_string());
    }
    if !evaluation.autologin
        || !username.is_empty()
        || !credentials.password.is_empty()
        || !credentials.challenge_response.is_empty()
    {
        let mut supplied = Credentials::new(username, credentials.password);
        supplied.response = credentials.challenge_response;
        client
            .provide_credentials(supplied)
            .await
            .map_err(|error| format!("OpenVPN rejected the credentials: {error}"))?;
        if cancellation_requested(&cancellation) {
            return Err("OpenVPN connection was cancelled".to_string());
        }
    }

    let session = client
        .connect()
        .await
        .map_err(|error| format!("could not start OpenVPN: {error}"))?;
    let control = EngineControl {
        handle: session.handle(),
    };
    let mut session = Box::pin(session);
    if cancellation_requested(&cancellation) {
        control.cancel();
        let _ = session.await;
        return Err("OpenVPN connection was cancelled".to_string());
    }
    let mut readiness = EngineRecovery::default();
    let _ = readiness.restart();
    loop {
        tokio::select! {
            event = event_receiver.recv() => match event {
                Some(EngineEvent::CoreConnected) if readiness.mark_core_connected() => break,
                Some(EngineEvent::Reconnecting) => {
                    let _ = readiness.restart();
                }
                Some(EngineEvent::TunnelReady(generation))
                    if connector.is_current(generation) && readiness.mark_tunnel_ready() => break,
                Some(EngineEvent::TunnelFailure(error) | EngineEvent::TunnelInterrupted(error)) => {
                    control.cancel();
                    let _ = session.await;
                    return Err(error);
                }
                Some(EngineEvent::CoreConnected | EngineEvent::TunnelReady(_)) => {}
                Some(EngineEvent::Failure(error)) => {
                    control.cancel();
                    let _ = session.await;
                    return Err(error);
                }
                None => {
                    control.cancel();
                    let _ = session.await;
                    return Err("OpenVPN event channel closed while connecting".to_string());
                }
            },
            result = &mut session => {
                return Err(session_result(result));
            }
            () = wait_for_cancellation(&mut cancellation) => {
                control.cancel();
                let _ = session.await;
                return Err("OpenVPN connection was cancelled".to_string());
            }
        }
    }
    if cancellation_requested(&cancellation) {
        control.cancel();
        let _ = session.await;
        return Err("OpenVPN connection was cancelled".to_string());
    }

    let completion_control = control.clone();
    let completion_connector = connector.clone();
    let (lifecycle_sender, lifecycle) = mpsc::unbounded_channel();
    let completion = Box::pin(async move {
        let mut recovery = EngineRecovery::default();
        loop {
            tokio::select! {
                result = &mut session => break Err(session_result(result)),
                event = event_receiver.recv() => match event {
                    Some(EngineEvent::Failure(error)) => {
                        completion_control.cancel();
                        let _ = session.await;
                        break Err(error);
                    }
                    Some(EngineEvent::TunnelFailure(error)) => {
                        completion_control.cancel();
                        let _ = session.await;
                        break Err(error);
                    }
                    Some(EngineEvent::TunnelInterrupted(error)) => {
                        let _ = recovery.restart();
                        let _ = lifecycle_sender
                            .send(EngineLifecycle::Reconnecting(Some(error)));
                    }
                    Some(EngineEvent::Reconnecting) => {
                        if recovery.restart() {
                            let _ = lifecycle_sender.send(EngineLifecycle::Reconnecting(None));
                        }
                    }
                    Some(EngineEvent::CoreConnected) if recovery.mark_core_connected() => {
                        let _ = lifecycle_sender.send(EngineLifecycle::Reconnected);
                    }
                    Some(EngineEvent::TunnelReady(generation))
                        if completion_connector.is_current(generation)
                            && recovery.mark_tunnel_ready() => {
                        let _ = lifecycle_sender.send(EngineLifecycle::Reconnected);
                    }
                    Some(EngineEvent::CoreConnected | EngineEvent::TunnelReady(_)) => {}
                    None => {
                        completion_control.cancel();
                        let _ = session.await;
                        break Err("OpenVPN event channel closed".to_string());
                    }
                }
            }
        }
    });

    Ok(EngineConnection {
        connector,
        control,
        lifecycle,
        completion,
    })
}

fn cancellation_requested(cancellation: &watch::Receiver<bool>) -> bool {
    *cancellation.borrow() || cancellation.has_changed().is_err()
}

async fn wait_for_cancellation(cancellation: &mut watch::Receiver<bool>) {
    loop {
        if *cancellation.borrow() {
            return;
        }
        if cancellation.changed().await.is_err() {
            return;
        }
    }
}

fn session_result(result: openvpn_connect::Result<openvpn_connect::Status>) -> String {
    match result {
        Ok(status) if status.status.is_empty() => "OpenVPN disconnected".to_string(),
        Ok(status) => format!("OpenVPN session ended ({})", status.status),
        Err(error) => format!("OpenVPN session failed: {error}"),
    }
}

struct NoreaEventHandler {
    tun: Arc<NoreaExternalTun>,
    events: mpsc::UnboundedSender<EngineEvent>,
}

impl EventHandler for NoreaEventHandler {
    fn event(&self, event: Event) {
        match event.name.as_str() {
            "CONNECTED" => {
                let _ = self.events.send(EngineEvent::CoreConnected);
            }
            "RECONNECTING" => {
                let _ = self.events.send(EngineEvent::Reconnecting);
            }
            "DYNAMIC_CHALLENGE" => {
                let _ = self.events.send(EngineEvent::Failure(
                    "OpenVPN dynamic challenges are not supported".to_string(),
                ));
            }
            "AUTH_FAILED" => {
                let _ = self.events.send(EngineEvent::Failure(
                    "OpenVPN authentication failed".to_string(),
                ));
            }
            _ if event.fatal => {
                let _ = self.events.send(EngineEvent::Failure(format!(
                    "OpenVPN connection failed ({})",
                    event.name
                )));
            }
            _ => {}
        }
    }

    fn external_tun(&self) -> Option<&dyn ExternalTun> {
        Some(self.tun.as_ref())
    }
}

struct NoreaExternalTun {
    runtime: Handle,
    events: mpsc::UnboundedSender<EngineEvent>,
    connector: Arc<SwitchingConnector>,
    state: std::sync::Mutex<TunState>,
}

struct TunState {
    generation: u64,
    configured_mtu: i32,
    network: Option<UserSpaceNetwork>,
    io: Option<ExternalTunIo>,
    info: ExternalTunInfo,
}

impl NoreaExternalTun {
    fn new(
        runtime: Handle,
        events: mpsc::UnboundedSender<EngineEvent>,
        connector: Arc<SwitchingConnector>,
    ) -> Self {
        Self {
            runtime,
            events,
            connector,
            state: std::sync::Mutex::new(TunState {
                generation: 0,
                configured_mtu: 0,
                network: None,
                io: None,
                info: ExternalTunInfo::default(),
            }),
        }
    }

    fn fail(&self, generation: u64, io: &ExternalTunIo, message: String) {
        if self.connector.clear_if_current(generation) {
            let _ = self
                .events
                .send(EngineEvent::TunnelFailure(message.clone()));
            let _ = io.error(&message);
        }
    }

    fn stop_network(&self) -> u64 {
        let generation = self.connector.reset();
        let network = {
            let mut state = self.state.lock().expect("OpenVPN tunnel state lock");
            state.generation = generation;
            state.io = None;
            state.info = ExternalTunInfo::default();
            state.network.take()
        };
        if let Some(network) = network {
            network.stop();
            let _ = self.events.send(EngineEvent::Reconnecting);
        }
        generation
    }

    fn stop_generation(&self, generation: u64) {
        self.connector.clear_if_current(generation);
        let network = {
            let mut state = self.state.lock().expect("OpenVPN tunnel state lock");
            if state.generation != generation {
                return;
            }
            state.io = None;
            state.info = ExternalTunInfo::default();
            state.network.take()
        };
        if let Some(network) = network {
            network.stop();
        }
    }
}

impl ExternalTun for NoreaExternalTun {
    fn configure(&self, config: &ExternalTunConfig) -> bool {
        if config.layer != 3 || config.google_dns_fallback || config.allow_local_lan_access {
            return false;
        }
        self.state
            .lock()
            .expect("OpenVPN tunnel state lock")
            .configured_mtu = config.mtu;
        true
    }

    fn start(&self, config: &ExternalTunStartConfig, io: ExternalTunIo) {
        let generation = self.stop_network();
        let mtu = self
            .state
            .lock()
            .expect("OpenVPN tunnel state lock")
            .configured_mtu;
        let configuration = match parse_tunnel_configuration(&config.options, mtu) {
            Ok(configuration) => configuration,
            Err(error) => {
                self.fail(generation, &io, error);
                return;
            }
        };
        let info = tunnel_info(&configuration);
        let sink = Arc::new(OpenVpnPacketSink { io: io.clone() });
        let failure_io = io.clone();
        let failure_events = self.events.clone();
        let failure_connector = self.connector.clone();
        let network = match UserSpaceNetwork::start(
            &self.runtime,
            configuration,
            sink,
            Arc::new(move |error| {
                if failure_connector.clear_if_current(generation) {
                    let _ = failure_events.send(EngineEvent::TunnelInterrupted(error.clone()));
                    let _ = failure_io.error(&error);
                }
            }),
        ) {
            Ok(network) => network,
            Err(error) => {
                self.fail(generation, &io, error);
                return;
            }
        };
        let connector = network.connector();
        let mut network = Some(network);
        {
            let mut state = self.state.lock().expect("OpenVPN tunnel state lock");
            if state.generation == generation {
                state.info = info;
                state.io = Some(io.clone());
                state.network = network.take();
            }
        }
        if let Some(network) = network {
            network.stop();
            return;
        }
        let activated = io
            .pre_tun_config()
            .and_then(|()| io.pre_route_config())
            .and_then(|()| io.connected());
        if let Err(error) = activated {
            self.stop_generation(generation);
            self.fail(
                generation,
                &io,
                format!("could not activate the OpenVPN tunnel: {error}"),
            );
            return;
        }
        if self.connector.replace(generation, connector) {
            let _ = self.events.send(EngineEvent::TunnelReady(generation));
        }
    }

    fn stop(&self) {
        self.stop_network();
    }

    fn set_disconnect(&self) {
        self.stop_network();
    }

    fn send(&self, packet: &[u8]) -> bool {
        self.state
            .lock()
            .expect("OpenVPN tunnel state lock")
            .network
            .as_ref()
            .is_some_and(|network| network.receive(packet))
    }

    fn info(&self) -> ExternalTunInfo {
        self.state
            .lock()
            .expect("OpenVPN tunnel state lock")
            .info
            .clone()
    }

    fn apply_push_update(&self, _: &str) {
        let (generation, io) = {
            let state = self.state.lock().expect("OpenVPN tunnel state lock");
            (state.generation, state.io.clone())
        };
        if let Some(io) = io {
            self.fail(
                generation,
                &io,
                "OpenVPN live tunnel configuration updates are not supported".to_string(),
            );
        }
    }

    fn supports_epoch_data(&self) -> bool {
        true
    }

    fn finalize(&self, _: bool) {
        self.stop_network();
    }
}

struct OpenVpnPacketSink {
    io: ExternalTunIo,
}

impl PacketSink for OpenVpnPacketSink {
    fn send(&self, packet: &[u8]) -> bool {
        self.io.receive(packet).is_ok()
    }
}

fn tunnel_info(configuration: &TunnelConfiguration) -> ExternalTunInfo {
    ExternalTunInfo {
        name: "norea-userspace".to_string(),
        vpn_ipv4: configuration
            .ipv4
            .map(|address| address.to_string())
            .unwrap_or_default(),
        vpn_ipv6: configuration
            .ipv6
            .map(|address| address.to_string())
            .unwrap_or_default(),
        gateway_ipv4: configuration
            .gateway_ipv4
            .map(|address| address.to_string())
            .unwrap_or_default(),
        gateway_ipv6: configuration
            .gateway_ipv6
            .map(|address| address.to_string())
            .unwrap_or_default(),
        mtu: configuration.mtu as i32,
        interface_index: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_vpn::proxy::ProxyStream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct MarkerConnector(u8);

    impl ProxyConnector for MarkerConnector {
        fn connect<'a>(&'a self, _: &'a ProxyTarget) -> ConnectFuture<'a> {
            let marker = self.0;
            Box::pin(async move {
                let (mut writer, reader) = tokio::io::duplex(1);
                tokio::spawn(async move {
                    writer.write_all(&[marker]).await.expect("marker write");
                });
                Ok(Box::new(reader) as ProxyStream)
            })
        }
    }

    #[test]
    fn recovery_requires_both_core_and_tunnel_readiness() {
        let mut recovery = EngineRecovery::default();

        assert!(recovery.restart());
        assert!(!recovery.mark_tunnel_ready());
        assert!(recovery.mark_core_connected());
    }

    #[test]
    fn a_new_reconnect_attempt_clears_partial_readiness() {
        let mut recovery = EngineRecovery::default();

        assert!(recovery.restart());
        assert!(!recovery.mark_core_connected());
        assert!(!recovery.restart());
        assert!(!recovery.mark_tunnel_ready());
        assert!(recovery.mark_core_connected());
    }

    #[test]
    fn switching_connector_tracks_the_current_tunnel() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
            .block_on(async {
                let connector = SwitchingConnector::new();
                let target = ProxyTarget {
                    host: "example.test".to_string(),
                    port: 443,
                };

                assert!(connector.connect(&target).await.is_err());

                let first_generation = connector.reset();
                assert!(connector.replace(first_generation, Arc::new(MarkerConnector(1))));
                let mut first = connector.connect(&target).await.expect("first tunnel");
                let mut marker = [0];
                first.read_exact(&mut marker).await.expect("first marker");
                assert_eq!(marker, [1]);

                let second_generation = connector.reset();
                assert!(!connector.clear_if_current(first_generation));
                assert!(connector.replace(second_generation, Arc::new(MarkerConnector(2))));
                let mut second = connector.connect(&target).await.expect("second tunnel");
                second.read_exact(&mut marker).await.expect("second marker");
                assert_eq!(marker, [2]);

                assert!(connector.clear_if_current(second_generation));
                assert!(connector.connect(&target).await.is_err());
            });
    }
}
