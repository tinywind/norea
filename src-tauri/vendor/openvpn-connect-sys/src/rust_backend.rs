use std::net::{IpAddr, ToSocketAddrs};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::slice;
use std::str;
use std::sync::Once;

use crate::{ovpn_rust_backend_register, ovpn_rust_backend_vtable, ovpn_rust_ip_address};

mod crypto;
mod tls;

const IPV4_FAMILY: u8 = 4;
const IPV6_FAMILY: u8 = 6;

static INSTALL: Once = Once::new();

/// Installs the Rust implementation used by the native OpenVPN Core adapter.
///
/// Registration is process-global because Core's resolver can outlive the
/// client thread while an asynchronous lookup is in progress.
pub fn install() {
    INSTALL.call_once(|| {
        let callbacks = ovpn_rust_backend_vtable {
            resolve: Some(resolve_callback),
            random: Some(crypto::random),
            digest_new: Some(crypto::digest_new),
            digest_free: Some(crypto::digest_free),
            digest_update: Some(crypto::digest_update),
            digest_final: Some(crypto::digest_final),
            digest_size: Some(crypto::digest_size),
            hmac_new: Some(crypto::hmac_new),
            hmac_free: Some(crypto::hmac_free),
            hmac_reset: Some(crypto::hmac_reset),
            hmac_update: Some(crypto::hmac_update),
            hmac_final: Some(crypto::hmac_final),
            hmac_size: Some(crypto::hmac_size),
            cipher_new: Some(crypto::cipher_new),
            cipher_free: Some(crypto::cipher_free),
            cipher_reset: Some(crypto::cipher_reset),
            cipher_update: Some(crypto::cipher_update),
            cipher_final: Some(crypto::cipher_final),
            cipher_supported: Some(crypto::cipher_supported),
            aead_new: Some(crypto::aead_new),
            aead_free: Some(crypto::aead_free),
            aead_encrypt: Some(crypto::aead_encrypt),
            aead_decrypt: Some(crypto::aead_decrypt),
            aead_supported: Some(crypto::aead_supported),
            tls_config_new: Some(tls::config_new),
            tls_config_free: Some(tls::config_free),
            tls_connection_new: Some(tls::connection_new),
            tls_connection_free: Some(tls::connection_free),
            tls_write_plaintext: Some(tls::write_plaintext),
            tls_read_plaintext: Some(tls::read_plaintext),
            tls_plaintext_ready: Some(tls::plaintext_ready),
            tls_write_ciphertext: Some(tls::write_ciphertext),
            tls_read_ciphertext: Some(tls::read_ciphertext),
            tls_ciphertext_ready: Some(tls::ciphertext_ready),
            tls_details: Some(tls::details),
            tls_export_keying_material: Some(tls::export_keying_material),
            tls_handshake_complete: Some(tls::handshake_complete),
            tls_peer_info: Some(tls::peer_info),
            tls_validate: Some(tls::validate),
            tls_key_info: Some(tls::key_info),
        };
        // SAFETY: the native side copies the function table before this stack
        // value goes out of scope. Each callback has process lifetime.
        unsafe { ovpn_rust_backend_register(&raw const callbacks) };
    });
}

unsafe extern "C" fn resolve_callback(
    host: *const u8,
    host_len: usize,
    addresses: *mut ovpn_rust_ip_address,
    addresses_capacity: usize,
    addresses_len: *mut usize,
) -> i32 {
    if host.is_null() || addresses.is_null() || addresses_len.is_null() {
        return 0;
    }

    let result = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: the native resolver lends a host buffer for this callback.
        let host = unsafe { slice::from_raw_parts(host, host_len) };
        let host = str::from_utf8(host).map_err(|error| error.to_string())?;
        let resolved = resolve_host(host)?;
        let count = resolved.len().min(addresses_capacity);

        // SAFETY: the caller provides `addresses_capacity` writable entries.
        let output = unsafe { slice::from_raw_parts_mut(addresses, addresses_capacity) };
        for (slot, address) in output.iter_mut().zip(resolved).take(count) {
            *slot = encode_address(address);
        }
        // SAFETY: the caller provides one writable result length.
        unsafe { addresses_len.write(count) };
        Ok::<(), String>(())
    }));

    i32::from(matches!(result, Ok(Ok(()))))
}

fn resolve_host(host: &str) -> Result<Vec<IpAddr>, String> {
    if let Ok(address) = host.parse() {
        return Ok(vec![address]);
    }

    (host, 0)
        .to_socket_addrs()
        .map(|addresses| addresses.map(|address| address.ip()).collect())
        .map_err(|error| format!("could not resolve OpenVPN host '{host}': {error}"))
}

fn encode_address(address: IpAddr) -> ovpn_rust_ip_address {
    let mut encoded = ovpn_rust_ip_address {
        family: 0,
        octets: [0; 16],
    };
    match address {
        IpAddr::V4(address) => {
            encoded.family = IPV4_FAMILY;
            encoded.octets[..4].copy_from_slice(&address.octets());
        }
        IpAddr::V6(address) => {
            encoded.family = IPV6_FAMILY;
            encoded.octets.copy_from_slice(&address.octets());
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{IPV4_FAMILY, IPV6_FAMILY, encode_address, resolve_host};

    #[test]
    fn resolves_literal_addresses_without_network_access() {
        let ipv4 = resolve_host("192.0.2.1").unwrap();
        let ipv6 = resolve_host("2001:db8::1").unwrap();

        assert_eq!(ipv4.len(), 1);
        assert_eq!(ipv6.len(), 1);
        assert_eq!(encode_address(ipv4[0]).family, IPV4_FAMILY);
        assert_eq!(encode_address(ipv6[0]).family, IPV6_FAMILY);
    }

    #[test]
    fn resolves_hostname_with_system_resolver() {
        let resolved = resolve_host("localhost").unwrap();

        assert!(resolved.iter().any(std::net::IpAddr::is_loopback));
    }
}
