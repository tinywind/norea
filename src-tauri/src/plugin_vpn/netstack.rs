use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant as StdInstant},
};

use smoltcp::{
    iface::{Config as InterfaceConfig, Interface, SocketHandle, SocketSet},
    phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken},
    socket::{dns, tcp},
    time::{Duration as SmolDuration, Instant},
    wire::{DnsQueryType, HardwareAddress, IpAddress, IpCidr},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    runtime::Handle,
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use super::{
    proxy::{ConnectFuture, ProxyConnector, ProxyStream, ProxyTarget},
    transport::ProxyConnectError,
    tunnel_config::TunnelConfiguration,
};

const COMMAND_CAPACITY: usize = 256;
const INBOUND_PACKET_CAPACITY: usize = 512;
const CONNECTION_DATA_CAPACITY: usize = 32;
const MAX_DNS_SERVERS: usize = 8;
const TCP_BUFFER_BYTES: usize = 64 * 1024;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;
const STREAM_CHUNK_BYTES: usize = 16 * 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(16);
// Keep DNS lookup under Chromium/WebView's 10s proxy CONNECT timeout so the
// local proxy records the DNS failure and replies 502 before WebView aborts.
const DNS_LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
const DNS_SERVER_HEDGE_DELAY: Duration = Duration::from_millis(1_500);
const DNS_FAMILY_GRACE: Duration = Duration::from_millis(250);
// Cap total TCP connect time across multi-IP answers below Chromium/WebView's
// proxy CONNECT timeout so 502 and transport diagnostics arrive before WebView aborts.
const TCP_DIAL_TIMEOUT: Duration = Duration::from_secs(9);
const TCP_SINGLE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const TCP_MULTI_ATTEMPT_TIMEOUT: Duration = Duration::from_millis(4_500);
const TCP_IDLE_TIMEOUT: SmolDuration = SmolDuration::from_secs(5 * 60);
const MAX_TIMER_DELAY: Duration = Duration::from_millis(100);
const ZOMBIE_TUNNEL_TIMEOUT_THRESHOLD: u32 = 3;
pub(super) const ZOMBIE_TUNNEL_ERROR: &str =
    "VPN tunnel stopped carrying traffic (consecutive DNS/TCP timeouts)";
pub(super) const CONNECT_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const TUNNEL_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const LIVENESS_PROBE_HEDGE_DELAY: Duration = Duration::from_millis(1_500);
const LIVENESS_PROBE_TARGETS: &[(&str, u16)] = &[
    ("one.one.one.one", 443),
    ("dns.google", 443),
];

pub(super) trait PacketSink: Send + Sync + 'static {
    fn send(&self, packet: &[u8]) -> bool;
}

#[derive(Clone)]
pub(super) struct TunnelHealthHandle {
    commands: mpsc::Sender<Command>,
    started_at: StdInstant,
    last_liveness_ms: Arc<AtomicU64>,
    probe_lock: Arc<tokio::sync::Mutex<()>>,
}

impl TunnelHealthHandle {
    pub(super) fn last_liveness_elapsed(&self) -> Duration {
        let recorded = Duration::from_millis(self.last_liveness_ms.load(Ordering::Acquire));
        self.started_at.elapsed().saturating_sub(recorded)
    }

    pub(super) async fn probe_liveness(&self, timeout: Duration) -> Result<(), String> {
        probe_tunnel_liveness_via_commands(&self.commands, timeout).await
    }

    pub(super) async fn check_health(&self, max_idle: Option<Duration>) -> Result<(), String> {
        if let Some(limit) = max_idle {
            if self.last_liveness_elapsed() < limit {
                return Ok(());
            }
        }
        let _guard = self.probe_lock.lock().await;
        if let Some(limit) = max_idle {
            if self.last_liveness_elapsed() < limit {
                return Ok(());
            }
        }
        match probe_tunnel_liveness_via_commands(&self.commands, TUNNEL_LIVENESS_PROBE_TIMEOUT).await {
            Ok(()) => Ok(()),
            Err(detail) => {
                let _ = self
                    .commands
                    .send(Command::FailZombie {
                        reason: format!("health probe failed: {detail}"),
                    })
                    .await;
                Err(ZOMBIE_TUNNEL_ERROR.to_string())
            }
        }
    }
}

pub(super) struct UserSpaceNetwork {
    inbound: mpsc::Sender<Vec<u8>>,
    connector: Arc<TunnelConnector>,
    health: TunnelHealthHandle,
    task: JoinHandle<()>,
}

