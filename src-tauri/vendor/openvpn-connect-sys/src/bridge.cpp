// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#include "wrapper.h"

#include <client/ovpncli.hpp>
#include <openvpn/error/error.hpp>

#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
#include <openvpn/log/logsimple.hpp>
#include <openvpn/transport/client/extern/config.hpp>
#endif
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
#include <openvpn/log/logsimple.hpp>
#include <openvpn/tun/extern/config.hpp>
#endif

#include <array>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using openvpn::ClientAPI::AppCustomControlMessageEvent;
using openvpn::ClientAPI::Config;
using openvpn::ClientAPI::ConnectionInfo;
using openvpn::ClientAPI::DynamicChallenge;
using openvpn::ClientAPI::EvalConfig;
using openvpn::ClientAPI::Event;
using openvpn::ClientAPI::ExternalPKICertRequest;
using openvpn::ClientAPI::ExternalPKISignRequest;
using openvpn::ClientAPI::InterfaceStats;
using openvpn::ClientAPI::LogInfo;
using openvpn::ClientAPI::MergeConfig;
using openvpn::ClientAPI::OpenVPNClient;
using openvpn::ClientAPI::OpenVPNClientHelper;
using openvpn::ClientAPI::ProvideCreds;
using openvpn::ClientAPI::RemoteOverride;
using openvpn::ClientAPI::SessionToken;
using openvpn::ClientAPI::Status;
using openvpn::ClientAPI::TransportStats;

#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
struct ExternalTransportState
{
    ExternalTransportState(openvpn_io::io_context &io_arg,
                           openvpn::TransportClientParent *parent_arg)
        : io(&io_arg), parent(parent_arg)
    {
    }

    std::mutex mutex;
    openvpn_io::io_context *io;
    openvpn::TransportClientParent *parent;
};

struct ovpn_external_transport_handle
{
    explicit ovpn_external_transport_handle(std::shared_ptr<ExternalTransportState> state_arg)
        : state(std::move(state_arg))
    {
    }

    std::shared_ptr<ExternalTransportState> state;
};
#else
struct ovpn_external_transport_handle
{
};
#endif

#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
struct ExternalTunState
{
    ExternalTunState(openvpn_io::io_context &io_arg,
                     openvpn::TunClientParent &parent_arg,
                     const openvpn::Frame::Context &read_tun_frame_arg)
        : io(&io_arg),
          parent(&parent_arg),
          read_tun_frame(read_tun_frame_arg)
    {
    }

    std::recursive_mutex mutex;
    openvpn_io::io_context *io;
    openvpn::TunClientParent *parent;
    const openvpn::Frame::Context read_tun_frame;
};

struct ovpn_external_tun_handle
{
    explicit ovpn_external_tun_handle(std::shared_ptr<ExternalTunState> state_arg)
        : state(std::move(state_arg))
    {
    }

    std::shared_ptr<ExternalTunState> state;
};
#else
struct ovpn_external_tun_handle
{
};
#endif

namespace {

std::shared_ptr<const ovpn_rust_backend_vtable> rust_backend;

std::string string_from(ovpn_string_view value)
{
    if (value.data == nullptr || value.len == 0)
        return {};
    return {reinterpret_cast<const char *>(value.data), value.len};
}

ovpn_string_view view_of(const std::string &value)
{
    return {reinterpret_cast<const uint8_t *>(value.data()), value.size()};
}

ovpn_owned_string own(const std::string &value)
{
    if (value.empty())
        return {};

    auto *data = static_cast<uint8_t *>(std::malloc(value.size()));
    if (data == nullptr)
        return {};
    std::memcpy(data, value.data(), value.size());
    return {data, value.size()};
}

ovpn_status status_from(const Status &value)
{
    return {
        value.error ? 1 : 0,
        own(value.status),
        own(value.message),
    };
}

ovpn_status error_status(const char *message)
{
    Status status;
    status.error = true;
    status.status = "FFI_ERROR";
    status.message = message == nullptr ? "unknown native exception" : message;
    return status_from(status);
}

ovpn_status null_client_status()
{
    return error_status("OpenVPN client pointer is null");
}

ovpn_merge_config merge_config_from(const MergeConfig &value)
{
    ovpn_merge_config result{
        own(value.status),
        own(value.errorText),
        own(value.basename),
        own(value.profileContent),
        nullptr,
        0,
    };
    if (!value.refPathList.empty())
    {
        result.ref_path_list = static_cast<ovpn_owned_string *>(
            std::calloc(value.refPathList.size(), sizeof(ovpn_owned_string)));
        if (result.ref_path_list != nullptr)
        {
            result.ref_path_list_len = value.refPathList.size();
            for (size_t i = 0; i < value.refPathList.size(); ++i)
                result.ref_path_list[i] = own(value.refPathList[i]);
        }
    }
    return result;
}

Config config_from(const ovpn_config &value)
{
    Config config;
    config.content = string_from(value.content);

    if (value.content_list != nullptr)
    {
        config.contentList.reserve(value.content_list_len);
        for (size_t i = 0; i < value.content_list_len; ++i)
        {
            const auto &entry = value.content_list[i];
            config.contentList.emplace_back(string_from(entry.key), string_from(entry.value));
        }
    }
    if (value.peer_info != nullptr)
    {
        config.peerInfo.reserve(value.peer_info_len);
        for (size_t i = 0; i < value.peer_info_len; ++i)
        {
            const auto &entry = value.peer_info[i];
            config.peerInfo.emplace_back(string_from(entry.key), string_from(entry.value));
        }
    }

    config.guiVersion = string_from(value.gui_version);
    config.ssoMethods = string_from(value.sso_methods);
    config.appCustomProtocols = string_from(value.app_custom_protocols);
    config.hwAddrOverride = string_from(value.hw_addr_override);
    config.platformVersion = string_from(value.platform_version);
    config.serverOverride = string_from(value.server_override);
    config.portOverride = string_from(value.port_override);
    config.protoOverride = string_from(value.proto_override);
    config.allowUnusedAddrFamilies = string_from(value.allow_unused_addr_families);
    config.compressionMode = string_from(value.compression_mode);
    config.externalPkiAlias = string_from(value.external_pki_alias);
    config.privateKeyPassword = string_from(value.private_key_password);
    config.tlsVersionMinOverride = string_from(value.tls_version_min_override);
    config.tlsCertProfileOverride = string_from(value.tls_cert_profile_override);
    config.tlsCipherList = string_from(value.tls_cipher_list);
    config.tlsCiphersuitesList = string_from(value.tls_ciphersuites_list);
    config.proxyHost = string_from(value.proxy_host);
    config.proxyPort = string_from(value.proxy_port);
    config.proxyUsername = string_from(value.proxy_username);
    config.proxyPassword = string_from(value.proxy_password);
    config.gremlinConfig = string_from(value.gremlin_config);

    config.connTimeout = value.conn_timeout;
    config.sslDebugLevel = value.ssl_debug_level;
    config.defaultKeyDirection = value.default_key_direction;
    config.protoVersionOverride = value.proto_version_override;
    config.clockTickMS = value.clock_tick_ms;

    config.tunPersist = value.tun_persist != 0;
    config.googleDnsFallback = value.google_dns_fallback != 0;
    config.dhcpSearchDomainsAsSplitDomains = value.dhcp_search_domains_as_split_domains != 0;
    config.synchronousDnsLookup = value.synchronous_dns_lookup != 0;
    config.autologinSessions = value.autologin_sessions != 0;
    config.retryOnAuthFailed = value.retry_on_auth_failed != 0;
    config.disableClientCert = value.disable_client_cert != 0;
    config.proxyAllowCleartextAuth = value.proxy_allow_cleartext_auth != 0;
    config.altProxy = value.alt_proxy != 0;
    config.dco = value.dco != 0;
    config.echo = value.echo != 0;
    config.info = value.info != 0;
    config.allowLocalLanAccess = value.allow_local_lan_access != 0;
#ifdef OPENVPN_PLATFORM_ANDROID
    config.enableRouteEmulation = value.enable_route_emulation != 0;
#endif
    config.wintun = value.wintun != 0;
    config.allowLocalDnsResolvers = value.allow_local_dns_resolvers != 0;
    config.enableLegacyAlgorithms = value.enable_legacy_algorithms != 0;
    config.enableNonPreferredDCAlgorithms = value.enable_non_preferred_dc_algorithms != 0;
    config.generateTunBuilderCaptureEvent = value.generate_tun_builder_capture_event != 0;
    return config;
}

ProvideCreds credentials_from(const ovpn_credentials &value)
{
    ProvideCreds credentials;
    credentials.username = string_from(value.username);
    credentials.password = string_from(value.password);
    credentials.http_proxy_user = string_from(value.http_proxy_username);
    credentials.http_proxy_pass = string_from(value.http_proxy_password);
    credentials.response = string_from(value.response);
    credentials.dynamicChallengeCookie = string_from(value.dynamic_challenge_cookie);
    return credentials;
}

ovpn_eval_config evaluation_from(const EvalConfig &value)
{
    ovpn_eval_config result{};
    result.error = value.error ? 1 : 0;
    result.message = own(value.message);
    result.userlocked_username = own(value.userlockedUsername);
    result.profile_name = own(value.profileName);
    result.friendly_name = own(value.friendlyName);
    result.autologin = value.autologin ? 1 : 0;
    result.external_pki = value.externalPki ? 1 : 0;
    result.vpn_ca = own(value.vpnCa);
    result.static_challenge = own(value.staticChallenge);
    result.static_challenge_echo = value.staticChallengeEcho ? 1 : 0;
    result.private_key_password_required = value.privateKeyPasswordRequired ? 1 : 0;
    result.allow_password_save = value.allowPasswordSave ? 1 : 0;
    result.remote_host = own(value.remoteHost);
    result.remote_port = own(value.remotePort);
    result.remote_proto = own(value.remoteProto);
    result.windows_driver = own(value.windowsDriver);
    result.dco_compatible = value.dcoCompatible ? 1 : 0;
    result.dco_incompatibility_reason = own(value.dcoIncompatibilityReason);

    if (!value.serverList.empty())
    {
        result.server_list = static_cast<ovpn_server_entry *>(
            std::calloc(value.serverList.size(), sizeof(ovpn_server_entry)));
        if (result.server_list != nullptr)
        {
            result.server_list_len = value.serverList.size();
            for (size_t i = 0; i < value.serverList.size(); ++i)
            {
                result.server_list[i].server = own(value.serverList[i].server);
                result.server_list[i].friendly_name = own(value.serverList[i].friendlyName);
            }
        }
    }
    return result;
}

ovpn_connection_info connection_info_from(const ConnectionInfo &value)
{
    return {
        value.defined ? 1 : 0,
        own(value.user),
        own(value.serverHost),
        own(value.serverPort),
        own(value.serverProto),
        own(value.serverIp),
        own(value.vpnIp4),
        own(value.vpnIp6),
        own(value.vpnMtu),
        own(value.gw4),
        own(value.gw6),
        own(value.clientIp),
        own(value.tunName),
    };
}

struct CertResponse
{
    bool error = true;
    bool invalid_alias = false;
    std::string error_text = "external PKI certificate callback did not complete";
    std::string cert;
    std::string supporting_chain;
};

void complete_cert(void *context,
                   int32_t error,
                   int32_t invalid_alias,
                   ovpn_string_view error_text,
                   ovpn_string_view cert,
                   ovpn_string_view supporting_chain)
{
    auto &response = *static_cast<CertResponse *>(context);
    response.error = error != 0;
    response.invalid_alias = invalid_alias != 0;
    response.error_text = string_from(error_text);
    response.cert = string_from(cert);
    response.supporting_chain = string_from(supporting_chain);
}

struct SignResponse
{
    bool error = true;
    bool invalid_alias = false;
    std::string error_text = "external PKI signing callback did not complete";
    std::string signature;
};

void complete_sign(void *context,
                   int32_t error,
                   int32_t invalid_alias,
                   ovpn_string_view error_text,
                   ovpn_string_view signature)
{
    auto &response = *static_cast<SignResponse *>(context);
    response.error = error != 0;
    response.invalid_alias = invalid_alias != 0;
    response.error_text = string_from(error_text);
    response.signature = string_from(signature);
}

struct RemoteResponse
{
    bool completed = false;
    std::string host;
    std::string ip;
    std::string port;
    std::string proto;
    std::string error = "remote override callback did not complete";
};

void complete_remote(void *context,
                     ovpn_string_view host,
                     ovpn_string_view ip,
                     ovpn_string_view port,
                     ovpn_string_view proto,
                     ovpn_string_view error)
{
    auto &response = *static_cast<RemoteResponse *>(context);
    response.completed = true;
    response.host = string_from(host);
    response.ip = string_from(ip);
    response.port = string_from(port);
    response.proto = string_from(proto);
    response.error = string_from(error);
}

struct LocalNetworksResponse
{
    std::vector<std::string> networks;
};

void complete_local_networks(void *context,
                             const ovpn_string_view *networks,
                             size_t networks_len)
{
    auto &response = *static_cast<LocalNetworksResponse *>(context);
    if (networks == nullptr)
        return;
    response.networks.reserve(networks_len);
    for (size_t i = 0; i < networks_len; ++i)
        response.networks.push_back(string_from(networks[i]));
}

#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
struct ExternalTransportEndpointResponse
{
    std::string host;
    std::string port;
    std::string protocol;
    std::string ip_address;
};

void complete_external_transport_endpoint(
    void *context, const ovpn_external_transport_endpoint_view *endpoint)
{
    if (endpoint == nullptr)
        return;
    auto &response = *static_cast<ExternalTransportEndpointResponse *>(context);
    response.host = string_from(endpoint->host);
    response.port = string_from(endpoint->port);
    response.protocol = string_from(endpoint->protocol);
    response.ip_address = string_from(endpoint->ip_address);
}

ExternalTransportEndpointResponse external_transport_endpoint(
    const ovpn_callbacks &callbacks)
{
    ExternalTransportEndpointResponse response;
    if (callbacks.external_transport_endpoint != nullptr)
    {
        try
        {
            callbacks.external_transport_endpoint(callbacks.context,
                                                  &response,
                                                  complete_external_transport_endpoint);
        }
        catch (...)
        {
        }
    }
    return response;
}

class ExternalTransportSelfTestParent final : public openvpn::TransportClientParent
{
  public:
    void transport_recv(openvpn::BufferAllocated &buf) override
    {
        ++received;
        received_bytes += buf.size();
    }

