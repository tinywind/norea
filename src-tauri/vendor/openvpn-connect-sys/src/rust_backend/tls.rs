use std::collections::VecDeque;
use std::ffi::c_void;
use std::fmt;
use std::io::{Cursor, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::slice;
use std::str;
use std::sync::Arc;

use digest::Digest;
use pkcs8::der::Decode;
use pkcs8::{EncryptedPrivateKeyInfo, SecretDocument};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    verify_tls12_signature, verify_tls13_signature, verify_tls13_signature_with_raw_key,
    CryptoProvider, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{
    CertificateDer, CertificateRevocationListDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName,
    SubjectPublicKeyInfoDer, UnixTime,
};
use rustls::sign::{CertifiedKey, Signer, SigningKey, SingleCertAndKey};
use rustls::{
    CipherSuite, ClientConfig, ClientConnection, DigitallySignedStruct, Error as RustlsError,
    NamedGroup, ProtocolVersion, RootCertStore, SignatureAlgorithm, SignatureScheme,
};
use webpki::{
    CertRevocationList, EndEntityCert, KeyUsage, OwnedCertRevocationList, RevocationOptionsBuilder,
};
use x509_parser::extensions::ParsedExtension;
use x509_parser::parse_x509_certificate;
use x509_parser::public_key::PublicKey;
use x509_parser::x509::X509Version;

use crate::{ovpn_rust_external_sign_fn, ovpn_string_view};

const NO_VERIFY_PEER: u32 = 1 << 1;
const VERIFY_PEER_FINGERPRINT: u32 = 1 << 8;
const TLS_VERSION_1_2: u32 = 3;
const TLS_VERSION_1_3: u32 = 4;
const PEM_CERT: u32 = 1;
const PEM_CERT_LIST: u32 = 2;
const PEM_PRIVATE_KEY: u32 = 3;
const PEM_CRL: u32 = 4;
const PEM_DH: u32 = 5;
const PK_UNKNOWN: u32 = 0;
const PK_NONE: u32 = 1;
const PK_DSA: u32 = 2;
const PK_RSA: u32 = 3;
const PK_ECDSA: u32 = 5;
const NS_CERT_NONE: u32 = 0;
const NS_CERT_CLIENT: u32 = 1;
const NS_CERT_SERVER: u32 = 2;
const VERIFY_X509_NONE: u32 = 0;
const VERIFY_X509_SUBJECT_DN: u32 = 1;
const VERIFY_X509_SUBJECT_RDN: u32 = 2;
const VERIFY_X509_SUBJECT_RDN_PREFIX: u32 = 3;

#[derive(Debug)]
struct CertificatePolicy {
    ns_cert_type: u32,
    key_usages: Vec<u32>,
    extended_key_usage: String,
    tls_remote: String,
    verify_x509_name_mode: u32,
    verify_x509_name: String,
}

struct TlsConfig {
    config: Arc<ClientConfig>,
}

struct TlsConnection {
    connection: ClientConnection,
    ciphertext: VecDeque<u8>,
    plaintext_ready: usize,
    peer_closed: bool,
}

#[derive(Debug)]
struct OpenVpnServerVerifier {
    roots: RootCertStore,
    root_certificates: Vec<CertificateDer<'static>>,
    crls: Vec<CertRevocationList<'static>>,
    peer_fingerprints: Vec<[u8; 32]>,
    supported: WebPkiSupportedAlgorithms,
    verify_chain: bool,
    policy: CertificatePolicy,
}

impl ServerCertVerifier for OpenVpnServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, RustlsError> {
        if self.verify_chain && !self.peer_fingerprints.is_empty() {
            let actual: [u8; 32] = sha2::Sha256::digest(end_entity.as_ref()).into();
            if !self.peer_fingerprints.contains(&actual) {
                return Err(RustlsError::General(
                    "peer certificate fingerprint does not match".into(),
                ));
            }
        } else if self.verify_chain && is_x509_v1_certificate(end_entity) {
            verify_x509_v1_server_certificate(
                end_entity,
                intermediates,
                &self.root_certificates,
                &self.crls,
                now,
            )
            .map_err(RustlsError::General)?;
        } else if self.verify_chain {
            let cert = EndEntityCert::try_from(end_entity).map_err(|error| {
                RustlsError::General(format!("invalid peer certificate: {error}"))
            })?;
            let crl_refs: Vec<_> = self.crls.iter().collect();
            let revocation = if crl_refs.is_empty() {
                None
            } else {
                Some(
                    RevocationOptionsBuilder::new(&crl_refs)
                        .map_err(|_| RustlsError::General("at least one CRL is required".into()))?
                        .build(),
                )
            };
            cert.verify_for_usage(
                self.supported.all,
                &self.roots.roots,
                intermediates,
                now,
                KeyUsage::server_auth(),
                revocation,
                None,
            )
            .map_err(|error| {
                RustlsError::General(format!("peer certificate verification failed: {error}"))
            })?;
        }
        self.policy
            .verify(end_entity)
            .map_err(RustlsError::General)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        if is_x509_v1_certificate(cert) {
            verify_x509_v1_tls12_signature(
                message,
                cert,
                signature.scheme,
                signature.signature(),
                &self.supported,
            )
        } else {
            verify_tls12_signature(message, cert, signature, &self.supported)
        }
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, RustlsError> {
        if is_x509_v1_certificate(cert) {
            let public_key = certificate_public_key(cert)?;
            verify_tls13_signature_with_raw_key(message, &public_key, signature, &self.supported)
        } else {
            verify_tls13_signature(message, cert, signature, &self.supported)
        }
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}

impl CertificatePolicy {
    fn validate(&self) -> Result<(), String> {
        if !matches!(
            self.ns_cert_type,
            NS_CERT_NONE | NS_CERT_CLIENT | NS_CERT_SERVER
        ) {
            return Err("invalid ns-cert-type value".into());
        }
        if !matches!(
            self.verify_x509_name_mode,
            VERIFY_X509_NONE
                | VERIFY_X509_SUBJECT_DN
                | VERIFY_X509_SUBJECT_RDN
                | VERIFY_X509_SUBJECT_RDN_PREFIX
        ) {
            return Err("invalid verify-x509-name mode".into());
        }
        if self.verify_x509_name_mode != VERIFY_X509_NONE && self.verify_x509_name.is_empty() {
            return Err("verify-x509-name value is empty".into());
        }
        Ok(())
    }

    fn verify(&self, certificate: &CertificateDer<'_>) -> Result<(), String> {
        let (_, certificate) =
            parse_x509_certificate(certificate.as_ref()).map_err(|error| error.to_string())?;
        let common_name = certificate
            .subject()
            .iter_common_name()
            .next()
            .and_then(|value| value.as_str().ok())
            .unwrap_or("");

        if self.ns_cert_type != NS_CERT_NONE {
            let mut matches_purpose = certificate.extensions().iter().any(|extension| {
                matches!(
                    extension.parsed_extension(),
                    ParsedExtension::NSCertType(value)
                        if (self.ns_cert_type == NS_CERT_SERVER && value.ssl_server())
                            || (self.ns_cert_type == NS_CERT_CLIENT && value.ssl_client())
                )
            });
            if !matches_purpose {
                matches_purpose = certificate
                    .extended_key_usage()
                    .map_err(|error| error.to_string())?
                    .is_some_and(|extension| {
                        extension.value.any
                            || (self.ns_cert_type == NS_CERT_SERVER && extension.value.server_auth)
                            || (self.ns_cert_type == NS_CERT_CLIENT && extension.value.client_auth)
                    });
            }
            if !matches_purpose {
                return Err("peer certificate has the wrong ns-cert-type".into());
            }
        }

        if !self.key_usages.is_empty() {
            let usage = certificate
                .key_usage()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "peer certificate has no key usage extension".to_owned())?;
            let mut encoded = 0_u32;
            for bit in 0..8 {
                if usage.value.flags & (1 << bit) != 0 {
                    encoded |= 1 << (7 - bit);
                }
            }
            if !self.key_usages.contains(&encoded) {
                return Err(format!(
                    "peer certificate key usage 0x{encoded:02x} is not allowed"
                ));
            }
        }

        if !self.extended_key_usage.is_empty() {
            let usage = certificate
                .extended_key_usage()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "peer certificate has no extended key usage extension".to_owned())?;
            if !extended_key_usage_matches(usage.value, &self.extended_key_usage) {
                return Err(format!(
                    "peer certificate extended key usage does not include {}",
                    self.extended_key_usage
                ));
            }
        }

        let subject = certificate.subject().to_string();
        let verify_name = match self.verify_x509_name_mode {
            VERIFY_X509_NONE => true,
            VERIFY_X509_SUBJECT_DN => self.verify_x509_name == subject,
            VERIFY_X509_SUBJECT_RDN => self.verify_x509_name == common_name,
            VERIFY_X509_SUBJECT_RDN_PREFIX => common_name.starts_with(&self.verify_x509_name),
            _ => false,
        };
        if !verify_name {
            return Err("verify-x509-name did not match the peer certificate".into());
        }

        if !self.tls_remote.is_empty() {
            let legacy_subject = sanitize_x509_name(&format!(
                "/{}",
                subject.replace(", ", "/").replace(" + ", "+")
            ));
            let legacy_common_name = sanitize_common_name(common_name);
            if self.tls_remote != legacy_subject
                && !legacy_common_name.starts_with(&self.tls_remote)
            {
                return Err("tls-remote did not match the peer certificate".into());
            }
        }
        Ok(())
    }
}

