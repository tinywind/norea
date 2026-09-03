// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once

#include "rust_crypto.hpp"
#include "wrapper.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include <openvpn/common/base64.hpp>
#include <openvpn/common/exception.hpp>
#include <openvpn/common/options.hpp>
#include <openvpn/common/string.hpp>
#include <openvpn/frame/frame.hpp>
#include <openvpn/pki/pktype.hpp>
#include <openvpn/ssl/sslapi.hpp>
#include <openvpn/ssl/sslconsts.hpp>
#include <openvpn/ssl/tls_cert_profile.hpp>
#include <openvpn/ssl/tlsver.hpp>
#include <openvpn/ssl/verify_x509_name.hpp>

namespace openvpn {

namespace rust_tls_detail {

inline ovpn_string_view view(const std::string &value)
{
    return {
        reinterpret_cast<const std::uint8_t *>(value.data()),
        value.size(),
    };
}

inline std::string error_text(const std::array<std::uint8_t, 1024> &error)
{
    const auto end = std::find(error.begin(), error.end(), std::uint8_t(0));
    return {
        reinterpret_cast<const char *>(error.data()),
        static_cast<std::size_t>(end - error.begin()),
    };
}

inline std::vector<std::string> split_certificates(const std::string &pem)
{
    static constexpr char begin_marker[] = "-----BEGIN CERTIFICATE-----";
    static constexpr char end_marker[] = "-----END CERTIFICATE-----";
    std::vector<std::string> result;
    std::size_t cursor = 0;
    while (true)
    {
        const auto begin = pem.find(begin_marker, cursor);
        if (begin == std::string::npos)
            break;
        const auto end = pem.find(end_marker, begin);
        if (end == std::string::npos)
            break;
        const auto after = end + sizeof(end_marker) - 1;
        result.push_back(pem.substr(begin, after - begin) + '\n');
        cursor = after;
    }
    return result;
}

inline std::string join_key_usages(const std::vector<unsigned int> &values)
{
    std::ostringstream output;
    for (std::size_t index = 0; index < values.size(); ++index)
    {
        if (index != 0)
            output << ',';
        output << values[index];
    }
    return output.str();
}

inline void validate_pem(const std::uint32_t kind,
                         const std::string &value,
                         const std::string &password,
                         const char *description)
{
    const auto &callbacks = rust_backend();
    if (callbacks.tls_validate == nullptr)
        throw Exception("Rust TLS PEM validator is unavailable");
    std::array<std::uint8_t, 1024> error{};
    if (!callbacks.tls_validate(
            kind,
            view(value),
            view(password),
            error.data(),
            error.size()))
    {
        OPENVPN_THROW(
            Exception,
            "invalid " << description << ": " << error_text(error));
    }
}

inline ptrdiff_t external_sign(void *context,
                               std::uint16_t signature_scheme,
                               const std::uint8_t *message,
                               std::size_t message_len,
                               std::uint8_t *signature,
                               std::size_t signature_capacity);

} // namespace rust_tls_detail

class RustTLSContext : public SSLFactoryAPI
{
  public:
    class Config : public SSLConfigAPI
    {
        friend class RustTLSContext;
        friend ptrdiff_t rust_tls_detail::external_sign(
            void *,
            std::uint16_t,
            const std::uint8_t *,
            std::size_t,
            std::uint8_t *,
            std::size_t);

      public:
        typedef RCPtr<Config> Ptr;

        Config()
            : external_pki(nullptr),
              session_ticket_handler(nullptr),
              sni_handler(nullptr),
              cn_reject_handler(nullptr),
              ssl_debug_level(0),
              flags(0),
              ns_cert_type(NSCert::NONE),
              remote_cert_tls(KUParse::TLS_WEB_NONE),
              verify_x509_name_mode(VerifyX509Name::VERIFY_X509_NONE),
              tls_version_min(TLSVersion::Type::UNDEF),
              tls_version_max(TLSVersion::Type::UNDEF),
              tls_cert_profile(TLSCertProfile::UNDEF),
              local_cert_enabled(true),
              client_session_tickets(false)
        {
        }

        SSLFactoryAPI::Ptr new_factory() override
        {
            return SSLFactoryAPI::Ptr(new RustTLSContext(this));
        }

