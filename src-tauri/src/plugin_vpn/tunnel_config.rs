use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
};

use super::directive_tokens;

const DEFAULT_TUNNEL_MTU: usize = 1500;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct TunnelConfiguration {
    pub(super) ipv4: Option<Ipv4Addr>,
    pub(super) gateway_ipv4: Option<Ipv4Addr>,
    pub(super) ipv6: Option<Ipv6Addr>,
    pub(super) gateway_ipv6: Option<Ipv6Addr>,
    pub(super) dns_servers: Vec<IpAddr>,
    pub(super) mtu: usize,
}

#[derive(Default)]
struct ModernDnsServer {
    addresses: Vec<IpAddr>,
    transport: Option<String>,
    dnssec: Option<String>,
}

pub(super) fn parse_tunnel_configuration(
    options: &str,
    mtu: i32,
) -> Result<TunnelConfiguration, String> {
    let mtu = if mtu == 0 {
        DEFAULT_TUNNEL_MTU
    } else {
        usize::try_from(mtu)
            .ok()
            .filter(|value| (576..=65_535).contains(value))
            .ok_or_else(|| "OpenVPN supplied an invalid tunnel MTU".to_string())?
    };
    let mut ipv4 = None;
    let mut gateway_ipv4 = None;
    let mut ipv6 = None;
    let mut gateway_ipv6 = None;
    let mut legacy_dns = Vec::new();
    let mut modern_dns = BTreeMap::<i32, ModernDnsServer>::new();

    for (index, line) in options.lines().enumerate() {
        let tokens = directive_tokens(line)
            .map_err(|error| format!("OpenVPN tunnel option line {}: {error}", index + 1))?;
        let Some((directive, arguments)) = tokens.split_first() else {
            continue;
        };
        match directive.to_ascii_lowercase().as_str() {
            "ifconfig" => {
                let address = parse_argument::<Ipv4Addr>(arguments, 0, "IPv4 address")?;
                ipv4 = Some(address);
                if let Some(value) = arguments.get(1) {
                    let remote_or_mask = value
                        .parse::<Ipv4Addr>()
                        .map_err(|_| "OpenVPN supplied an invalid IPv4 gateway".to_string())?;
                    if !is_ipv4_netmask(remote_or_mask) {
                        gateway_ipv4 = Some(remote_or_mask);
                    }
                }
            }
            "route-gateway" => {
                gateway_ipv4 = Some(parse_argument(arguments, 0, "IPv4 gateway")?);
            }
            "ifconfig-ipv6" => {
                let value = arguments
                    .first()
                    .ok_or_else(|| "OpenVPN tunnel IPv6 address is missing".to_string())?;
                let address = value.split('/').next().unwrap_or_default();
                ipv6 = Some(
                    address
                        .parse::<Ipv6Addr>()
                        .map_err(|_| "OpenVPN supplied an invalid IPv6 address".to_string())?,
                );
                gateway_ipv6 = arguments
                    .get(1)
                    .map(|value| {
                        value
                            .parse::<Ipv6Addr>()
                            .map_err(|_| "OpenVPN supplied an invalid IPv6 gateway".to_string())
                    })
                    .transpose()?;
            }
            "dhcp-option"
                if arguments.first().is_some_and(|value| {
                    matches!(value.to_ascii_uppercase().as_str(), "DNS" | "DNS6")
                }) =>
            {
                let server = parse_argument::<IpAddr>(arguments, 1, "DNS server")?;
                push_unique(&mut legacy_dns, server);
            }
            "dns" => parse_modern_dns(arguments, &mut modern_dns)?,
            _ => {}
        }
    }

    if ipv4.is_none() && ipv6.is_none() {
        return Err("OpenVPN supplied no tunnel address".to_string());
    }
    if ipv6.is_some() && mtu < 1280 {
        return Err("OpenVPN supplied an IPv6 tunnel MTU below 1280".to_string());
    }
    if gateway_ipv4.is_none() {
        gateway_ipv4 = ipv4;
    }
    if gateway_ipv6.is_none() {
        gateway_ipv6 = ipv6;
    }

    let mut dns_servers = legacy_dns;
    for server in modern_dns.into_values() {
        if server.addresses.is_empty() {
            return Err("OpenVPN DNS server has no address".to_string());
        }
        if server
            .transport
            .as_deref()
            .is_some_and(|value| !value.eq_ignore_ascii_case("plain"))
        {
            return Err("OpenVPN DNS-over-HTTPS and DNS-over-TLS are not supported".to_string());
        }
        if server
            .dnssec
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("yes"))
        {
            return Err("OpenVPN profiles that require DNSSEC are not supported".to_string());
        }
        for address in server.addresses {
            push_unique(&mut dns_servers, address);
        }
    }
    dns_servers.retain(|server| match server {
        IpAddr::V4(_) => ipv4.is_some(),
        IpAddr::V6(_) => ipv6.is_some(),
    });
    if dns_servers.is_empty() {
        return Err("OpenVPN supplied no usable in-tunnel DNS server".to_string());
    }

    Ok(TunnelConfiguration {
        ipv4,
        gateway_ipv4,
        ipv6,
        gateway_ipv6,
        dns_servers,
        mtu,
    })
}