fn extended_key_usage_matches(
    usage: &x509_parser::extensions::ExtendedKeyUsage<'_>,
    expected: &str,
) -> bool {
    usage.any
        || matches!(
            expected,
            "TLS Web Server Authentication" | "1.3.6.1.5.5.7.3.1"
        ) && usage.server_auth
        || matches!(
            expected,
            "TLS Web Client Authentication" | "1.3.6.1.5.5.7.3.2"
        ) && usage.client_auth
        || matches!(expected, "Code Signing" | "1.3.6.1.5.5.7.3.3") && usage.code_signing
        || matches!(expected, "E-mail Protection" | "1.3.6.1.5.5.7.3.4") && usage.email_protection
        || matches!(expected, "Time Stamping" | "1.3.6.1.5.5.7.3.8") && usage.time_stamping
        || matches!(expected, "OCSP Signing" | "1.3.6.1.5.5.7.3.9") && usage.ocsp_signing
        || usage
            .other
            .iter()
            .any(|identifier| identifier.to_id_string() == expected)
}

fn sanitize_x509_name(value: &str) -> String {
    let mut leading_dash = true;
    value
        .chars()
        .map(|character| {
            if character == '-' && leading_dash {
                return '_';
            }
            leading_dash = false;
            if character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | '@' | ':' | '/' | '=')
            {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn sanitize_common_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '@' | '/')
            {
                character
            } else {
                '_'
            }
        })
        .collect()
}

struct ExternalSigningKey {
    context: usize,
    callback: ovpn_rust_external_sign_fn,
    algorithm: SignatureAlgorithm,
}

unsafe impl Send for ExternalSigningKey {}
unsafe impl Sync for ExternalSigningKey {}

impl fmt::Debug for ExternalSigningKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalSigningKey")
            .field("algorithm", &self.algorithm)
            .finish_non_exhaustive()
    }
}

impl SigningKey for ExternalSigningKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        preferred_schemes(self.algorithm)
            .iter()
            .copied()
            .find(|scheme| offered.contains(scheme))
            .map(|scheme| {
                Box::new(ExternalSigner {
                    context: self.context,
                    callback: self.callback,
                    scheme,
                }) as Box<dyn Signer>
            })
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        self.algorithm
    }
}

struct ExternalSigner {
    context: usize,
    callback: ovpn_rust_external_sign_fn,
    scheme: SignatureScheme,
}

unsafe impl Send for ExternalSigner {}
unsafe impl Sync for ExternalSigner {}

impl fmt::Debug for ExternalSigner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExternalSigner")
            .field("scheme", &self.scheme)
            .finish_non_exhaustive()
    }
}

impl Signer for ExternalSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, RustlsError> {
        let callback = self.callback.ok_or_else(|| {
            RustlsError::General("external signing callback is unavailable".into())
        })?;
        let mut signature = vec![0; 8192];
        // SAFETY: the C++ callback only borrows the message and output buffers
        // for the duration of this call.
        let length = unsafe {
            callback(
                self.context as *mut c_void,
                u16::from(self.scheme),
                message.as_ptr(),
                message.len(),
                signature.as_mut_ptr(),
                signature.len(),
            )
        };
        let length = usize::try_from(length)
            .map_err(|_| RustlsError::General("external private key signing failed".into()))?;
        if length == 0 || length > signature.len() {
            return Err(RustlsError::General(
                "external private key signing failed".into(),
            ));
        }
        signature.truncate(length);
        Ok(signature)
    }

    fn scheme(&self) -> SignatureScheme {
        self.scheme
    }
}

