use std::{
    collections::HashSet,
    net::Ipv4Addr,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    directive_tokens, inline_closing_tag, inline_opening_tag, validate_profile, MAX_PROFILE_BYTES,
    VPN_GATE_PROFILE_MARKER,
};

#[cfg(target_os = "windows")]
mod winhttp;

const VPN_GATE_API_URL: &str = "https://www.vpngate.net/api/iphone/";
const VPN_GATE_AUTH_DIRECTIVE: &[u8] = b"auth-user-pass\n";
const VPN_GATE_MARKER: &str = "*vpn_servers";
const VPN_GATE_HEADER: &str = "#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64";
const VPN_GATE_FOOTER: &str = "*";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SERVER_ROWS: usize = 512;
const MAX_BASE64_PROFILE_BYTES: usize = MAX_PROFILE_BYTES.div_ceil(3) * 4;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum VpnGateProtocol {
    Tcp,
    Udp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VpnGateServer {
    candidate_id: String,
    host_name: String,
    ip: String,
    score: u64,
    ping_ms: Option<u32>,
    speed_bps: u64,
    country_name: String,
    country_code: String,
    active_sessions: u32,
    uptime_ms: u64,
    total_users: u64,
    log_type: String,
    protocol: VpnGateProtocol,
}

#[derive(Clone)]
struct VpnGateCandidate {
    server: VpnGateServer,
    profile: Vec<u8>,
}

struct CachedServers {
    fetched_at: Instant,
    candidates: Vec<VpnGateCandidate>,
}

pub(super) struct VpnGateFinder {
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    client: reqwest::Client,
    refresh: tokio::sync::Mutex<()>,
    cache: Mutex<Option<CachedServers>>,
}

impl VpnGateFinder {
    pub(super) fn new() -> Result<Self, String> {
        #[cfg(not(any(target_os = "android", target_os = "windows")))]
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("could not create the VPN Gate client: {error}"))?;
        Ok(Self {
            #[cfg(not(any(target_os = "android", target_os = "windows")))]
            client,
            refresh: tokio::sync::Mutex::new(()),
            cache: Mutex::new(None),
        })
    }

    pub(super) async fn load_servers(
        &self,
        force_refresh: bool,
    ) -> Result<Vec<VpnGateServer>, String> {
        if !force_refresh {
            if let Some(servers) = self.cached_servers()? {
                return Ok(servers);
            }
        }

        let _refresh = self.refresh.lock().await;
        if !force_refresh {
            if let Some(servers) = self.cached_servers()? {
                return Ok(servers);
            }
        }

        let response = self.fetch_response().await?;
        let candidates = parse_usable_api_candidates(&response)?;
        let servers = candidates
            .iter()
            .map(|candidate| candidate.server.clone())
            .collect();
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| "VPN Gate server cache is unavailable".to_string())?;
        *cache = Some(CachedServers {
            fetched_at: Instant::now(),
            candidates,
        });
        Ok(servers)
    }

    pub(super) fn profile_bytes(&self, candidate_id: &str) -> Result<Vec<u8>, String> {
        if candidate_id.len() != 64
            || !candidate_id
                .bytes()
                .all(|value| value.is_ascii_digit() || matches!(value, b'a'..=b'f'))
        {
            return Err("VPN Gate candidate ID is invalid".to_string());
        }

        let cache = self
            .cache
            .lock()
            .map_err(|_| "VPN Gate server cache is unavailable".to_string())?;
        let cached = cache.as_ref().ok_or_else(|| {
            "refresh the VPN Gate server list before applying a profile".to_string()
        })?;
        if !cache_is_fresh(cached.fetched_at) {
            return Err(
                "VPN Gate server list expired; refresh it before applying a profile".to_string(),
            );
        }
        cached
            .candidates
            .iter()
            .find(|candidate| candidate.server.candidate_id == candidate_id)
            .map(|candidate| candidate.profile.clone())
            .ok_or_else(|| {
                "VPN Gate profile is no longer available; refresh the server list".to_string()
            })
    }

    fn cached_servers(&self) -> Result<Option<Vec<VpnGateServer>>, String> {
        let cache = self
            .cache
            .lock()
            .map_err(|_| "VPN Gate server cache is unavailable".to_string())?;
        Ok(cache.as_ref().and_then(|cached| {
            cache_is_fresh(cached.fetched_at).then(|| {
                cached
                    .candidates
                    .iter()
                    .map(|candidate| candidate.server.clone())
                    .collect()
            })
        }))
    }

    #[cfg(target_os = "android")]
    async fn fetch_response(&self) -> Result<Vec<u8>, String> {
        tauri::async_runtime::spawn_blocking(|| {
            crate::android_tls::https_get(
                VPN_GATE_API_URL,
                CONNECT_TIMEOUT.as_millis() as i32,
                REQUEST_TIMEOUT.as_millis() as i32,
                MAX_RESPONSE_BYTES as i32,
            )
        })
        .await
        .map_err(|error| format!("VPN Gate Android HTTPS task failed: {error}"))?
        .map_err(|error| format!("could not load the VPN Gate server list: {error}"))
    }

    #[cfg(target_os = "windows")]
    async fn fetch_response(&self) -> Result<Vec<u8>, String> {
        tauri::async_runtime::spawn_blocking(|| {
            winhttp::fetch_vpn_gate_response(CONNECT_TIMEOUT, REQUEST_TIMEOUT, MAX_RESPONSE_BYTES)
        })
        .await
        .map_err(|error| format!("VPN Gate Windows HTTP task failed: {error}"))?
    }

    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    async fn fetch_response(&self) -> Result<Vec<u8>, String> {
        let mut response = self
            .client
            .get(VPN_GATE_API_URL)
            .send()
            .await
            .map_err(|error| format!("could not load the VPN Gate server list: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "VPN Gate server list returned HTTP {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(format!(
                "VPN Gate server list exceeds the {MAX_RESPONSE_BYTES}-byte limit"
            ));
        }

        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("could not read the VPN Gate server list: {error}"))?
        {
            let next_length = bytes
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| "VPN Gate server list size overflowed".to_string())?;
            if next_length > MAX_RESPONSE_BYTES {
                return Err(format!(
                    "VPN Gate server list exceeds the {MAX_RESPONSE_BYTES}-byte limit"
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

fn cache_is_fresh(fetched_at: Instant) -> bool {
    Instant::now().saturating_duration_since(fetched_at) < CACHE_TTL
}

fn parse_usable_api_candidates(bytes: &[u8]) -> Result<Vec<VpnGateCandidate>, String> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(format!(
            "VPN Gate server list exceeds the {MAX_RESPONSE_BYTES}-byte limit"
        ));
    }
    let response = std::str::from_utf8(bytes)
        .map_err(|_| "VPN Gate server list must be UTF-8 text".to_string())?;
    let mut lines = response.lines();
    if lines.next() != Some(VPN_GATE_MARKER) {
        return Err("VPN Gate server list marker is invalid".to_string());
    }
    if lines.next() != Some(VPN_GATE_HEADER) {
        return Err("VPN Gate server list header is invalid".to_string());
    }

    let mut candidate_ids = HashSet::new();
    let mut candidates = Vec::new();
    let mut row_count = 0usize;
    let mut footer_found = false;
    while let Some(line) = lines.next() {
        if line == VPN_GATE_FOOTER {
            footer_found = true;
            if lines.next().is_some() {
                return Err("VPN Gate server list footer is invalid".to_string());
            }
            break;
        }
        row_count = row_count
            .checked_add(1)
            .ok_or_else(|| "VPN Gate server row count overflowed".to_string())?;
        if row_count > MAX_SERVER_ROWS {
            return Err(format!(
                "VPN Gate server list exceeds the {MAX_SERVER_ROWS}-row limit"
            ));
        }
        let Ok(candidate) = parse_candidate(line) else {
            continue;
        };
        if candidate_ids.insert(candidate.server.candidate_id.clone()) {
            candidates.push(candidate);
        }
    }
    if !footer_found {
        return Err("VPN Gate server list footer is invalid".to_string());
    }
    if candidates.is_empty() {
        return Err("VPN Gate server list contains no usable OpenVPN profiles".to_string());
    }
    Ok(candidates)
}

fn parse_candidate(line: &str) -> Result<VpnGateCandidate, String> {
    let mut parts = line.splitn(16, ',');
    let mut fields = [""; 15];
    for field in &mut fields {
        *field = parts
            .next()
            .ok_or_else(|| "VPN Gate server row must contain exactly 15 fields".to_string())?;
    }
    if parts.next().is_some() {
        return Err("VPN Gate server row must contain exactly 15 fields".to_string());
    }
    for field in fields {
        if field.chars().any(char::is_control) {
            return Err("VPN Gate server row contains control characters".to_string());
        }
    }

    let host_name = validated_host_name(fields[0])?;
    let ip: Ipv4Addr = fields[1]
        .parse()
        .map_err(|_| "VPN Gate server IP address is invalid".to_string())?;
    if !is_public_ipv4(ip) {
        return Err("VPN Gate server IP address is not public".to_string());
    }
    let score = parse_u64(fields[2], "score")?;
    let ping_ms = if fields[3] == "-" {
        None
    } else {
        Some(parse_u32(fields[3], "ping")?)
    };
    let speed_bps = parse_u64(fields[4], "speed")?;
    let country_name = validated_text(fields[5], "country name", 128)?;
    let country_code = validated_country_code(fields[6])?;
    let active_sessions = parse_u32(fields[7], "active sessions")?;
    let uptime_ms = parse_u64(fields[8], "uptime")?;
    let total_users = parse_u64(fields[9], "total users")?;
    let _total_traffic = parse_u64(fields[10], "total traffic")?;
    let log_type = validated_log_type(fields[11])?;
    validate_ignored_text(fields[12], "operator")?;
    validate_ignored_text(fields[13], "message")?;
    if fields[14].len() > MAX_BASE64_PROFILE_BYTES {
        return Err(format!(
            "VPN Gate OpenVPN profile exceeds the {MAX_PROFILE_BYTES}-byte limit"
        ));
    }
    let profile = decode_base64(fields[14])?;
    let validated = validate_profile(&profile)?;
    if validated.requires_username_password {
        return Err("VPN Gate OpenVPN profile requires credentials".to_string());
    }
    let remote_ip: Ipv4Addr = validated
        .remote_host
        .parse()
        .map_err(|_| "VPN Gate OpenVPN profile remote host is not an IPv4 address".to_string())?;
    if remote_ip != ip {
        return Err(
            "VPN Gate OpenVPN profile remote host does not match its server row".to_string(),
        );
    }
    let protocol = inspect_profile_transport(&profile, ip)?;
    let profile = add_vpn_gate_authentication(profile)?;
    let normalized = validate_profile(&profile)?;
    if !normalized.requires_username_password || normalized.remote_host != validated.remote_host {
        return Err("VPN Gate OpenVPN profile authentication normalization failed".to_string());
    }
    let candidate_id = candidate_id(&profile);

    Ok(VpnGateCandidate {
        server: VpnGateServer {
            candidate_id,
            host_name,
            ip: ip.to_string(),
            score,
            ping_ms,
            speed_bps,
            country_name,
            country_code,
            active_sessions,
            uptime_ms,
            total_users,
            log_type,
            protocol,
        },
        profile,
    })
}

fn add_vpn_gate_authentication(mut profile: Vec<u8>) -> Result<Vec<u8>, String> {
    let needs_line_break = !profile.ends_with(b"\n");
    let added_bytes = VPN_GATE_PROFILE_MARKER
        .len()
        .checked_add(1)
        .and_then(|value| value.checked_add(VPN_GATE_AUTH_DIRECTIVE.len()))
        .and_then(|value| value.checked_add(usize::from(needs_line_break)))
        .ok_or_else(|| "VPN Gate OpenVPN profile size overflowed".to_string())?;
    let normalized_bytes = profile
        .len()
        .checked_add(added_bytes)
        .ok_or_else(|| "VPN Gate OpenVPN profile size overflowed".to_string())?;
    if normalized_bytes > MAX_PROFILE_BYTES {
        return Err(format!(
            "VPN Gate OpenVPN profile exceeds the {MAX_PROFILE_BYTES}-byte limit"
        ));
    }

    profile.reserve(added_bytes);
    if needs_line_break {
        profile.push(b'\n');
    }
    profile.extend_from_slice(VPN_GATE_PROFILE_MARKER.as_bytes());
    profile.push(b'\n');
    profile.extend_from_slice(VPN_GATE_AUTH_DIRECTIVE);
    Ok(profile)
}

fn candidate_id(profile: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"norea:vpn-gate-candidate:v1\0");
    hasher.update(profile);
    format!("{:x}", hasher.finalize())
}

fn inspect_profile_transport(
    profile: &[u8],
    expected_ip: Ipv4Addr,
) -> Result<VpnGateProtocol, String> {
    #[derive(Default)]
    struct TransportScope {
        protocol: Option<VpnGateProtocol>,
        remotes: Vec<Option<VpnGateProtocol>>,
    }

    let text = std::str::from_utf8(profile)
        .map_err(|_| "VPN Gate OpenVPN profile must be UTF-8 text".to_string())?;
    let mut inline_block: Option<String> = None;
    let mut global_scope = TransportScope::default();
    let mut connection_scope: Option<TransportScope> = None;
    let mut connection_scopes = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if let Some(block) = inline_block.as_deref() {
            if inline_closing_tag(line).is_some_and(|closing| closing.eq_ignore_ascii_case(block)) {
                inline_block = None;
            }
            continue;
        }
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(block) = inline_closing_tag(line) {
            if block.eq_ignore_ascii_case("connection") {
                if let Some(scope) = connection_scope.take() {
                    connection_scopes.push(scope);
                }
            }
            continue;
        }
        if let Some(block) = inline_opening_tag(line) {
            if block.eq_ignore_ascii_case("connection") {
                connection_scope = Some(TransportScope::default());
            } else {
                inline_block = Some(block.to_ascii_lowercase());
            }
            continue;
        }

        let tokens = directive_tokens(line)
            .map_err(|error| format!("VPN Gate OpenVPN profile is invalid: {error}"))?;
        let Some((directive, arguments)) = tokens.split_first() else {
            continue;
        };
        if directive.eq_ignore_ascii_case("proto") {
            let value = arguments
                .first()
                .ok_or_else(|| "VPN Gate OpenVPN profile protocol is missing".to_string())?;
            let protocol = parse_protocol(value)?;
            if let Some(scope) = connection_scope.as_mut() {
                scope.protocol = Some(protocol);
            } else {
                global_scope.protocol = Some(protocol);
            }
        } else if directive.eq_ignore_ascii_case("remote") {
            let host = arguments
                .first()
                .ok_or_else(|| "VPN Gate OpenVPN profile remote host is missing".to_string())?;
            let remote_ip: Ipv4Addr = host.parse().map_err(|_| {
                "VPN Gate OpenVPN profile remote host is not an IPv4 address".to_string()
            })?;
            if remote_ip != expected_ip {
                return Err(
                    "VPN Gate OpenVPN profile contains a mismatched remote host".to_string()
                );
            }
            let protocol = arguments
                .get(2)
                .map(|value| parse_protocol(value))
                .transpose()?;
            if let Some(scope) = connection_scope.as_mut() {
                scope.remotes.push(protocol);
            } else {
                global_scope.remotes.push(protocol);
            }
        }
    }

    if connection_scope.is_some() {
        return Err("VPN Gate OpenVPN connection block is not closed".to_string());
    }

    let global_protocol = global_scope.protocol.unwrap_or(VpnGateProtocol::Udp);
    let protocols = global_scope
        .remotes
        .into_iter()
        .map(|protocol| protocol.unwrap_or(global_protocol))
        .chain(connection_scopes.into_iter().flat_map(|scope| {
            let default_protocol = scope.protocol.unwrap_or(global_protocol);
            scope
                .remotes
                .into_iter()
                .map(move |protocol| protocol.unwrap_or(default_protocol))
        }));
    let mut resolved = None;
    for protocol in protocols {
        if resolved.is_some_and(|existing| existing != protocol) {
            return Err("VPN Gate OpenVPN profile uses multiple transport protocols".to_string());
        }
        resolved = Some(protocol);
    }
    resolved.ok_or_else(|| "VPN Gate OpenVPN profile has no remote server".to_string())
}

fn parse_protocol(value: &str) -> Result<VpnGateProtocol, String> {
    if value.eq_ignore_ascii_case("udp") || value.eq_ignore_ascii_case("udp4") {
        Ok(VpnGateProtocol::Udp)
    } else if value.eq_ignore_ascii_case("tcp")
        || value.eq_ignore_ascii_case("tcp4")
        || value.eq_ignore_ascii_case("tcp-client")
        || value.eq_ignore_ascii_case("tcp4-client")
    {
        Ok(VpnGateProtocol::Tcp)
    } else {
        Err(format!(
            "VPN Gate OpenVPN profile uses unsupported protocol '{value}'"
        ))
    }
}

fn validated_host_name(value: &str) -> Result<String, String> {
    validate_text(value, "host name", 253)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err("VPN Gate server host name contains invalid characters".to_string());
    }
    if value.split('.').any(|label| {
        label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
    }) {
        return Err("VPN Gate server host name is invalid".to_string());
    }
    Ok(value.to_string())
}