fn parse_modern_dns(
    arguments: &[String],
    servers: &mut BTreeMap<i32, ModernDnsServer>,
) -> Result<(), String> {
    if !arguments
        .first()
        .is_some_and(|value| value.eq_ignore_ascii_case("server"))
    {
        return Ok(());
    }
    let priority = parse_argument::<i32>(arguments, 1, "DNS priority")?;
    let option = arguments
        .get(2)
        .ok_or_else(|| "OpenVPN DNS server option is missing".to_string())?
        .to_ascii_lowercase();
    let server = servers.entry(priority).or_default();
    match option.as_str() {
        "address" => {
            if arguments.len() < 4 {
                return Err("OpenVPN DNS server address is missing".to_string());
            }
            for value in &arguments[3..] {
                let (address, port) = parse_dns_endpoint(value)?;
                if port != 53 {
                    return Err("OpenVPN DNS servers must use port 53".to_string());
                }
                push_unique(&mut server.addresses, address);
            }
        }
        "transport" => {
            server.transport = Some(
                arguments
                    .get(3)
                    .ok_or_else(|| "OpenVPN DNS transport is missing".to_string())?
                    .clone(),
            );
        }
        "dnssec" => {
            server.dnssec = Some(
                arguments
                    .get(3)
                    .ok_or_else(|| "OpenVPN DNSSEC mode is missing".to_string())?
                    .clone(),
            );
        }
        "resolve-domains" | "exclude-domains" | "sni" => {}
        _ => return Err(format!("unsupported OpenVPN DNS server option '{option}'")),
    }
    Ok(())
}

fn parse_dns_endpoint(value: &str) -> Result<(IpAddr, u16), String> {
    if let Ok(address) = value.parse::<IpAddr>() {
        return Ok((address, 53));
    }
    value
        .parse::<SocketAddr>()
        .map(|endpoint| (endpoint.ip(), endpoint.port()))
        .map_err(|_| "OpenVPN supplied an invalid DNS server address".to_string())
}

fn parse_argument<T: std::str::FromStr>(
    arguments: &[String],
    index: usize,
    name: &str,
) -> Result<T, String> {
    arguments
        .get(index)
        .ok_or_else(|| format!("OpenVPN tunnel {name} is missing"))?
        .parse::<T>()
        .map_err(|_| format!("OpenVPN supplied an invalid {name}"))
}

fn is_ipv4_netmask(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    let inverse = !value;
    inverse == 0 || inverse & inverse.wrapping_add(1) == 0
}

fn push_unique<T: PartialEq>(values: &mut Vec<T>, value: T) {
    if !values.contains(&value) {
        values.push(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    #[test]
    fn parses_dual_stack_addresses_and_legacy_dns() {
        let configuration = parse_tunnel_configuration(
            "ifconfig 10.8.0.2 255.255.255.0\n\
             route-gateway 10.8.0.1\n\
             ifconfig-ipv6 2001:db8::2/64 2001:db8::1\n\
             dhcp-option DNS 10.8.0.53\n\
             dhcp-option DNS6 2001:db8::53\n",
            1500,
        )
        .expect("tunnel configuration");

        assert_eq!(configuration.ipv4, Some(Ipv4Addr::new(10, 8, 0, 2)));
        assert_eq!(configuration.gateway_ipv4, Some(Ipv4Addr::new(10, 8, 0, 1)));
        assert_eq!(configuration.ipv6, Some("2001:db8::2".parse().unwrap()));
        assert_eq!(
            configuration.gateway_ipv6,
            Some("2001:db8::1".parse().unwrap())
        );
        assert_eq!(
            configuration.dns_servers,
            vec![
                IpAddr::V4(Ipv4Addr::new(10, 8, 0, 53)),
                IpAddr::V6("2001:db8::53".parse::<Ipv6Addr>().unwrap()),
            ]
        );
        assert_eq!(configuration.mtu, 1500);
    }

    #[test]
    fn parses_modern_plain_dns_options() {
        let configuration = parse_tunnel_configuration(
            "ifconfig 10.9.0.2 10.9.0.1\n\
             dns server -1 address 10.9.0.53\n\
             dns server -1 transport plain\n\
             dns server -1 dnssec optional\n",
            1400,
        )
        .expect("tunnel configuration");

        assert_eq!(configuration.gateway_ipv4, Some(Ipv4Addr::new(10, 9, 0, 1)));
        assert_eq!(
            configuration.dns_servers,
            vec![IpAddr::V4(Ipv4Addr::new(10, 9, 0, 53))]
        );
    }

    #[test]
    fn defaults_an_unspecified_mtu_to_openvpn_default() {
        let configuration = parse_tunnel_configuration(
            "ifconfig 10.8.0.2 10.8.0.1\n\
             dhcp-option DNS 10.8.0.53\n",
            0,
        )
        .expect("tunnel configuration");

        assert_eq!(configuration.mtu, 1500);
    }

    #[test]
    fn rejects_dns_that_cannot_stay_inside_the_tunnel() {
        for option in [
            "dns server 0 address 10.8.0.53:5353",
            "dns server 0 transport DoH",
            "dns server 0 transport DoT",
            "dns server 0 dnssec yes",
        ] {
            let options = format!("ifconfig 10.8.0.2 10.8.0.1\n{option}\n");
            assert!(
                parse_tunnel_configuration(&options, 1500).is_err(),
                "{option}"
            );
        }
    }

    #[test]
    fn requires_an_address_and_tunneled_dns() {
        assert!(parse_tunnel_configuration("dhcp-option DNS 10.8.0.53\n", 1500).is_err());
        assert!(parse_tunnel_configuration("ifconfig 10.8.0.2 10.8.0.1\n", 1500).is_err());
        assert!(parse_tunnel_configuration(
            "ifconfig-ipv6 2001:db8::2/64 2001:db8::1\ndhcp-option DNS6 2001:db8::53\n",
            1200,
        )
        .is_err());
    }
}
