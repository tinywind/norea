#ifndef OPENVPN_CONNECT_SYS_WRAPPER_H
#define OPENVPN_CONNECT_SYS_WRAPPER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ovpn_client ovpn_client;
typedef struct ovpn_external_transport_handle ovpn_external_transport_handle;
typedef struct ovpn_external_tun_handle ovpn_external_tun_handle;
typedef void (*ovpn_connect_started_fn)(void *context);

typedef struct ovpn_string_view {
    const uint8_t *data;
    size_t len;
} ovpn_string_view;

typedef struct ovpn_owned_string {
    uint8_t *data;
    size_t len;
} ovpn_owned_string;

typedef struct ovpn_rust_ip_address {
    uint8_t family;
    uint8_t octets[16];
} ovpn_rust_ip_address;

typedef int32_t (*ovpn_rust_resolve_fn)(
    const uint8_t *host, size_t host_len, ovpn_rust_ip_address *addresses,
    size_t addresses_capacity, size_t *addresses_len);

typedef int32_t (*ovpn_rust_random_fn)(uint8_t *output, size_t output_len);
typedef void *(*ovpn_rust_digest_new_fn)(uint32_t algorithm);
typedef void (*ovpn_rust_handle_free_fn)(void *handle);
typedef int32_t (*ovpn_rust_update_fn)(
    void *handle, const uint8_t *input, size_t input_len);
typedef size_t (*ovpn_rust_final_fn)(
    void *handle, uint8_t *output, size_t output_capacity);
typedef size_t (*ovpn_rust_size_fn)(const void *handle);
typedef void *(*ovpn_rust_hmac_new_fn)(
    uint32_t algorithm, const uint8_t *key, size_t key_len);
typedef int32_t (*ovpn_rust_reset_fn)(void *handle);
typedef void *(*ovpn_rust_cipher_new_fn)(
    uint32_t algorithm, const uint8_t *key, size_t key_len, int32_t encrypt);
typedef int32_t (*ovpn_rust_cipher_reset_fn)(
    void *handle, const uint8_t *iv, size_t iv_len);
typedef size_t (*ovpn_rust_cipher_final_fn)(
    void *handle, uint8_t *output, size_t output_capacity);
typedef int32_t (*ovpn_rust_algorithm_supported_fn)(uint32_t algorithm);
typedef void *(*ovpn_rust_aead_new_fn)(
    uint32_t algorithm, const uint8_t *key, size_t key_len, int32_t encrypt);
typedef int32_t (*ovpn_rust_aead_crypt_fn)(
    void *handle, const uint8_t *input, size_t input_len, uint8_t *output,
    size_t output_capacity, const uint8_t *nonce, size_t nonce_len,
    uint8_t *tag, size_t tag_len, const uint8_t *additional_data,
    size_t additional_data_len);
typedef ptrdiff_t (*ovpn_rust_external_sign_fn)(
    void *context, uint16_t signature_scheme, const uint8_t *message,
    size_t message_len, uint8_t *signature, size_t signature_capacity);
typedef void *(*ovpn_rust_tls_config_new_fn)(
    ovpn_string_view ca, ovpn_string_view crl, ovpn_string_view cert,
    ovpn_string_view extra_certs, ovpn_string_view private_key,
    ovpn_string_view private_key_password, ovpn_string_view peer_fingerprints,
    uint32_t ns_cert_type, ovpn_string_view remote_cert_ku,
    ovpn_string_view remote_cert_eku, ovpn_string_view tls_remote,
    uint32_t verify_x509_name_mode, ovpn_string_view verify_x509_name,
    ovpn_string_view tls_cipher_list, ovpn_string_view tls_ciphersuite_list,
    ovpn_string_view tls_groups,
    uint32_t tls_version_min, uint32_t tls_version_max, uint32_t flags,
    int32_t local_cert_enabled, void *external_sign_context,
    ovpn_rust_external_sign_fn external_sign, uint8_t *error,
    size_t error_capacity);
typedef void *(*ovpn_rust_tls_connection_new_fn)(
    const void *config, ovpn_string_view server_name, uint8_t *error,
    size_t error_capacity);
typedef ptrdiff_t (*ovpn_rust_tls_io_fn)(
    void *handle, uint8_t *output, size_t output_capacity, uint8_t *error,
    size_t error_capacity);
typedef ptrdiff_t (*ovpn_rust_tls_write_fn)(
    void *handle, const uint8_t *input, size_t input_len, uint8_t *error,
    size_t error_capacity);