fn validated_country_code(value: &str) -> Result<String, String> {
    if value.len() != 2 || !value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err("VPN Gate server country code must contain two uppercase letters".to_string());
    }
    Ok(value.to_string())
}

fn validated_log_type(value: &str) -> Result<String, String> {
    validate_text(value, "log type", 64)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("VPN Gate server log type contains invalid characters".to_string());
    }
    Ok(value.to_string())
}

fn validated_text(value: &str, name: &str, max_bytes: usize) -> Result<String, String> {
    validate_text(value, name, max_bytes)?;
    Ok(value.to_string())
}

fn validate_text(value: &str, name: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("VPN Gate server {name} is empty"));
    }
    if value.len() > max_bytes {
        return Err(format!("VPN Gate server {name} is too long"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!(
            "VPN Gate server {name} contains control characters"
        ));
    }
    Ok(())
}

fn validate_ignored_text(value: &str, name: &str) -> Result<(), String> {
    if value.len() > 1024 {
        return Err(format!("VPN Gate server {name} is too long"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!(
            "VPN Gate server {name} contains control characters"
        ));
    }
    Ok(())
}

fn parse_u64(value: &str, name: &str) -> Result<u64, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("VPN Gate server {name} is not an unsigned integer"));
    }
    let value = value
        .parse::<u64>()
        .map_err(|_| format!("VPN Gate server {name} is out of range"))?;
    if value > MAX_SAFE_INTEGER {
        return Err(format!(
            "VPN Gate server {name} exceeds the supported numeric range"
        ));
    }
    Ok(value)
}