pub(super) unsafe extern "C" fn config_new(
    ca: ovpn_string_view,
    crl: ovpn_string_view,
    cert: ovpn_string_view,
    extra_certs: ovpn_string_view,
    private_key: ovpn_string_view,
    private_key_password: ovpn_string_view,
    peer_fingerprints: ovpn_string_view,
    ns_cert_type: u32,
    key_usage_selector: ovpn_string_view,
    extended_usage_selector: ovpn_string_view,
    tls_remote: ovpn_string_view,
    verify_x509_name_mode: u32,
    verify_x509_name: ovpn_string_view,
    tls_cipher_list: ovpn_string_view,
    tls_ciphersuite_list: ovpn_string_view,
    tls_groups: ovpn_string_view,
    tls_version_min: u32,
    tls_version_max: u32,
    flags: u32,
    local_cert_enabled: i32,
    external_sign_context: *mut c_void,
    external_sign: ovpn_rust_external_sign_fn,
    error: *mut u8,
    error_capacity: usize,
) -> *mut c_void {
    ffi_pointer(error, error_capacity, || {
        let mut provider = rustls::crypto::ring::default_provider();
        configure_provider(
            &mut provider,
            view_str(tls_cipher_list)?,
            view_str(tls_ciphersuite_list)?,
            view_str(tls_groups)?,
        )?;
        let provider = Arc::new(provider);
        let versions = protocol_versions(tls_version_min, tls_version_max)?;
        let ca = view_bytes(ca)?;
        let crl = view_bytes(crl)?;
        let cert = view_bytes(cert)?;
        let extra_certs = view_bytes(extra_certs)?;
        let private_key = view_bytes(private_key)?;
        let password = view_bytes(private_key_password)?;
        let peer_fingerprints = parse_fingerprints(view_str(peer_fingerprints)?)?;
        let policy = CertificatePolicy {
            ns_cert_type,
            key_usages: parse_key_usages(view_str(key_usage_selector)?)?,
            extended_key_usage: view_str(extended_usage_selector)?.to_owned(),
            tls_remote: view_str(tls_remote)?.to_owned(),
            verify_x509_name_mode,
            verify_x509_name: view_str(verify_x509_name)?.to_owned(),
        };
        policy.validate()?;

        let mut roots = RootCertStore::empty();
        let root_certificates = parse_certificates(ca)?;
        for root in &root_certificates {
            roots
                .add(root.clone())
                .map_err(|error| format!("invalid CA certificate: {error}"))?;
        }
        if flags & NO_VERIFY_PEER == 0 && peer_fingerprints.is_empty() && roots.is_empty() {
            return Err("CA certificate is required when peer verification is enabled".into());
        }

        let crls = parse_crls(crl)?
            .into_iter()
            .map(|value| {
                OwnedCertRevocationList::from_der(value.as_ref())
                    .map(CertRevocationList::from)
                    .map_err(|error| format!("invalid certificate revocation list: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let verifier = Arc::new(OpenVpnServerVerifier {
            roots,
            root_certificates,
            crls,
            peer_fingerprints,
            supported: provider.signature_verification_algorithms,
            verify_chain: flags & NO_VERIFY_PEER == 0 || flags & VERIFY_PEER_FINGERPRINT != 0,
            policy,
        });
        let builder = ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&versions)
            .map_err(|error| error.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(verifier);

        let mut client_config = if local_cert_enabled == 0 {
            builder.with_no_client_auth()
        } else {
            let mut chain = parse_certificates(cert)?;
            chain.extend(parse_certificates(extra_certs)?);
            if chain.is_empty() {
                return Err("client certificate is required".into());
            }

            if external_sign.is_some() {
                let algorithm = certificate_signature_algorithm(&chain[0])?;
                let key = Arc::new(ExternalSigningKey {
                    context: external_sign_context as usize,
                    callback: external_sign,
                    algorithm,
                });
                let certified_key = CertifiedKey::new(chain, key);
                builder.with_client_cert_resolver(Arc::new(SingleCertAndKey::from(certified_key)))
            } else {
                let key = parse_private_key(private_key, password)?;
                if is_x509_v1_certificate(&chain[0]) {
                    let certified_key = legacy_client_certified_key(chain, key, &provider)
                        .map_err(|error| {
                            format!("invalid client certificate/private key: {error}")
                        })?;
                    builder
                        .with_client_cert_resolver(Arc::new(SingleCertAndKey::from(certified_key)))
                } else {
                    builder.with_client_auth_cert(chain, key).map_err(|error| {
                        format!("invalid client certificate/private key: {error}")
                    })?
                }
            }
        };
        client_config.enable_sni = false;

        Ok(TlsConfig {
            config: Arc::new(client_config),
        })
    })
}

pub(super) unsafe extern "C" fn config_free(handle: *mut c_void) {
    free_handle::<TlsConfig>(handle);
}

pub(super) unsafe extern "C" fn connection_new(
    config: *const c_void,
    server_name: ovpn_string_view,
    error: *mut u8,
    error_capacity: usize,
) -> *mut c_void {
    ffi_pointer(error, error_capacity, || {
        let config = handle_ref::<TlsConfig>(config)?;
        let name = view_str(server_name)?;
        let name = if name.is_empty() {
            "openvpn.invalid"
        } else {
            name
        };
        let server_name = ServerName::try_from(name.to_owned())
            .map_err(|error| format!("invalid TLS server name: {error}"))?;
        let connection = ClientConnection::new(config.config.clone(), server_name)
            .map_err(|error| error.to_string())?;
        Ok(TlsConnection {
            connection,
            ciphertext: VecDeque::new(),
            plaintext_ready: 0,
            peer_closed: false,
        })
    })
}

pub(super) unsafe extern "C" fn connection_free(handle: *mut c_void) {
    free_handle::<TlsConnection>(handle);
}

pub(super) unsafe extern "C" fn write_plaintext(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
    error: *mut u8,
    error_capacity: usize,
) -> isize {
    ffi_io(error, error_capacity, || {
        let handle = handle_mut::<TlsConnection>(handle)?;
        let input = input_slice(input, input_len)?;
        handle
            .connection
            .writer()
            .write(input)
            .map_err(|error| error.to_string())
    })
}

pub(super) unsafe extern "C" fn read_plaintext(
    handle: *mut c_void,
    output: *mut u8,
    output_capacity: usize,
    error: *mut u8,
    error_capacity: usize,
) -> isize {
    ffi_io(error, error_capacity, || {
        let handle = handle_mut::<TlsConnection>(handle)?;
        let output = output_slice(output, output_capacity)?;
        match handle.connection.reader().read(output) {
            Ok(0) if handle.peer_closed => Ok(usize::MAX),
            Ok(length) => {
                handle.plaintext_ready = handle.plaintext_ready.saturating_sub(length);
                Ok(length)
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
            Err(error) => Err(error.to_string()),
        }
    })
}

pub(super) unsafe extern "C" fn plaintext_ready(handle: *const c_void) -> i32 {
    ffi_state(|| {
        let handle = handle_ref::<TlsConnection>(handle)?;
        Ok(handle.plaintext_ready != 0 || handle.peer_closed)
    })
}

pub(super) unsafe extern "C" fn write_ciphertext(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
    error: *mut u8,
    error_capacity: usize,
) -> isize {
    ffi_io(error, error_capacity, || {
        let handle = handle_mut::<TlsConnection>(handle)?;
        let input = input_slice(input, input_len)?;
        let mut cursor = Cursor::new(input);
        let read = handle
            .connection
            .read_tls(&mut cursor)
            .map_err(|error| error.to_string())?;
        let state = handle
            .connection
            .process_new_packets()
            .map_err(|error| error.to_string())?;
        handle.plaintext_ready = state.plaintext_bytes_to_read();
        handle.peer_closed = state.peer_has_closed();
        Ok(read)
    })
}

pub(super) unsafe extern "C" fn read_ciphertext(
    handle: *mut c_void,
    output: *mut u8,
    output_capacity: usize,
    error: *mut u8,
    error_capacity: usize,
) -> isize {
    ffi_io(error, error_capacity, || {
        let handle = handle_mut::<TlsConnection>(handle)?;
        if handle.ciphertext.is_empty() && handle.connection.wants_write() {
            let mut pending = Vec::new();
            handle
                .connection
                .write_tls(&mut pending)
                .map_err(|error| error.to_string())?;
            handle.ciphertext.extend(pending);
        }
        let output = output_slice(output, output_capacity)?;
        let length = output.len().min(handle.ciphertext.len());
        for slot in &mut output[..length] {
            *slot = handle
                .ciphertext
                .pop_front()
                .expect("ciphertext length checked");
        }
        Ok(length)
    })
}

pub(super) unsafe extern "C" fn ciphertext_ready(handle: *const c_void) -> i32 {
    ffi_state(|| {
        let handle = handle_ref::<TlsConnection>(handle)?;
        Ok(!handle.ciphertext.is_empty() || handle.connection.wants_write())
    })
}

pub(super) unsafe extern "C" fn details(
    handle: *const c_void,
    output: *mut u8,
    output_capacity: usize,
) -> usize {
    ffi_length(|| {
        let handle = handle_ref::<TlsConnection>(handle)?;
        let version = match handle.connection.protocol_version() {
            Some(ProtocolVersion::TLSv1_2) => "TLSv1.2",
            Some(ProtocolVersion::TLSv1_3) => "TLSv1.3",
            Some(_) => "TLS",
            None => return Ok(0),
        };
        let suite = handle
            .connection
            .negotiated_cipher_suite()
            .map_or_else(|| "UNKNOWN".into(), |value| format!("{:?}", value.suite()));
        copy_output(
            output,
            output_capacity,
            format!("{version}/{suite}").as_bytes(),
        )
    })
}

pub(super) unsafe extern "C" fn export_keying_material(
    handle: *const c_void,
    label: ovpn_string_view,
    output: *mut u8,
    output_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_ref::<TlsConnection>(handle)?;
        let label = view_bytes(label)?;
        let output = output_slice(output, output_len)?;
        handle
            .connection
            .export_keying_material(output, label, None)
            .map(|_| ())
            .map_err(|error| error.to_string())
    })
}

pub(super) unsafe extern "C" fn handshake_complete(handle: *const c_void) -> i32 {
    ffi_state(|| {
        let handle = handle_ref::<TlsConnection>(handle)?;
        Ok(!handle.connection.is_handshaking())
    })
}

pub(super) unsafe extern "C" fn peer_info(
    handle: *const c_void,
    common_name: *mut u8,
    common_name_capacity: usize,
    common_name_len: *mut usize,
    serial: *mut i64,
) -> i32 {
    ffi_status(|| {
        let handle = handle_ref::<TlsConnection>(handle)?;
        let certificate = handle
            .connection
            .peer_certificates()
            .and_then(|certificates| certificates.first())
            .ok_or_else(|| "peer certificate is unavailable".to_owned())?;
        let (_, certificate) =
            parse_x509_certificate(certificate.as_ref()).map_err(|error| error.to_string())?;
        let cn = certificate
            .subject()
            .iter_common_name()
            .next()
            .and_then(|value| value.as_str().ok())
            .unwrap_or("");
        let output = output_slice(common_name, common_name_capacity)?;
        let length = cn.len().min(output.len());
        output[..length].copy_from_slice(&cn.as_bytes()[..length]);
        if common_name_len.is_null() || serial.is_null() {
            return Err("peer info output pointer is null".into());
        }
        // SAFETY: both output pointers are checked and owned by the caller.
        unsafe {
            common_name_len.write(length);
            serial.write(serial_i64(certificate.raw_serial()));
        }
        Ok(())
    })
}

pub(super) unsafe extern "C" fn validate(
    kind: u32,
    value: ovpn_string_view,
    password: ovpn_string_view,
    error: *mut u8,
    error_capacity: usize,
) -> i32 {
    ffi_status_with_error(error, error_capacity, || {
        let value = view_bytes(value)?;
        let password = view_bytes(password)?;
        match kind {
            PEM_CERT => {
                if parse_certificates(value)?.len() != 1 {
                    return Err("expected exactly one certificate".into());
                }
            }
            PEM_CERT_LIST => {
                if parse_certificates(value)?.is_empty() {
                    return Err("certificate list is empty".into());
                }
            }
            PEM_PRIVATE_KEY => {
                parse_private_key(value, password)?;
            }
            PEM_CRL => {
                if parse_crls(value)?.is_empty() {
                    return Err("certificate revocation list is empty".into());
                }
            }
            PEM_DH => {
                if !value
                    .windows("BEGIN DH PARAMETERS".len())
                    .any(|part| part == b"BEGIN DH PARAMETERS")
                {
                    return Err("invalid DH parameters PEM".into());
                }
            }
            _ => return Err("unknown PEM validation type".into()),
        }
        Ok(())
    })
}

pub(super) unsafe extern "C" fn key_info(
    cert: ovpn_string_view,
    key_type: *mut u32,
    key_bits: *mut usize,
) -> i32 {
    ffi_status(|| {
        if key_type.is_null() || key_bits.is_null() {
            return Err("key info output pointer is null".into());
        }
        let certificates = parse_certificates(view_bytes(cert)?)?;
        let Some(certificate) = certificates.first() else {
            // SAFETY: output pointers were checked.
            unsafe {
                key_type.write(PK_NONE);
                key_bits.write(0);
            }
            return Ok(());
        };
        let (kind, bits) = certificate_key_info(certificate)?;
        // SAFETY: output pointers were checked.
        unsafe {
            key_type.write(kind);
            key_bits.write(bits);
        }
        Ok(())
    })
}

fn configure_provider(
    provider: &mut rustls::crypto::CryptoProvider,
    tls12: &str,
    tls13: &str,
    groups: &str,
) -> Result<(), String> {
    let tls12_names = selector_names(tls12);
    let tls13_names = selector_names(tls13);
    if !tls12_names.is_empty() && !tls12_names.iter().any(|name| name == "DEFAULT") {
        provider.cipher_suites.retain(|suite| {
            suite.version().version == ProtocolVersion::TLSv1_3
                || tls12_names
                    .iter()
                    .any(|name| cipher_suite_matches(suite.suite(), name))
        });
    }
    if !tls13_names.is_empty() && !tls13_names.iter().any(|name| name == "DEFAULT") {
        provider.cipher_suites.retain(|suite| {
            suite.version().version == ProtocolVersion::TLSv1_2
                || tls13_names
                    .iter()
                    .any(|name| cipher_suite_matches(suite.suite(), name))
        });
    }
    if provider.cipher_suites.is_empty() {
        return Err("configured TLS cipher lists contain no rustls-supported suites".into());
    }

    let group_names = selector_names(groups);
    if !group_names.is_empty() && !group_names.iter().any(|name| name == "DEFAULT") {
        provider.kx_groups.retain(|group| {
            group_names
                .iter()
                .any(|name| key_exchange_group_matches(group.name(), name))
        });
        if provider.kx_groups.is_empty() {
            return Err("configured tls-groups contains no rustls-supported group".into());
        }
    }
    Ok(())
}

fn selector_names(value: &str) -> Vec<String> {
    value
        .split(':')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.to_ascii_uppercase().replace('-', "_"))
        .collect()
}