typedef int32_t (*ovpn_rust_tls_state_fn)(const void *handle);
typedef size_t (*ovpn_rust_tls_details_fn)(
    const void *handle, uint8_t *output, size_t output_capacity);
typedef int32_t (*ovpn_rust_tls_export_fn)(
    const void *handle, ovpn_string_view label, uint8_t *output,
    size_t output_len);
typedef int32_t (*ovpn_rust_tls_peer_info_fn)(
    const void *handle, uint8_t *common_name, size_t common_name_capacity,
    size_t *common_name_len, int64_t *serial);
typedef int32_t (*ovpn_rust_tls_validate_fn)(
    uint32_t kind, ovpn_string_view value, ovpn_string_view password,
    uint8_t *error, size_t error_capacity);
typedef int32_t (*ovpn_rust_tls_key_info_fn)(
    ovpn_string_view cert, uint32_t *key_type, size_t *key_bits);

typedef struct ovpn_rust_backend_vtable {
    ovpn_rust_resolve_fn resolve;
    ovpn_rust_random_fn random;
    ovpn_rust_digest_new_fn digest_new;
    ovpn_rust_handle_free_fn digest_free;
    ovpn_rust_update_fn digest_update;
    ovpn_rust_final_fn digest_final;
    ovpn_rust_size_fn digest_size;
    ovpn_rust_hmac_new_fn hmac_new;
    ovpn_rust_handle_free_fn hmac_free;
    ovpn_rust_reset_fn hmac_reset;
    ovpn_rust_update_fn hmac_update;
    ovpn_rust_final_fn hmac_final;
    ovpn_rust_size_fn hmac_size;
    ovpn_rust_cipher_new_fn cipher_new;
    ovpn_rust_handle_free_fn cipher_free;
    ovpn_rust_cipher_reset_fn cipher_reset;
    ovpn_rust_update_fn cipher_update;
    ovpn_rust_cipher_final_fn cipher_final;
    ovpn_rust_algorithm_supported_fn cipher_supported;
    ovpn_rust_aead_new_fn aead_new;
    ovpn_rust_handle_free_fn aead_free;
    ovpn_rust_aead_crypt_fn aead_encrypt;
    ovpn_rust_aead_crypt_fn aead_decrypt;
    ovpn_rust_algorithm_supported_fn aead_supported;
    ovpn_rust_tls_config_new_fn tls_config_new;
    ovpn_rust_handle_free_fn tls_config_free;
    ovpn_rust_tls_connection_new_fn tls_connection_new;
    ovpn_rust_handle_free_fn tls_connection_free;
    ovpn_rust_tls_write_fn tls_write_plaintext;
    ovpn_rust_tls_io_fn tls_read_plaintext;
    ovpn_rust_tls_state_fn tls_plaintext_ready;
    ovpn_rust_tls_write_fn tls_write_ciphertext;
    ovpn_rust_tls_io_fn tls_read_ciphertext;
    ovpn_rust_tls_state_fn tls_ciphertext_ready;
    ovpn_rust_tls_details_fn tls_details;
    ovpn_rust_tls_export_fn tls_export_keying_material;
    ovpn_rust_tls_state_fn tls_handshake_complete;
    ovpn_rust_tls_peer_info_fn tls_peer_info;
    ovpn_rust_tls_validate_fn tls_validate;
    ovpn_rust_tls_key_info_fn tls_key_info;
} ovpn_rust_backend_vtable;

typedef struct ovpn_merge_config {
    ovpn_owned_string status;
    ovpn_owned_string error_text;
    ovpn_owned_string basename;
    ovpn_owned_string profile_content;
    ovpn_owned_string *ref_path_list;
    size_t ref_path_list_len;
} ovpn_merge_config;

typedef struct ovpn_i64_array {
    int64_t *data;
    size_t len;
} ovpn_i64_array;

typedef struct ovpn_capabilities {
    int32_t tun_builder;
    int32_t dco;
    int32_t dco_tun_builder;
    int32_t gremlin;
    int32_t external_tun;
    int32_t external_transport;
    int32_t private_tunnel_proxy;
} ovpn_capabilities;

typedef struct ovpn_external_remote_view {
    ovpn_string_view host;
    ovpn_string_view port;
    ovpn_string_view protocol;
} ovpn_external_remote_view;