fn parse_u32(value: &str, name: &str) -> Result<u32, String> {
    let value = parse_u64(value, name)?;
    u32::try_from(value).map_err(|_| format!("VPN Gate server {name} is out of range"))
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [first, second, third, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || first == 0
        || first >= 240
        || (first == 100 && (64..=127).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 88 && third == 99)
        || (first == 198 && matches!(second, 18 | 19)))
}

fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err("VPN Gate OpenVPN profile Base64 is invalid".to_string());
    }
    if bytes.len() > MAX_BASE64_PROFILE_BYTES {
        return Err(format!(
            "VPN Gate OpenVPN profile exceeds the {MAX_PROFILE_BYTES}-byte limit"
        ));
    }

    let padding = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    let decoded_length = bytes
        .len()
        .checked_div(4)
        .and_then(|length| length.checked_mul(3))
        .and_then(|length| length.checked_sub(padding))
        .ok_or_else(|| "VPN Gate OpenVPN profile Base64 size is invalid".to_string())?;
    if decoded_length > MAX_PROFILE_BYTES {
        return Err(format!(
            "VPN Gate OpenVPN profile exceeds the {MAX_PROFILE_BYTES}-byte limit"
        ));
    }

    let mut decoded = Vec::with_capacity(decoded_length);
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let is_last = index + 1 == bytes.len() / 4;
        let first = base64_value(chunk[0])?;
        let second = base64_value(chunk[1])?;
        match (chunk[2], chunk[3]) {
            (b'=', b'=') if is_last && second & 0x0f == 0 => {
                decoded.push(first << 2 | second >> 4);
            }
            (third, b'=') if is_last => {
                let third = base64_value(third)?;
                if third & 0x03 != 0 {
                    return Err("VPN Gate OpenVPN profile Base64 is not canonical".to_string());
                }
                decoded.push(first << 2 | second >> 4);
                decoded.push(second << 4 | third >> 2);
            }
            (b'=', _) => {
                return Err("VPN Gate OpenVPN profile Base64 padding is invalid".to_string());
            }
            (third, fourth) => {
                let third = base64_value(third)?;
                let fourth = base64_value(fourth)?;
                decoded.push(first << 2 | second >> 4);
                decoded.push(second << 4 | third >> 2);
                decoded.push(third << 6 | fourth);
            }
        }
    }
    if decoded.len() != decoded_length {
        return Err("VPN Gate OpenVPN profile Base64 length is invalid".to_string());
    }
    Ok(decoded)
}