        void set_mode(const Mode &value) override
        {
            mode = value;
        }

        const Mode &get_mode() const override
        {
            return mode;
        }

        void set_external_pki_callback(ExternalPKIBase *callback,
                                       const std::string &alias) override
        {
            external_pki = callback;
            external_pki_alias = alias;
        }

        void set_session_ticket_handler(TLSSessionTicketBase *handler) override
        {
            session_ticket_handler = handler;
        }

        void set_client_session_tickets(const bool value) override
        {
            client_session_tickets = value;
        }

        void enable_legacy_algorithms(const bool) override
        {
            // rustls intentionally exposes no legacy TLS provider.
        }

        void set_sni_handler(SNI::HandlerBase *handler) override
        {
            sni_handler = handler;
        }

        void set_sni_name(const std::string &value) override
        {
            sni_name = value;
        }

        void set_private_key_password(const std::string &value) override
        {
            private_key_password = value;
        }

        void set_cn_reject_handler(CommonNameReject *handler) override
        {
            cn_reject_handler = handler;
        }

        void load_ca(const std::string &value, bool) override
        {
            rust_tls_detail::validate_pem(2, value, {}, "CA certificate list");
            ca = value;
        }

        void load_crl(const std::string &value) override
        {
            rust_tls_detail::validate_pem(4, value, {}, "certificate revocation list");
            crl = value;
        }

        void load_cert(const std::string &value) override
        {
            rust_tls_detail::validate_pem(1, value, {}, "client certificate");
            cert = value;
            extra_certs.clear();
        }

        void load_cert(const std::string &value,
                       const std::string &extra) override
        {
            load_cert(value);
            if (!extra.empty())
            {
                rust_tls_detail::validate_pem(
                    2, extra, {}, "supporting certificate list");
                extra_certs = extra;
            }
        }

        void load_private_key(const std::string &value) override
        {
            rust_tls_detail::validate_pem(
                3, value, private_key_password, "private key");
            private_key = value;
        }

        void load_dh(const std::string &value) override
        {
            rust_tls_detail::validate_pem(5, value, {}, "DH parameters");
            dh = value;
        }

        std::string extract_ca() const override
        {
            return ca;
        }

        std::string extract_crl() const override
        {
            return crl;
        }

        std::string extract_cert() const override
        {
            return cert;
        }

        std::vector<std::string> extract_extra_certs() const override
        {
            return rust_tls_detail::split_certificates(extra_certs);
        }

        std::string extract_private_key() const override
        {
            return private_key;
        }

        std::string extract_dh() const override
        {
            return dh;
        }

        PKType::Type private_key_type() const override
        {
            std::uint32_t type = 0;
            std::size_t bits = 0;
            key_info(type, bits);
            return static_cast<PKType::Type>(type);
        }

        std::size_t private_key_length() const override
        {
            std::uint32_t type = 0;
            std::size_t bits = 0;
            key_info(type, bits);
            return bits;
        }

        void set_frame(const Frame::Ptr &value) override
        {
            frame = value;
        }

        void set_debug_level(const int value) override
        {
            ssl_debug_level = value;
        }

        void set_flags(const unsigned int value) override
        {
            flags = value;
        }

        void set_ns_cert_type(const NSCert::Type value) override
        {
            ns_cert_type = value;
        }

        void set_remote_cert_tls(const KUParse::TLSWebType value) override
        {
            remote_cert_tls = value;
            KUParse::remote_cert_tls(value, ku, eku);
        }

        void set_tls_remote(const std::string &value) override
        {
            tls_remote = value;
        }

        void set_tls_version_min(const TLSVersion::Type value) override
        {
            tls_version_min = value;
        }

        void set_tls_version_max(const TLSVersion::Type value) override
        {
            tls_version_max = value;
        }

        void set_tls_version_min_override(const std::string &value) override
        {
            TLSVersion::apply_override(tls_version_min, value);
        }

        void set_tls_cert_profile(const TLSCertProfile::Type value) override
        {
            tls_cert_profile = value;
        }

        void set_tls_cert_profile_override(const std::string &value) override
        {
            TLSCertProfile::apply_override(tls_cert_profile, value);
        }

        void set_tls_cipher_list(const std::string &value)
        {
            tls_cipher_list = value;
        }