impl UserSpaceNetwork {
    pub(super) fn start(
        runtime: &Handle,
        configuration: TunnelConfiguration,
        sink: Arc<dyn PacketSink>,
        active_liveness_probe: bool,
        failure: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        let (commands, command_receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (inbound, inbound_receiver) = mpsc::channel(INBOUND_PACKET_CAPACITY);
        let started_at = StdInstant::now();
        let last_liveness_ms = Arc::new(AtomicU64::new(0));
        let stack = Netstack::new(
            configuration,
            sink,
            commands.clone(),
            command_receiver,
            inbound_receiver,
            started_at,
            last_liveness_ms.clone(),
            active_liveness_probe,
        )?;
        let task = runtime.spawn(async move {
            if let Err(error) = stack.run().await {
                failure(error);
            }
        });
        let health = TunnelHealthHandle {
            commands: commands.clone(),
            started_at,
            last_liveness_ms,
            probe_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        Ok(Self {
            inbound,
            connector: Arc::new(TunnelConnector { commands }),
            health,
            task,
        })
    }

    pub(super) fn receive(&self, packet: &[u8]) -> bool {
        !packet.is_empty()
            && packet.len() <= u16::MAX as usize
            && self.inbound.try_send(packet.to_vec()).is_ok()
    }

    pub(super) fn connector(&self) -> Arc<dyn ProxyConnector> {
        self.connector.clone()
    }

    pub(super) fn health_handle(&self) -> TunnelHealthHandle {
        self.health.clone()
    }

    pub(super) fn stop(self) {
        self.task.abort();
    }
}

struct ProbeFlagGuard(Arc<AtomicBool>);

impl Drop for ProbeFlagGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

async fn probe_single_target(
    commands: &mpsc::Sender<Command>,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<(), String> {
    let (reply, response) = oneshot::channel();
    commands
        .send(Command::Probe {
            host: host.to_string(),
            port,
            timeout,
            reply,
        })
        .await
        .map_err(|_| "VPN network stack is not running".to_string())?;
    let result = tokio::time::timeout(timeout + Duration::from_millis(250), response)
        .await
        .map_err(|_| format!("liveness probe to {host}:{port} timed out"))?
        .map_err(|_| "VPN network stack stopped during liveness probe".to_string())?;
    match result {
        Ok(_stream) => Ok(()),
        Err(error) => Err(format!("liveness probe to {host}:{port} failed: {}", error.message)),
    }
}

async fn probe_tunnel_liveness_via_commands(
    commands: &mpsc::Sender<Command>,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = StdInstant::now() + timeout;
    let (primary_host, primary_port) = LIVENESS_PROBE_TARGETS[0];
    let (secondary_host, secondary_port) = LIVENESS_PROBE_TARGETS[1];
    let primary_timeout = deadline.saturating_duration_since(StdInstant::now());
    if primary_timeout.is_zero() {
        return Err("liveness probe timed out".to_string());
    }
    let primary = probe_single_target(commands, primary_host, primary_port, primary_timeout);
    tokio::pin!(primary);

    let hedge_delay = LIVENESS_PROBE_HEDGE_DELAY.min(primary_timeout);
    let primary_error = tokio::select! {
        result = &mut primary => match result {
            Ok(()) => return Ok(()),
            Err(error) => Some(error),
        },
        () = tokio::time::sleep(hedge_delay) => None,
    };

    let remaining = deadline.saturating_duration_since(StdInstant::now());
    if remaining.is_zero() {
        return Err(primary_error.unwrap_or_else(|| "liveness probe timed out".to_string()));
    }

    if let Some(first_error) = primary_error {
        return probe_single_target(commands, secondary_host, secondary_port, remaining)
            .await
            .map_err(|second_error| format!("{first_error}; {second_error}"));
    }

    let secondary = probe_single_target(commands, secondary_host, secondary_port, remaining);
    tokio::pin!(secondary);

    tokio::select! {
        first = &mut primary => match first {
            Ok(()) => Ok(()),
            Err(first_error) => match secondary.await {
                Ok(()) => Ok(()),
                Err(second_error) => Err(format!("{first_error}; {second_error}")),
            },
        },
        second = &mut secondary => match second {
            Ok(()) => Ok(()),
            Err(second_error) => match primary.await {
                Ok(()) => Ok(()),
                Err(first_error) => Err(format!("{first_error}; {second_error}")),
            },
        },
    }
}

struct TunnelConnector {
    commands: mpsc::Sender<Command>,
}

impl ProxyConnector for TunnelConnector {
    fn connect<'a>(&'a self, target: &'a ProxyTarget) -> ConnectFuture<'a> {
        Box::pin(async move {
            let (reply, response) = oneshot::channel();
            self.commands
                .send(Command::Dial {
                    host: target.host.clone(),
                    port: target.port,
                    reply,
                })
                .await
                .map_err(|_| "VPN network stack is not running".to_string())?;
            let stream = response
                .await
                .map_err(|_| "VPN network stack stopped while connecting".to_string())??;
            Ok(Box::new(stream) as ProxyStream)
        })
    }
}

enum Command {
    Dial {
        host: String,
        port: u16,
        reply: oneshot::Sender<Result<DuplexStream, ProxyConnectError>>,
    },
    Probe {
        host: String,
        port: u16,
        timeout: Duration,
        reply: oneshot::Sender<Result<DuplexStream, ProxyConnectError>>,
    },
    FailZombie {
        reason: String,
    },
    Write {
        id: u64,
        bytes: Vec<u8>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Close {
        id: u64,
    },
}

struct Netstack {
    interface: Interface,
    device: PacketDevice,
    sockets: SocketSet<'static>,
    dns_sockets: Vec<SocketHandle>,
    preferred_dns_server: usize,
    commands: mpsc::Sender<Command>,
    command_receiver: mpsc::Receiver<Command>,
    inbound_receiver: mpsc::Receiver<Vec<u8>>,
    resolutions: Vec<Resolution>,
    connections: HashMap<u64, Connection>,
    local_ipv4: Option<std::net::Ipv4Addr>,
    local_ipv6: Option<std::net::Ipv6Addr>,
    next_connection_id: u64,
    next_port: u16,
    started_at: StdInstant,
    last_liveness_ms: Arc<AtomicU64>,
    active_liveness_probe: bool,
    probe_in_flight: Arc<AtomicBool>,
    consecutive_dial_timeouts: u32,
}

struct ActiveDnsQuery {
    server_index: usize,
    handle: dns::QueryHandle,
}

struct Resolution {
    host: String,
    port: u16,
    reply: oneshot::Sender<Result<DuplexStream, ProxyConnectError>>,
    queries: Vec<ActiveDnsQuery>,
    remaining_servers: VecDeque<usize>,
    next_server_at: Option<StdInstant>,
    addresses: Vec<IpAddr>,
    grace_deadline: Option<StdInstant>,
    dns_deadline: StdInstant,
    dial_deadline: StdInstant,
    is_probe: bool,
}

struct Connection {
    socket: SocketHandle,
    reply: Option<oneshot::Sender<Result<DuplexStream, ProxyConnectError>>>,
    inbound: Option<mpsc::Sender<Vec<u8>>>,
    pending_writes: VecDeque<PendingWrite>,
    remote_port: u16,
    remaining_addresses: VecDeque<IpAddr>,
    overall_deadline: StdInstant,
    attempt_deadline: StdInstant,
    established: bool,
    is_probe: bool,
}

struct PendingWrite {
    bytes: Vec<u8>,
    offset: usize,
    reply: oneshot::Sender<Result<(), String>>,
}

impl Netstack {
    fn new(
        configuration: TunnelConfiguration,
        sink: Arc<dyn PacketSink>,
        commands: mpsc::Sender<Command>,
        command_receiver: mpsc::Receiver<Command>,
        inbound_receiver: mpsc::Receiver<Vec<u8>>,
        started_at: StdInstant,
        last_liveness_ms: Arc<AtomicU64>,
        active_liveness_probe: bool,
    ) -> Result<Self, String> {
        let mut seed = [0; 8];
        getrandom::fill(&mut seed)
            .map_err(|error| format!("could not seed the VPN network stack: {error}"))?;
        let seed = u64::from_ne_bytes(seed);
        let next_port = 49_152 + (seed % 16_384) as u16;
        let failed = Arc::new(AtomicBool::new(false));
        let mut device = PacketDevice {
            packets: VecDeque::new(),
            sink,
            failed,
            mtu: configuration.mtu,
        };
        let mut interface_config = InterfaceConfig::new(HardwareAddress::Ip);
        interface_config.random_seed = seed;
        let mut interface = Interface::new(interface_config, &mut device, Instant::from_millis(0));
        interface.update_ip_addrs(|addresses| {
            if let Some(address) = configuration.ipv4 {
                addresses
                    .push(IpCidr::new(IpAddress::from(IpAddr::V4(address)), 32))
                    .expect("IPv4 interface address capacity");
            }
            if let Some(address) = configuration.ipv6 {
                addresses
                    .push(IpCidr::new(IpAddress::from(IpAddr::V6(address)), 128))
                    .expect("IPv6 interface address capacity");
            }
        });
        if let Some(gateway) = configuration.gateway_ipv4 {
            interface
                .routes_mut()
                .add_default_ipv4_route(gateway)
                .map_err(|_| "could not install the VPN IPv4 route".to_string())?;
        }
        if let Some(gateway) = configuration.gateway_ipv6 {
            interface
                .routes_mut()
                .add_default_ipv6_route(gateway)
                .map_err(|_| "could not install the VPN IPv6 route".to_string())?;
        }

        let mut unique_dns_servers = Vec::new();
        for server in configuration.dns_servers {
            if !unique_dns_servers.contains(&server) {
                unique_dns_servers.push(server);
                if unique_dns_servers.len() >= MAX_DNS_SERVERS {
                    break;
                }
            }
        }
        let mut sockets = SocketSet::new(Vec::new());
        // Keep one smoltcp DNS socket per pushed server so failover across
        // stalled servers can hedge before smoltcp's 10s per-server timeout.
        let dns_sockets = unique_dns_servers
            .into_iter()
            .map(|server| sockets.add(dns::Socket::new(&[IpAddress::from(server)], Vec::new())))
            .collect::<Vec<_>>();

        Ok(Self {
            interface,
            device,
            sockets,
            dns_sockets,
            preferred_dns_server: 0,
            commands,
            command_receiver,
            inbound_receiver,
            resolutions: Vec::new(),
            connections: HashMap::new(),
            local_ipv4: configuration.ipv4,
            local_ipv6: configuration.ipv6,
            next_connection_id: 1,
            next_port,
            started_at,
            last_liveness_ms,
            active_liveness_probe,
            probe_in_flight: Arc::new(AtomicBool::new(false)),
            consecutive_dial_timeouts: 0,
        })
    }

    fn record_tunnel_liveness(&mut self) {
        self.consecutive_dial_timeouts = 0;
        let elapsed_ms = self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        self.last_liveness_ms.store(elapsed_ms, Ordering::Release);
    }

    fn record_dial_timeout(&mut self) -> Result<(), String> {
        self.consecutive_dial_timeouts = self.consecutive_dial_timeouts.saturating_add(1);
        if self.consecutive_dial_timeouts >= ZOMBIE_TUNNEL_TIMEOUT_THRESHOLD {
            log::warn!(
                "plugin VPN tunnel became unresponsive after {} consecutive DNS/TCP dial timeouts",
                self.consecutive_dial_timeouts
            );
            return Err(ZOMBIE_TUNNEL_ERROR.to_string());
        }
        if self.active_liveness_probe
            && self
                .probe_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
        {
            if let Ok(runtime) = Handle::try_current() {
                let commands = self.commands.clone();
                let flag = self.probe_in_flight.clone();
                runtime.spawn(async move {
                    let _guard = ProbeFlagGuard(flag);
                    match probe_tunnel_liveness_via_commands(
                        &commands,
                        TUNNEL_LIVENESS_PROBE_TIMEOUT,
                    )
                    .await
                    {
                        Ok(()) => {
                            log::debug!(
                                "plugin VPN tunnel passed active liveness probe after dial timeout"
                            );
                        }
                        Err(detail) => {
                            log::warn!(
                                "plugin VPN tunnel failed active liveness probe after dial timeout: {detail}"
                            );
                            let _ = commands
                                .send(Command::FailZombie {
                                    reason: format!(
                                        "active liveness probe failed after dial timeout: {detail}"
                                    ),
                                })
                                .await;
                        }
                    }
                });
            } else {
                self.probe_in_flight.store(false, Ordering::Release);
            }
        }
        Ok(())
    }

    async fn run(mut self) -> Result<(), String> {
        loop {
            self.drain_inputs()?;
            let now = self.timestamp();
            self.interface
                .poll(now, &mut self.device, &mut self.sockets);
            self.process_resolutions()?;
            self.process_connections()?;
            if self.device.failed.load(Ordering::Acquire) {
                return Err("OpenVPN stopped accepting network packets".to_string());
            }

            let delay = self
                .interface
                .poll_delay(now, &self.sockets)
                .map(|delay| Duration::from_micros(delay.total_micros()))
                .unwrap_or(MAX_TIMER_DELAY)
                .min(self.next_resolution_delay())
                .min(MAX_TIMER_DELAY);
            tokio::select! {
                command = self.command_receiver.recv() => match command {
                    Some(command) => self.handle_command(command)?,
                    None => return Ok(()),
                },
                packet = self.inbound_receiver.recv() => match packet {
                    Some(packet) => self.device.packets.push_back(packet),
                    None => return Ok(()),
                },
                () = tokio::time::sleep(delay) => {}
            }
        }
    }

    fn drain_inputs(&mut self) -> Result<(), String> {
        for _ in 0..COMMAND_CAPACITY {
            match self.command_receiver.try_recv() {
                Ok(command) => self.handle_command(command)?,
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        for _ in 0..INBOUND_PACKET_CAPACITY {
            match self.inbound_receiver.try_recv() {
                Ok(packet) => self.device.packets.push_back(packet),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return Ok(()),
            }
        }
        Ok(())
    }

    fn handle_command(&mut self, command: Command) -> Result<(), String> {
        match command {
            Command::Dial { host, port, reply } => self.start_dial(host, port, reply, None, false),
            Command::Probe {
                host,
                port,
                timeout,
                reply,
            } => self.start_dial(host, port, reply, Some(timeout), true),
            Command::FailZombie { reason } => {
                log::warn!("plugin VPN tunnel marked unresponsive: {reason}");
                Err(ZOMBIE_TUNNEL_ERROR.to_string())
            }
            Command::Write { id, bytes, reply } => {
                if let Some(connection) = self.connections.get_mut(&id) {
                    connection.pending_writes.push_back(PendingWrite {
                        bytes,
                        offset: 0,
                        reply,
                    });
                } else {
                    let _ = reply.send(Err("VPN connection is closed".to_string()));
                }
                Ok(())
            }
            Command::Close { id } => {
                self.remove_connection(id, "VPN connection was closed");
                Ok(())
            }
        }
    }

    fn start_dial(
        &mut self,
        host: String,
        port: u16,
        reply: oneshot::Sender<Result<DuplexStream, ProxyConnectError>>,
        timeout_override: Option<Duration>,
        is_probe: bool,
    ) -> Result<(), String> {
        let now = StdInstant::now();
        if let Ok(address) = host.parse::<IpAddr>() {
            let tcp_timeout = timeout_override
                .map(|limit| limit.min(TCP_DIAL_TIMEOUT))
                .unwrap_or(TCP_DIAL_TIMEOUT);
            return self.start_tcp_candidates(
                std::iter::once(address).collect(),
                port,
                reply,
                now + tcp_timeout,
                None,
                false,
                is_probe,
            );
        }

        if self.dns_sockets.is_empty() {
            let _ = reply.send(Err(ProxyConnectError::dns(
                "OpenVPN supplied no usable in-tunnel DNS server",
            )));
            return Ok(());
        }

        let server_count = self.dns_sockets.len();
        let start_index = self.preferred_dns_server % server_count;
        let mut remaining_servers = (0..server_count)
            .map(|offset| (start_index + offset) % server_count)
            .collect::<VecDeque<_>>();
        let mut queries = Vec::new();
        let query_error = self.start_next_dns_server(&host, &mut remaining_servers, &mut queries);
        if queries.is_empty() {
            let error = query_error.unwrap_or_else(|| {
                ProxyConnectError::tunnel("VPN has no usable address family")
            });
            let _ = reply.send(Err(error));
            return Ok(());
        }

        let dial_deadline = now + timeout_override.unwrap_or(DIAL_TIMEOUT);
        let dns_deadline = (now + DNS_LOOKUP_TIMEOUT).min(dial_deadline);
        let next_server_at = (!remaining_servers.is_empty())
            .then(|| (now + DNS_SERVER_HEDGE_DELAY).min(dns_deadline));
        self.resolutions.push(Resolution {
            host,
            port,
            reply,
            queries,
            remaining_servers,
            next_server_at,
            addresses: Vec::new(),
            grace_deadline: None,
            dns_deadline,
            dial_deadline,
            is_probe,
        });
        Ok(())
    }

    fn start_dns_queries_on_server(
        &mut self,
        server_index: usize,
        host: &str,
    ) -> Result<Vec<ActiveDnsQuery>, ProxyConnectError> {
        let mut queries = Vec::new();
        let mut query_error = None;
        let socket = self.dns_sockets[server_index];
        let dns = self.sockets.get_mut::<dns::Socket>(socket);
        if self.local_ipv4.is_some() {
            match dns.start_query(self.interface.context(), host, DnsQueryType::A) {
                Ok(handle) => queries.push(ActiveDnsQuery {
                    server_index,
                    handle,
                }),
                Err(error) => {
                    query_error = Some(format!("could not start VPN DNS lookup: {error}"));
                }
            }
        }
        if self.local_ipv6.is_some() {
            match dns.start_query(self.interface.context(), host, DnsQueryType::Aaaa) {
                Ok(handle) => queries.push(ActiveDnsQuery {
                    server_index,
                    handle,
                }),
                Err(error) => {
                    query_error = Some(format!("could not start VPN DNS lookup: {error}"));
                }
            }
        }
        if queries.is_empty() {
            Err(query_error
                .map(ProxyConnectError::dns)
                .unwrap_or_else(|| ProxyConnectError::tunnel("VPN has no usable address family")))
        } else {
            Ok(queries)
        }
    }

    fn start_next_dns_server(
        &mut self,
        host: &str,
        remaining_servers: &mut VecDeque<usize>,
        active: &mut Vec<ActiveDnsQuery>,
    ) -> Option<ProxyConnectError> {
        let mut last_error = None;
        while let Some(server_index) = remaining_servers.pop_front() {
            match self.start_dns_queries_on_server(server_index, host) {
                Ok(started) => {
                    active.extend(started);
                    return None;
                }
                Err(error) => {
                    last_error = Some(error);
                }
            }
        }
        last_error
    }

    fn next_resolution_delay(&self) -> Duration {
        let now = StdInstant::now();
        self.resolutions
            .iter()
            .flat_map(|resolution| {
                [
                    Some(resolution.dns_deadline),
                    resolution.next_server_at,
                    resolution.grace_deadline,
                ]
            })
            .flatten()
            .map(|deadline| deadline.saturating_duration_since(now))
            .min()
            .unwrap_or(MAX_TIMER_DELAY)
    }

    fn process_resolutions(&mut self) -> Result<(), String> {
        let mut pending = Vec::new();
        let mut dial_timeouts = 0u32;
        for mut resolution in std::mem::take(&mut self.resolutions) {
            if resolution.reply.is_closed() {
                self.cancel_queries(&resolution.queries);
                continue;
            }
            let mut active = Vec::new();
            let mut winning_server = None;
            for query in resolution.queries {
                let socket = self.dns_sockets[query.server_index];
                match self
                    .sockets
                    .get_mut::<dns::Socket>(socket)
                    .get_query_result(query.handle)
                {
                    Ok(addresses) => {
                        let previous_len = resolution.addresses.len();
                        for address in addresses {
                            let address = IpAddr::from(address);
                            add_usable_dns_address(&mut resolution.addresses, address);
                        }
                        if resolution.addresses.len() > previous_len && winning_server.is_none() {
                            winning_server = Some(query.server_index);
                        }
                    }
                    Err(dns::GetQueryResultError::Pending) => active.push(query),
                    // smoltcp reports both negative answers and exhausted DNS
                    // server timeouts as Failed. Do not invent an NXDOMAIN cause.
                    Err(dns::GetQueryResultError::Failed) => {}
                }
            }
            if let Some(winner) = winning_server {
                self.preferred_dns_server = winner;
                let mut winner_queries = Vec::new();
                let mut other_queries = Vec::new();
                for query in active {
                    if query.server_index == winner {
                        winner_queries.push(query);
                    } else {
                        other_queries.push(query);
                    }
                }
                self.cancel_queries(&other_queries);
                active = winner_queries;
                resolution.remaining_servers.clear();
                resolution.next_server_at = None;
            }
            let now = StdInstant::now();
            let grace_expired = resolution
                .grace_deadline
                .is_some_and(|deadline| now >= deadline);
            if !resolution.addresses.is_empty()
                && (active.is_empty() || grace_expired || now >= resolution.dns_deadline)
            {
                self.cancel_queries(&active);
                let tcp_deadline = (now + TCP_DIAL_TIMEOUT).min(resolution.dial_deadline);
                self.start_tcp_candidates(
                    interleave_address_families(resolution.addresses),
                    resolution.port,
                    resolution.reply,
                    tcp_deadline,
                    None,
                    false,
                    resolution.is_probe,
                )?;
                continue;
            }
            if resolution.addresses.is_empty()
                && now < resolution.dns_deadline
                && !resolution.remaining_servers.is_empty()
                && (active.is_empty()
                    || resolution.next_server_at.is_some_and(|at| now >= at))
            {
                let _ = self.start_next_dns_server(
                    &resolution.host,
                    &mut resolution.remaining_servers,
                    &mut active,
                );
                resolution.next_server_at = (!resolution.remaining_servers.is_empty())
                    .then(|| (now + DNS_SERVER_HEDGE_DELAY).min(resolution.dns_deadline));
            }
            if active.is_empty() {
                let _ = resolution
                    .reply
                    .send(Err(ProxyConnectError::dns("VPN DNS lookup failed or returned no usable address")));
            } else if now >= resolution.dns_deadline {
                self.cancel_queries(&active);
                let _ = resolution
                    .reply
                    .send(Err(ProxyConnectError::dns("VPN DNS lookup timed out")));
                if !resolution.is_probe {
                    dial_timeouts = dial_timeouts.saturating_add(1);
                }
            } else {
                if !resolution.addresses.is_empty() && resolution.grace_deadline.is_none() {
                    resolution.grace_deadline =
                        Some((now + DNS_FAMILY_GRACE).min(resolution.dns_deadline));
                }
                resolution.queries = active;
                pending.push(resolution);
            }
        }
        self.resolutions = pending;
        for _ in 0..dial_timeouts {
            self.record_dial_timeout()?;
        }
        Ok(())
    }

    fn cancel_queries(&mut self, queries: &[ActiveDnsQuery]) {
        for query in queries {
            let socket = self.dns_sockets[query.server_index];
            self.sockets
                .get_mut::<dns::Socket>(socket)
                .cancel_query(query.handle);
        }
    }

    fn start_tcp_candidates(
        &mut self,
        mut addresses: VecDeque<IpAddr>,
        port: u16,
        reply: oneshot::Sender<Result<DuplexStream, ProxyConnectError>>,
        overall_deadline: StdInstant,
        mut last_error: Option<String>,
        timed_out: bool,
        is_probe: bool,
    ) -> Result<(), String> {
        if reply.is_closed() {
            return Ok(());
        }
        if port == 0 {
            let _ = reply.send(Err(ProxyConnectError::tcp("invalid VPN connection target")));
            return Ok(());
        }
        if StdInstant::now() >= overall_deadline {
            let _ = reply.send(Err(ProxyConnectError::tcp("VPN TCP connection timed out")));
            if !is_probe {
                return self.record_dial_timeout();
            }
            return Ok(());
        }

        while let Some(remote) = addresses.pop_front() {
            if is_disallowed_tunnel_address(remote) {
                last_error = Some("invalid VPN connection target".to_string());
                continue;
            }
            let local = match remote {
                IpAddr::V4(_) => self.local_ipv4.map(IpAddr::V4),
                IpAddr::V6(_) => self.local_ipv6.map(IpAddr::V6),
            };
            let Some(local) = local else {
                last_error = Some("VPN does not support the target address family".to_string());
                continue;
            };
            let local_port = match self.allocate_port() {
                Ok(port) => port,
                Err(error) => {
                    let _ = reply.send(Err(ProxyConnectError::tcp(error)));
                    return Ok(());
                }
            };
            let mut socket = tcp::Socket::new(
                tcp::SocketBuffer::new(vec![0; TCP_BUFFER_BYTES]),
                tcp::SocketBuffer::new(vec![0; TCP_BUFFER_BYTES]),
            );
            socket.set_timeout(Some(TCP_IDLE_TIMEOUT));
            socket.set_keep_alive(Some(SmolDuration::from_secs(30)));
            socket.set_nagle_enabled(false);
            if let Err(error) = socket.connect(
                self.interface.context(),
                SocketAddr::new(remote, port),
                SocketAddr::new(local, local_port),
            ) {
                last_error = Some(format!("could not start VPN TCP connection: {error}"));
                continue;
            }
            let socket = self.sockets.add(socket);
            let id = self.next_connection_id;
            self.next_connection_id = self.next_connection_id.wrapping_add(1).max(1);
            let attempt_timeout = if addresses.is_empty() {
                TCP_SINGLE_ATTEMPT_TIMEOUT
            } else {
                TCP_MULTI_ATTEMPT_TIMEOUT
            };
            self.connections.insert(
                id,
                Connection {
                    socket,
                    reply: Some(reply),
                    inbound: None,
                    pending_writes: VecDeque::new(),
                    remote_port: port,
                    remaining_addresses: addresses,
                    overall_deadline,
                    attempt_deadline: (StdInstant::now() + attempt_timeout)
                        .min(overall_deadline),
                    established: false,
                    is_probe,
                },
            );
            return Ok(());
        }

        let error = last_error.map(ProxyConnectError::tcp)
            .unwrap_or_else(|| ProxyConnectError::dns("VPN DNS lookup returned no usable address"));
        let _ = reply.send(Err(error));
        if timed_out && !is_probe {
            return self.record_dial_timeout();
        }
        Ok(())
    }

    fn process_connections(&mut self) -> Result<(), String> {
        let ids = self.connections.keys().copied().collect::<Vec<_>>();
        let mut remove = Vec::<(u64, String, bool)>::new();
        let mut retry = Vec::<(u64, String, bool)>::new();
        let mut saw_liveness = false;
        for id in ids {
            let Some(connection) = self.connections.get_mut(&id) else {
                continue;
            };
            let socket = self.sockets.get_mut::<tcp::Socket>(connection.socket);
            if !connection.established {
                let cancelled = connection
                    .reply
                    .as_ref()
                    .is_none_or(oneshot::Sender::is_closed);
                if cancelled {
                    remove.push((id, "VPN TCP requester closed".to_string(), false));
                    continue;
                }
                if StdInstant::now() >= connection.overall_deadline {
                    remove.push((id, "VPN TCP connection timed out".to_string(), !connection.is_probe));
                    continue;
                }
                if StdInstant::now() >= connection.attempt_deadline {
                    retry.push((id, "VPN TCP connection attempt timed out".to_string(), !connection.is_probe));
                    continue;
                }
                if socket.state() == tcp::State::Established {
                    saw_liveness = true;
                    let (client, bridge) = tokio::io::duplex(STREAM_BUFFER_BYTES);
                    let (inbound, inbound_receiver) = mpsc::channel(CONNECTION_DATA_CAPACITY);
                    spawn_stream_bridge(id, bridge, inbound_receiver, self.commands.clone());
                    connection.inbound = Some(inbound);
                    connection.remaining_addresses.clear();
                    connection.established = true;
                    let delivered = connection
                        .reply
                        .take()
                        .is_some_and(|reply| reply.send(Ok(client)).is_ok());
                    if !delivered {
                        remove.push((id, "VPN TCP requester closed".to_string(), false));
                        continue;
                    }
                } else if socket.state() == tcp::State::Closed {
                    // Receiving a peer RST before timeout proves packets traverse the tunnel.
                    saw_liveness = true;
                    retry.push((id, "VPN TCP connection failed".to_string(), false));
                    continue;
                }
            }

            let mut connection_error = None;
            while socket.can_send() {
                let Some(write) = connection.pending_writes.front_mut() else {
                    break;
                };
                let count = match socket.send_slice(&write.bytes[write.offset..]) {
                    Ok(count) => count,
                    Err(error) => {
                        connection_error = Some(format!("could not write VPN TCP data: {error}"));
                        break;
                    }
                };
                if count == 0 {
                    break;
                }
                write.offset += count;
                if write.offset == write.bytes.len() {
                    let write = connection
                        .pending_writes
                        .pop_front()
                        .expect("pending VPN write");
                    let _ = write.reply.send(Ok(()));
                }
            }
            if let Some(error) = connection_error {
                remove.push((id, error, false));
                continue;
            }

            if socket.can_recv()
                && connection
                    .inbound
                    .as_ref()
                    .is_some_and(|sender| sender.capacity() > 0)
            {
                let mut bytes = vec![0; STREAM_CHUNK_BYTES];
                let count = match socket.recv_slice(&mut bytes) {
                    Ok(count) => count,
                    Err(error) => {
                        remove.push((id, format!("could not read VPN TCP data: {error}"), false));
                        continue;
                    }
                };
                bytes.truncate(count);
                if count > 0 {
                    saw_liveness = true;
                    if connection
                        .inbound
                        .as_ref()
                        .is_some_and(|sender| sender.try_send(bytes).is_err())
                    {
                        remove.push((id, "VPN TCP receive buffer closed".to_string(), false));
                        continue;
                    }
                }
            }
            if connection.established && !socket.may_recv() && socket.recv_queue() == 0 {
                connection.inbound.take();
            }
            if connection.established && socket.state() == tcp::State::Closed {
                remove.push((id, "VPN TCP connection closed".to_string(), false));
            }
        }
        if saw_liveness {
            self.record_tunnel_liveness();
        }
        for (id, reason, dial_timeout) in remove {
            self.remove_connection(id, &reason);
            if dial_timeout {
                self.record_dial_timeout()?;
            }
        }
        for (id, reason, timed_out) in retry {
            self.retry_connection(id, &reason, timed_out)?;
        }
        Ok(())
    }

    fn retry_connection(&mut self, id: u64, reason: &str, timed_out: bool) -> Result<(), String> {
        let Some(mut connection) = self.connections.remove(&id) else {
            return Ok(());
        };
        self.sockets
            .get_mut::<tcp::Socket>(connection.socket)
            .abort();
        self.sockets.remove(connection.socket);
        for write in connection.pending_writes {
            let _ = write.reply.send(Err(reason.to_string()));
        }
        let Some(reply) = connection.reply.take() else {
            return Ok(());
        };
        self.start_tcp_candidates(
            connection.remaining_addresses,
            connection.remote_port,
            reply,
            connection.overall_deadline,
            Some(reason.to_string()),
            timed_out,
            connection.is_probe,
        )
    }

    fn remove_connection(&mut self, id: u64, reason: &str) {
        let Some(mut connection) = self.connections.remove(&id) else {
            return;
        };
        self.sockets
            .get_mut::<tcp::Socket>(connection.socket)
            .abort();
        self.sockets.remove(connection.socket);
        if let Some(reply) = connection.reply.take() {
            let _ = reply.send(Err(ProxyConnectError::tcp(reason)));
        }
        for write in connection.pending_writes {
            let _ = write.reply.send(Err(reason.to_string()));
        }
    }

    fn allocate_port(&mut self) -> Result<u16, String> {
        for _ in 0..16_384 {
            let port = self.next_port;
            self.next_port = if port == 65_535 { 49_152 } else { port + 1 };
            let in_use = self.connections.values().any(|connection| {
                self.sockets
                    .get::<tcp::Socket>(connection.socket)
                    .local_endpoint()
                    .is_some_and(|endpoint| endpoint.port == port)
            });
            if !in_use {
                return Ok(port);
            }
        }
        Err("VPN TCP port range is exhausted".to_string())
    }

    fn timestamp(&self) -> Instant {
        let millis = self.started_at.elapsed().as_millis().min(i64::MAX as u128) as i64;
        Instant::from_millis(millis)
    }
}

fn is_disallowed_tunnel_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_unspecified()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_multicast()
                || address.is_broadcast()
        }
        IpAddr::V6(address) => {
            address.is_unspecified()
                || address.is_loopback()
                || address.is_unicast_link_local()
                || address.is_multicast()
                || address.to_ipv4().is_some_and(|mapped| {
                    mapped.is_unspecified()
                        || mapped.is_loopback()
                        || mapped.is_link_local()
                        || mapped.is_multicast()
                        || mapped.is_broadcast()
                })
        }
    }
}

fn interleave_address_families(addresses: Vec<IpAddr>) -> VecDeque<IpAddr> {
    let prefer_ipv4 = addresses.first().is_none_or(IpAddr::is_ipv4);
    let mut ipv4 = addresses
        .iter()
        .copied()
        .filter(IpAddr::is_ipv4)
        .collect::<VecDeque<_>>();
    let mut ipv6 = addresses
        .into_iter()
        .filter(IpAddr::is_ipv6)
        .collect::<VecDeque<_>>();
    let mut candidates = VecDeque::with_capacity(ipv4.len() + ipv6.len());
    let mut take_ipv4 = prefer_ipv4;
    while !ipv4.is_empty() || !ipv6.is_empty() {
        let candidate = if take_ipv4 {
            ipv4.pop_front().or_else(|| ipv6.pop_front())
        } else {
            ipv6.pop_front().or_else(|| ipv4.pop_front())
        };
        if let Some(candidate) = candidate {
            candidates.push_back(candidate);
        }
        take_ipv4 = !take_ipv4;
    }
    candidates
}

fn add_usable_dns_address(addresses: &mut Vec<IpAddr>, address: IpAddr) {
    if !is_disallowed_tunnel_address(address) && !addresses.contains(&address) {
        addresses.push(address);
    }
}

fn spawn_stream_bridge(
    id: u64,
    stream: DuplexStream,
    mut inbound: mpsc::Receiver<Vec<u8>>,
    commands: mpsc::Sender<Command>,
) {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let read_commands = commands.clone();
    tokio::spawn(async move {
        let mut buffer = vec![0; STREAM_CHUNK_BYTES];
        loop {
            let count = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            let (reply, response) = oneshot::channel();
            if read_commands
                .send(Command::Write {
                    id,
                    bytes: buffer[..count].to_vec(),
                    reply,
                })
                .await
                .is_err()
                || !matches!(response.await, Ok(Ok(())))
            {
                break;
            }
        }
        let _ = read_commands.send(Command::Close { id }).await;
    });
    tokio::spawn(async move {
        while let Some(bytes) = inbound.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                let _ = commands.send(Command::Close { id }).await;
                return;
            }
        }
        let _ = writer.shutdown().await;
    });
}

struct PacketDevice {
    packets: VecDeque<Vec<u8>>,
    sink: Arc<dyn PacketSink>,
    failed: Arc<AtomicBool>,
    mtu: usize,
}

struct PacketRxToken(Vec<u8>);

struct PacketTxToken {
    sink: Arc<dyn PacketSink>,
    failed: Arc<AtomicBool>,
}

impl Device for PacketDevice {
    type RxToken<'a> = PacketRxToken;
    type TxToken<'a> = PacketTxToken;