fn base64_value(value: u8) -> Result<u8, String> {
    match value {
        b'A'..=b'Z' => Ok(value - b'A'),
        b'a'..=b'z' => Ok(value - b'a' + 26),
        b'0'..=b'9' => Ok(value - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err("VPN Gate OpenVPN profile Base64 contains invalid characters".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILE_BASE64: &str =
        "Y2xpZW50CmRldiB0dW4KcHJvdG8gdGNwCnJlbW90ZSA5My4xODQuMjE2LjM0IDQ0Mwo=";

    fn api_response(row: &str) -> Vec<u8> {
        format!("{VPN_GATE_MARKER}\r\n{VPN_GATE_HEADER}\r\n{row}\r\n{VPN_GATE_FOOTER}\r\n")
            .into_bytes()
    }

    fn valid_row() -> String {
        format!(
            "public-vpn-1,93.184.216.34,123456,12,987654321,United States,US,4,60000,20,1000,2weeks,ignored,,{PROFILE_BASE64}"
        )
    }

    #[test]
    fn parses_valid_metadata_without_exposing_profile_bytes() {
        let candidates =
            parse_usable_api_candidates(&api_response(&valid_row())).expect("server list");
        let candidate = &candidates[0];
        let server = &candidate.server;

        assert_eq!(server.host_name, "public-vpn-1");
        assert_eq!(server.ip, "93.184.216.34");
        assert_eq!(server.ping_ms, Some(12));
        assert_eq!(server.protocol, VpnGateProtocol::Tcp);
        assert_eq!(server.candidate_id.len(), 64);
        let serialized = serde_json::to_value(server).expect("serialized server");
        assert_eq!(serialized["speedBps"], 987654321);
        assert_eq!(serialized["protocol"], "tcp");
        assert!(serialized.get("profile").is_none());
        assert!(
            validate_profile(&candidate.profile)
                .expect("normalized profile")
                .requires_username_password
        );
    }

    #[test]
    fn rejects_invalid_envelopes_and_excess_rows() {
        let invalid_marker = String::from_utf8(api_response(&valid_row()))
            .expect("UTF-8 response")
            .replacen(VPN_GATE_MARKER, "*invalid", 1);
        assert!(parse_usable_api_candidates(invalid_marker.as_bytes()).is_err());

        let rows = std::iter::repeat_n(valid_row(), MAX_SERVER_ROWS + 1)
            .collect::<Vec<_>>()
            .join("\r\n");
        assert!(parse_usable_api_candidates(&api_response(&rows)).is_err());

        let extra_after_footer = format!(
            "{VPN_GATE_MARKER}\r\n{VPN_GATE_HEADER}\r\n{}\r\n{VPN_GATE_FOOTER}\r\nextra\r\n",
            valid_row()
        );
        assert!(parse_usable_api_candidates(extra_after_footer.as_bytes()).is_err());
    }

    #[test]
    fn skips_invalid_rows_without_weakening_valid_candidates() {
        let private_ip = valid_row().replace("93.184.216.34", "127.0.0.1");
        let malformed = "too,few,fields";
        let rows = format!("{private_ip}\r\n{malformed}\r\n{}", valid_row());

        let candidates =
            parse_usable_api_candidates(&api_response(&rows)).expect("usable candidates");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].server.ip, "93.184.216.34");
    }

    #[test]
    fn rejects_remote_mismatches_credentials_and_invalid_numbers() {
        let mismatched_profile = valid_row().replace("93.184.216.34,123456", "1.1.1.1,123456");
        assert!(parse_candidate(&mismatched_profile).is_err());

        let invalid_number = valid_row().replace(",123456,12,", ",-1,12,");
        assert!(parse_candidate(&invalid_number).is_err());

        for credentials_profile in [
            b"client\ndev tun\nremote 93.184.216.34 443\nauth-user-pass\n".as_slice(),
            b"client\ndev tun\nremote 93.184.216.34 443\nauth-user-pass credentials.txt\n"
                .as_slice(),
            b"client\ndev tun\nremote 93.184.216.34 443\n<auth-user-pass>\nvpn\nvpn\n</auth-user-pass>\n"
                .as_slice(),
        ] {
            let credentials_base64 = encode_base64(credentials_profile);
            let credentials_row = valid_row().replace(PROFILE_BASE64, &credentials_base64);
            assert!(parse_candidate(&credentials_row).is_err());
        }

        assert!(parse_candidate(&format!("{},extra", valid_row())).is_err());
    }

    #[test]
    fn resolves_global_and_connection_protocols_independent_of_order() {
        let global = b"client\ndev tun\nremote 93.184.216.34 443\nproto tcp4-client\n";
        assert_eq!(
            inspect_profile_transport(global, "93.184.216.34".parse().unwrap())
                .expect("global protocol"),
            VpnGateProtocol::Tcp
        );

        let connection = b"client\ndev tun\nproto udp4\n<connection>\nremote 93.184.216.34 443\nproto tcp4-client\n</connection>\n";
        assert_eq!(
            inspect_profile_transport(connection, "93.184.216.34".parse().unwrap())
                .expect("connection protocol"),
            VpnGateProtocol::Tcp
        );
    }

    #[test]
    fn rejects_invalid_and_non_canonical_base64() {
        assert!(decode_base64("not base64").is_err());
        assert!(decode_base64("Zh==").is_err());
        assert!(decode_base64("Zm9=").is_err());
        assert_eq!(decode_base64("Zm9v").expect("canonical Base64"), b"foo");
    }

    #[test]
    fn appends_authentication_after_profiles_without_a_final_line_break() {
        assert_eq!(
            add_vpn_gate_authentication(b"client".to_vec()).expect("normalized profile"),
            b"client\n# norea:vpn-gate-finder\nauth-user-pass\n"
        );
        assert!(add_vpn_gate_authentication(vec![b'a'; MAX_PROFILE_BYTES]).is_err());
    }

    #[test]
    fn serves_profile_bytes_only_from_a_fresh_cache() {
        let finder = VpnGateFinder::new().expect("finder");
        let candidate = parse_candidate(&valid_row()).expect("candidate");
        let candidate_id = candidate.server.candidate_id.clone();
        *finder.cache.lock().expect("cache") = Some(CachedServers {
            fetched_at: Instant::now(),
            candidates: vec![candidate],
        });

        let mut expected_profile = decode_base64(PROFILE_BASE64).expect("profile");
        expected_profile.extend_from_slice(b"# norea:vpn-gate-finder\nauth-user-pass\n");
        assert_eq!(
            finder.profile_bytes(&candidate_id).expect("cached profile"),
            expected_profile
        );
        assert!(finder.profile_bytes(&"0".repeat(64)).is_err());

        finder
            .cache
            .lock()
            .expect("cache")
            .as_mut()
            .unwrap()
            .fetched_at = Instant::now() - CACHE_TTL;
        assert!(finder.profile_bytes(&candidate_id).is_err());
    }

    fn encode_base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut encoded = String::new();
        for chunk in bytes.chunks(3) {
            encoded.push(ALPHABET[(chunk[0] >> 2) as usize] as char);
            encoded.push(
                ALPHABET[((chunk[0] << 4 | chunk.get(1).copied().unwrap_or_default() >> 4) & 0x3f)
                    as usize] as char,
            );
            if let Some(second) = chunk.get(1) {
                encoded.push(
                    ALPHABET[(((*second << 2) | (chunk.get(2).copied().unwrap_or_default() >> 6))
                        & 0x3f) as usize] as char,
                );
            } else {
                encoded.push('=');
            }
            if let Some(third) = chunk.get(2) {
                encoded.push(ALPHABET[(*third & 0x3f) as usize] as char);
            } else {
                encoded.push('=');
            }
        }
        encoded
    }
}