        void set_tls_ciphersuite_list(const std::string &value)
        {
            tls_ciphersuite_list = value;
        }

        void set_tls_groups(const std::string &value)
        {
            tls_groups = value;
        }

        void set_local_cert_enabled(const bool value) override
        {
            local_cert_enabled = value;
        }

        void set_x509_track(X509Track::ConfigSet value) override
        {
            x509_track_config = std::move(value);
        }

        void set_rng(const StrongRandomAPI::Ptr &value) override
        {
            rng = value;
        }

        void load(const OptionList &opt, const unsigned int load_flags) override
        {
            if (load_flags & LF_PARSE_MODE)
                mode = opt.exists("client") ? Mode(Mode::CLIENT)
                                            : Mode(Mode::SERVER);
            if (!mode.is_client())
                throw Exception("Rust TLS backend currently supports OpenVPN client mode");

            if ((load_flags & LF_ALLOW_CLIENT_CERT_NOT_REQUIRED)
                && opt.exists("client-cert-not-required"))
                flags |= SSLConst::NO_VERIFY_PEER;

            const std::string configured_sni = opt.get_optional("sni", 1, 256);
            if (!configured_sni.empty())
                set_sni_name(configured_sni);

            std::string ca_text = opt.cat("ca");
            if (load_flags & LF_RELAY_MODE)
                ca_text += opt.cat("relay-extra-ca");
            if (!ca_text.empty())
                load_ca(ca_text, true);

            const std::string crl_text = opt.cat("crl-verify");
            if (!crl_text.empty())
                load_crl(crl_text);

            if (local_cert_enabled)
            {
                const std::string &cert_text =
                    opt.get("cert", 1, Option::MULTILINE);
                load_cert(cert_text, opt.cat("extra-certs"));
                if (external_pki == nullptr)
                {
                    const std::string &key_text =
                        opt.get("key", 1, Option::MULTILINE);
                    load_private_key(key_text);
                }
            }

            std::string relay_prefix;
            if (load_flags & LF_RELAY_MODE)
                relay_prefix = "relay-";
            ns_cert_type = NSCert::ns_cert_type(opt, relay_prefix);
            KUParse::remote_cert_tls(opt, relay_prefix, ku, eku);
            KUParse::remote_cert_ku(opt, relay_prefix, ku);
            KUParse::remote_cert_eku(opt, relay_prefix, eku);
            tls_remote =
                opt.get_optional(relay_prefix + "tls-remote", 1, 256);
            verify_x509_name.init(opt, relay_prefix);
            verify_x509_name_mode = VerifyX509Name::VERIFY_X509_NONE;
            verify_x509_name_value.clear();
            if (const Option *verify =
                    opt.get_ptr(relay_prefix + "verify-x509-name"))
            {
                verify_x509_name_value = verify->get(1, 256);
                const std::string type =
                    verify->get_default(2, 256, "subject");
                if (type == "subject")
                    verify_x509_name_mode =
                        VerifyX509Name::VERIFY_X509_SUBJECT_DN;
                else if (type == "name")
                    verify_x509_name_mode =
                        VerifyX509Name::VERIFY_X509_SUBJECT_RDN;
                else if (type == "name-prefix")
                    verify_x509_name_mode =
                        VerifyX509Name::VERIFY_X509_SUBJECT_RDN_PREFIX;
            }
            peer_fingerprints = opt.cat("peer-fingerprint");
            if (!peer_fingerprints.empty())
                flags |= SSLConst::VERIFY_PEER_FINGERPRINT;
            tls_version_min = TLSVersion::parse_tls_version_min(
                opt, relay_prefix, TLSVersion::Type::V1_3);
            tls_cert_profile =
                TLSCertProfile::parse_tls_cert_profile(opt, relay_prefix);
            if (opt.exists("tls-cipher"))
                tls_cipher_list =
                    opt.get_optional("tls-cipher", 1, 256);
            if (opt.exists("tls-ciphersuites"))
                tls_ciphersuite_list =
                    opt.get_optional("tls-ciphersuites", 1, 256);
            if (opt.exists("tls-groups"))
                tls_groups = opt.get_optional("tls-groups", 1, 256);
        }

#ifdef OPENVPN_JSON_INTERNAL
        SSLConfigAPI::Ptr json_override(const Json::Value &,
                                        const bool) const override
        {
            throw Exception("Rust TLS JSON override is not implemented");
        }
#endif