typedef struct ovpn_external_transport_config_view {
    ovpn_string_view host;
    ovpn_string_view port;
    ovpn_string_view protocol;
    ovpn_string_view gremlin_config;
    const ovpn_external_remote_view *remotes;
    size_t remotes_len;
    int32_t server_address_float;
    int32_t synchronous_dns_lookup;
} ovpn_external_transport_config_view;

typedef struct ovpn_external_transport_endpoint_view {
    ovpn_string_view host;
    ovpn_string_view port;
    ovpn_string_view protocol;
    ovpn_string_view ip_address;
} ovpn_external_transport_endpoint_view;

typedef struct ovpn_external_tun_config_view {
    ovpn_string_view session_name;
    int32_t layer;
    int32_t mtu;
    int32_t mtu_max;
    int32_t google_dns_fallback;
    int32_t dhcp_search_domains_as_split_domains;
    int32_t allow_local_lan_access;
    int32_t remote_bypass;
    int32_t tun_persist;
} ovpn_external_tun_config_view;

typedef struct ovpn_external_tun_start_view {
    ovpn_string_view options;
    uint32_t cipher_algorithm;
    uint32_t digest_algorithm;
    uint32_t key_derivation;
    int32_t use_epoch_keys;
} ovpn_external_tun_start_view;

typedef struct ovpn_external_tun_info_view {
    ovpn_string_view name;
    ovpn_string_view vpn_ipv4;
    ovpn_string_view vpn_ipv6;
    ovpn_string_view gateway_ipv4;
    ovpn_string_view gateway_ipv6;
    int32_t mtu;
    uint32_t interface_index;
} ovpn_external_tun_info_view;

typedef struct ovpn_key_value_view {
    ovpn_string_view key;
    ovpn_string_view value;
} ovpn_key_value_view;

typedef struct ovpn_config {
    ovpn_string_view content;
    const ovpn_key_value_view *content_list;
    size_t content_list_len;
    const ovpn_key_value_view *peer_info;
    size_t peer_info_len;

    ovpn_string_view gui_version;
    ovpn_string_view sso_methods;
    ovpn_string_view app_custom_protocols;
    ovpn_string_view hw_addr_override;
    ovpn_string_view platform_version;
    ovpn_string_view server_override;
    ovpn_string_view port_override;
    ovpn_string_view proto_override;
    ovpn_string_view allow_unused_addr_families;
    ovpn_string_view compression_mode;
    ovpn_string_view external_pki_alias;
    ovpn_string_view private_key_password;
    ovpn_string_view tls_version_min_override;
    ovpn_string_view tls_cert_profile_override;
    ovpn_string_view tls_cipher_list;
    ovpn_string_view tls_ciphersuites_list;
    ovpn_string_view proxy_host;
    ovpn_string_view proxy_port;
    ovpn_string_view proxy_username;
    ovpn_string_view proxy_password;
    ovpn_string_view gremlin_config;

    int32_t conn_timeout;
    int32_t ssl_debug_level;
    int32_t default_key_direction;
    int32_t proto_version_override;
    uint32_t clock_tick_ms;

    int32_t tun_persist;
    int32_t google_dns_fallback;
    int32_t dhcp_search_domains_as_split_domains;
    int32_t synchronous_dns_lookup;
    int32_t autologin_sessions;
    int32_t retry_on_auth_failed;
    int32_t disable_client_cert;
    int32_t proxy_allow_cleartext_auth;
    int32_t alt_proxy;
    int32_t dco;
    int32_t echo;
    int32_t info;
    int32_t allow_local_lan_access;
    int32_t enable_route_emulation;
    int32_t wintun;
    int32_t allow_local_dns_resolvers;
    int32_t enable_legacy_algorithms;
    int32_t enable_non_preferred_dc_algorithms;
    int32_t generate_tun_builder_capture_event;
} ovpn_config;

typedef struct ovpn_credentials {
    ovpn_string_view username;
    ovpn_string_view password;
    ovpn_string_view http_proxy_username;
    ovpn_string_view http_proxy_password;
    ovpn_string_view response;
    ovpn_string_view dynamic_challenge_cookie;
} ovpn_credentials;

typedef struct ovpn_status {
    int32_t error;
    ovpn_owned_string status;
    ovpn_owned_string message;
} ovpn_status;

typedef struct ovpn_server_entry {
    ovpn_owned_string server;
    ovpn_owned_string friendly_name;
} ovpn_server_entry;