fn cipher_suite_matches(suite: CipherSuite, name: &str) -> bool {
    if format!("{suite:?}") == name {
        return true;
    }
    matches!(
        (suite, name),
        (
            CipherSuite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
            "ECDHE_RSA_AES128_GCM_SHA256"
        ) | (
            CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            "ECDHE_RSA_AES256_GCM_SHA384"
        ) | (
            CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
            "ECDHE_ECDSA_AES128_GCM_SHA256"
        ) | (
            CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            "ECDHE_ECDSA_AES256_GCM_SHA384"
        ) | (
            CipherSuite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
            "ECDHE_RSA_CHACHA20_POLY1305"
        ) | (
            CipherSuite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
            "ECDHE_ECDSA_CHACHA20_POLY1305"
        )
    )
}

fn key_exchange_group_matches(group: NamedGroup, name: &str) -> bool {
    matches!(
        (group, name),
        (NamedGroup::X25519, "X25519")
            | (NamedGroup::secp256r1, "SECP256R1" | "PRIME256V1" | "P_256")
            | (NamedGroup::secp384r1, "SECP384R1" | "P_384")
    )
}

fn parse_key_usages(value: &str) -> Result<Vec<u32>, String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse()
                .map_err(|error| format!("invalid remote-cert-ku value: {error}"))
        })
        .collect()
}