        std::string validate_cert(const std::string &value) const override
        {
            rust_tls_detail::validate_pem(1, value, {}, "certificate");
            return value;
        }

        std::string validate_cert_list(const std::string &value) const override
        {
            rust_tls_detail::validate_pem(2, value, {}, "certificate list");
            return value;
        }

        std::string validate_crl(const std::string &value) const override
        {
            rust_tls_detail::validate_pem(
                4, value, {}, "certificate revocation list");
            return value;
        }

        std::string validate_private_key(const std::string &value) const override
        {
            rust_tls_detail::validate_pem(
                3, value, private_key_password, "private key");
            return value;
        }

        std::string validate_dh(const std::string &value) const override
        {
            rust_tls_detail::validate_pem(5, value, {}, "DH parameters");
            return value;
        }

      private:
        void key_info(std::uint32_t &type, std::size_t &bits) const
        {
            if (cert.empty())
            {
                type = static_cast<std::uint32_t>(PKType::PK_NONE);
                bits = 0;
                return;
            }
            const auto &callbacks = rust_backend();
            if (callbacks.tls_key_info == nullptr
                || !callbacks.tls_key_info(
                    rust_tls_detail::view(cert), &type, &bits))
            {
                type = static_cast<std::uint32_t>(PKType::PK_UNKNOWN);
                bits = 0;
            }
        }

        Mode mode;
        ExternalPKIBase *external_pki;
        std::string external_pki_alias;
        TLSSessionTicketBase *session_ticket_handler;
        SNI::HandlerBase *sni_handler;
        CommonNameReject *cn_reject_handler;
        std::string sni_name;
        std::string private_key_password;
        std::string ca;
        std::string crl;
        std::string cert;
        std::string extra_certs;
        std::string private_key;
        std::string dh;
        Frame::Ptr frame;
        int ssl_debug_level;
        unsigned int flags;
        NSCert::Type ns_cert_type;
        KUParse::TLSWebType remote_cert_tls;
        std::vector<unsigned int> ku;
        std::string eku;
        std::string tls_remote;
        std::string peer_fingerprints;
        VerifyX509Name verify_x509_name;
        VerifyX509Name::Mode verify_x509_name_mode;
        std::string verify_x509_name_value;
        TLSVersion::Type tls_version_min;
        TLSVersion::Type tls_version_max;
        TLSCertProfile::Type tls_cert_profile;
        std::string tls_cipher_list;
        std::string tls_ciphersuite_list;
        std::string tls_groups;
        X509Track::ConfigSet x509_track_config;
        bool local_cert_enabled;
        bool client_session_tickets;
        StrongRandomAPI::Ptr rng;
    };

    class SSL : public SSLAPI
    {
      public:
        typedef RCPtr<SSL> Ptr;

        ~SSL() override
        {
            if (handle_ != nullptr)
            {
                const auto &callbacks = rust_backend();
                if (callbacks.tls_connection_free != nullptr)
                    callbacks.tls_connection_free(handle_);
            }
        }

        void start_handshake() override
        {
            // rustls queues ClientHello when the connection is constructed.
        }

        ssize_t write_cleartext_unbuffered(const void *data,
                                           const std::size_t size) override
        {
            return call_write(
                rust_backend().tls_write_plaintext,
                static_cast<const std::uint8_t *>(data),
                size,
                "write cleartext");
        }

        ssize_t read_cleartext(void *data,
                               const std::size_t capacity) override
        {
            std::array<std::uint8_t, 1024> error{};
            const auto callback = rust_backend().tls_read_plaintext;
            if (callback == nullptr)
                throw Exception("Rust TLS cleartext reader is unavailable");
            const auto result = callback(
                handle_,
                static_cast<std::uint8_t *>(data),
                capacity,
                error.data(),
                error.size());
            if (result >= 0)
                return result == 0 ? SSLConst::SHOULD_RETRY : result;
            if (result == -2)
                return SSLConst::PEER_CLOSE_NOTIFY;
            OPENVPN_THROW(
                Exception,
                "Rust TLS read cleartext failed: "
                    << rust_tls_detail::error_text(error));
        }