typedef struct ovpn_eval_config {
    int32_t error;
    ovpn_owned_string message;
    ovpn_owned_string userlocked_username;
    ovpn_owned_string profile_name;
    ovpn_owned_string friendly_name;
    int32_t autologin;
    int32_t external_pki;
    ovpn_owned_string vpn_ca;
    ovpn_owned_string static_challenge;
    int32_t static_challenge_echo;
    int32_t private_key_password_required;
    int32_t allow_password_save;
    ovpn_owned_string remote_host;
    ovpn_owned_string remote_port;
    ovpn_owned_string remote_proto;
    ovpn_server_entry *server_list;
    size_t server_list_len;
    ovpn_owned_string windows_driver;
    int32_t dco_compatible;
    ovpn_owned_string dco_incompatibility_reason;
} ovpn_eval_config;

typedef struct ovpn_connection_info {
    int32_t defined;
    ovpn_owned_string user;
    ovpn_owned_string server_host;
    ovpn_owned_string server_port;
    ovpn_owned_string server_proto;
    ovpn_owned_string server_ip;
    ovpn_owned_string vpn_ip4;
    ovpn_owned_string vpn_ip6;
    ovpn_owned_string vpn_mtu;
    ovpn_owned_string gateway_ip4;
    ovpn_owned_string gateway_ip6;
    ovpn_owned_string client_ip;
    ovpn_owned_string tun_name;
} ovpn_connection_info;

typedef struct ovpn_session_token {
    int32_t defined;
    ovpn_owned_string username;
    ovpn_owned_string session_id;
} ovpn_session_token;

typedef struct ovpn_dynamic_challenge {
    int32_t defined;
    ovpn_owned_string challenge;
    int32_t echo;
    int32_t response_required;
    ovpn_owned_string state_id;
} ovpn_dynamic_challenge;

typedef struct ovpn_interface_stats {
    int64_t bytes_in;
    int64_t packets_in;
    int64_t errors_in;
    int64_t bytes_out;
    int64_t packets_out;
    int64_t errors_out;
} ovpn_interface_stats;

typedef struct ovpn_transport_stats {
    int64_t bytes_in;
    int64_t bytes_out;
    int64_t packets_in;
    int64_t packets_out;
    int32_t last_packet_received;
} ovpn_transport_stats;

typedef struct ovpn_dns_address_view {
    ovpn_string_view address;
    uint32_t port;
} ovpn_dns_address_view;

typedef struct ovpn_dns_server_view {
    int32_t priority;
    const ovpn_dns_address_view *addresses;
    size_t addresses_len;
    const ovpn_string_view *domains;
    size_t domains_len;
    int32_t dnssec;
    int32_t transport;
    ovpn_string_view sni;
} ovpn_dns_server_view;

typedef struct ovpn_dns_options_view {
    int32_t from_dhcp_options;
    const ovpn_string_view *search_domains;
    size_t search_domains_len;
    const ovpn_dns_server_view *servers;
    size_t servers_len;
} ovpn_dns_options_view;

typedef struct ovpn_dco_peer_view {
    uint32_t peer_id;
    uint32_t transport_fd;
    ovpn_string_view remote_ip;
    uint16_t remote_port;
    ovpn_string_view vpn_ipv4;
    ovpn_string_view vpn_ipv6;
} ovpn_dco_peer_view;

typedef struct ovpn_dco_key_direction_view {
    const uint8_t *cipher_key;
    size_t cipher_key_len;
    const uint8_t *nonce_tail;
    size_t nonce_tail_len;
} ovpn_dco_key_direction_view;

typedef struct ovpn_dco_key_config_view {
    ovpn_dco_key_direction_view encrypt;
    ovpn_dco_key_direction_view decrypt;
    int32_t key_id;
    int32_t remote_peer_id;
    uint32_t cipher_algorithm;
} ovpn_dco_key_config_view;

typedef void (*ovpn_event_fn)(void *context, int32_t error, int32_t fatal,
                              ovpn_string_view name, ovpn_string_view info);
typedef void (*ovpn_log_fn)(void *context, ovpn_string_view text);
typedef void (*ovpn_acc_event_fn)(void *context, ovpn_string_view protocol,
                                  ovpn_string_view payload);
typedef int32_t (*ovpn_socket_protect_fn)(void *context, intptr_t socket,
                                          ovpn_string_view remote, int32_t ipv6);
typedef int32_t (*ovpn_pause_on_connection_timeout_fn)(void *context);
typedef void (*ovpn_clock_tick_fn)(void *context);