    void transport_needs_send() override { ++needs_send; }

    void transport_error(const openvpn::Error::Type,
                         const std::string &) override
    {
        ++errors;
    }

    void proxy_error(const openvpn::Error::Type,
                     const std::string &) override
    {
        ++proxy_errors;
    }

    bool transport_is_openvpn_protocol() override { return true; }
    void transport_pre_resolve() override { ++pre_resolve; }
    void transport_wait_proxy() override { ++wait_proxy; }
    void transport_wait() override { ++wait; }
    void transport_connecting() override { ++connecting; }
    bool is_keepalive_enabled() const override { return true; }

    void disable_keepalive(unsigned int &ping,
                           unsigned int &timeout) override
    {
        ++disable_keepalive_calls;
        ping = 17;
        timeout = 43;
    }

    size_t received = 0;
    size_t received_bytes = 0;
    size_t needs_send = 0;
    size_t errors = 0;
    size_t proxy_errors = 0;
    size_t pre_resolve = 0;
    size_t wait_proxy = 0;
    size_t wait = 0;
    size_t connecting = 0;
    size_t disable_keepalive_calls = 0;
};

class RustExternalTransportClient final : public openvpn::TransportClient
{
  public:
    RustExternalTransportClient(openvpn_io::io_context &io_context,
                                openvpn::TransportClientParent *parent,
                                ovpn_callbacks callbacks,
                                openvpn::Protocol protocol)
        : callbacks_(callbacks),
          protocol_(protocol),
          state_(std::make_shared<ExternalTransportState>(io_context, parent)),
          handle_(new ovpn_external_transport_handle(state_))
    {
    }

    ~RustExternalTransportClient() override
    {
        {
            std::lock_guard<std::mutex> lock(state_->mutex);
            state_->parent = nullptr;
            state_->io = nullptr;
        }
        delete handle_;
    }

    void transport_start() override
    {
        if (callbacks_.external_transport_start != nullptr)
        {
            try
            {
                callbacks_.external_transport_start(callbacks_.context, handle_);
            }
            catch (...)
            {
            }
        }
    }

    void stop() override
    {
        call_void(callbacks_.external_transport_stop);
    }

    bool transport_send_const(const openvpn::Buffer &buf) override
    {
        return send(buf);
    }

    bool transport_send(openvpn::BufferAllocated &buf) override
    {
        return send(buf);
    }

    bool transport_send_queue_empty() override
    {
        return call_bool(callbacks_.external_transport_send_queue_empty, true);
    }

    bool transport_has_send_queue() override
    {
        return call_bool(callbacks_.external_transport_has_send_queue, false);
    }

    void transport_stop_requeueing() override
    {
        call_void(callbacks_.external_transport_stop_requeueing);
    }

    size_t transport_send_queue_size() override
    {
        if (callbacks_.external_transport_send_queue_size == nullptr)
            return 0;
        try
        {
            return callbacks_.external_transport_send_queue_size(callbacks_.context);
        }
        catch (...)
        {
            return 0;
        }
    }

    void reset_align_adjust(const size_t align_adjust) override
    {
        if (callbacks_.external_transport_reset_align_adjust != nullptr)
        {
            try
            {
                callbacks_.external_transport_reset_align_adjust(callbacks_.context,
                                                                  align_adjust);
            }
            catch (...)
            {
            }
        }
    }

    openvpn::IP::Addr server_endpoint_addr() const override
    {
        try
        {
            const auto endpoint = external_transport_endpoint(callbacks_);
            if (!endpoint.ip_address.empty())
                return openvpn::IP::Addr::from_string(endpoint.ip_address);
        }
        catch (...)
        {
        }
        return {};
    }

    unsigned short server_endpoint_port() const override
    {
        try
        {
            const auto endpoint = external_transport_endpoint(callbacks_);
            if (!endpoint.port.empty())
                return openvpn::parse_number_throw<unsigned short>(endpoint.port,
                                                                    "external transport port");
        }
        catch (...)
        {
        }
        return 0;
    }

    openvpn_io::detail::socket_type native_handle() override
    {
        if (callbacks_.external_transport_native_handle == nullptr)
            return 0;
        try
        {
            return static_cast<openvpn_io::detail::socket_type>(
                callbacks_.external_transport_native_handle(callbacks_.context));
        }
        catch (...)
        {
            return 0;
        }
    }

    void server_endpoint_info(std::string &host,
                              std::string &port,
                              std::string &protocol,
                              std::string &ip_address) const override
    {
        auto endpoint = external_transport_endpoint(callbacks_);
        host = std::move(endpoint.host);
        port = std::move(endpoint.port);
        protocol = std::move(endpoint.protocol);
        ip_address = std::move(endpoint.ip_address);
    }

    openvpn::Protocol transport_protocol() const override
    {
        return protocol_;
    }

    void transport_reparent(openvpn::TransportClientParent *parent) override
    {
        std::lock_guard<std::mutex> lock(state_->mutex);
        state_->parent = parent;
    }