        bool read_cleartext_ready() const override
        {
            const auto callback = rust_backend().tls_plaintext_ready;
            return callback != nullptr && callback(handle_) != 0;
        }

        void write_ciphertext(const BufferPtr &buffer) override
        {
            if (buffer)
                write_ciphertext_unbuffered(
                    buffer->c_data(), buffer->size());
        }

        void write_ciphertext_unbuffered(
            const unsigned char *data,
            const std::size_t size) override
        {
            const auto written = call_write(
                rust_backend().tls_write_ciphertext,
                data,
                size,
                "write ciphertext");
            if (written != static_cast<ssize_t>(size))
                throw ssl_ciphertext_in_overflow();
        }

        bool read_ciphertext_ready() const override
        {
            const auto callback = rust_backend().tls_ciphertext_ready;
            return callback != nullptr && callback(handle_) != 0;
        }

        BufferPtr read_ciphertext() override
        {
            if (!frame_)
                throw Exception("Rust TLS frame is unavailable");
            BufferPtr output =
                frame_->prepare(Frame::READ_BIO_MEMQ_STREAM);
            const std::size_t capacity =
                (*frame_)[Frame::READ_BIO_MEMQ_STREAM].payload();
            std::array<std::uint8_t, 1024> error{};
            const auto callback = rust_backend().tls_read_ciphertext;
            if (callback == nullptr)
                throw Exception("Rust TLS ciphertext reader is unavailable");
            const auto length = callback(
                handle_,
                output->data(),
                capacity,
                error.data(),
                error.size());
            if (length < 0)
            {
                OPENVPN_THROW(
                    Exception,
                    "Rust TLS read ciphertext failed: "
                        << rust_tls_detail::error_text(error));
            }
            output->set_size(static_cast<std::size_t>(length));
            return output;
        }

        std::string ssl_handshake_details() const override
        {
            std::array<std::uint8_t, 256> output{};
            const auto callback = rust_backend().tls_details;
            if (callback == nullptr)
                return {};
            const auto length =
                callback(handle_, output.data(), output.size());
            return {
                reinterpret_cast<const char *>(output.data()),
                std::min(length, output.size()),
            };
        }

        bool export_keying_material(const std::string &label,
                                    unsigned char *dest,
                                    std::size_t size) override
        {
            const auto callback =
                rust_backend().tls_export_keying_material;
            return callback != nullptr
                   && callback(
                       handle_,
                       rust_tls_detail::view(label),
                       dest,
                       size)
                          != 0;
        }

        bool did_full_handshake() override
        {
            if (full_handshake_reported_)
                return false;
            const auto callback = rust_backend().tls_handshake_complete;
            if (callback == nullptr || callback(handle_) == 0)
                return false;
            full_handshake_reported_ = true;
            return true;
        }

        const AuthCert::Ptr &auth_cert() const override
        {
            if (!authcert)
            {
                std::array<std::uint8_t, 512> common_name{};
                std::size_t common_name_len = 0;
                std::int64_t serial = -1;
                const auto callback = rust_backend().tls_peer_info;
                if (callback != nullptr
                    && callback(
                        handle_,
                        common_name.data(),
                        common_name.size(),
                        &common_name_len,
                        &serial))
                {
                    authcert.reset(new AuthCert(
                        std::string(
                            reinterpret_cast<const char *>(
                                common_name.data()),
                            std::min(
                                common_name_len,
                                common_name.size())),
                        serial));
                }
                else
                    authcert.reset(new AuthCert());
            }
            return authcert;
        }

        void mark_no_cache() override
        {
            // The current adapter does not share rustls sessions.
        }

      private:
        friend class RustTLSContext;

        SSL(RustTLSContext &context, const std::string *hostname)
            : handle_(nullptr),
              full_handshake_reported_(false),
              frame_(context.config_->frame)
        {
            const auto &callbacks = rust_backend();
            if (callbacks.tls_connection_new == nullptr)
                throw Exception("Rust TLS connection constructor is unavailable");
            const std::string name =
                hostname != nullptr
                    ? *hostname
                    : context.config_->sni_name;
            std::array<std::uint8_t, 1024> error{};
            handle_ = callbacks.tls_connection_new(
                context.handle_,
                rust_tls_detail::view(name),
                error.data(),
                error.size());
            if (handle_ == nullptr)
            {
                OPENVPN_THROW(
                    Exception,
                    "Rust TLS connection setup failed: "
                        << rust_tls_detail::error_text(error));
            }
        }