    fn receive(&mut self, _: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        self.packets.pop_front().map(|packet| {
            (
                PacketRxToken(packet),
                PacketTxToken {
                    sink: self.sink.clone(),
                    failed: self.failed.clone(),
                },
            )
        })
    }

    fn transmit(&mut self, _: Instant) -> Option<Self::TxToken<'_>> {
        Some(PacketTxToken {
            sink: self.sink.clone(),
            failed: self.failed.clone(),
        })
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut capabilities = DeviceCapabilities::default();
        capabilities.medium = Medium::Ip;
        capabilities.max_transmission_unit = self.mtu;
        capabilities.max_burst_size = Some(64);
        capabilities
    }
}

impl RxToken for PacketRxToken {
    fn consume<R, F>(self, operation: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        operation(&self.0)
    }
}

impl TxToken for PacketTxToken {
    fn consume<R, F>(self, length: usize, operation: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut packet = vec![0; length];
        let result = operation(&mut packet);
        if !self.sink.send(&packet) {
            self.failed.store(true, Ordering::Release);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use smoltcp::{
        phy::ChecksumCapabilities,
        wire::{IpProtocol, Ipv4Packet, Ipv4Repr, UdpPacket, UdpRepr},
    };
    use std::{
        net::{Ipv4Addr, Ipv6Addr},
        sync::Mutex,
    };

    struct DiscardSink;

    impl PacketSink for DiscardSink {
        fn send(&self, _: &[u8]) -> bool {
            true
        }
    }

    #[derive(Default)]
    struct CaptureSink {
        packets: Mutex<Vec<Vec<u8>>>,
    }

    impl CaptureSink {
        fn take_packets(&self) -> Vec<Vec<u8>> {
            std::mem::take(&mut *self.packets.lock().expect("capture sink lock"))
        }
    }

    impl PacketSink for CaptureSink {
        fn send(&self, packet: &[u8]) -> bool {
            self.packets
                .lock()
                .expect("capture sink lock")
                .push(packet.to_vec());
            true
        }
    }

    fn dns_test_stack() -> Netstack {
        dns_test_stack_with_servers(vec![IpAddr::V4(Ipv4Addr::new(10, 8, 0, 53))], Arc::new(DiscardSink))
    }

    fn dns_test_stack_with_servers(dns_servers: Vec<IpAddr>, sink: Arc<dyn PacketSink>) -> Netstack {
        let (commands, receiver) = mpsc::channel(4);
        let (_, inbound) = mpsc::channel(4);
        Netstack::new(
            TunnelConfiguration {
                ipv4: Some(Ipv4Addr::new(10, 8, 0, 2)),
                gateway_ipv4: Some(Ipv4Addr::new(10, 8, 0, 1)),
                ipv6: None,
                gateway_ipv6: None,
                dns_servers,
                mtu: 1500,
            },
            sink,
            commands,
            receiver,
            inbound,
            StdInstant::now(),
            Arc::new(AtomicU64::new(0)),
            false,
        ).expect("test stack")
    }

    fn parse_ipv4_dns_query(packet: &[u8]) -> Option<(Ipv4Addr, u16, Vec<u8>)> {
        let ip = Ipv4Packet::new_checked(packet).ok()?;
        if ip.next_header() != IpProtocol::Udp {
            return None;
        }
        let udp = UdpPacket::new_checked(ip.payload()).ok()?;
        if udp.dst_port() != 53 {
            return None;
        }
        Some((Ipv4Addr::from(ip.dst_addr().octets()), udp.src_port(), udp.payload().to_vec()))
    }

    fn build_ipv4_dns_response(
        server: Ipv4Addr,
        client: Ipv4Addr,
        client_port: u16,
        query: &[u8],
        rcode: u8,
        answers: &[Ipv4Addr],
    ) -> Vec<u8> {
        let mut dns = Vec::with_capacity(query.len() + answers.len() * 16);
        dns.extend_from_slice(&query[..2]);
        dns.extend_from_slice(&[0x81, 0x80 | (rcode & 0x0f)]);
        dns.extend_from_slice(&1u16.to_be_bytes());
        dns.extend_from_slice(&(answers.len() as u16).to_be_bytes());
        dns.extend_from_slice(&0u16.to_be_bytes());
        dns.extend_from_slice(&0u16.to_be_bytes());
        dns.extend_from_slice(&query[12..]);
        for answer in answers {
            dns.extend_from_slice(&[0xc0, 0x0c]);
            dns.extend_from_slice(&1u16.to_be_bytes());
            dns.extend_from_slice(&1u16.to_be_bytes());
            dns.extend_from_slice(&60u32.to_be_bytes());
            dns.extend_from_slice(&4u16.to_be_bytes());
            dns.extend_from_slice(&answer.octets());
        }
        let udp_repr = UdpRepr {
            src_port: 53,
            dst_port: client_port,
        };
        let ip_repr = Ipv4Repr {
            src_addr: server.into(),
            dst_addr: client.into(),
            next_header: IpProtocol::Udp,
            payload_len: udp_repr.header_len() + dns.len(),
            hop_limit: 64,
        };
        let mut packet = vec![0u8; ip_repr.buffer_len() + ip_repr.payload_len];
        let mut ip = Ipv4Packet::new_unchecked(&mut packet);
        ip_repr.emit(&mut ip, &ChecksumCapabilities::default());
        let mut udp = UdpPacket::new_unchecked(ip.payload_mut());
        udp_repr.emit(
            &mut udp,
            &ip_repr.src_addr.into(),
            &ip_repr.dst_addr.into(),
            dns.len(),
            |payload| payload.copy_from_slice(&dns),
            &ChecksumCapabilities::default(),
        );
        packet
    }

    #[test]
    fn exhausted_dns_socket_retains_dns_failure_without_claiming_nxdomain() {
        let mut stack = dns_test_stack();
        let (reply, mut response) = oneshot::channel();
        stack.start_dial("source.example".into(), 443, reply, None, false).expect("start DNS");
        // Exercise smoltcp's real per-server deadline with a discarded packet
        // sink. Advancing its clock requires no network and no wall-clock wait.
        stack.interface.poll(Instant::from_millis(0), &mut stack.device, &mut stack.sockets);
        stack.interface.poll(Instant::from_millis(10_001), &mut stack.device, &mut stack.sockets);
        stack.process_resolutions().expect("per-request failure is not a tunnel failure");
        let error = response.try_recv().expect("DNS result").err().expect("failed lookup");
        assert_eq!(error.kind, super::super::transport::PluginVpnTransportFailureKind::Dns);
        assert_eq!(error.message, "VPN DNS lookup failed or returned no usable address");
        assert!(stack.connections.is_empty());
    }

    #[test]
    fn application_dns_deadline_stays_distinct_from_no_usable_answer() {
        let mut stack = dns_test_stack();
        let (reply, mut response) = oneshot::channel();
        stack.start_dial("source.example".into(), 443, reply, None, false).expect("start DNS");
        stack.resolutions[0].dns_deadline = StdInstant::now();
        stack.process_resolutions().expect("per-request timeout is not a tunnel failure");
        let error = response.try_recv().expect("DNS result").err().expect("expired lookup");
        assert_eq!(error.kind, super::super::transport::PluginVpnTransportFailureKind::Dns);
        assert_eq!(error.message, "VPN DNS lookup timed out");
        assert!(stack.connections.is_empty());
    }

    #[test]
    fn hedges_to_secondary_pushed_dns_server_preserves_multiple_answers_and_prefers_healthy_server() {
        let primary = Ipv4Addr::new(10, 211, 254, 254);
        let secondary = Ipv4Addr::new(8, 8, 8, 8);
        let sink = Arc::new(CaptureSink::default());
        let mut stack = dns_test_stack_with_servers(
            vec![IpAddr::V4(primary), IpAddr::V4(secondary)],
            sink.clone(),
        );

        let (reply, _response) = oneshot::channel();
        stack.start_dial("source.example".into(), 443, reply, None, false).expect("start DNS");
        stack.interface.poll(Instant::from_millis(0), &mut stack.device, &mut stack.sockets);

        let initial_queries = sink
            .take_packets()
            .into_iter()
            .filter_map(|packet| parse_ipv4_dns_query(&packet))
            .collect::<Vec<_>>();
        assert_eq!(initial_queries.len(), 1);
        assert_eq!(initial_queries[0].0, primary);

        // Simulate primary dropping packets until the hedge timer fires.
        stack.resolutions[0].next_server_at = Some(StdInstant::now());
        stack.process_resolutions().expect("hedge to secondary DNS");
        stack.interface.poll(Instant::from_millis(1_500), &mut stack.device, &mut stack.sockets);

        let hedged_queries = sink
            .take_packets()
            .into_iter()
            .filter_map(|packet| parse_ipv4_dns_query(&packet))
            .collect::<Vec<_>>();
        let secondary_query = hedged_queries
            .iter()
            .find(|(dst, _, _)| *dst == secondary)
            .expect("secondary DNS query emitted");

        let answer_a = Ipv4Addr::new(198, 51, 100, 10);
        let answer_b = Ipv4Addr::new(198, 51, 100, 11);
        stack.device.packets.push_back(build_ipv4_dns_response(
            secondary,
            Ipv4Addr::new(10, 8, 0, 2),
            secondary_query.1,
            &secondary_query.2,
            0,
            &[answer_a, answer_b],
        ));
        stack.interface.poll(Instant::from_millis(1_700), &mut stack.device, &mut stack.sockets);
        stack.process_resolutions().expect("complete DNS from secondary");

        assert!(stack.resolutions.is_empty());
        assert_eq!(stack.preferred_dns_server, 1);
        assert_eq!(stack.connections.len(), 1);
        let connection = stack.connections.values().next().expect("TCP connection started");
        assert_eq!(connection.remaining_addresses, VecDeque::from([IpAddr::V4(answer_b)]));

        // Next dial should start immediately on the healthy secondary server.
        let (next_reply, _next_response) = oneshot::channel();
        stack.start_dial("next.example".into(), 443, next_reply, None, false).expect("start next DNS");
        stack.interface.poll(Instant::from_millis(1_800), &mut stack.device, &mut stack.sockets);
        let next_queries = sink
            .take_packets()
            .into_iter()
            .filter_map(|packet| parse_ipv4_dns_query(&packet))
            .collect::<Vec<_>>();
        assert_eq!(next_queries.len(), 1);
        assert_eq!(next_queries[0].0, secondary);
    }

    #[test]
    fn fails_over_immediately_when_primary_dns_returns_unusable_address() {
        let primary = Ipv4Addr::new(10, 211, 254, 254);
        let secondary = Ipv4Addr::new(8, 8, 8, 8);
        let sink = Arc::new(CaptureSink::default());
        let mut stack = dns_test_stack_with_servers(
            vec![IpAddr::V4(primary), IpAddr::V4(secondary)],
            sink.clone(),
        );

        let (reply, _response) = oneshot::channel();
        stack.start_dial("source.example".into(), 443, reply, None, false).expect("start DNS");
        stack.interface.poll(Instant::from_millis(0), &mut stack.device, &mut stack.sockets);
        let primary_query = sink
            .take_packets()
            .into_iter()
            .find_map(|packet| parse_ipv4_dns_query(&packet))
            .expect("primary DNS query");
        assert_eq!(primary_query.0, primary);

        // Primary returns disallowed loopback address; failover must not wait for hedge delay.
        stack.device.packets.push_back(build_ipv4_dns_response(
            primary,
            Ipv4Addr::new(10, 8, 0, 2),
            primary_query.1,
            &primary_query.2,
            0,
            &[Ipv4Addr::LOCALHOST],
        ));
        stack.interface.poll(Instant::from_millis(50), &mut stack.device, &mut stack.sockets);
        stack.process_resolutions().expect("failover to secondary DNS");
        stack.interface.poll(Instant::from_millis(60), &mut stack.device, &mut stack.sockets);

        let secondary_query = sink
            .take_packets()
            .into_iter()
            .find_map(|packet| parse_ipv4_dns_query(&packet))
            .expect("immediate secondary DNS query");
        assert_eq!(secondary_query.0, secondary);

        stack.device.packets.push_back(build_ipv4_dns_response(
            secondary,
            Ipv4Addr::new(10, 8, 0, 2),
            secondary_query.1,
            &secondary_query.2,
            0,
            &[Ipv4Addr::new(198, 51, 100, 42)],
        ));
        stack.interface.poll(Instant::from_millis(120), &mut stack.device, &mut stack.sockets);
        stack.process_resolutions().expect("resolve via secondary DNS");
        assert_eq!(stack.connections.len(), 1);
        assert_eq!(stack.preferred_dns_server, 1);
    }

    #[test]
    fn dns_lookup_timeout_is_shorter_than_browser_proxy_connect_timeout() {
        assert!(DNS_SERVER_HEDGE_DELAY < DNS_LOOKUP_TIMEOUT);
        assert!(DNS_LOOKUP_TIMEOUT < Duration::from_secs(10));

        let primary = Ipv4Addr::new(10, 211, 254, 254);
        let secondary = Ipv4Addr::new(8, 8, 8, 8);
        let mut stack = dns_test_stack_with_servers(
            vec![IpAddr::V4(primary), IpAddr::V4(secondary)],
            Arc::new(DiscardSink),
        );
        let (reply, mut response) = oneshot::channel();
        stack.start_dial("source.example".into(), 443, reply, None, false).expect("start DNS");
        stack.resolutions[0].next_server_at = Some(StdInstant::now());
        stack.process_resolutions().expect("hedge before timeout");
        assert_eq!(stack.resolutions[0].queries.len(), 2);

        stack.resolutions[0].dns_deadline = StdInstant::now();
        stack.process_resolutions().expect("expire both stalled servers");
        let error = response.try_recv().expect("DNS timeout result").err().expect("timeout error");
        assert_eq!(error.kind, super::super::transport::PluginVpnTransportFailureKind::Dns);
        assert_eq!(error.message, "VPN DNS lookup timed out");
        assert!(stack.resolutions.is_empty());
        assert!(stack.connections.is_empty());
    }

    #[test]
    fn rejects_local_only_tunnel_addresses() {
        assert!(is_disallowed_tunnel_address(IpAddr::V4(
            Ipv4Addr::LOCALHOST
        )));
        assert!(is_disallowed_tunnel_address(IpAddr::V4(Ipv4Addr::new(
            169, 254, 1, 1
        ))));
        assert!(is_disallowed_tunnel_address(IpAddr::V6(
            Ipv6Addr::LOCALHOST
        )));
        assert!(is_disallowed_tunnel_address(IpAddr::V6(
            "fe80::1".parse().expect("link-local IPv6 address")
        )));
        assert!(is_disallowed_tunnel_address(IpAddr::V6(
            "::ffff:127.0.0.1"
                .parse()
                .expect("mapped loopback IPv6 address")
        )));
        assert!(is_disallowed_tunnel_address(IpAddr::V6(
            "::127.0.0.1"
                .parse()
                .expect("compatible loopback IPv6 address")
        )));
        assert!(!is_disallowed_tunnel_address(IpAddr::V4(Ipv4Addr::new(
            10, 8, 0, 1
        ))));
        assert!(!is_disallowed_tunnel_address(IpAddr::V6(
            "fd00::1".parse().expect("private IPv6 address")
        )));
    }

    #[test]
    fn interleaves_dns_candidates_starting_with_the_first_resolved_family() {
        let ipv4_first = interleave_address_families(vec![
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1)),
            IpAddr::V4(Ipv4Addr::new(198, 51, 100, 2)),
            IpAddr::V6("2001:db8::1".parse().expect("IPv6 candidate")),
            IpAddr::V6("2001:db8::2".parse().expect("IPv6 candidate")),
        ]);
        assert_eq!(
            ipv4_first,
            VecDeque::from([
                IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1)),
                IpAddr::V6("2001:db8::1".parse().expect("IPv6 candidate")),
                IpAddr::V4(Ipv4Addr::new(198, 51, 100, 2)),
                IpAddr::V6("2001:db8::2".parse().expect("IPv6 candidate")),
            ])
        );

        let ipv6_first = interleave_address_families(vec![
            IpAddr::V6("2001:db8::3".parse().expect("IPv6 candidate")),
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1)),
            IpAddr::V4(Ipv4Addr::new(203, 0, 113, 2)),
        ]);
        assert_eq!(
            ipv6_first,
            VecDeque::from([
                IpAddr::V6("2001:db8::3".parse().expect("IPv6 candidate")),
                IpAddr::V4(Ipv4Addr::new(203, 0, 113, 1)),
                IpAddr::V4(Ipv4Addr::new(203, 0, 113, 2)),
            ])
        );
    }

    #[test]
    fn ignores_disallowed_dns_answers_before_starting_family_grace() {
        let mut addresses = Vec::new();
        add_usable_dns_address(&mut addresses, IpAddr::V4(Ipv4Addr::LOCALHOST));
        add_usable_dns_address(
            &mut addresses,
            IpAddr::V6("2001:db8::5".parse().expect("IPv6 candidate")),
        );
        add_usable_dns_address(
            &mut addresses,
            IpAddr::V6("2001:db8::5".parse().expect("duplicate IPv6 candidate")),
        );

        assert_eq!(
            addresses,
            vec![IpAddr::V6("2001:db8::5".parse().expect("IPv6 candidate"))]
        );
    }

    #[test]
    fn rejects_targets_outside_the_negotiated_address_family() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            let configuration = TunnelConfiguration {
                ipv4: Some(Ipv4Addr::new(10, 8, 0, 2)),
                gateway_ipv4: Some(Ipv4Addr::new(10, 8, 0, 1)),
                ipv6: None,
                gateway_ipv6: None,
                dns_servers: vec![IpAddr::V4(Ipv4Addr::new(10, 8, 0, 53))],
                mtu: 1500,
            };
            let network = UserSpaceNetwork::start(
                &Handle::current(),
                configuration,
                Arc::new(DiscardSink),
                false,
                Arc::new(|_| {}),
            )
            .expect("network stack");
            let result = network
                .connector
                .connect(&ProxyTarget {
                    host: "2001:db8::1".to_string(),
                    port: 443,
                })
                .await;
            let error = match result {
                Ok(_) => panic!("IPv6 must be unavailable"),
                Err(error) => error,
            };

        assert_eq!(error.kind, super::super::transport::PluginVpnTransportFailureKind::Tcp);
        assert!(error.message.contains("address family"));
        network.stop();
        });
    }

    #[test]
    fn tcp_dial_timeout_stays_under_browser_proxy_connect_timeout() {
        assert!(TCP_MULTI_ATTEMPT_TIMEOUT < TCP_DIAL_TIMEOUT);
        assert!(TCP_SINGLE_ATTEMPT_TIMEOUT <= TCP_DIAL_TIMEOUT);
        assert!(TCP_DIAL_TIMEOUT < Duration::from_secs(10));

        let mut stack = dns_test_stack();
        let (reply, mut response) = oneshot::channel();
        let now = StdInstant::now();
        stack
            .start_tcp_candidates(
                VecDeque::from([
                    IpAddr::V4(Ipv4Addr::new(198, 51, 100, 1)),
                    IpAddr::V4(Ipv4Addr::new(198, 51, 100, 2)),
                ]),
                443,
                reply,
                now + TCP_DIAL_TIMEOUT,
                None,
                false,
                false,
            )
            .expect("start multi-IP TCP dial");
        let connection = stack.connections.values().next().expect("active connection");
        assert!(connection.overall_deadline <= now + Duration::from_secs(10));
        assert!(connection.attempt_deadline <= now + TCP_MULTI_ATTEMPT_TIMEOUT + Duration::from_millis(50));
        assert!(response.try_recv().is_err());
    }

    #[test]
    fn consecutive_dial_timeouts_mark_tunnel_unresponsive_and_liveness_resets_counter() {
        let mut stack = dns_test_stack();
        for _ in 0..(ZOMBIE_TUNNEL_TIMEOUT_THRESHOLD - 1) {
            let (reply, mut response) = oneshot::channel();
            stack.start_dial("source.example".into(), 443, reply, None, false).expect("start DNS");
            stack.resolutions[0].dns_deadline = StdInstant::now();
            stack.process_resolutions().expect("below zombie threshold");
            assert_eq!(
                response.try_recv().expect("DNS result").err().expect("timeout").kind,
                super::super::transport::PluginVpnTransportFailureKind::Dns
            );
        }
        assert_eq!(stack.consecutive_dial_timeouts, ZOMBIE_TUNNEL_TIMEOUT_THRESHOLD - 1);

        // Observing live tunnel traffic resets the consecutive timeout streak.
        stack.record_tunnel_liveness();
        assert_eq!(stack.consecutive_dial_timeouts, 0);

        for attempt in 1..=ZOMBIE_TUNNEL_TIMEOUT_THRESHOLD {
            let (reply, mut response) = oneshot::channel();
            stack
                .start_dial("198.51.100.10".into(), 443, reply, None, false)
                .expect("start TCP dial");
            let id = *stack.connections.keys().next().expect("connection id");
            stack.connections.get_mut(&id).expect("connection").attempt_deadline = StdInstant::now();
            let result = stack.process_connections();
            assert_eq!(
                response.try_recv().expect("TCP timeout delivered").err().expect("timeout").kind,
                super::super::transport::PluginVpnTransportFailureKind::Tcp
            );
            if attempt < ZOMBIE_TUNNEL_TIMEOUT_THRESHOLD {
                assert!(result.is_ok());
            } else {
                assert_eq!(result.unwrap_err(), ZOMBIE_TUNNEL_ERROR);
            }
        }
    }

    #[test]
    fn probe_timeouts_do_not_increment_dial_timeout_counter() {
        let mut stack = dns_test_stack();
        let (reply, mut response) = oneshot::channel();
        stack
            .start_dial(
                "one.one.one.one".into(),
                443,
                reply,
                Some(Duration::from_secs(2)),
                true,
            )
            .expect("start probe DNS");
        stack.resolutions[0].dns_deadline = StdInstant::now();
        stack.process_resolutions().expect("probe timeout stays isolated");
        assert_eq!(stack.consecutive_dial_timeouts, 0);
        assert_eq!(
            response.try_recv().expect("probe error").err().expect("timeout").kind,
            super::super::transport::PluginVpnTransportFailureKind::Dns
        );
    }

    #[test]
    fn health_check_skips_fresh_tunnel_and_fails_blackhole_tunnel() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async {
            let (failure_tx, failure_rx) = oneshot::channel::<String>();
            let failure_tx = Arc::new(Mutex::new(Some(failure_tx)));
            let network = UserSpaceNetwork::start(
                &Handle::current(),
                TunnelConfiguration {
                    ipv4: Some(Ipv4Addr::new(10, 8, 0, 2)),
                    gateway_ipv4: Some(Ipv4Addr::new(10, 8, 0, 1)),
                    ipv6: None,
                    gateway_ipv6: None,
                    dns_servers: vec![IpAddr::V4(Ipv4Addr::new(10, 8, 0, 53))],
                    mtu: 1500,
                },
                Arc::new(DiscardSink),
                false,
                Arc::new(move |error| {
                    if let Some(tx) = failure_tx.lock().expect("failure tx").take() {
                        let _ = tx.send(error);
                    }
                }),
            )
            .expect("network stack");
            let health = network.health_handle();
            health
                .check_health(Some(Duration::from_secs(60)))
                .await
                .expect("fresh tunnel skips probe");
            let error = health
                .check_health(None)
                .await
                .expect_err("blackhole tunnel must fail forced health check");
            assert_eq!(error, ZOMBIE_TUNNEL_ERROR);
            let failure = tokio::time::timeout(Duration::from_secs(2), failure_rx)
                .await
                .expect("failure callback arrives")
                .expect("failure payload");
            assert_eq!(failure, ZOMBIE_TUNNEL_ERROR);
            network.stop();
        });
    }
}