typedef void (*ovpn_external_pki_cert_complete_fn)(
    void *response_context, int32_t error, int32_t invalid_alias,
    ovpn_string_view error_text, ovpn_string_view cert,
    ovpn_string_view supporting_chain);
typedef void (*ovpn_external_pki_cert_request_fn)(
    void *context, ovpn_string_view alias, void *response_context,
    ovpn_external_pki_cert_complete_fn complete);

typedef void (*ovpn_external_pki_sign_complete_fn)(
    void *response_context, int32_t error, int32_t invalid_alias,
    ovpn_string_view error_text, ovpn_string_view signature);
typedef void (*ovpn_external_pki_sign_request_fn)(
    void *context, ovpn_string_view alias, ovpn_string_view data,
    ovpn_string_view algorithm, ovpn_string_view hash_algorithm,
    ovpn_string_view salt_length, void *response_context,
    ovpn_external_pki_sign_complete_fn complete);

typedef void (*ovpn_remote_override_complete_fn)(
    void *response_context, ovpn_string_view host, ovpn_string_view ip,
    ovpn_string_view port, ovpn_string_view proto, ovpn_string_view error);
typedef int32_t (*ovpn_remote_override_enabled_fn)(void *context);
typedef void (*ovpn_remote_override_request_fn)(
    void *context, void *response_context,
    ovpn_remote_override_complete_fn complete);

typedef int32_t (*ovpn_tun_builder_new_fn)(void *context);
typedef int32_t (*ovpn_tun_builder_set_layer_fn)(void *context, int32_t layer);
typedef int32_t (*ovpn_tun_builder_set_remote_address_fn)(
    void *context, ovpn_string_view address, int32_t ipv6);
typedef int32_t (*ovpn_tun_builder_add_address_fn)(
    void *context, ovpn_string_view address, int32_t prefix_length,
    ovpn_string_view gateway, int32_t ipv6, int32_t net30);
typedef int32_t (*ovpn_tun_builder_set_route_metric_default_fn)(
    void *context, int32_t metric);
typedef int32_t (*ovpn_tun_builder_reroute_gw_fn)(
    void *context, int32_t ipv4, int32_t ipv6, uint32_t flags);
typedef int32_t (*ovpn_tun_builder_route_fn)(
    void *context, ovpn_string_view address, int32_t prefix_length,
    int32_t metric, int32_t ipv6);
typedef int32_t (*ovpn_tun_builder_set_dns_options_fn)(
    void *context, const ovpn_dns_options_view *dns);
typedef int32_t (*ovpn_tun_builder_set_int_fn)(void *context, int32_t value);
typedef int32_t (*ovpn_tun_builder_set_string_fn)(
    void *context, ovpn_string_view value);
typedef int32_t (*ovpn_tun_builder_set_proxy_fn)(
    void *context, ovpn_string_view host, int32_t port);
typedef int32_t (*ovpn_tun_builder_set_allow_family_fn)(
    void *context, int32_t address_family, int32_t allow);
typedef int32_t (*ovpn_tun_builder_establish_fn)(void *context);
typedef int32_t (*ovpn_tun_builder_persist_fn)(void *context);
typedef void (*ovpn_tun_builder_local_networks_complete_fn)(
    void *response_context, const ovpn_string_view *networks, size_t networks_len);
typedef void (*ovpn_tun_builder_get_local_networks_fn)(
    void *context, int32_t ipv6, void *response_context,
    ovpn_tun_builder_local_networks_complete_fn complete);
typedef void (*ovpn_tun_builder_establish_lite_fn)(void *context);
typedef void (*ovpn_tun_builder_teardown_fn)(void *context, int32_t disconnect);
typedef int32_t (*ovpn_tun_builder_dco_available_fn)(void *context);
typedef int32_t (*ovpn_tun_builder_dco_enable_fn)(
    void *context, ovpn_string_view device_name);
typedef void (*ovpn_tun_builder_dco_new_peer_fn)(
    void *context, const ovpn_dco_peer_view *peer);
typedef void (*ovpn_tun_builder_dco_set_peer_fn)(
    void *context, uint32_t peer_id, int32_t keepalive_interval,
    int32_t keepalive_timeout);
typedef void (*ovpn_tun_builder_dco_peer_fn)(void *context, uint32_t peer_id);
typedef void (*ovpn_tun_builder_dco_get_peer_fn)(
    void *context, uint32_t peer_id, int32_t synchronous);