fn protocol_versions(
    minimum: u32,
    maximum: u32,
) -> Result<Vec<&'static rustls::SupportedProtocolVersion>, String> {
    let minimum = if minimum == 0 {
        TLS_VERSION_1_2
    } else {
        minimum.max(TLS_VERSION_1_2)
    };
    let maximum = if maximum == 0 {
        TLS_VERSION_1_3
    } else {
        maximum
    };
    let mut versions = Vec::new();
    if minimum <= TLS_VERSION_1_3 && maximum >= TLS_VERSION_1_3 {
        versions.push(&rustls::version::TLS13);
    }
    if minimum <= TLS_VERSION_1_2 && maximum >= TLS_VERSION_1_2 {
        versions.push(&rustls::version::TLS12);
    }
    if versions.is_empty() {
        return Err("rustls supports TLS 1.2 and TLS 1.3".into());
    }
    Ok(versions)
}

fn parse_certificates(value: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    rustls_pemfile::certs(&mut Cursor::new(value))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn parse_crls(value: &[u8]) -> Result<Vec<CertificateRevocationListDer<'static>>, String> {
    if value.is_empty() {
        return Ok(Vec::new());
    }
    rustls_pemfile::crls(&mut Cursor::new(value))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn parse_private_key(value: &[u8], password: &[u8]) -> Result<PrivateKeyDer<'static>, String> {
    if value.is_empty() {
        return Err("private key is empty".into());
    }
    if value
        .windows("BEGIN ENCRYPTED PRIVATE KEY".len())
        .any(|part| part == b"BEGIN ENCRYPTED PRIVATE KEY")
    {
        let pem = str::from_utf8(value).map_err(|error| error.to_string())?;
        let (_, document) = SecretDocument::from_pem(pem).map_err(|error| error.to_string())?;
        let encrypted = EncryptedPrivateKeyInfo::from_der(document.as_bytes())
            .map_err(|error| error.to_string())?;
        let decrypted = encrypted
            .decrypt(password)
            .map_err(|error| format!("failed to decrypt private key: {error}"))?;
        return Ok(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            decrypted.as_bytes().to_vec(),
        )));
    }
    rustls_pemfile::private_key(&mut Cursor::new(value))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "no supported private key found".into())
}

fn is_x509_v1_certificate(certificate: &CertificateDer<'_>) -> bool {
    parse_x509_certificate(certificate.as_ref()).is_ok_and(|(remainder, certificate)| {
        remainder.is_empty() && certificate.version() == X509Version::V1
    })
}

