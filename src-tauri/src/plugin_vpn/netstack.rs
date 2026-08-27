use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering},
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
    tunnel_config::TunnelConfiguration,
};

const COMMAND_CAPACITY: usize = 256;
const INBOUND_PACKET_CAPACITY: usize = 512;
const CONNECTION_DATA_CAPACITY: usize = 32;
const TCP_BUFFER_BYTES: usize = 64 * 1024;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;
const STREAM_CHUNK_BYTES: usize = 16 * 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(30);
const DNS_FAMILY_GRACE: Duration = Duration::from_millis(250);
const TCP_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(8);
const TCP_IDLE_TIMEOUT: SmolDuration = SmolDuration::from_secs(5 * 60);
const MAX_TIMER_DELAY: Duration = Duration::from_millis(100);

pub(super) trait PacketSink: Send + Sync + 'static {
    fn send(&self, packet: &[u8]) -> bool;
}

pub(super) struct UserSpaceNetwork {
    inbound: mpsc::Sender<Vec<u8>>,
    connector: Arc<TunnelConnector>,
    task: JoinHandle<()>,
}

impl UserSpaceNetwork {
    pub(super) fn start(
        runtime: &Handle,
        configuration: TunnelConfiguration,
        sink: Arc<dyn PacketSink>,
        failure: Arc<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        let (commands, command_receiver) = mpsc::channel(COMMAND_CAPACITY);
        let (inbound, inbound_receiver) = mpsc::channel(INBOUND_PACKET_CAPACITY);
        let stack = Netstack::new(
            configuration,
            sink,
            commands.clone(),
            command_receiver,
            inbound_receiver,
        )?;
        let task = runtime.spawn(async move {
            if let Err(error) = stack.run().await {
                failure(error);
            }
        });
        Ok(Self {
            inbound,
            connector: Arc::new(TunnelConnector { commands }),
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

    pub(super) fn stop(self) {
        self.task.abort();
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
        reply: oneshot::Sender<Result<DuplexStream, String>>,
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
    dns_handle: SocketHandle,
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
}

struct Resolution {
    port: u16,
    reply: oneshot::Sender<Result<DuplexStream, String>>,
    queries: Vec<dns::QueryHandle>,
    addresses: Vec<IpAddr>,
    grace_deadline: Option<StdInstant>,
    deadline: StdInstant,
}

struct Connection {
    socket: SocketHandle,
    reply: Option<oneshot::Sender<Result<DuplexStream, String>>>,
    inbound: Option<mpsc::Sender<Vec<u8>>>,
    pending_writes: VecDeque<PendingWrite>,
    remote_port: u16,
    remaining_addresses: VecDeque<IpAddr>,
    overall_deadline: StdInstant,
    attempt_deadline: StdInstant,
    established: bool,
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

        let dns_servers = configuration
            .dns_servers
            .iter()
            .copied()
            .map(IpAddress::from)
            .collect::<Vec<_>>();
        let mut sockets = SocketSet::new(Vec::new());
        let dns_handle = sockets.add(dns::Socket::new(&dns_servers, Vec::new()));

        Ok(Self {
            interface,
            device,
            sockets,
            dns_handle,
            commands,
            command_receiver,
            inbound_receiver,
            resolutions: Vec::new(),
            connections: HashMap::new(),
            local_ipv4: configuration.ipv4,
            local_ipv6: configuration.ipv6,
            next_connection_id: 1,
            next_port,
            started_at: StdInstant::now(),
        })
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
            Command::Dial { host, port, reply } => self.start_dial(host, port, reply),
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
        reply: oneshot::Sender<Result<DuplexStream, String>>,
    ) -> Result<(), String> {
        if let Ok(address) = host.parse::<IpAddr>() {
            return self.start_tcp_candidates(
                std::iter::once(address).collect(),
                port,
                reply,
                StdInstant::now() + DIAL_TIMEOUT,
                None,
            );
        }

        let mut queries = Vec::new();
        let mut query_error = None;
        let dns = self.sockets.get_mut::<dns::Socket>(self.dns_handle);
        if self.local_ipv4.is_some() {
            match dns.start_query(self.interface.context(), &host, DnsQueryType::A) {
                Ok(query) => queries.push(query),
                Err(error) => {
                    query_error = Some(format!("could not start VPN DNS lookup: {error}"));
                }
            }
        }
        if self.local_ipv6.is_some() {
            match dns.start_query(self.interface.context(), &host, DnsQueryType::Aaaa) {
                Ok(query) => queries.push(query),
                Err(error) => {
                    query_error = Some(format!("could not start VPN DNS lookup: {error}"));
                }
            }
        }
        if queries.is_empty() {
            let error =
                query_error.unwrap_or_else(|| "VPN has no usable address family".to_string());
            let _ = reply.send(Err(error));
            return Ok(());
        }
        self.resolutions.push(Resolution {
            port,
            reply,
            queries,
            addresses: Vec::new(),
            grace_deadline: None,
            deadline: StdInstant::now() + DIAL_TIMEOUT,
        });
        Ok(())
    }

    fn process_resolutions(&mut self) -> Result<(), String> {
        let mut pending = Vec::new();
        for mut resolution in std::mem::take(&mut self.resolutions) {
            if resolution.reply.is_closed() {
                self.cancel_queries(&resolution.queries);
                continue;
            }
            let mut active = Vec::new();
            for query in resolution.queries {
                match self
                    .sockets
                    .get_mut::<dns::Socket>(self.dns_handle)
                    .get_query_result(query)
                {
                    Ok(addresses) => {
                        for address in addresses {
                            let address = IpAddr::from(address);
                            add_usable_dns_address(&mut resolution.addresses, address);
                        }
                    }
                    Err(dns::GetQueryResultError::Pending) => active.push(query),
                    Err(dns::GetQueryResultError::Failed) => {}
                }
            }
            let now = StdInstant::now();
            let grace_expired = resolution
                .grace_deadline
                .is_some_and(|deadline| now >= deadline);
            if !resolution.addresses.is_empty()
                && (active.is_empty() || grace_expired || now >= resolution.deadline)
            {
                self.cancel_queries(&active);
                self.start_tcp_candidates(
                    interleave_address_families(resolution.addresses),
                    resolution.port,
                    resolution.reply,
                    resolution.deadline,
                    None,
                )?;
            } else if active.is_empty() {
                let _ = resolution
                    .reply
                    .send(Err("VPN DNS lookup returned no address".to_string()));
            } else if now >= resolution.deadline {
                self.cancel_queries(&active);
                let _ = resolution
                    .reply
                    .send(Err("VPN DNS lookup timed out".to_string()));
            } else {
                if !resolution.addresses.is_empty() && resolution.grace_deadline.is_none() {
                    resolution.grace_deadline =
                        Some((now + DNS_FAMILY_GRACE).min(resolution.deadline));
                }
                resolution.queries = active;
                pending.push(resolution);
            }
        }
        self.resolutions = pending;
        Ok(())
    }

    fn cancel_queries(&mut self, queries: &[dns::QueryHandle]) {
        let dns = self.sockets.get_mut::<dns::Socket>(self.dns_handle);
        for query in queries {
            dns.cancel_query(*query);
        }
    }

    fn start_tcp_candidates(
        &mut self,
        mut addresses: VecDeque<IpAddr>,
        port: u16,
        reply: oneshot::Sender<Result<DuplexStream, String>>,
        overall_deadline: StdInstant,
        mut last_error: Option<String>,
    ) -> Result<(), String> {
        if reply.is_closed() {
            return Ok(());
        }
        if port == 0 {
            let _ = reply.send(Err("invalid VPN connection target".to_string()));
            return Ok(());
        }
        if StdInstant::now() >= overall_deadline {
            let _ = reply.send(Err("VPN TCP connection timed out".to_string()));
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
                    let _ = reply.send(Err(error));
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
                    attempt_deadline: (StdInstant::now() + TCP_ATTEMPT_TIMEOUT)
                        .min(overall_deadline),
                    established: false,
                },
            );
            return Ok(());
        }

        let _ = reply.send(Err(last_error.unwrap_or_else(|| {
            "VPN DNS lookup returned no usable address".to_string()
        })));
        Ok(())
    }

    fn process_connections(&mut self) -> Result<(), String> {
        let ids = self.connections.keys().copied().collect::<Vec<_>>();
        let mut remove = Vec::<(u64, String)>::new();
        let mut retry = Vec::<(u64, String)>::new();
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
                    remove.push((id, "VPN TCP requester closed".to_string()));
                    continue;
                }
                if StdInstant::now() >= connection.overall_deadline {
                    remove.push((id, "VPN TCP connection timed out".to_string()));
                    continue;
                }
                if StdInstant::now() >= connection.attempt_deadline {
                    retry.push((id, "VPN TCP connection attempt timed out".to_string()));
                    continue;
                }
                if socket.state() == tcp::State::Established {
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
                        remove.push((id, "VPN TCP requester closed".to_string()));
                        continue;
                    }
                } else if socket.state() == tcp::State::Closed {
                    retry.push((id, "VPN TCP connection failed".to_string()));
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
                remove.push((id, error));
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
                        remove.push((id, format!("could not read VPN TCP data: {error}")));
                        continue;
                    }
                };
                bytes.truncate(count);
                if count > 0
                    && connection
                        .inbound
                        .as_ref()
                        .is_some_and(|sender| sender.try_send(bytes).is_err())
                {
                    remove.push((id, "VPN TCP receive buffer closed".to_string()));
                    continue;
                }
            }
            if connection.established && !socket.may_recv() && socket.recv_queue() == 0 {
                connection.inbound.take();
            }
            if connection.established && socket.state() == tcp::State::Closed {
                remove.push((id, "VPN TCP connection closed".to_string()));
            }
        }
        for (id, reason) in remove {
            self.remove_connection(id, &reason);
        }
        for (id, reason) in retry {
            self.retry_connection(id, &reason)?;
        }
        Ok(())
    }

    fn retry_connection(&mut self, id: u64, reason: &str) -> Result<(), String> {
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
            let _ = reply.send(Err(reason.to_string()));
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
    use std::net::{Ipv4Addr, Ipv6Addr};

    struct DiscardSink;

    impl PacketSink for DiscardSink {
        fn send(&self, _: &[u8]) -> bool {
            true
        }
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

            assert!(error.contains("address family"));
            network.stop();
        });
    }
}