typedef void (*ovpn_tun_builder_dco_new_key_fn)(
    void *context, uint32_t key_slot, const ovpn_dco_key_config_view *key);
typedef void (*ovpn_tun_builder_dco_key_fn)(
    void *context, uint32_t peer_id, uint32_t key_slot);
typedef void (*ovpn_tun_builder_dco_establish_fn)(void *context);
typedef int32_t (*ovpn_external_transport_configure_fn)(
    void *context, const ovpn_external_transport_config_view *config);
typedef void (*ovpn_external_transport_start_fn)(
    void *context, ovpn_external_transport_handle *handle);
typedef void (*ovpn_external_transport_void_fn)(void *context);
typedef int32_t (*ovpn_external_transport_send_fn)(
    void *context, const uint8_t *data, size_t len);
typedef int32_t (*ovpn_external_transport_bool_fn)(void *context);
typedef size_t (*ovpn_external_transport_size_fn)(void *context);
typedef void (*ovpn_external_transport_align_fn)(void *context, size_t align_adjust);
typedef void (*ovpn_external_transport_endpoint_complete_fn)(
    void *response_context, const ovpn_external_transport_endpoint_view *endpoint);
typedef void (*ovpn_external_transport_endpoint_fn)(
    void *context, void *response_context,
    ovpn_external_transport_endpoint_complete_fn complete);
typedef intptr_t (*ovpn_external_transport_native_handle_fn)(void *context);
typedef void (*ovpn_external_transport_process_push_fn)(
    void *context, ovpn_string_view options);
typedef int32_t (*ovpn_external_tun_configure_fn)(
    void *context, const ovpn_external_tun_config_view *config);
typedef void (*ovpn_external_tun_start_fn)(
    void *context, ovpn_external_tun_handle *handle,
    const ovpn_external_tun_start_view *start);
typedef void (*ovpn_external_tun_void_fn)(void *context);
typedef int32_t (*ovpn_external_tun_send_fn)(
    void *context, const uint8_t *data, size_t len);
typedef void (*ovpn_external_tun_info_complete_fn)(
    void *response_context, const ovpn_external_tun_info_view *info);
typedef void (*ovpn_external_tun_info_fn)(
    void *context, void *response_context, ovpn_external_tun_info_complete_fn complete);
typedef void (*ovpn_external_tun_adjust_mss_fn)(void *context, int32_t mss);
typedef void (*ovpn_external_tun_push_update_fn)(
    void *context, ovpn_string_view options);
typedef int32_t (*ovpn_external_tun_bool_fn)(void *context);
typedef void (*ovpn_external_tun_finalize_fn)(void *context, int32_t disconnected);