        ssize_t call_write(ovpn_rust_tls_write_fn callback,
                           const std::uint8_t *data,
                           const std::size_t size,
                           const char *operation)
        {
            if (callback == nullptr)
                OPENVPN_THROW(
                    Exception,
                    "Rust TLS " << operation << " callback is unavailable");
            std::array<std::uint8_t, 1024> error{};
            const auto result = callback(
                handle_,
                data,
                size,
                error.data(),
                error.size());
            if (result >= 0)
                return result;
            OPENVPN_THROW(
                Exception,
                "Rust TLS " << operation << " failed: "
                            << rust_tls_detail::error_text(error));
        }

        void *handle_;
        bool full_handshake_reported_;
        Frame::Ptr frame_;
        mutable AuthCert::Ptr authcert;
    };

    explicit RustTLSContext(Config *config)
        : config_(config),
          handle_(nullptr)
    {
        if (!config_->mode.is_client())
            throw Exception("Rust TLS context requires client mode");
        const auto &callbacks = rust_backend();
        if (callbacks.tls_config_new == nullptr)
            throw Exception("Rust TLS configuration constructor is unavailable");
        std::array<std::uint8_t, 1024> error{};
        const std::string remote_cert_ku =
            rust_tls_detail::join_key_usages(config_->ku);
        handle_ = callbacks.tls_config_new(
            rust_tls_detail::view(config_->ca),
            rust_tls_detail::view(config_->crl),
            rust_tls_detail::view(config_->cert),
            rust_tls_detail::view(config_->extra_certs),
            rust_tls_detail::view(config_->private_key),
            rust_tls_detail::view(config_->private_key_password),
            rust_tls_detail::view(config_->peer_fingerprints),
            static_cast<std::uint32_t>(config_->ns_cert_type),
            rust_tls_detail::view(remote_cert_ku),
            rust_tls_detail::view(config_->eku),
            rust_tls_detail::view(config_->tls_remote),
            static_cast<std::uint32_t>(
                config_->verify_x509_name_mode),
            rust_tls_detail::view(config_->verify_x509_name_value),
            rust_tls_detail::view(config_->tls_cipher_list),
            rust_tls_detail::view(config_->tls_ciphersuite_list),
            rust_tls_detail::view(config_->tls_groups),
            static_cast<std::uint32_t>(config_->tls_version_min),
            static_cast<std::uint32_t>(config_->tls_version_max),
            config_->flags,
            config_->local_cert_enabled ? 1 : 0,
            config_.get(),
            config_->external_pki != nullptr
                ? rust_tls_detail::external_sign
                : nullptr,
            error.data(),
            error.size());
        if (handle_ == nullptr)
        {
            OPENVPN_THROW(
                Exception,
                "Rust TLS configuration failed: "
                    << rust_tls_detail::error_text(error));
        }
    }

    ~RustTLSContext() override
    {
        if (handle_ != nullptr)
        {
            const auto &callbacks = rust_backend();
            if (callbacks.tls_config_free != nullptr)
                callbacks.tls_config_free(handle_);
        }
    }

    SSLAPI::Ptr ssl() override
    {
        return SSLAPI::Ptr(new SSL(*this, nullptr));
    }

    SSLAPI::Ptr ssl(const std::string *hostname,
                    const std::string *) override
    {
        return SSLAPI::Ptr(new SSL(*this, hostname));
    }

    SSLLib::Ctx libctx() override
    {
        return nullptr;
    }

    const Mode &mode() const override
    {
        return config_->mode;
    }

    static bool support_key_material_export()
    {
        return true;
    }