  private:
    bool send(const openvpn::Buffer &buf)
    {
        if (callbacks_.external_transport_send == nullptr)
            return false;
        try
        {
            return callbacks_.external_transport_send(callbacks_.context,
                                                       buf.c_data(),
                                                       buf.size())
                   != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    bool call_bool(ovpn_external_transport_bool_fn callback,
                   bool default_value) const
    {
        if (callback == nullptr)
            return default_value;
        try
        {
            return callback(callbacks_.context) != 0;
        }
        catch (...)
        {
            return default_value;
        }
    }

    void call_void(ovpn_external_transport_void_fn callback)
    {
        if (callback != nullptr)
        {
            try
            {
                callback(callbacks_.context);
            }
            catch (...)
            {
            }
        }
    }

    ovpn_callbacks callbacks_;
    openvpn::Protocol protocol_;
    std::shared_ptr<ExternalTransportState> state_;
    ovpn_external_transport_handle *handle_;
};

class RustExternalTransportFactory final : public openvpn::TransportClientFactory
{
  public:
    RustExternalTransportFactory(ovpn_callbacks callbacks,
                                 openvpn::Protocol protocol)
        : callbacks_(callbacks), protocol_(protocol)
    {
    }

    openvpn::TransportClient::Ptr new_transport_client_obj(
        openvpn_io::io_context &io_context,
        openvpn::TransportClientParent *parent) override
    {
        return openvpn::TransportClient::Ptr(
            new RustExternalTransportClient(io_context, parent, callbacks_, protocol_));
    }

    bool is_relay() override
    {
        if (callbacks_.external_transport_is_relay == nullptr)
            return false;
        try
        {
            return callbacks_.external_transport_is_relay(callbacks_.context) != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    void process_push(const openvpn::OptionList &options) override
    {
        if (callbacks_.external_transport_process_push != nullptr)
        {
            try
            {
                const std::string rendered = options.render(0);
                callbacks_.external_transport_process_push(callbacks_.context,
                                                           view_of(rendered));
            }
            catch (...)
            {
            }
        }
    }

  private:
    ovpn_callbacks callbacks_;
    openvpn::Protocol protocol_;
};
#endif

#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
struct ExternalTunInfoResponse
{
    std::string name;
    std::string vpn_ipv4;
    std::string vpn_ipv6;
    std::string gateway_ipv4;
    std::string gateway_ipv6;
    int32_t mtu = 0;
    uint32_t interface_index = openvpn::INVALID_ADAPTER_INDEX;
};

void complete_external_tun_info(void *context,
                                const ovpn_external_tun_info_view *info)
{
    if (info == nullptr)
        return;
    auto &response = *static_cast<ExternalTunInfoResponse *>(context);
    response.name = string_from(info->name);
    response.vpn_ipv4 = string_from(info->vpn_ipv4);
    response.vpn_ipv6 = string_from(info->vpn_ipv6);
    response.gateway_ipv4 = string_from(info->gateway_ipv4);
    response.gateway_ipv6 = string_from(info->gateway_ipv6);
    response.mtu = info->mtu;
    response.interface_index = info->interface_index;
}

ExternalTunInfoResponse external_tun_info(const ovpn_callbacks &callbacks)
{
    ExternalTunInfoResponse response;
    if (callbacks.external_tun_info != nullptr)
    {
        try
        {
            callbacks.external_tun_info(callbacks.context,
                                        &response,
                                        complete_external_tun_info);
        }
        catch (...)
        {
        }
    }
    return response;
}

class ExternalTunSelfTestParent final : public openvpn::TunClientParent
{
  public:
    void tun_recv(openvpn::BufferAllocated &buf) override
    {
        ++received;
        received_bytes += buf.size();
        received_headroom = buf.offset();
    }

    void tun_error(const openvpn::Error::Type,
                   const std::string &) override
    {
        ++errors;
    }

    void tun_pre_tun_config() override { ++pre_tun_config; }
    void tun_pre_route_config() override { ++pre_route_config; }
    void tun_connected() override { ++connected; }

    size_t received = 0;
    size_t received_bytes = 0;
    size_t received_headroom = 0;
    size_t errors = 0;
    size_t pre_tun_config = 0;
    size_t pre_route_config = 0;
    size_t connected = 0;
};

class RustExternalTunClient final : public openvpn::TunClient
{
  public:
    RustExternalTunClient(openvpn_io::io_context &io_context,
                          openvpn::TunClientParent &parent,
                          ovpn_callbacks callbacks,
                          const openvpn::Frame::Context &read_tun_frame)
        : callbacks_(callbacks),
          state_(std::make_shared<ExternalTunState>(io_context,
                                                    parent,
                                                    read_tun_frame)),
          handle_(new ovpn_external_tun_handle(state_))
    {
    }

    ~RustExternalTunClient() override
    {
        {
            std::lock_guard<std::recursive_mutex> lock(state_->mutex);
            state_->parent = nullptr;
            state_->io = nullptr;
        }
        delete handle_;
    }

    void tun_start(const openvpn::OptionList &options,
                   openvpn::TransportClient &,
                   openvpn::CryptoDCSettings &crypto) override
    {
        if (callbacks_.external_tun_start == nullptr)
            return;
        try
        {
            const std::string rendered = options.render(0);
            const ovpn_external_tun_start_view start{
                view_of(rendered),
                static_cast<uint32_t>(crypto.cipher()),
                static_cast<uint32_t>(crypto.digest()),
                static_cast<uint32_t>(crypto.key_derivation()),
                crypto.useEpochKeys() ? 1 : 0,
            };
            callbacks_.external_tun_start(callbacks_.context, handle_, &start);
        }
        catch (...)
        {
        }
    }

    void stop() override
    {
        call_void(callbacks_.external_tun_stop);
    }

    void set_disconnect() override
    {
        call_void(callbacks_.external_tun_set_disconnect);
    }

    bool tun_send(openvpn::BufferAllocated &buf) override
    {
        if (callbacks_.external_tun_send == nullptr)
            return false;
        try
        {
            return callbacks_.external_tun_send(callbacks_.context,
                                                buf.c_data(),
                                                buf.size())
                   != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    std::string tun_name() const override
    {
        return external_tun_info(callbacks_).name;
    }

    std::string vpn_ip4() const override
    {
        return external_tun_info(callbacks_).vpn_ipv4;
    }

    std::string vpn_ip6() const override
    {
        return external_tun_info(callbacks_).vpn_ipv6;
    }

    std::string vpn_gw4() const override
    {
        return external_tun_info(callbacks_).gateway_ipv4;
    }

    std::string vpn_gw6() const override
    {
        return external_tun_info(callbacks_).gateway_ipv6;
    }

    int vpn_mtu() const override
    {
        return external_tun_info(callbacks_).mtu;
    }

    void adjust_mss(int mss) override
    {
        if (callbacks_.external_tun_adjust_mss != nullptr)
        {
            try
            {
                callbacks_.external_tun_adjust_mss(callbacks_.context, mss);
            }
            catch (...)
            {
            }
        }
    }

    void apply_push_update(const openvpn::OptionList &options,
                           openvpn::TransportClient &) override
    {
        if (callbacks_.external_tun_apply_push_update != nullptr)
        {
            try
            {
                const std::string rendered = options.render(0);
                callbacks_.external_tun_apply_push_update(callbacks_.context,
                                                          view_of(rendered));
            }
            catch (...)
            {
            }
        }
    }

    uint32_t vpn_interface_index() const override
    {
        return external_tun_info(callbacks_).interface_index;
    }

  private:
    void call_void(ovpn_external_tun_void_fn callback)
    {
        if (callback != nullptr)
        {
            try
            {
                callback(callbacks_.context);
            }
            catch (...)
            {
            }
        }
    }

    ovpn_callbacks callbacks_;
    std::shared_ptr<ExternalTunState> state_;
    ovpn_external_tun_handle *handle_;
};

class RustExternalTunFactory final : public openvpn::TunClientFactory
{
  public:
    RustExternalTunFactory(ovpn_callbacks callbacks,
                           const openvpn::Frame::Context &read_tun_frame)
        : callbacks_(callbacks), read_tun_frame_(read_tun_frame)
    {
    }

    openvpn::TunClient::Ptr new_tun_client_obj(
        openvpn_io::io_context &io_context,
        openvpn::TunClientParent &parent,
        openvpn::TransportClient *) override
    {
        return openvpn::TunClient::Ptr(
            new RustExternalTunClient(io_context,
                                      parent,
                                      callbacks_,
                                      read_tun_frame_));
    }

    bool layer_2_supported() const override
    {
        return call_bool(callbacks_.external_tun_layer_2_supported, false);
    }

    bool supports_epoch_data() override
    {
        return call_bool(callbacks_.external_tun_supports_epoch_data, false);
    }

    void finalize(const bool disconnected) override
    {
        if (callbacks_.external_tun_finalize != nullptr)
        {
            try
            {
                callbacks_.external_tun_finalize(callbacks_.context,
                                                 disconnected ? 1 : 0);
            }
            catch (...)
            {
            }
        }
    }

  private:
    bool call_bool(ovpn_external_tun_bool_fn callback,
                   bool default_value) const
    {
        if (callback == nullptr)
            return default_value;
        try
        {
            return callback(callbacks_.context) != 0;
        }
        catch (...)
        {
            return default_value;
        }
    }

    ovpn_callbacks callbacks_;
    const openvpn::Frame::Context read_tun_frame_;
};
#endif

class RustClient final : public OpenVPNClient
{
  public:
    explicit RustClient(ovpn_callbacks callbacks)
        : callbacks_(callbacks)
    {
    }

    void set_connect_started(void *context, ovpn_connect_started_fn callback)
    {
        connect_started_context_ = context;
        connect_started_ = callback;
    }

    void notify_connect_started()
    {
        const auto callback = connect_started_;
        void *const context = connect_started_context_;
        connect_started_ = nullptr;
        connect_started_context_ = nullptr;
        if (callback != nullptr)
            callback(context);
    }

    void connect_run() override
    {
        // OpenVPNClient::connect_setup() has enabled foreign-thread access
        // before dispatch reaches this override, so stop() cannot be lost.
        notify_connect_started();
        OpenVPNClient::connect_run();
    }

    void callback_self_test()
    {
        Event test_event;
        test_event.name = "SELF_TEST";
        test_event.info = "callback adapter self-test";
        event(test_event);
        log(LogInfo("callback adapter self-test\n"));

        AppCustomControlMessageEvent control;
        control.protocol = "self-test";
        control.payload = "payload";
        acc_event(control);

        (void)socket_protect(static_cast<openvpn_io::detail::socket_type>(-1),
                             "192.0.2.1",
                             false);
        (void)pause_on_connection_timeout();
        clock_tick();

        if (remote_override_enabled())
        {
            RemoteOverride remote;
            remote_override(remote);
            const bool success = remote.error.empty()
                                 && remote.host == "override.example.test"
                                 && remote.ip == "192.0.2.200"
                                 && remote.port == "443"
                                 && remote.proto == "TCP";
            const bool expected_error =
                remote.error == "intentional E2E remote override failure"
                && remote.host.empty()
                && remote.ip.empty()
                && remote.port.empty()
                && remote.proto.empty();
            if (!success && !expected_error)
                throw std::runtime_error("remote override response self-test failed");
        }

        ExternalPKICertRequest cert;
        cert.alias = "self-test";
        external_pki_cert_request(cert);
        const bool cert_success = !cert.error
                                  && !cert.invalidAlias
                                  && cert.errorText.empty()
                                  && cert.cert == "self-test-certificate"
                                  && cert.supportingChain
                                         == "self-test-supporting-chain";
        const bool cert_expected_error =
            cert.error
            && !cert.invalidAlias
            && cert.errorText == "intentional E2E certificate failure"
            && cert.cert.empty()
            && cert.supportingChain.empty();
        if (!cert_success && !cert_expected_error)
            throw std::runtime_error("external PKI certificate response self-test failed");

        ExternalPKISignRequest sign;
        sign.alias = "self-test";
        sign.data = "c2VsZi10ZXN0";
        sign.algorithm = "RSA_PKCS1_PADDING";
        sign.hashalg = "SHA256";
        sign.saltlen = "32";
        external_pki_sign_request(sign);
        const bool sign_success = !sign.error
                                  && !sign.invalidAlias
                                  && sign.errorText.empty()
                                  && sign.sig == "c2lnbmF0dXJl";
        const bool sign_expected_error =
            sign.error
            && !sign.invalidAlias
            && sign.errorText == "intentional E2E signing failure"
            && sign.sig.empty();
        if (!sign_success && !sign_expected_error)
            throw std::runtime_error("external PKI signing response self-test failed");

        (void)tun_builder_new();
        (void)tun_builder_set_layer(3);
        (void)tun_builder_set_remote_address("192.0.2.1", false);
        (void)tun_builder_add_address("10.8.0.2", 24, "10.8.0.1", false, false);
        (void)tun_builder_set_route_metric_default(100);
        (void)tun_builder_reroute_gw(true, false, 0);
        (void)tun_builder_add_route("10.9.0.0", 24, 100, false);
        (void)tun_builder_exclude_route("192.168.0.0", 16, 100, false);
        openvpn::DnsOptions dns;
        dns.from_dhcp_options = true;
        dns.search_domains.emplace_back("search.example.test");
        openvpn::DnsServer dns_server;
        dns_server.addresses.emplace_back("192.0.2.53:5353");
        dns_server.domains.emplace_back("split.example.test");
        dns_server.dnssec = openvpn::DnsServer::Security::Optional;
        dns_server.transport = openvpn::DnsServer::Transport::TLS;
        dns_server.sni = "resolver.example.test";
        dns.servers.emplace(-42, std::move(dns_server));
        (void)tun_builder_set_dns_options(dns);
        (void)tun_builder_set_mtu(1500);
        (void)tun_builder_set_session_name("self-test");
        (void)tun_builder_add_proxy_bypass("localhost");
        (void)tun_builder_set_proxy_auto_config_url("https://example.test/proxy.pac");
        (void)tun_builder_set_proxy_http("127.0.0.1", 8080);
        (void)tun_builder_set_proxy_https("127.0.0.1", 8443);
        (void)tun_builder_add_wins_server("192.0.2.53");
        (void)tun_builder_set_allow_family(2, true);
        (void)tun_builder_set_allow_local_dns(true);
        (void)tun_builder_establish();
        (void)tun_builder_persist();
        const auto local_networks = tun_builder_get_local_networks(false);
        if (!local_networks.empty()
            && (local_networks.size() != 1
                || local_networks[0] != "192.168.0.0/16"))
            throw std::runtime_error("local network response self-test failed");
        tun_builder_establish_lite();
        tun_builder_teardown(true);

#ifdef ENABLE_OVPNDCO
        (void)tun_builder_dco_available();
        (void)tun_builder_dco_enable("ovpn-self-test");
        sockaddr_in endpoint{};
        endpoint.sin_family = AF_INET;
        endpoint.sin_port = htons(1194);
        endpoint.sin_addr.s_addr = htonl(0xc0000201);
        auto vpn4 = openvpn::IPv4::Addr::from_string("10.8.0.2");
        openvpn::IPv6::Addr vpn6;
        tun_builder_dco_new_peer(1,
                                 0,
                                 reinterpret_cast<sockaddr *>(&endpoint),
                                 sizeof(endpoint),
                                 vpn4,
                                 vpn6);
        tun_builder_dco_set_peer(1, 10, 60);
        tun_builder_dco_get_peer(1, true);
        const std::array<unsigned char, 16> encrypt_key{
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15};
        const std::array<unsigned char, 16> decrypt_key{
            15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0};
        openvpn::KoRekey::KeyConfig key{};
        key.encrypt.cipher_key = encrypt_key.data();
        key.encrypt.cipher_key_size = encrypt_key.size();
        key.decrypt.cipher_key = decrypt_key.data();
        key.decrypt.cipher_key_size = decrypt_key.size();
        for (size_t i = 0; i < sizeof(key.encrypt.nonce_tail); ++i)
        {
            key.encrypt.nonce_tail[i] = static_cast<unsigned char>(i + 16);
            key.decrypt.nonce_tail[i] = static_cast<unsigned char>(i + 32);
        }
        key.key_id = 7;
        key.remote_peer_id = 1;
        key.cipher_alg = 99;
        tun_builder_dco_new_key(0, &key);
        tun_builder_dco_swap_keys(1);
        tun_builder_dco_del_key(1, 0);
        tun_builder_dco_del_peer(1);
        tun_builder_dco_establish();
#endif

#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
        const std::string host = "vpn.example.test";
        const std::string port = "1194";
        const std::string protocol = "UDP";
        const std::string gremlin = "delay=1";
        const std::string backup_host = "backup.example.test";
        const std::string backup_port = "443";
        const std::string backup_protocol = "TCP";
        const ovpn_external_remote_view remotes[] = {
            {view_of(host), view_of(port), view_of(protocol)},
            {view_of(backup_host), view_of(backup_port), view_of(backup_protocol)},
        };
        const ovpn_external_transport_config_view transport_config{
            view_of(host),
            view_of(port),
            view_of(protocol),
            view_of(gremlin),
            remotes,
            2,
            1,
            1};
        bool transport_configured = false;
        if (callbacks_.external_transport_configure != nullptr)
            transport_configured = callbacks_.external_transport_configure(
                                       callbacks_.context, &transport_config)
                                   != 0;
        if (transport_configured)
        {
        openvpn_io::io_context transport_io;
        ExternalTransportSelfTestParent transport_parent;
        auto transport_state = std::make_shared<ExternalTransportState>(
            transport_io, &transport_parent);
        ovpn_external_transport_handle transport_handle(transport_state);
        if (callbacks_.external_transport_start != nullptr)
            callbacks_.external_transport_start(callbacks_.context, &transport_handle);
        transport_io.poll();
        if (callbacks_.external_transport_stop != nullptr)
            callbacks_.external_transport_stop(callbacks_.context);
        const uint8_t transport_packet[] = {1, 2, 3, 4};
        if (callbacks_.external_transport_send != nullptr)
            (void)callbacks_.external_transport_send(callbacks_.context,
                                                     transport_packet,
                                                     sizeof(transport_packet));
        if (callbacks_.external_transport_send_queue_empty != nullptr)
        {
            if (!callbacks_.external_transport_send_queue_empty(callbacks_.context))
                throw std::runtime_error("external transport empty-queue self-test failed");
        }
        if (callbacks_.external_transport_has_send_queue != nullptr)
        {
            if (callbacks_.external_transport_has_send_queue(callbacks_.context))
                throw std::runtime_error("external transport send-queue self-test failed");
        }
        if (callbacks_.external_transport_stop_requeueing != nullptr)
            callbacks_.external_transport_stop_requeueing(callbacks_.context);
        if (callbacks_.external_transport_send_queue_size != nullptr)
        {
            if (callbacks_.external_transport_send_queue_size(callbacks_.context) != 0)
                throw std::runtime_error("external transport queue-size self-test failed");
        }
        if (callbacks_.external_transport_reset_align_adjust != nullptr)
            callbacks_.external_transport_reset_align_adjust(callbacks_.context, 32);
        if (callbacks_.external_transport_endpoint != nullptr)
        {
            ExternalTransportEndpointResponse response;
            callbacks_.external_transport_endpoint(callbacks_.context,
                                                   &response,
                                                   complete_external_transport_endpoint);
            if (response.host != "vpn.example.test"
                || response.port != "1194"
                || response.protocol != "UDP"
                || response.ip_address != "192.0.2.1")
                throw std::runtime_error("external transport endpoint self-test failed");
        }
        if (callbacks_.external_transport_native_handle != nullptr)
        {
            if (callbacks_.external_transport_native_handle(callbacks_.context) != 7)
                throw std::runtime_error("external transport native-handle self-test failed");
        }
        if (callbacks_.external_transport_is_relay != nullptr)
        {
            if (callbacks_.external_transport_is_relay(callbacks_.context))
                throw std::runtime_error("external transport relay self-test failed");
        }
        if (callbacks_.external_transport_process_push != nullptr)
            callbacks_.external_transport_process_push(callbacks_.context,
                                                       view_of("push-option self-test\n"));
        if (transport_parent.received != 1
            || transport_parent.received_bytes != 4
            || transport_parent.needs_send != 1
            || transport_parent.errors != 2
            || transport_parent.proxy_errors != 2
            || transport_parent.pre_resolve != 1
            || transport_parent.wait_proxy != 1
            || transport_parent.wait != 1
            || transport_parent.connecting != 1
            || transport_parent.disable_keepalive_calls != 1)
            throw std::runtime_error("external transport reverse-I/O self-test failed");
        }
#endif

#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
        const ovpn_external_tun_config_view tun_config{
            view_of("self-test"), 3, 1500, 1600, 0, 1, 0, 0, 0};
        bool tun_configured = false;
        if (callbacks_.external_tun_configure != nullptr)
            tun_configured = callbacks_.external_tun_configure(
                                 callbacks_.context, &tun_config)
                             != 0;
        if (tun_configured)
        {
        openvpn_io::io_context tun_io;
        ExternalTunSelfTestParent tun_parent;
        auto tun_state = std::make_shared<ExternalTunState>(
            tun_io,
            tun_parent,
            openvpn::Frame::Context(64, 1600, 64, 0, 16, 0));
        ovpn_external_tun_handle tun_handle(tun_state);
        const std::string tun_options = "route 10.9.0.0 255.255.255.0\n";
        const ovpn_external_tun_start_view tun_start{
            view_of(tun_options), 11, 22, 33, 1};
        if (callbacks_.external_tun_start != nullptr)
            callbacks_.external_tun_start(callbacks_.context, &tun_handle, &tun_start);
        tun_io.poll();
        if (callbacks_.external_tun_stop != nullptr)
            callbacks_.external_tun_stop(callbacks_.context);
        if (callbacks_.external_tun_set_disconnect != nullptr)
            callbacks_.external_tun_set_disconnect(callbacks_.context);
        const uint8_t tun_packet[] = {5, 6, 7, 8};
        if (callbacks_.external_tun_send != nullptr)
            (void)callbacks_.external_tun_send(callbacks_.context,
                                               tun_packet,
                                               sizeof(tun_packet));
        if (callbacks_.external_tun_info != nullptr)
        {
            ExternalTunInfoResponse response;
            callbacks_.external_tun_info(callbacks_.context,
                                         &response,
                                         complete_external_tun_info);
            if (response.name != "self-test-tun"
                || response.vpn_ipv4 != "10.8.0.2"
                || response.vpn_ipv6 != "2001:db8::2"
                || response.gateway_ipv4 != "10.8.0.1"
                || response.gateway_ipv6 != "2001:db8::1"
                || response.mtu != 1500
                || response.interface_index != 9)
                throw std::runtime_error("external TUN info self-test failed");
        }
        if (callbacks_.external_tun_adjust_mss != nullptr)
            callbacks_.external_tun_adjust_mss(callbacks_.context, 1234);
        if (callbacks_.external_tun_apply_push_update != nullptr)
            callbacks_.external_tun_apply_push_update(
                callbacks_.context, view_of("dhcp-option DNS 192.0.2.53\n"));
        if (callbacks_.external_tun_layer_2_supported != nullptr)
        {
            if (callbacks_.external_tun_layer_2_supported(callbacks_.context))
                throw std::runtime_error("external TUN layer-2 self-test failed");
        }
        if (callbacks_.external_tun_supports_epoch_data != nullptr)
        {
            if (callbacks_.external_tun_supports_epoch_data(callbacks_.context))
                throw std::runtime_error("external TUN epoch-data self-test failed");
        }
        if (callbacks_.external_tun_finalize != nullptr)
            callbacks_.external_tun_finalize(callbacks_.context, 1);
        if (tun_parent.received != 1
            || tun_parent.received_bytes != 4
            || tun_parent.received_headroom < 64
            || tun_parent.received_headroom >= 80
            || tun_parent.errors != 2
            || tun_parent.pre_tun_config != 1
            || tun_parent.pre_route_config != 1
            || tun_parent.connected != 1)
            throw std::runtime_error("external TUN reverse-I/O self-test failed");
        }
#endif
    }

#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    openvpn::TransportClientFactory *new_transport_factory(
        const openvpn::ExternalTransport::Config &config) override
    {
        if (callbacks_.external_transport_configure == nullptr
            || !config.remote_list)
            return nullptr;
        try
        {
            std::string host;
            std::string port;
            openvpn::Protocol current_protocol;
            (void)config.remote_list->endpoint_available(&host,
                                                        &port,
                                                        &current_protocol);
            const std::string protocol = current_protocol.str();
            std::vector<std::string> remote_hosts;
            std::vector<std::string> remote_ports;
            std::vector<std::string> remote_protocols;
            std::vector<ovpn_external_remote_view> remotes;
            const size_t remote_count = config.remote_list->size();
            remote_hosts.reserve(remote_count);
            remote_ports.reserve(remote_count);
            remote_protocols.reserve(remote_count);
            remotes.reserve(remote_count);
            for (size_t i = 0; i < remote_count; ++i)
            {
                const auto remote = config.remote_list->get_item(i);
                remote_hosts.push_back(remote->actual_host());
                remote_ports.push_back(remote->server_port);
                remote_protocols.emplace_back(remote->transport_protocol.str());
                remotes.push_back({
                    view_of(remote_hosts.back()),
                    view_of(remote_ports.back()),
                    view_of(remote_protocols.back()),
                });
            }
            const ovpn_external_transport_config_view view{
                view_of(host),
                view_of(port),
                view_of(protocol),
                view_of(config.gremlin_config),
                remotes.data(),
                remotes.size(),
                config.server_addr_float ? 1 : 0,
                config.synchronous_dns_lookup ? 1 : 0,
            };
            if (callbacks_.external_transport_configure(callbacks_.context, &view) == 0)
                return nullptr;
            return new RustExternalTransportFactory(callbacks_, config.protocol);
        }
        catch (...)
        {
            return nullptr;
        }
    }
#endif

#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    openvpn::TunClientFactory *new_tun_factory(
        const openvpn::ExternalTun::Config &config,
        const openvpn::OptionList &) override
    {
        if (callbacks_.external_tun_configure == nullptr || !config.frame)
            return nullptr;
        try
        {
            const auto &tun = config.tun_prop;
            const ovpn_external_tun_config_view view{
                view_of(tun.session_name),
                tun.layer.value(),
                tun.mtu,
                tun.mtu_max,
                tun.google_dns_fallback ? 1 : 0,
                tun.dhcp_search_domains_as_split_domains ? 1 : 0,
                tun.allow_local_lan_access ? 1 : 0,
                tun.remote_bypass ? 1 : 0,
                config.tun_persist ? 1 : 0,
            };
            if (callbacks_.external_tun_configure(callbacks_.context, &view) == 0)
                return nullptr;
            return new RustExternalTunFactory(
                callbacks_, (*config.frame)[openvpn::Frame::READ_TUN]);
        }
        catch (...)
        {
            return nullptr;
        }
    }
#endif

    bool pause_on_connection_timeout() override
    {
        if (callbacks_.pause_on_connection_timeout == nullptr)
            return false;
        try
        {
            return callbacks_.pause_on_connection_timeout(callbacks_.context) != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    bool socket_protect(openvpn_io::detail::socket_type socket,
                        std::string remote,
                        bool ipv6) override
    {
        if (callbacks_.socket_protect == nullptr)
            return OpenVPNClient::socket_protect(socket, std::move(remote), ipv6);
        try
        {
            return callbacks_.socket_protect(callbacks_.context,
                                             static_cast<intptr_t>(socket),
                                             view_of(remote),
                                             ipv6 ? 1 : 0)
                   != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    void event(const Event &event) override
    {
        if (callbacks_.event != nullptr)
        {
            try
            {
                callbacks_.event(callbacks_.context,
                                 event.error ? 1 : 0,
                                 event.fatal ? 1 : 0,
                                 view_of(event.name),
                                 view_of(event.info));
            }
            catch (...)
            {
            }
        }
    }

    void acc_event(const AppCustomControlMessageEvent &event) override
    {
        if (callbacks_.acc_event != nullptr)
        {
            try
            {
                callbacks_.acc_event(
                    callbacks_.context, view_of(event.protocol), view_of(event.payload));
            }
            catch (...)
            {
            }
        }
    }

    void log(const LogInfo &log) override
    {
        if (callbacks_.log != nullptr)
        {
            try
            {
                callbacks_.log(callbacks_.context, view_of(log.text));
            }
            catch (...)
            {
            }
        }
    }

    void external_pki_cert_request(ExternalPKICertRequest &request) override
    {
        if (callbacks_.external_pki_cert_request == nullptr)
        {
            request.error = true;
            request.errorText = "external PKI certificate callback is not configured";
            return;
        }

        CertResponse response;
        try
        {
            callbacks_.external_pki_cert_request(callbacks_.context,
                                                 view_of(request.alias),
                                                 &response,
                                                 complete_cert);
        }
        catch (...)
        {
            response.error_text = "external PKI certificate callback threw an exception";
        }
        request.error = response.error;
        request.invalidAlias = response.invalid_alias;
        request.errorText = std::move(response.error_text);
        request.cert = std::move(response.cert);
        request.supportingChain = std::move(response.supporting_chain);
    }

    void external_pki_sign_request(ExternalPKISignRequest &request) override
    {
        if (callbacks_.external_pki_sign_request == nullptr)
        {
            request.error = true;
            request.errorText = "external PKI signing callback is not configured";
            return;
        }

        SignResponse response;
        try
        {
            callbacks_.external_pki_sign_request(callbacks_.context,
                                                 view_of(request.alias),
                                                 view_of(request.data),
                                                 view_of(request.algorithm),
                                                 view_of(request.hashalg),
                                                 view_of(request.saltlen),
                                                 &response,
                                                 complete_sign);
        }
        catch (...)
        {
            response.error_text = "external PKI signing callback threw an exception";
        }
        request.error = response.error;
        request.invalidAlias = response.invalid_alias;
        request.errorText = std::move(response.error_text);
        request.sig = std::move(response.signature);
    }

    bool remote_override_enabled() override
    {
        if (callbacks_.remote_override_enabled == nullptr)
            return false;
        try
        {
            return callbacks_.remote_override_enabled(callbacks_.context) != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    void remote_override(RemoteOverride &remote) override
    {
        if (callbacks_.remote_override_request == nullptr)
        {
            remote.error = "remote override callback is not configured";
            return;
        }
        RemoteResponse response;
        try
        {
            callbacks_.remote_override_request(
                callbacks_.context, &response, complete_remote);
        }
        catch (...)
        {
            response.error = "remote override callback threw an exception";
        }
        remote.host = std::move(response.host);
        remote.ip = std::move(response.ip);
        remote.port = std::move(response.port);
        remote.proto = std::move(response.proto);
        remote.error = std::move(response.error);
    }

    bool tun_builder_new() override
    {
        return call_bool(callbacks_.tun_builder_new, false);
    }

    bool tun_builder_set_layer(int layer) override
    {
        return call_bool(callbacks_.tun_builder_set_layer, true, layer);
    }

    bool tun_builder_set_remote_address(const std::string &address, bool ipv6) override
    {
        return call_bool(callbacks_.tun_builder_set_remote_address,
                         false,
                         view_of(address),
                         ipv6 ? 1 : 0);
    }

    bool tun_builder_add_address(const std::string &address,
                                 int prefix_length,
                                 const std::string &gateway,
                                 bool ipv6,
                                 bool net30) override
    {
        return call_bool(callbacks_.tun_builder_add_address,
                         false,
                         view_of(address),
                         prefix_length,
                         view_of(gateway),
                         ipv6 ? 1 : 0,
                         net30 ? 1 : 0);
    }

    bool tun_builder_set_route_metric_default(int metric) override
    {
        return call_bool(callbacks_.tun_builder_set_route_metric_default, true, metric);
    }

    bool tun_builder_reroute_gw(bool ipv4, bool ipv6, unsigned int flags) override
    {
        return call_bool(callbacks_.tun_builder_reroute_gw,
                         false,
                         ipv4 ? 1 : 0,
                         ipv6 ? 1 : 0,
                         flags);
    }

    bool tun_builder_add_route(const std::string &address,
                               int prefix_length,
                               int metric,
                               bool ipv6) override
    {
        return call_bool(callbacks_.tun_builder_add_route,
                         false,
                         view_of(address),
                         prefix_length,
                         metric,
                         ipv6 ? 1 : 0);
    }

    bool tun_builder_exclude_route(const std::string &address,
                                   int prefix_length,
                                   int metric,
                                   bool ipv6) override
    {
        return call_bool(callbacks_.tun_builder_exclude_route,
                         false,
                         view_of(address),
                         prefix_length,
                         metric,
                         ipv6 ? 1 : 0);
    }

    bool tun_builder_set_dns_options(const openvpn::DnsOptions &dns) override
    {
        if (callbacks_.tun_builder_set_dns_options == nullptr)
            return false;
        try
        {
            std::vector<ovpn_string_view> search_domains;
            search_domains.reserve(dns.search_domains.size());
            for (const auto &domain : dns.search_domains)
                search_domains.push_back(view_of(domain.domain));

            std::vector<std::vector<ovpn_dns_address_view>> addresses;
            std::vector<std::vector<ovpn_string_view>> domains;
            std::vector<ovpn_dns_server_view> servers;
            addresses.reserve(dns.servers.size());
            domains.reserve(dns.servers.size());
            servers.reserve(dns.servers.size());
            for (const auto &[priority, server] : dns.servers)
            {
                addresses.emplace_back();
                auto &server_addresses = addresses.back();
                server_addresses.reserve(server.addresses.size());
                for (const auto &address : server.addresses)
                    server_addresses.push_back(
                        {view_of(address.address), address.port});

                domains.emplace_back();
                auto &server_domains = domains.back();
                server_domains.reserve(server.domains.size());
                for (const auto &domain : server.domains)
                    server_domains.push_back(view_of(domain.domain));

                servers.push_back({
                    priority,
                    server_addresses.empty() ? nullptr : server_addresses.data(),
                    server_addresses.size(),
                    server_domains.empty() ? nullptr : server_domains.data(),
                    server_domains.size(),
                    static_cast<int32_t>(server.dnssec),
                    static_cast<int32_t>(server.transport),
                    view_of(server.sni),
                });
            }

            const ovpn_dns_options_view view{
                dns.from_dhcp_options ? 1 : 0,
                search_domains.empty() ? nullptr : search_domains.data(),
                search_domains.size(),
                servers.empty() ? nullptr : servers.data(),
                servers.size(),
            };
            return callbacks_.tun_builder_set_dns_options(callbacks_.context, &view) != 0;
        }
        catch (...)
        {
            return false;
        }
    }

    bool tun_builder_set_mtu(int mtu) override
    {
        return call_bool(callbacks_.tun_builder_set_mtu, false, mtu);
    }

    bool tun_builder_set_session_name(const std::string &name) override
    {
        return call_bool(
            callbacks_.tun_builder_set_session_name, false, view_of(name));
    }

    bool tun_builder_add_proxy_bypass(const std::string &host) override
    {
        return call_bool(callbacks_.tun_builder_add_proxy_bypass,
                         false,
                         view_of(host));
    }

    bool tun_builder_set_proxy_auto_config_url(const std::string &url) override
    {
        return call_bool(callbacks_.tun_builder_set_proxy_auto_config_url,
                         false,
                         view_of(url));
    }

    bool tun_builder_set_proxy_http(const std::string &host, int port) override
    {
        return call_bool(
            callbacks_.tun_builder_set_proxy_http, false, view_of(host), port);
    }

    bool tun_builder_set_proxy_https(const std::string &host, int port) override
    {
        return call_bool(
            callbacks_.tun_builder_set_proxy_https, false, view_of(host), port);
    }

    bool tun_builder_add_wins_server(const std::string &address) override
    {
        return call_bool(callbacks_.tun_builder_add_wins_server,
                         false,
                         view_of(address));
    }

    bool tun_builder_set_allow_family(int af, bool allow) override
    {
        return call_bool(callbacks_.tun_builder_set_allow_family,
                         true,
                         af,
                         allow ? 1 : 0);
    }

    bool tun_builder_set_allow_local_dns(bool allow) override
    {
        return call_bool(callbacks_.tun_builder_set_allow_local_dns,
                         true,
                         allow ? 1 : 0);
    }

    int tun_builder_establish() override
    {
        if (callbacks_.tun_builder_establish == nullptr)
            return -1;
        try
        {
            return callbacks_.tun_builder_establish(callbacks_.context);
        }
        catch (...)
        {
            return -1;
        }
    }

    bool tun_builder_persist() override
    {
        return call_bool(callbacks_.tun_builder_persist, true);
    }

    std::vector<std::string> tun_builder_get_local_networks(bool ipv6) override
    {
        if (callbacks_.tun_builder_get_local_networks == nullptr)
            return {};
        LocalNetworksResponse response;
        try
        {
            callbacks_.tun_builder_get_local_networks(callbacks_.context,
                                                       ipv6 ? 1 : 0,
                                                       &response,
                                                       complete_local_networks);
        }
        catch (...)
        {
            return {};
        }
        return response.networks;
    }

    void tun_builder_establish_lite() override
    {
        if (callbacks_.tun_builder_establish_lite != nullptr)
        {
            try
            {
                callbacks_.tun_builder_establish_lite(callbacks_.context);
            }
            catch (...)
            {
            }
        }
    }

    void tun_builder_teardown(bool disconnect) override
    {
        if (callbacks_.tun_builder_teardown != nullptr)
        {
            try
            {
                callbacks_.tun_builder_teardown(callbacks_.context,
                                                disconnect ? 1 : 0);
            }
            catch (...)
            {
            }
        }
    }

#ifdef ENABLE_OVPNDCO
    bool tun_builder_dco_available() override
    {
        return call_bool(callbacks_.tun_builder_dco_available, false);
    }

    int tun_builder_dco_enable(const std::string &device_name) override
    {
        if (callbacks_.tun_builder_dco_enable == nullptr)
            return -1;
        try
        {
            return callbacks_.tun_builder_dco_enable(
                callbacks_.context, view_of(device_name));
        }
        catch (...)
        {
            return -1;
        }
    }

    void tun_builder_dco_new_peer(uint32_t peer_id,
                                  uint32_t transport_fd,
                                  struct sockaddr *sa,
                                  socklen_t,
                                  openvpn::IPv4::Addr &vpn4,
                                  openvpn::IPv6::Addr &vpn6) override
    {
        if (callbacks_.tun_builder_dco_new_peer == nullptr || sa == nullptr)
            return;
        try
        {
            const std::string remote_ip = openvpn::IP::Addr::from_sockaddr(sa).to_string();
            uint16_t remote_port = 0;
            if (sa->sa_family == AF_INET)
                remote_port = ntohs(reinterpret_cast<sockaddr_in *>(sa)->sin_port);
            else if (sa->sa_family == AF_INET6)
                remote_port = ntohs(reinterpret_cast<sockaddr_in6 *>(sa)->sin6_port);
            const std::string vpn_ipv4 = vpn4.to_string();
            const std::string vpn_ipv6 = vpn6.to_string();
            const ovpn_dco_peer_view peer{
                peer_id,
                transport_fd,
                view_of(remote_ip),
                remote_port,
                view_of(vpn_ipv4),
                view_of(vpn_ipv6),
            };
            callbacks_.tun_builder_dco_new_peer(callbacks_.context, &peer);
        }
        catch (...)
        {
        }
    }

    void tun_builder_dco_set_peer(uint32_t peer_id,
                                  int keepalive_interval,
                                  int keepalive_timeout) override
    {
        if (callbacks_.tun_builder_dco_set_peer != nullptr)
        {
            try
            {
                callbacks_.tun_builder_dco_set_peer(callbacks_.context,
                                                    peer_id,
                                                    keepalive_interval,
                                                    keepalive_timeout);
            }
            catch (...)
            {
            }
        }
    }

    void tun_builder_dco_del_peer(uint32_t peer_id) override
    {
        call_dco_peer(callbacks_.tun_builder_dco_del_peer, peer_id);
    }

    void tun_builder_dco_get_peer(uint32_t peer_id, bool synchronous) override
    {
        if (callbacks_.tun_builder_dco_get_peer != nullptr)
        {
            try
            {
                callbacks_.tun_builder_dco_get_peer(
                    callbacks_.context, peer_id, synchronous ? 1 : 0);
            }
            catch (...)
            {
            }
        }
    }

    void tun_builder_dco_new_key(unsigned int key_slot,
                                 const openvpn::KoRekey::KeyConfig *key) override
    {
        if (callbacks_.tun_builder_dco_new_key == nullptr || key == nullptr)
            return;
        try
        {
            const ovpn_dco_key_config_view view{
                {
                    key->encrypt.cipher_key,
                    key->encrypt.cipher_key_size,
                    key->encrypt.nonce_tail,
                    sizeof(key->encrypt.nonce_tail),
                },
                {
                    key->decrypt.cipher_key,
                    key->decrypt.cipher_key_size,
                    key->decrypt.nonce_tail,
                    sizeof(key->decrypt.nonce_tail),
                },
                key->key_id,
                key->remote_peer_id,
                key->cipher_alg,
            };
            callbacks_.tun_builder_dco_new_key(
                callbacks_.context, key_slot, &view);
        }
        catch (...)
        {
        }
    }

    void tun_builder_dco_swap_keys(uint32_t peer_id) override
    {
        call_dco_peer(callbacks_.tun_builder_dco_swap_keys, peer_id);
    }

    void tun_builder_dco_del_key(uint32_t peer_id, unsigned int key_slot) override
    {
        if (callbacks_.tun_builder_dco_del_key != nullptr)
        {
            try
            {
                callbacks_.tun_builder_dco_del_key(
                    callbacks_.context, peer_id, key_slot);
            }
            catch (...)
            {
            }
        }
    }

    void tun_builder_dco_establish() override
    {
        if (callbacks_.tun_builder_dco_establish != nullptr)
        {
            try
            {
                callbacks_.tun_builder_dco_establish(callbacks_.context);
            }
            catch (...)
            {
            }
        }
    }
#endif

    void clock_tick() override
    {
        if (callbacks_.clock_tick != nullptr)
        {
            try
            {
                callbacks_.clock_tick(callbacks_.context);
            }
            catch (...)
            {
            }
        }
    }

  private:
    template <typename Callback, typename... Args>
    bool call_bool(Callback callback, bool default_value, Args... args)
    {
        if (callback == nullptr)
            return default_value;
        try
        {
            return callback(callbacks_.context, args...) != 0;
        }
        catch (...)
        {
            return false;
        }
    }

#ifdef ENABLE_OVPNDCO
    void call_dco_peer(ovpn_tun_builder_dco_peer_fn callback, uint32_t peer_id)
    {
        if (callback != nullptr)
        {
            try
            {
                callback(callbacks_.context, peer_id);
            }
            catch (...)
            {
            }
        }
    }
#endif

    ovpn_callbacks callbacks_;
    void *connect_started_context_ = nullptr;
    ovpn_connect_started_fn connect_started_ = nullptr;
};

} // namespace

struct ovpn_client
{
    explicit ovpn_client(ovpn_callbacks callbacks)
        : implementation(callbacks)
    {
    }

    RustClient implementation;
};

#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
namespace {
template <typename Function>
int32_t post_external_transport(const ovpn_external_transport_handle *handle,
                                Function function)
{
    if (handle == nullptr || !handle->state)
        return 0;
    const auto state = handle->state;
    std::lock_guard<std::mutex> lock(state->mutex);
    if (state->io == nullptr || state->parent == nullptr)
        return 0;
    openvpn_io::post(*state->io,
                     [state, function = std::move(function)]() mutable
                     {
                         openvpn::TransportClientParent *parent = nullptr;
                         {
                             std::lock_guard<std::mutex> inner_lock(state->mutex);
                             parent = state->parent;
                         }
                         if (parent != nullptr)
                             function(*parent);
                     });
    return 1;
}

template <typename Function, typename Result>
Result query_external_transport(const ovpn_external_transport_handle *handle,
                                Result default_value,
                                Function function)
{
    if (handle == nullptr || !handle->state)
        return default_value;
    std::lock_guard<std::mutex> lock(handle->state->mutex);
    if (handle->state->parent == nullptr)
        return default_value;
    return function(*handle->state->parent);
}
} // namespace
#endif

#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
namespace {
template <typename Function>
int32_t post_external_tun(const ovpn_external_tun_handle *handle,
                          Function function)
{
    if (handle == nullptr || !handle->state)
        return 0;
    const auto state = handle->state;
    std::lock_guard<std::recursive_mutex> lock(state->mutex);
    if (state->io == nullptr || state->parent == nullptr)
        return 0;
    // External TUN start is invoked on Core's I/O thread and platform
    // implementations commonly report connected() before returning. Dispatch
    // preserves that ordering there, while still queueing calls made by a
    // packet-reader thread. Always posting allowed an already-received data
    // packet to overtake connected() and Core rejected it as "tun: not connected".
    openvpn_io::dispatch(*state->io,
                         [state, function = std::move(function)]() mutable
                         {
                             openvpn::TunClientParent *parent = nullptr;
                             {
                                 std::lock_guard<std::recursive_mutex> inner_lock(state->mutex);
                                 parent = state->parent;
                             }
                             if (parent != nullptr)
                                 function(*parent);
                         });
    return 1;
}
} // namespace
#endif

extern "C" {

void ovpn_rust_backend_register(const ovpn_rust_backend_vtable *callbacks)
{
    if (callbacks == nullptr)
        return;
    std::atomic_store(
        &rust_backend,
        std::make_shared<const ovpn_rust_backend_vtable>(*callbacks));
}

int32_t ovpn_rust_backend_resolve(
    const uint8_t *host,
    size_t host_len,
    ovpn_rust_ip_address *addresses,
    size_t addresses_capacity,
    size_t *addresses_len)
{
    const auto callbacks = std::atomic_load(&rust_backend);
    if (!callbacks || callbacks->resolve == nullptr)
        return 0;
    try
    {
        return callbacks->resolve(
            host, host_len, addresses, addresses_capacity, addresses_len);
    }
    catch (...)
    {
        return 0;
    }
}

const ovpn_rust_backend_vtable *ovpn_rust_backend_callbacks()
{
    const auto callbacks = std::atomic_load(&rust_backend);
    return callbacks.get();
}

void ovpn_owned_string_free(ovpn_owned_string value)
{
    std::free(value.data);
}

void ovpn_merge_config_free(ovpn_merge_config value)
{
    ovpn_owned_string_free(value.status);
    ovpn_owned_string_free(value.error_text);
    ovpn_owned_string_free(value.basename);
    ovpn_owned_string_free(value.profile_content);
    if (value.ref_path_list != nullptr)
    {
        for (size_t i = 0; i < value.ref_path_list_len; ++i)
            ovpn_owned_string_free(value.ref_path_list[i]);
        std::free(value.ref_path_list);
    }
}

void ovpn_i64_array_free(ovpn_i64_array value)
{
    std::free(value.data);
}

ovpn_external_transport_handle *ovpn_external_transport_handle_retain(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    if (handle == nullptr || !handle->state)
        return nullptr;
    return new (std::nothrow) ovpn_external_transport_handle(handle->state);
#else
    (void)handle;
    return nullptr;
#endif
}

void ovpn_external_transport_handle_free(ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    delete handle;
#else
    (void)handle;
#endif
}

int32_t ovpn_external_transport_receive(
    const ovpn_external_transport_handle *handle,
    const uint8_t *data,
    size_t len)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    if (data == nullptr && len != 0)
        return 0;
    openvpn::BufferAllocated packet(len, 0);
    if (len != 0)
        packet.write(data, len);
    return post_external_transport(
        handle,
        [packet = std::move(packet)](openvpn::TransportClientParent &parent) mutable
        { parent.transport_recv(packet); });
#else
    (void)handle;
    (void)data;
    (void)len;
    return 0;
#endif
}

int32_t ovpn_external_transport_needs_send(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return post_external_transport(
        handle,
        [](openvpn::TransportClientParent &parent) { parent.transport_needs_send(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_error(
    const ovpn_external_transport_handle *handle,
    int32_t error_code,
    ovpn_string_view message)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    const std::string text = string_from(message);
    return post_external_transport(
        handle,
        [error_code, text](openvpn::TransportClientParent &parent)
        {
            parent.transport_error(static_cast<openvpn::Error::Type>(error_code), text);
        });
#else
    (void)handle;
    (void)error_code;
    (void)message;
    return 0;
#endif
}

int32_t ovpn_external_transport_proxy_error(
    const ovpn_external_transport_handle *handle,
    int32_t error_code,
    ovpn_string_view message)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    const std::string text = string_from(message);
    return post_external_transport(
        handle,
        [error_code, text](openvpn::TransportClientParent &parent)
        { parent.proxy_error(static_cast<openvpn::Error::Type>(error_code), text); });
#else
    (void)handle;
    (void)error_code;
    (void)message;
    return 0;
#endif
}

int32_t ovpn_external_transport_pre_resolve(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return post_external_transport(
        handle,
        [](openvpn::TransportClientParent &parent) { parent.transport_pre_resolve(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_wait_proxy(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return post_external_transport(
        handle,
        [](openvpn::TransportClientParent &parent) { parent.transport_wait_proxy(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_wait(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return post_external_transport(
        handle,
        [](openvpn::TransportClientParent &parent) { parent.transport_wait(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_connecting(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return post_external_transport(
        handle,
        [](openvpn::TransportClientParent &parent) { parent.transport_connecting(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_is_openvpn_protocol(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return query_external_transport(
               handle,
               false,
               [](openvpn::TransportClientParent &parent)
               { return parent.transport_is_openvpn_protocol(); })
               ? 1
               : 0;
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_is_keepalive_enabled(
    const ovpn_external_transport_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    return query_external_transport(
               handle,
               false,
               [](openvpn::TransportClientParent &parent)
               { return parent.is_keepalive_enabled(); })
               ? 1
               : 0;
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_transport_disable_keepalive(
    const ovpn_external_transport_handle *handle,
    uint32_t *ping_seconds,
    uint32_t *timeout_seconds)
{
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    if (ping_seconds == nullptr || timeout_seconds == nullptr)
        return 0;
    return query_external_transport(
               handle,
               false,
               [ping_seconds, timeout_seconds](openvpn::TransportClientParent &parent)
               {
                   parent.disable_keepalive(*ping_seconds, *timeout_seconds);
                   return true;
               })
               ? 1
               : 0;
#else
    (void)handle;
    (void)ping_seconds;
    (void)timeout_seconds;
    return 0;
#endif
}

ovpn_external_tun_handle *ovpn_external_tun_handle_retain(
    const ovpn_external_tun_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    if (handle == nullptr || !handle->state)
        return nullptr;
    return new (std::nothrow) ovpn_external_tun_handle(handle->state);
#else
    (void)handle;
    return nullptr;
#endif
}

void ovpn_external_tun_handle_free(ovpn_external_tun_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    delete handle;
#else
    (void)handle;
#endif
}

int32_t ovpn_external_tun_receive(const ovpn_external_tun_handle *handle,
                                  const uint8_t *data,
                                  size_t len)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    if ((data == nullptr && len != 0)
        || handle == nullptr
        || !handle->state)
        return 0;
    const auto state = handle->state;
    openvpn::BufferAllocated packet;
    try
    {
        packet = len != 0
                     ? state->read_tun_frame.copy_by_value(data, len)
                     : state->read_tun_frame.alloc();
    }
    catch (...)
    {
        return 0;
    }
    return post_external_tun(
        handle,
        [packet = std::move(packet)](openvpn::TunClientParent &parent) mutable
        { parent.tun_recv(packet); });
#else
    (void)handle;
    (void)data;
    (void)len;
    return 0;
#endif
}

int32_t ovpn_external_tun_error(const ovpn_external_tun_handle *handle,
                                int32_t error_code,
                                ovpn_string_view message)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    const std::string text = string_from(message);
    return post_external_tun(
        handle,
        [error_code, text](openvpn::TunClientParent &parent)
        { parent.tun_error(static_cast<openvpn::Error::Type>(error_code), text); });
#else
    (void)handle;
    (void)error_code;
    (void)message;
    return 0;
#endif
}

int32_t ovpn_external_tun_pre_tun_config(
    const ovpn_external_tun_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    return post_external_tun(
        handle,
        [](openvpn::TunClientParent &parent) { parent.tun_pre_tun_config(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_tun_pre_route_config(
    const ovpn_external_tun_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    return post_external_tun(
        handle,
        [](openvpn::TunClientParent &parent) { parent.tun_pre_route_config(); });
#else
    (void)handle;
    return 0;
#endif
}

int32_t ovpn_external_tun_connected(const ovpn_external_tun_handle *handle)
{
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    return post_external_tun(
        handle,
        [](openvpn::TunClientParent &parent) { parent.tun_connected(); });
#else
    (void)handle;
    return 0;
#endif
}

void ovpn_status_free(ovpn_status value)
{
    ovpn_owned_string_free(value.status);
    ovpn_owned_string_free(value.message);
}

void ovpn_eval_config_free(ovpn_eval_config value)
{
    ovpn_owned_string_free(value.message);
    ovpn_owned_string_free(value.userlocked_username);
    ovpn_owned_string_free(value.profile_name);
    ovpn_owned_string_free(value.friendly_name);
    ovpn_owned_string_free(value.vpn_ca);
    ovpn_owned_string_free(value.static_challenge);
    ovpn_owned_string_free(value.remote_host);
    ovpn_owned_string_free(value.remote_port);
    ovpn_owned_string_free(value.remote_proto);
    ovpn_owned_string_free(value.windows_driver);
    ovpn_owned_string_free(value.dco_incompatibility_reason);
    if (value.server_list != nullptr)
    {
        for (size_t i = 0; i < value.server_list_len; ++i)
        {
            ovpn_owned_string_free(value.server_list[i].server);
            ovpn_owned_string_free(value.server_list[i].friendly_name);
        }
        std::free(value.server_list);
    }
}

void ovpn_connection_info_free(ovpn_connection_info value)
{
    ovpn_owned_string_free(value.user);
    ovpn_owned_string_free(value.server_host);
    ovpn_owned_string_free(value.server_port);
    ovpn_owned_string_free(value.server_proto);
    ovpn_owned_string_free(value.server_ip);
    ovpn_owned_string_free(value.vpn_ip4);
    ovpn_owned_string_free(value.vpn_ip6);
    ovpn_owned_string_free(value.vpn_mtu);
    ovpn_owned_string_free(value.gateway_ip4);
    ovpn_owned_string_free(value.gateway_ip6);
    ovpn_owned_string_free(value.client_ip);
    ovpn_owned_string_free(value.tun_name);
}

void ovpn_session_token_free(ovpn_session_token value)
{
    ovpn_owned_string_free(value.username);
    ovpn_owned_string_free(value.session_id);
}

void ovpn_dynamic_challenge_free(ovpn_dynamic_challenge value)
{
    ovpn_owned_string_free(value.challenge);
    ovpn_owned_string_free(value.state_id);
}

ovpn_owned_string ovpn_platform(void)
{
    try
    {
        return own(OpenVPNClientHelper::platform());
    }
    catch (...)
    {
        return {};
    }
}

ovpn_capabilities ovpn_get_capabilities(void)
{
    ovpn_capabilities capabilities{};
#ifdef USE_TUN_BUILDER
    capabilities.tun_builder = 1;
#endif
#if defined(ENABLE_OVPNDCO) || defined(ENABLE_OVPNDCOWIN)
    capabilities.dco = 1;
#endif
#if defined(ENABLE_OVPNDCO) && defined(USE_TUN_BUILDER)
    capabilities.dco_tun_builder = 1;
#endif
#ifdef OPENVPN_GREMLIN
    capabilities.gremlin = 1;
#endif
#ifdef OPENVPN_EXTERNAL_TUN_FACTORY
    capabilities.external_tun = 1;
#endif
#ifdef OPENVPN_EXTERNAL_TRANSPORT_FACTORY
    capabilities.external_transport = 1;
#endif
#ifdef PRIVATE_TUNNEL_PROXY
    capabilities.private_tunnel_proxy = 1;
#endif
    return capabilities;
}

int32_t ovpn_error_code_tun(void)
{
    return static_cast<int32_t>(openvpn::Error::TUN_ERROR);
}

int32_t ovpn_error_code_transport(void)
{
    return static_cast<int32_t>(openvpn::Error::TRANSPORT_ERROR);
}

int32_t ovpn_error_code_proxy(void)
{
    return static_cast<int32_t>(openvpn::Error::PROXY_ERROR);
}

ovpn_owned_string ovpn_copyright(void)
{
    try
    {
        return own(OpenVPNClientHelper::copyright());
    }
    catch (...)
    {
        return {};
    }
}

int64_t ovpn_max_profile_size(void)
{
    return static_cast<int64_t>(OpenVPNClientHelper::max_profile_size());
}

ovpn_owned_string ovpn_crypto_self_test(void)
{
    try
    {
        OpenVPNClientHelper helper;
        return own(helper.crypto_self_test());
    }
    catch (const std::exception &error)
    {
        return own(error.what());
    }
    catch (...)
    {
        return own("unknown exception during OpenVPN crypto self-test");
    }
}

ovpn_dynamic_challenge ovpn_parse_dynamic_challenge(ovpn_string_view cookie)
{
    ovpn_dynamic_challenge result{};
    try
    {
        // ChallengeResponse decodes the embedded username through Core's
        // process-wide Base64 singleton. OpenVPNClientHelper owns the matching
        // InitProcess lifetime; without it valid cookies dereference a null
        // Base64 pointer while malformed cookies appear to work.
        OpenVPNClientHelper helper;
        DynamicChallenge challenge;
        result.defined = helper.parse_dynamic_challenge(string_from(cookie), challenge)
                             ? 1
                             : 0;
        if (result.defined)
        {
            result.challenge = own(challenge.challenge);
            result.echo = challenge.echo ? 1 : 0;
            result.response_required = challenge.responseRequired ? 1 : 0;
            result.state_id = own(challenge.stateID);
        }
    }
    catch (...)
    {
    }
    return result;
}

ovpn_merge_config ovpn_merge_config_path(ovpn_string_view path,
                                         int32_t follow_references)
{
    try
    {
        OpenVPNClientHelper helper;
        return merge_config_from(
            helper.merge_config(string_from(path), follow_references != 0));
    }
    catch (const std::exception &error)
    {
        MergeConfig result;
        result.status = "PROFILE_MERGE_EXCEPTION";
        result.errorText = error.what();
        return merge_config_from(result);
    }
    catch (...)
    {
        MergeConfig result;
        result.status = "PROFILE_MERGE_EXCEPTION";
        result.errorText = "unknown exception while merging OpenVPN profile";
        return merge_config_from(result);
    }
}

ovpn_merge_config ovpn_merge_config_string(ovpn_string_view content)
{
    try
    {
        OpenVPNClientHelper helper;
        return merge_config_from(helper.merge_config_string(string_from(content)));
    }
    catch (const std::exception &error)
    {
        MergeConfig result;
        result.status = "PROFILE_MERGE_EXCEPTION";
        result.errorText = error.what();
        return merge_config_from(result);
    }
    catch (...)
    {
        MergeConfig result;
        result.status = "PROFILE_MERGE_EXCEPTION";
        result.errorText = "unknown exception while merging OpenVPN profile";
        return merge_config_from(result);
    }
}

ovpn_eval_config ovpn_eval_config_static(const ovpn_config *config)
{
    if (config == nullptr)
    {
        EvalConfig error;
        error.error = true;
        error.message = "OpenVPN config pointer is null";
        return evaluation_from(error);
    }
    try
    {
        OpenVPNClientHelper helper;
        return evaluation_from(helper.eval_config(config_from(*config)));
    }
    catch (const std::exception &error)
    {
        EvalConfig result;
        result.error = true;
        result.message = error.what();
        return evaluation_from(result);
    }
    catch (...)
    {
        EvalConfig result;
        result.error = true;
        result.message = "unknown exception while evaluating OpenVPN config";
        return evaluation_from(result);
    }
}

ovpn_client *ovpn_client_new(ovpn_callbacks callbacks, ovpn_status *status)
{
    if (status != nullptr)
        *status = {};
    try
    {
        return new ovpn_client(callbacks);
    }
    catch (const std::exception &error)
    {
        if (status != nullptr)
            *status = error_status(error.what());
    }
    catch (...)
    {
        if (status != nullptr)
            *status = error_status("unknown exception while creating OpenVPN client");
    }
    return nullptr;
}

void ovpn_client_free(ovpn_client *client)
{
    delete client;
}

ovpn_eval_config ovpn_client_eval_config(ovpn_client *client, const ovpn_config *config)
{
    if (client == nullptr || config == nullptr)
    {
        EvalConfig error;
        error.error = true;
        error.message = client == nullptr ? "OpenVPN client pointer is null"
                                          : "OpenVPN config pointer is null";
        return evaluation_from(error);
    }
    try
    {
        return evaluation_from(client->implementation.eval_config(config_from(*config)));
    }
    catch (const std::exception &error)
    {
        EvalConfig result;
        result.error = true;
        result.message = error.what();
        return evaluation_from(result);
    }
    catch (...)
    {
        EvalConfig result;
        result.error = true;
        result.message = "unknown exception while evaluating OpenVPN config";
        return evaluation_from(result);
    }
}

ovpn_status ovpn_client_provide_creds(ovpn_client *client,
                                      const ovpn_credentials *credentials)
{
    if (client == nullptr)
        return null_client_status();
    if (credentials == nullptr)
        return error_status("OpenVPN credentials pointer is null");
    try
    {
        return status_from(client->implementation.provide_creds(credentials_from(*credentials)));
    }
    catch (const std::exception &error)
    {
        return error_status(error.what());
    }
    catch (...)
    {
        return error_status("unknown exception while providing OpenVPN credentials");
    }
}

ovpn_status ovpn_client_connect(ovpn_client *client)
{
    return ovpn_client_connect_started(client, nullptr, nullptr);
}

ovpn_status ovpn_client_connect_started(ovpn_client *client,
                                        void *started_context,
                                        ovpn_connect_started_fn started)
{
    if (client == nullptr)
        return null_client_status();
    client->implementation.set_connect_started(started_context, started);
    try
    {
        const auto result = client->implementation.connect();
        client->implementation.notify_connect_started();
        return status_from(result);
    }
    catch (const std::exception &error)
    {
        client->implementation.notify_connect_started();
        return error_status(error.what());
    }
    catch (...)
    {
        client->implementation.notify_connect_started();
        return error_status("unknown exception while connecting OpenVPN client");
    }
}

ovpn_status ovpn_client_callback_self_test(ovpn_client *client)
{
    if (client == nullptr)
        return null_client_status();
    try
    {
        client->implementation.callback_self_test();
        Status status;
        status.status = "CALLBACK_SELF_TEST_OK";
        return status_from(status);
    }
    catch (const std::exception &error)
    {
        return error_status(error.what());
    }
    catch (...)
    {
        return error_status("unknown exception during callback self-test");
    }
}

ovpn_status ovpn_client_start_cert_check(ovpn_client *client,
                                         ovpn_string_view client_cert,
                                         ovpn_string_view client_key,
                                         ovpn_string_view ca,
                                         int32_t has_ca)
{
    if (client == nullptr)
        return null_client_status();
    try
    {
        const std::string ca_value = string_from(ca);
        client->implementation.start_cert_check(
            string_from(client_cert),
            string_from(client_key),
            has_ca != 0 ? std::optional<const std::string>(ca_value) : std::nullopt);
        return {};
    }
    catch (const std::exception &error)
    {
        return error_status(error.what());
    }
    catch (...)
    {
        return error_status("unknown exception while starting certificate check");
    }
}

ovpn_status ovpn_client_start_cert_check_epki(ovpn_client *client,
                                              ovpn_string_view alias,
                                              ovpn_string_view ca,
                                              int32_t has_ca)
{
    if (client == nullptr)
        return null_client_status();
    try
    {
        const std::string ca_value = string_from(ca);
        client->implementation.start_cert_check_epki(
            string_from(alias),
            has_ca != 0 ? std::optional<const std::string>(ca_value) : std::nullopt);
        return {};
    }
    catch (const std::exception &error)
    {
        return error_status(error.what());
    }
    catch (...)
    {
        return error_status("unknown exception while starting external PKI certificate check");
    }
}

void ovpn_client_stop(ovpn_client *client)
{
    if (client != nullptr)
    {
        try
        {
            client->implementation.stop();
        }
        catch (...)
        {
        }
    }
}

void ovpn_client_pause(ovpn_client *client, ovpn_string_view reason)
{
    if (client != nullptr)
    {
        try
        {
            client->implementation.pause(string_from(reason));
        }
        catch (...)
        {
        }
    }
}

void ovpn_client_resume(ovpn_client *client)
{
    if (client != nullptr)
    {
        try
        {
            client->implementation.resume();
        }
        catch (...)
        {
        }
    }
}

void ovpn_client_reconnect(ovpn_client *client, int32_t seconds)
{
    if (client != nullptr)
    {
        try
        {
            client->implementation.reconnect(seconds);
        }
        catch (...)
        {
        }
    }
}

void ovpn_client_post_cc_msg(ovpn_client *client, ovpn_string_view message)
{
    if (client != nullptr)
    {
        try
        {
            client->implementation.post_cc_msg(string_from(message));
        }
        catch (...)
        {
        }
    }
}

void ovpn_client_send_app_control_channel_msg(ovpn_client *client,
                                              ovpn_string_view protocol,
                                              ovpn_string_view message)
{
    if (client != nullptr)
    {
        try
        {
            client->implementation.send_app_control_channel_msg(
                string_from(protocol), string_from(message));
        }
        catch (...)
        {
        }
    }
}

ovpn_connection_info ovpn_client_connection_info(ovpn_client *client)
{
    if (client == nullptr)
        return {};
    try
    {
        return connection_info_from(client->implementation.connection_info());
    }
    catch (...)
    {
        return {};
    }
}

ovpn_session_token ovpn_client_session_token(ovpn_client *client)
{
    ovpn_session_token result{};
    if (client == nullptr)
        return result;
    try
    {
        SessionToken token;
        result.defined = client->implementation.session_token(token) ? 1 : 0;
        if (result.defined)
        {
            result.username = own(token.username);
            result.session_id = own(token.session_id);
        }
    }
    catch (...)
    {
    }
    return result;
}

int32_t ovpn_client_stats_count(void)
{
    return OpenVPNClient::stats_n();
}

ovpn_owned_string ovpn_client_stats_name(int32_t index)
{
    try
    {
        return own(OpenVPNClient::stats_name(index));
    }
    catch (...)
    {
        return {};
    }
}

int64_t ovpn_client_stats_value(const ovpn_client *client, int32_t index)
{
    if (client == nullptr)
        return 0;
    try
    {
        return client->implementation.stats_value(index);
    }
    catch (...)
    {
        return 0;
    }
}

ovpn_i64_array ovpn_client_stats_bundle(const ovpn_client *client)
{
    if (client == nullptr)
        return {};
    try
    {
        const auto values = client->implementation.stats_bundle();
        if (values.empty())
            return {};
        auto *data = static_cast<int64_t *>(std::malloc(values.size() * sizeof(int64_t)));
        if (data == nullptr)
            return {};
        for (size_t i = 0; i < values.size(); ++i)
            data[i] = values[i];
        return {data, values.size()};
    }
    catch (...)
    {
        return {};
    }
}

ovpn_interface_stats ovpn_client_tun_stats(const ovpn_client *client)
{
    if (client == nullptr)
        return {};
    try
    {
        const InterfaceStats stats = client->implementation.tun_stats();
        return {stats.bytesIn,
                stats.packetsIn,
                stats.errorsIn,
                stats.bytesOut,
                stats.packetsOut,
                stats.errorsOut};
    }
    catch (...)
    {
        return {};
    }
}

ovpn_transport_stats ovpn_client_transport_stats(const ovpn_client *client)
{
    if (client == nullptr)
        return {};
    try
    {
        const TransportStats stats = client->implementation.transport_stats();
        return {stats.bytesIn,
                stats.bytesOut,
                stats.packetsIn,
                stats.packetsOut,
                stats.lastPacketReceived};
    }
    catch (...)
    {
        return {};
    }
}

} // extern "C"