fn verify_x509_v1_server_certificate(
    certificate_der: &CertificateDer<'_>,
    intermediates: &[CertificateDer<'_>],
    root_certificates: &[CertificateDer<'_>],
    crls: &[CertRevocationList<'_>],
    now: UnixTime,
) -> Result<(), String> {
    if intermediates.iter().any(|intermediate| {
        !root_certificates
            .iter()
            .any(|root| root.as_ref() == intermediate.as_ref())
    }) {
        return Err(
            "X.509 v1 server certificates with untrusted intermediates are not supported".into(),
        );
    }
    if !crls.is_empty() {
        return Err("X.509 v1 server certificates with CRLs are not supported".into());
    }

    let (remainder, certificate) =
        parse_x509_certificate(certificate_der.as_ref()).map_err(|error| error.to_string())?;
    if !remainder.is_empty() {
        return Err("server certificate contains trailing DER data".into());
    }
    if certificate.version() != X509Version::V1 {
        return Err("server certificate is not X.509 v1".into());
    }
    if certificate.tbs_certificate.issuer_uid.is_some()
        || certificate.tbs_certificate.subject_uid.is_some()
        || !certificate.extensions().is_empty()
    {
        return Err("X.509 v1 server certificate contains fields from a later version".into());
    }
    if certificate.signature_algorithm != certificate.tbs_certificate.signature {
        return Err("server certificate signature algorithms do not match".into());
    }
    if matches!(
        certificate
            .signature_algorithm
            .algorithm
            .to_id_string()
            .as_str(),
        "1.2.840.113549.1.1.5" | "1.3.14.3.2.29"
    ) {
        return Err("SHA-1 signed X.509 v1 server certificates are not supported".into());
    }

    let timestamp = i64::try_from(now.as_secs())
        .map_err(|_| "server certificate verification time is out of range")?;
    let now = x509_parser::time::ASN1Time::from_timestamp(timestamp)
        .map_err(|error| error.to_string())?;
    if !certificate.validity().is_valid_at(now) {
        return Err("server certificate is not valid at the current time".into());
    }

    for root_der in root_certificates {
        let Ok((remainder, root)) = parse_x509_certificate(root_der.as_ref()) else {
            continue;
        };
        if !remainder.is_empty()
            || root.subject() != certificate.issuer()
            || !root.validity().is_valid_at(now)
            || root.extensions().iter().any(|extension| {
                matches!(
                    extension.parsed_extension(),
                    ParsedExtension::NameConstraints(_)
                )
            })
        {
            continue;
        }
        if root
            .basic_constraints()
            .map_err(|error| error.to_string())?
            .is_some_and(|constraints| !constraints.value.ca)
        {
            continue;
        }
        if root
            .key_usage()
            .map_err(|error| error.to_string())?
            .is_some_and(|usage| !usage.value.key_cert_sign())
        {
            continue;
        }
        if certificate
            .verify_signature(Some(root.public_key()))
            .is_ok()
        {
            return Ok(());
        }
    }

    Err("X.509 v1 server certificate is not signed by a configured CA".into())
}

fn certificate_public_key(
    certificate_der: &CertificateDer<'_>,
) -> Result<SubjectPublicKeyInfoDer<'static>, RustlsError> {
    let (remainder, certificate) = parse_x509_certificate(certificate_der.as_ref())
        .map_err(|error| RustlsError::General(format!("invalid peer certificate: {error}")))?;
    if !remainder.is_empty() {
        return Err(RustlsError::General(
            "peer certificate contains trailing DER data".into(),
        ));
    }
    Ok(SubjectPublicKeyInfoDer::from(
        certificate.public_key().raw.to_vec(),
    ))
}

fn verify_x509_v1_tls12_signature(
    message: &[u8],
    certificate: &CertificateDer<'_>,
    scheme: SignatureScheme,
    signature: &[u8],
    supported: &WebPkiSupportedAlgorithms,
) -> Result<HandshakeSignatureValid, RustlsError> {
    let public_key = certificate_public_key(certificate)?;
    let public_key = webpki::RawPublicKeyEntity::try_from(&public_key).map_err(|error| {
        RustlsError::General(format!("invalid peer certificate public key: {error}"))
    })?;
    let algorithms = supported
        .mapping
        .iter()
        .find_map(|(candidate, algorithms)| (*candidate == scheme).then_some(*algorithms))
        .ok_or_else(|| {
            RustlsError::General(format!("unsupported TLS signature scheme {scheme:?}"))
        })?;
    let mut unsupported = None;
    for algorithm in algorithms {
        match public_key.verify_signature(*algorithm, message, signature) {
            Ok(()) => return Ok(HandshakeSignatureValid::assertion()),
            Err(error @ webpki::Error::UnsupportedSignatureAlgorithmForPublicKeyContext(_)) => {
                unsupported = Some(error);
            }
            Err(error) => {
                return Err(RustlsError::General(format!(
                    "peer TLS signature verification failed: {error}"
                )));
            }
        }
    }
    Err(RustlsError::General(format!(
        "peer TLS signature algorithm is not compatible with its public key: {}",
        unsupported
            .map(|error| error.to_string())
            .unwrap_or_else(|| "no verification algorithm is available".into())
    )))
}

fn legacy_client_certified_key(
    chain: Vec<CertificateDer<'static>>,
    private_key: PrivateKeyDer<'static>,
    provider: &CryptoProvider,
) -> Result<CertifiedKey, String> {
    let certificate_der = chain
        .first()
        .ok_or_else(|| "client certificate is required".to_string())?;
    let (remainder, certificate) =
        parse_x509_certificate(certificate_der.as_ref()).map_err(|error| error.to_string())?;
    if !remainder.is_empty() {
        return Err("client certificate contains trailing DER data".into());
    }
    if certificate.version() != X509Version::V1 {
        return Err("client certificate is not X.509 v1".into());
    }
    if certificate.tbs_certificate.issuer_uid.is_some()
        || certificate.tbs_certificate.subject_uid.is_some()
        || !certificate.extensions().is_empty()
    {
        return Err("X.509 v1 client certificate contains fields from a later version".into());
    }
    if certificate.signature_algorithm != certificate.tbs_certificate.signature {
        return Err("client certificate signature algorithms do not match".into());
    }

    let signing_key = provider
        .key_provider
        .load_private_key(private_key)
        .map_err(|error| error.to_string())?;
    let key_spki = signing_key
        .public_key()
        .ok_or_else(|| "client private key does not expose its public key".to_string())?;
    if key_spki.as_ref() != certificate.public_key().raw {
        return Err("client certificate and private key do not match".into());
    }

    Ok(CertifiedKey::new(chain, signing_key))
}

fn certificate_key_info(certificate: &CertificateDer<'_>) -> Result<(u32, usize), String> {
    let (_, certificate) =
        parse_x509_certificate(certificate.as_ref()).map_err(|error| error.to_string())?;
    let public_key = certificate
        .public_key()
        .parsed()
        .map_err(|error| error.to_string())?;
    let info = match public_key {
        PublicKey::RSA(key) => (PK_RSA, significant_bits(key.modulus)),
        PublicKey::EC(key) => (PK_ECDSA, key.key_size()),
        PublicKey::DSA(key) => (PK_DSA, significant_bits(key)),
        _ => (PK_UNKNOWN, public_key.key_size()),
    };
    Ok(info)
}

fn certificate_signature_algorithm(
    certificate: &CertificateDer<'_>,
) -> Result<SignatureAlgorithm, String> {
    let (_, certificate) =
        parse_x509_certificate(certificate.as_ref()).map_err(|error| error.to_string())?;
    match certificate
        .public_key()
        .parsed()
        .map_err(|error| error.to_string())?
    {
        PublicKey::RSA(_) => Ok(SignatureAlgorithm::RSA),
        PublicKey::EC(_) => Ok(SignatureAlgorithm::ECDSA),
        _ => {
            let oid = certificate.public_key().algorithm.algorithm.to_id_string();
            match oid.as_str() {
                "1.3.101.112" => Ok(SignatureAlgorithm::ED25519),
                "1.3.101.113" => Ok(SignatureAlgorithm::ED448),
                _ => Err(format!("unsupported external private key algorithm {oid}")),
            }
        }
    }
}

fn preferred_schemes(algorithm: SignatureAlgorithm) -> &'static [SignatureScheme] {
    match algorithm {
        SignatureAlgorithm::RSA => &[
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
        ],
        SignatureAlgorithm::ECDSA => &[
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::ECDSA_NISTP521_SHA512,
        ],
        SignatureAlgorithm::ED25519 => &[SignatureScheme::ED25519],
        SignatureAlgorithm::ED448 => &[SignatureScheme::ED448],
        _ => &[],
    }
}

fn significant_bits(value: &[u8]) -> usize {
    let Some((index, first)) = value
        .iter()
        .copied()
        .enumerate()
        .find(|(_, byte)| *byte != 0)
    else {
        return 0;
    };
    (value.len() - index) * 8 - first.leading_zeros() as usize
}

fn parse_fingerprints(value: &str) -> Result<Vec<[u8; 32]>, String> {
    value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with(['#', ';']))
        .map(|line| {
            let bytes = line
                .split(':')
                .map(|part| {
                    u8::from_str_radix(part, 16)
                        .map_err(|error| format!("invalid peer fingerprint: {error}"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            bytes
                .try_into()
                .map_err(|_| "peer fingerprint must contain 32 bytes".into())
        })
        .collect()
}

fn serial_i64(value: &[u8]) -> i64 {
    let value = value.strip_prefix(&[0]).unwrap_or(value);
    if value.len() > 8 {
        return -1;
    }
    let mut bytes = [0; 8];
    bytes[8 - value.len()..].copy_from_slice(value);
    let value = u64::from_be_bytes(bytes);
    i64::try_from(value).unwrap_or(-1)
}

fn view_bytes(value: ovpn_string_view) -> Result<&'static [u8], String> {
    if value.len == 0 {
        return Ok(&[]);
    }
    if value.data.is_null() {
        return Err("string view data pointer is null".into());
    }
    // SAFETY: all FFI entry points use this slice only for the duration of the
    // callback. The artificial lifetime cannot escape the callback-owned data.
    Ok(unsafe { slice::from_raw_parts(value.data, value.len) })
}

fn view_str(value: ovpn_string_view) -> Result<&'static str, String> {
    str::from_utf8(view_bytes(value)?).map_err(|error| error.to_string())
}

fn input_slice(input: *const u8, length: usize) -> Result<&'static [u8], String> {
    if length == 0 {
        return Ok(&[]);
    }
    if input.is_null() {
        return Err("input pointer is null".into());
    }
    // SAFETY: the caller provides `length` readable bytes for this callback.
    Ok(unsafe { slice::from_raw_parts(input, length) })
}

fn output_slice(output: *mut u8, length: usize) -> Result<&'static mut [u8], String> {
    if length == 0 {
        return Ok(&mut []);
    }
    if output.is_null() {
        return Err("output pointer is null".into());
    }
    // SAFETY: the caller provides `length` writable bytes for this callback.
    Ok(unsafe { slice::from_raw_parts_mut(output, length) })
}