  private:
    Config::Ptr config_;
    void *handle_;
};

namespace rust_tls_detail {

inline ptrdiff_t external_sign(void *context,
                               const std::uint16_t signature_scheme,
                               const std::uint8_t *message,
                               const std::size_t message_len,
                               std::uint8_t *signature,
                               const std::size_t signature_capacity)
{
    try
    {
        auto *config = static_cast<RustTLSContext::Config *>(context);
        if (config == nullptr || config->external_pki == nullptr)
            return -1;

        std::string algorithm;
        std::string hash;
        std::string salt_length;
        switch (signature_scheme)
        {
        case 0x0401:
            algorithm = "RSA_PKCS1_PADDING";
            hash = "SHA256";
            break;
        case 0x0501:
            algorithm = "RSA_PKCS1_PADDING";
            hash = "SHA384";
            break;
        case 0x0601:
            algorithm = "RSA_PKCS1_PADDING";
            hash = "SHA512";
            break;
        case 0x0804:
            algorithm = "RSA_PKCS1_PSS_PADDING";
            hash = "SHA256";
            salt_length = "digest";
            break;
        case 0x0805:
            algorithm = "RSA_PKCS1_PSS_PADDING";
            hash = "SHA384";
            salt_length = "digest";
            break;
        case 0x0806:
            algorithm = "RSA_PKCS1_PSS_PADDING";
            hash = "SHA512";
            salt_length = "digest";
            break;
        case 0x0403:
            algorithm = "ECDSA";
            hash = "SHA256";
            break;
        case 0x0503:
            algorithm = "ECDSA";
            hash = "SHA384";
            break;
        case 0x0603:
            algorithm = "ECDSA";
            hash = "SHA512";
            break;
        case 0x0807:
            algorithm = "ED25519";
            break;
        case 0x0808:
            algorithm = "ED448";
            break;
        default:
            return -1;
        }

        const Base64 codec;
        const std::string encoded = codec.encode(message, message_len);
        std::string encoded_signature;
        if (!config->external_pki->sign(
                config->external_pki_alias,
                encoded,
                encoded_signature,
                algorithm,
                hash,
                salt_length))
            return -1;
        const std::string decoded = codec.decode(encoded_signature);
        if (decoded.size() > signature_capacity)
            return -1;
        std::memcpy(signature, decoded.data(), decoded.size());
        return static_cast<ptrdiff_t>(decoded.size());
    }
    catch (...)
    {
        return -1;
    }
}

} // namespace rust_tls_detail

class RustPEM
{
  public:
    static bool pem_encode(BufferAllocated &destination,
                           const unsigned char *source,
                           const std::size_t source_len,
                           const std::string &key_name)
    {
        try
        {
            const Base64 codec;
            const std::string encoded = codec.encode(source, source_len);
            std::string pem = "-----BEGIN " + key_name + "-----\n";
            for (std::size_t offset = 0; offset < encoded.size(); offset += 64)
                pem += encoded.substr(offset, 64) + '\n';
            pem += "-----END " + key_name + "-----\n";
            destination.write(
                reinterpret_cast<const unsigned char *>(pem.data()),
                pem.size());
            return true;
        }
        catch (...)
        {
            return false;
        }
    }

    static bool pem_decode(BufferAllocated &destination,
                           const char *source,
                           const std::size_t source_len,
                           const std::string &key_name)
    {
        try
        {
            const std::string pem(source, source_len);
            const std::string begin = "-----BEGIN " + key_name + "-----";
            const std::string end = "-----END " + key_name + "-----";
            const auto begin_at = pem.find(begin);
            const auto end_at =
                begin_at == std::string::npos
                    ? std::string::npos
                    : pem.find(end, begin_at + begin.size());
            if (begin_at == std::string::npos || end_at == std::string::npos)
                return false;
            std::string encoded =
                pem.substr(begin_at + begin.size(),
                           end_at - begin_at - begin.size());
            encoded.erase(
                std::remove_if(
                    encoded.begin(),
                    encoded.end(),
                    [](const char value) {
                        return value == '\r' || value == '\n'
                               || value == ' ' || value == '\t';
                    }),
                encoded.end());
            const Base64 codec;
            const std::string decoded = codec.decode(encoded);
            destination.write(
                reinterpret_cast<const unsigned char *>(decoded.data()),
                decoded.size());
            return true;
        }
        catch (...)
        {
            return false;
        }
    }
};

inline const std::string get_ssl_library_version()
{
    return "rustls 0.23";
}

} // namespace openvpn