typedef struct ovpn_callbacks {
    void *context;
    ovpn_event_fn event;
    ovpn_log_fn log;
    ovpn_acc_event_fn acc_event;
    ovpn_socket_protect_fn socket_protect;
    ovpn_pause_on_connection_timeout_fn pause_on_connection_timeout;
    ovpn_clock_tick_fn clock_tick;
    ovpn_external_pki_cert_request_fn external_pki_cert_request;
    ovpn_external_pki_sign_request_fn external_pki_sign_request;
    ovpn_remote_override_enabled_fn remote_override_enabled;
    ovpn_remote_override_request_fn remote_override_request;
    ovpn_tun_builder_new_fn tun_builder_new;
    ovpn_tun_builder_set_layer_fn tun_builder_set_layer;
    ovpn_tun_builder_set_remote_address_fn tun_builder_set_remote_address;
    ovpn_tun_builder_add_address_fn tun_builder_add_address;
    ovpn_tun_builder_set_route_metric_default_fn tun_builder_set_route_metric_default;
    ovpn_tun_builder_reroute_gw_fn tun_builder_reroute_gw;
    ovpn_tun_builder_route_fn tun_builder_add_route;
    ovpn_tun_builder_route_fn tun_builder_exclude_route;
    ovpn_tun_builder_set_dns_options_fn tun_builder_set_dns_options;
    ovpn_tun_builder_set_int_fn tun_builder_set_mtu;
    ovpn_tun_builder_set_string_fn tun_builder_set_session_name;
    ovpn_tun_builder_set_string_fn tun_builder_add_proxy_bypass;
    ovpn_tun_builder_set_string_fn tun_builder_set_proxy_auto_config_url;
    ovpn_tun_builder_set_proxy_fn tun_builder_set_proxy_http;
    ovpn_tun_builder_set_proxy_fn tun_builder_set_proxy_https;
    ovpn_tun_builder_set_string_fn tun_builder_add_wins_server;
    ovpn_tun_builder_set_allow_family_fn tun_builder_set_allow_family;
    ovpn_tun_builder_set_int_fn tun_builder_set_allow_local_dns;
    ovpn_tun_builder_establish_fn tun_builder_establish;
    ovpn_tun_builder_persist_fn tun_builder_persist;
    ovpn_tun_builder_get_local_networks_fn tun_builder_get_local_networks;
    ovpn_tun_builder_establish_lite_fn tun_builder_establish_lite;
    ovpn_tun_builder_teardown_fn tun_builder_teardown;
    ovpn_tun_builder_dco_available_fn tun_builder_dco_available;
    ovpn_tun_builder_dco_enable_fn tun_builder_dco_enable;
    ovpn_tun_builder_dco_new_peer_fn tun_builder_dco_new_peer;
    ovpn_tun_builder_dco_set_peer_fn tun_builder_dco_set_peer;
    ovpn_tun_builder_dco_peer_fn tun_builder_dco_del_peer;
    ovpn_tun_builder_dco_get_peer_fn tun_builder_dco_get_peer;
    ovpn_tun_builder_dco_new_key_fn tun_builder_dco_new_key;
    ovpn_tun_builder_dco_peer_fn tun_builder_dco_swap_keys;
    ovpn_tun_builder_dco_key_fn tun_builder_dco_del_key;
    ovpn_tun_builder_dco_establish_fn tun_builder_dco_establish;
    ovpn_external_transport_configure_fn external_transport_configure;
    ovpn_external_transport_start_fn external_transport_start;
    ovpn_external_transport_void_fn external_transport_stop;
    ovpn_external_transport_send_fn external_transport_send;
    ovpn_external_transport_bool_fn external_transport_send_queue_empty;
    ovpn_external_transport_bool_fn external_transport_has_send_queue;
    ovpn_external_transport_void_fn external_transport_stop_requeueing;
    ovpn_external_transport_size_fn external_transport_send_queue_size;
    ovpn_external_transport_align_fn external_transport_reset_align_adjust;
    ovpn_external_transport_endpoint_fn external_transport_endpoint;
    ovpn_external_transport_native_handle_fn external_transport_native_handle;
    ovpn_external_transport_bool_fn external_transport_is_relay;
    ovpn_external_transport_process_push_fn external_transport_process_push;
    ovpn_external_tun_configure_fn external_tun_configure;
    ovpn_external_tun_start_fn external_tun_start;
    ovpn_external_tun_void_fn external_tun_stop;
    ovpn_external_tun_void_fn external_tun_set_disconnect;
    ovpn_external_tun_send_fn external_tun_send;
    ovpn_external_tun_info_fn external_tun_info;
    ovpn_external_tun_adjust_mss_fn external_tun_adjust_mss;
    ovpn_external_tun_push_update_fn external_tun_apply_push_update;
    ovpn_external_tun_bool_fn external_tun_layer_2_supported;
    ovpn_external_tun_bool_fn external_tun_supports_epoch_data;
    ovpn_external_tun_finalize_fn external_tun_finalize;
} ovpn_callbacks;

void ovpn_owned_string_free(ovpn_owned_string value);
void ovpn_merge_config_free(ovpn_merge_config value);
void ovpn_i64_array_free(ovpn_i64_array value);
void ovpn_status_free(ovpn_status value);
void ovpn_eval_config_free(ovpn_eval_config value);
void ovpn_connection_info_free(ovpn_connection_info value);
void ovpn_session_token_free(ovpn_session_token value);
void ovpn_dynamic_challenge_free(ovpn_dynamic_challenge value);

ovpn_owned_string ovpn_platform(void);
ovpn_capabilities ovpn_get_capabilities(void);
int32_t ovpn_error_code_tun(void);
int32_t ovpn_error_code_transport(void);
int32_t ovpn_error_code_proxy(void);
ovpn_owned_string ovpn_copyright(void);
int64_t ovpn_max_profile_size(void);
ovpn_owned_string ovpn_crypto_self_test(void);
ovpn_dynamic_challenge ovpn_parse_dynamic_challenge(ovpn_string_view cookie);
ovpn_merge_config ovpn_merge_config_path(ovpn_string_view path,
                                         int32_t follow_references);
ovpn_merge_config ovpn_merge_config_string(ovpn_string_view content);
ovpn_eval_config ovpn_eval_config_static(const ovpn_config *config);