fn copy_output(output: *mut u8, capacity: usize, value: &[u8]) -> Result<usize, String> {
    let output = output_slice(output, capacity)?;
    let length = output.len().min(value.len());
    output[..length].copy_from_slice(&value[..length]);
    Ok(length)
}

fn write_error(output: *mut u8, capacity: usize, message: &str) {
    if let Ok(output) = output_slice(output, capacity) {
        let length = output.len().min(message.len());
        output[..length].copy_from_slice(&message.as_bytes()[..length]);
        if length < output.len() {
            output[length] = 0;
        }
    }
}

fn handle_ref<T>(handle: *const c_void) -> Result<&'static T, String> {
    if handle.is_null() {
        return Err("handle is null".into());
    }
    // SAFETY: handles are created and type-paired by this module.
    Ok(unsafe { &*handle.cast::<T>() })
}

fn handle_mut<T>(handle: *mut c_void) -> Result<&'static mut T, String> {
    if handle.is_null() {
        return Err("handle is null".into());
    }
    // SAFETY: handles are created and type-paired by this module, and Core
    // serializes access to an individual TLS session.
    Ok(unsafe { &mut *handle.cast::<T>() })
}

fn free_handle<T>(handle: *mut c_void) {
    if !handle.is_null() {
        // SAFETY: the handle came from `Box::into_raw` and is freed once.
        unsafe { drop(Box::from_raw(handle.cast::<T>())) };
    }
}

fn ffi_pointer<T>(
    error: *mut u8,
    error_capacity: usize,
    function: impl FnOnce() -> Result<T, String>,
) -> *mut c_void {
    match catch_unwind(AssertUnwindSafe(function)) {
        Ok(Ok(value)) => Box::into_raw(Box::new(value)).cast(),
        Ok(Err(message)) => {
            write_error(error, error_capacity, &message);
            ptr::null_mut()
        }
        Err(_) => {
            write_error(error, error_capacity, "Rust TLS callback panicked");
            ptr::null_mut()
        }
    }
}

fn ffi_io(
    error: *mut u8,
    error_capacity: usize,
    function: impl FnOnce() -> Result<usize, String>,
) -> isize {
    match catch_unwind(AssertUnwindSafe(function)) {
        Ok(Ok(usize::MAX)) => -2,
        Ok(Ok(value)) => isize::try_from(value).unwrap_or(-1),
        Ok(Err(message)) => {
            write_error(error, error_capacity, &message);
            -3
        }
        Err(_) => {
            write_error(error, error_capacity, "Rust TLS callback panicked");
            -3
        }
    }
}

fn ffi_status(function: impl FnOnce() -> Result<(), String>) -> i32 {
    i32::from(matches!(
        catch_unwind(AssertUnwindSafe(function)),
        Ok(Ok(()))
    ))
}

fn ffi_status_with_error(
    error: *mut u8,
    error_capacity: usize,
    function: impl FnOnce() -> Result<(), String>,
) -> i32 {
    match catch_unwind(AssertUnwindSafe(function)) {
        Ok(Ok(())) => 1,
        Ok(Err(message)) => {
            write_error(error, error_capacity, &message);
            0
        }
        Err(_) => {
            write_error(error, error_capacity, "Rust TLS callback panicked");
            0
        }
    }
}

fn ffi_state(function: impl FnOnce() -> Result<bool, String>) -> i32 {
    match catch_unwind(AssertUnwindSafe(function)) {
        Ok(Ok(value)) => i32::from(value),
        _ => 0,
    }
}

fn ffi_length(function: impl FnOnce() -> Result<usize, String>) -> usize {
    match catch_unwind(AssertUnwindSafe(function)) {
        Ok(Ok(value)) => value,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rustls::crypto::ring::default_provider;
    use rustls::sign::CertifiedKey;
    use rustls::{CipherSuite, NamedGroup, SignatureScheme};

    use super::{
        cipher_suite_matches, is_x509_v1_certificate, key_exchange_group_matches,
        legacy_client_certified_key, parse_certificates, parse_fingerprints, parse_key_usages,
        parse_private_key, protocol_versions, verify_x509_v1_server_certificate,
        verify_x509_v1_tls12_signature,
    };

    const LEGACY_CLIENT_CERTIFICATE: &[u8] = include_bytes!("testdata/legacy-v1-client-cert.pem");
    const LEGACY_CLIENT_KEY: &[u8] = include_bytes!("testdata/legacy-v1-client-key.pem");
    const OTHER_CLIENT_KEY: &[u8] = include_bytes!("testdata/other-client-key.pem");

    #[test]
    fn accepts_openvpn_and_iana_tls_selector_names() {
        assert!(cipher_suite_matches(
            CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            "ECDHE_RSA_AES256_GCM_SHA384"
        ));
        assert!(cipher_suite_matches(
            CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
            "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"
        ));
        assert!(key_exchange_group_matches(
            NamedGroup::secp256r1,
            "PRIME256V1"
        ));
        assert!(key_exchange_group_matches(NamedGroup::X25519, "X25519"));
    }

    #[test]
    fn parses_openvpn_certificate_selectors() {
        assert_eq!(parse_key_usages("160,136").unwrap(), [160, 136]);
        let fingerprint = "00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10:11:12:13:14:15:16:17:18:19:1a:1b:1c:1d:1e:1f";
        assert_eq!(parse_fingerprints(fingerprint).unwrap().len(), 1);
        assert!(parse_fingerprints("00:01").is_err());
    }

    #[test]
    fn restricts_protocols_to_rustls_supported_versions() {
        assert_eq!(protocol_versions(3, 3).unwrap(), [&rustls::version::TLS12]);
        assert_eq!(protocol_versions(4, 4).unwrap(), [&rustls::version::TLS13]);
        assert!(protocol_versions(5, 5).is_err());
    }

    #[test]
    fn accepts_matching_x509_v1_client_certificate_and_key() {
        let provider = default_provider();
        let chain = parse_certificates(LEGACY_CLIENT_CERTIFICATE).unwrap();
        let key = parse_private_key(LEGACY_CLIENT_KEY, b"").unwrap();

        assert!(is_x509_v1_certificate(&chain[0]));
        assert!(CertifiedKey::from_der(chain.clone(), key.clone_key(), &provider).is_err());
        let certified_key = legacy_client_certified_key(chain, key, &provider).unwrap();
        assert_eq!(certified_key.cert.len(), 1);
    }

    #[test]
    fn rejects_x509_v1_client_certificate_with_mismatched_key() {
        let provider = default_provider();
        let chain = parse_certificates(LEGACY_CLIENT_CERTIFICATE).unwrap();
        let key = parse_private_key(OTHER_CLIENT_KEY, b"").unwrap();

        assert!(legacy_client_certified_key(chain, key, &provider).is_err());
    }

    #[test]
    fn accepts_a_directly_trusted_x509_v1_server_certificate() {
        let certificates = parse_certificates(LEGACY_CLIENT_CERTIFICATE).unwrap();
        let now = rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(1_893_456_000));

        assert!(
            verify_x509_v1_server_certificate(&certificates[0], &[], &certificates, &[], now,)
                .is_ok()
        );
        assert!(verify_x509_v1_server_certificate(
            &certificates[0],
            &certificates,
            &certificates,
            &[],
            now,
        )
        .is_ok());
        assert!(verify_x509_v1_server_certificate(&certificates[0], &[], &[], &[], now).is_err());
    }

    #[test]
    fn rejects_untrusted_intermediates_for_an_x509_v1_server_certificate() {
        let certificates = parse_certificates(LEGACY_CLIENT_CERTIFICATE).unwrap();
        let now = rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(1_893_456_000));

        assert_eq!(
            verify_x509_v1_server_certificate(&certificates[0], &certificates, &[], &[], now,)
                .unwrap_err(),
            "X.509 v1 server certificates with untrusted intermediates are not supported"
        );
    }

    #[test]
    fn verifies_tls12_signatures_with_an_x509_v1_server_certificate() {
        let provider = default_provider();
        let certificates = parse_certificates(LEGACY_CLIENT_CERTIFICATE).unwrap();
        let key = parse_private_key(LEGACY_CLIENT_KEY, b"").unwrap();
        let signing_key = provider.key_provider.load_private_key(key).unwrap();
        let signer = signing_key
            .choose_scheme(&[SignatureScheme::RSA_PKCS1_SHA256])
            .unwrap();
        let message = b"OpenVPN TLS signature test";
        let signature = signer.sign(message).unwrap();

        assert!(verify_x509_v1_tls12_signature(
            message,
            &certificates[0],
            signer.scheme(),
            &signature,
            &provider.signature_verification_algorithms,
        )
        .is_ok());
        assert!(verify_x509_v1_tls12_signature(
            b"tampered",
            &certificates[0],
            signer.scheme(),
            &signature,
            &provider.signature_verification_algorithms,
        )
        .is_err());
    }
}