ovpn_client *ovpn_client_new(ovpn_callbacks callbacks, ovpn_status *status);
void ovpn_client_free(ovpn_client *client);
ovpn_eval_config ovpn_client_eval_config(ovpn_client *client,
                                         const ovpn_config *config);
ovpn_status ovpn_client_provide_creds(ovpn_client *client,
                                      const ovpn_credentials *credentials);
ovpn_status ovpn_client_connect(ovpn_client *client);
ovpn_status ovpn_client_connect_started(ovpn_client *client,
                                        void *started_context,
                                        ovpn_connect_started_fn started);
ovpn_status ovpn_client_callback_self_test(ovpn_client *client);
ovpn_status ovpn_client_start_cert_check(ovpn_client *client,
                                         ovpn_string_view client_cert,
                                         ovpn_string_view client_key,
                                         ovpn_string_view ca,
                                         int32_t has_ca);
ovpn_status ovpn_client_start_cert_check_epki(ovpn_client *client,
                                              ovpn_string_view alias,
                                              ovpn_string_view ca,
                                              int32_t has_ca);
void ovpn_client_stop(ovpn_client *client);
void ovpn_client_pause(ovpn_client *client, ovpn_string_view reason);
void ovpn_client_resume(ovpn_client *client);
void ovpn_client_reconnect(ovpn_client *client, int32_t seconds);
void ovpn_client_post_cc_msg(ovpn_client *client, ovpn_string_view message);
void ovpn_client_send_app_control_channel_msg(ovpn_client *client,
                                              ovpn_string_view protocol,
                                              ovpn_string_view message);
ovpn_connection_info ovpn_client_connection_info(ovpn_client *client);
ovpn_session_token ovpn_client_session_token(ovpn_client *client);
int32_t ovpn_client_stats_count(void);
ovpn_owned_string ovpn_client_stats_name(int32_t index);
int64_t ovpn_client_stats_value(const ovpn_client *client, int32_t index);
ovpn_i64_array ovpn_client_stats_bundle(const ovpn_client *client);
ovpn_interface_stats ovpn_client_tun_stats(const ovpn_client *client);
ovpn_transport_stats ovpn_client_transport_stats(const ovpn_client *client);

ovpn_external_transport_handle *ovpn_external_transport_handle_retain(
    const ovpn_external_transport_handle *handle);
void ovpn_external_transport_handle_free(ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_receive(
    const ovpn_external_transport_handle *handle, const uint8_t *data, size_t len);
int32_t ovpn_external_transport_needs_send(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_error(
    const ovpn_external_transport_handle *handle, int32_t error_code,
    ovpn_string_view message);
int32_t ovpn_external_transport_proxy_error(
    const ovpn_external_transport_handle *handle, int32_t error_code,
    ovpn_string_view message);
int32_t ovpn_external_transport_pre_resolve(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_wait_proxy(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_wait(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_connecting(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_is_openvpn_protocol(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_is_keepalive_enabled(
    const ovpn_external_transport_handle *handle);
int32_t ovpn_external_transport_disable_keepalive(
    const ovpn_external_transport_handle *handle, uint32_t *ping_seconds,
    uint32_t *timeout_seconds);

ovpn_external_tun_handle *ovpn_external_tun_handle_retain(
    const ovpn_external_tun_handle *handle);
void ovpn_external_tun_handle_free(ovpn_external_tun_handle *handle);
int32_t ovpn_external_tun_receive(
    const ovpn_external_tun_handle *handle, const uint8_t *data, size_t len);
int32_t ovpn_external_tun_error(
    const ovpn_external_tun_handle *handle, int32_t error_code,
    ovpn_string_view message);
int32_t ovpn_external_tun_pre_tun_config(
    const ovpn_external_tun_handle *handle);
int32_t ovpn_external_tun_pre_route_config(
    const ovpn_external_tun_handle *handle);
int32_t ovpn_external_tun_connected(const ovpn_external_tun_handle *handle);

void ovpn_rust_backend_register(const ovpn_rust_backend_vtable *callbacks);
int32_t ovpn_rust_backend_resolve(
    const uint8_t *host, size_t host_len, ovpn_rust_ip_address *addresses,
    size_t addresses_capacity, size_t *addresses_len);
const ovpn_rust_backend_vtable *ovpn_rust_backend_callbacks(void);

#ifdef __cplusplus
}
#endif

#endif
