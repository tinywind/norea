// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once

#include "wrapper.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include <openvpn/common/exception.hpp>
#include <openvpn/crypto/aead_usage_limit.hpp>
#include <openvpn/crypto/cryptoalgs.hpp>
#include <openvpn/random/randapi.hpp>

namespace openvpn {

inline const ovpn_rust_backend_vtable &rust_backend()
{
    const auto *callbacks = ovpn_rust_backend_callbacks();
    if (callbacks == nullptr)
        throw Exception("Rust crypto backend is not registered");
    return *callbacks;
}

class RustRandom : public StrongRandomAPI
{
  public:
    std::string name() const override
    {
        return "Rust-getrandom";
    }

    void rand_bytes(unsigned char *buffer, size_t size) override
    {
        if (!rand_bytes_noexcept(buffer, size))
            throw Exception("Rust random generator failed");
    }

    bool rand_bytes_noexcept(unsigned char *buffer, size_t size) override
    {
        const auto &callbacks = rust_backend();
        return callbacks.random != nullptr
               && callbacks.random(buffer, size) != 0;
    }
};

namespace RustCrypto {

class CipherContextCommon
{
  public:
    enum
    {
        MODE_UNDEF = -1,
        DECRYPT = 0,
        ENCRYPT = 1,
    };

    constexpr bool requires_authtag_at_end() const
    {
        return false;
    }

    CipherContextCommon() = default;
    CipherContextCommon(const CipherContextCommon &) = delete;
    CipherContextCommon &operator=(const CipherContextCommon &) = delete;

    CipherContextCommon(CipherContextCommon &&other) noexcept
        : handle_(std::exchange(other.handle_, nullptr))
    {
    }

    CipherContextCommon &operator=(CipherContextCommon &&other) noexcept
    {
        if (this != &other)
            handle_ = std::exchange(other.handle_, nullptr);
        return *this;
    }

    bool is_initialized() const
    {
        return handle_ != nullptr;
    }

  protected:
    void *handle_ = nullptr;
};

class CipherContext : public CipherContextCommon
{
  public:
    enum
    {
        MAX_IV_LENGTH = 16,
        CIPH_CBC_MODE = 1,
    };

    ~CipherContext()
    {
        erase();
    }

    static bool is_supported(SSLLib::Ctx, CryptoAlgs::Type algorithm)
    {
        const auto &callbacks = rust_backend();
        return callbacks.cipher_supported != nullptr
               && callbacks.cipher_supported(static_cast<uint32_t>(algorithm)) != 0;
    }

    void init(SSLLib::Ctx,
              CryptoAlgs::Type algorithm,
              const unsigned char *key,
              int mode)
    {
        erase();
        const auto &callbacks = rust_backend();
        if (callbacks.cipher_new == nullptr)
            throw Exception("Rust cipher constructor is unavailable");
        handle_ = callbacks.cipher_new(
            static_cast<uint32_t>(algorithm),
            key,
            CryptoAlgs::key_length(algorithm),
            mode == ENCRYPT ? 1 : 0);
        if (handle_ == nullptr)
            throw Exception("Rust cipher initialization failed");
        algorithm_ = algorithm;
    }

    void reset(const unsigned char *iv)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.cipher_reset == nullptr
            || callbacks.cipher_reset(
                   handle_, iv, CryptoAlgs::iv_length(algorithm_))
                   == 0)
            throw Exception("Rust cipher reset failed");
    }

    bool update(unsigned char *,
                size_t,
                const unsigned char *input,
                size_t input_size,
                size_t &)
    {
        const auto &callbacks = rust_backend();
        return handle_ != nullptr && callbacks.cipher_update != nullptr
               && callbacks.cipher_update(handle_, input, input_size) != 0;
    }

    bool final(unsigned char *output, size_t output_size, size_t &output_acc)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.cipher_final == nullptr)
            return false;
        const size_t written =
            callbacks.cipher_final(handle_, output, output_size);
        if (written == 0)
            return false;
        output_acc += written;
        return true;
    }

    size_t iv_length() const
    {
        return CryptoAlgs::iv_length(algorithm_);
    }

    size_t block_size() const
    {
        return CryptoAlgs::block_size(algorithm_);
    }

    int cipher_mode() const
    {
        return algorithm_ == CryptoAlgs::AES_256_CTR ? 2 : CIPH_CBC_MODE;
    }

  private:
    void erase()
    {
        if (handle_ != nullptr)
        {
            const auto &callbacks = rust_backend();
            if (callbacks.cipher_free != nullptr)
                callbacks.cipher_free(handle_);
            handle_ = nullptr;
        }
    }

    CryptoAlgs::Type algorithm_ = CryptoAlgs::NONE;
};

class CipherContextAEAD : public CipherContextCommon
{
  public:
    enum
    {
        IV_LEN = 12,
        AUTH_TAG_LEN = 16,
    };

    ~CipherContextAEAD()
    {
        erase();
    }

    CipherContextAEAD() = default;

    CipherContextAEAD(CipherContextAEAD &&other) noexcept
        : CipherContextCommon(std::move(other)),
          usage_limit_(other.usage_limit_)
    {
    }

    CipherContextAEAD &operator=(CipherContextAEAD &&other) noexcept
    {
        erase();
        CipherContextCommon::operator=(std::move(other));
        usage_limit_ = other.usage_limit_;
        return *this;
    }

    static bool is_supported(SSLLib::Ctx, CryptoAlgs::Type algorithm)
    {
        const auto &callbacks = rust_backend();
        return callbacks.aead_supported != nullptr
               && callbacks.aead_supported(static_cast<uint32_t>(algorithm)) != 0;
    }

    void init(SSLLib::Ctx,
              CryptoAlgs::Type algorithm,
              const unsigned char *key,
              unsigned int key_size,
              int mode)
    {
        erase();
        const auto &callbacks = rust_backend();
        if (callbacks.aead_new == nullptr)
            throw Exception("Rust AEAD constructor is unavailable");
        handle_ = callbacks.aead_new(
            static_cast<uint32_t>(algorithm),
            key,
            key_size,
            mode == ENCRYPT ? 1 : 0);
        if (handle_ == nullptr)
            throw Exception("Rust AEAD initialization failed");
        usage_limit_ = Crypto::AEADUsageLimit{algorithm};
    }

    void encrypt(const unsigned char *input,
                 unsigned char *output,
                 size_t length,
                 const unsigned char *iv,
                 unsigned char *tag,
                 const unsigned char *additional_data,
                 size_t additional_data_len)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.aead_encrypt == nullptr
            || callbacks.aead_encrypt(
                   handle_,
                   input,
                   length,
                   output,
                   length,
                   iv,
                   IV_LEN,
                   tag,
                   AUTH_TAG_LEN,
                   additional_data,
                   additional_data_len)
                   == 0)
            throw Exception("Rust AEAD encryption failed");
        usage_limit_.update(length + additional_data_len);
    }

    bool decrypt(const unsigned char *input,
                 unsigned char *output,
                 size_t length,
                 const unsigned char *iv,
                 const unsigned char *tag,
                 const unsigned char *additional_data,
                 size_t additional_data_len)
    {
        const auto &callbacks = rust_backend();
        return handle_ != nullptr && tag != nullptr
               && callbacks.aead_decrypt != nullptr
               && callbacks.aead_decrypt(
                      handle_,
                      input,
                      length,
                      output,
                      length,
                      iv,
                      IV_LEN,
                      const_cast<unsigned char *>(tag),
                      AUTH_TAG_LEN,
                      additional_data,
                      additional_data_len)
                      != 0;
    }

    const Crypto::AEADUsageLimit &get_usage_limit()
    {
        return usage_limit_;
    }

  private:
    void erase()
    {
        if (handle_ != nullptr)
        {
            const auto &callbacks = rust_backend();
            if (callbacks.aead_free != nullptr)
                callbacks.aead_free(handle_);
            handle_ = nullptr;
        }
    }

    Crypto::AEADUsageLimit usage_limit_{};
};

class DigestContext
{
  public:
    enum
    {
        MAX_DIGEST_SIZE = 64,
    };

    DigestContext() = default;

    explicit DigestContext(CryptoAlgs::Type algorithm)
    {
        init(algorithm);
    }

    DigestContext(CryptoAlgs::Type algorithm, SSLLib::Ctx)
    {
        init(algorithm);
    }

    ~DigestContext()
    {
        erase();
    }

    DigestContext(const DigestContext &) = delete;
    DigestContext &operator=(const DigestContext &) = delete;

    void init(CryptoAlgs::Type algorithm)
    {
        erase();
        const auto &callbacks = rust_backend();
        if (callbacks.digest_new != nullptr)
            handle_ = callbacks.digest_new(static_cast<uint32_t>(algorithm));
        if (handle_ == nullptr)
            throw Exception("Rust digest initialization failed");
    }

    void update(const unsigned char *input, size_t size)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.digest_update == nullptr
            || callbacks.digest_update(handle_, input, size) == 0)
            throw Exception("Rust digest update failed");
    }

    size_t final(unsigned char *output)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.digest_final == nullptr)
            throw Exception("Rust digest finalization failed");
        const size_t written =
            callbacks.digest_final(handle_, output, MAX_DIGEST_SIZE);
        if (written == 0)
            throw Exception("Rust digest finalization failed");
        return written;
    }

    size_t size() const
    {
        const auto &callbacks = rust_backend();
        return handle_ != nullptr && callbacks.digest_size != nullptr
                   ? callbacks.digest_size(handle_)
                   : 0;
    }

    bool is_initialized() const
    {
        return handle_ != nullptr;
    }

  private:
    void erase()
    {
        if (handle_ != nullptr)
        {
            const auto &callbacks = rust_backend();
            if (callbacks.digest_free != nullptr)
                callbacks.digest_free(handle_);
            handle_ = nullptr;
        }
    }

    void *handle_ = nullptr;
};

class HMACContext
{
  public:
    enum
    {
        MAX_HMAC_SIZE = 64,
    };

    HMACContext() = default;

    HMACContext(CryptoAlgs::Type algorithm,
                const unsigned char *key,
                size_t key_size)
    {
        init(algorithm, key, key_size);
    }

    ~HMACContext()
    {
        erase();
    }

    HMACContext(const HMACContext &) = delete;
    HMACContext &operator=(const HMACContext &) = delete;

    void init(CryptoAlgs::Type algorithm,
              const unsigned char *key,
              size_t key_size)
    {
        erase();
        const auto &callbacks = rust_backend();
        if (callbacks.hmac_new != nullptr)
            handle_ = callbacks.hmac_new(
                static_cast<uint32_t>(algorithm), key, key_size);
        if (handle_ == nullptr)
            throw Exception("Rust HMAC initialization failed");
    }

    void reset()
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.hmac_reset == nullptr
            || callbacks.hmac_reset(handle_) == 0)
            throw Exception("Rust HMAC reset failed");
    }

    void update(const unsigned char *input, size_t size)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.hmac_update == nullptr
            || callbacks.hmac_update(handle_, input, size) == 0)
            throw Exception("Rust HMAC update failed");
    }

    size_t final(unsigned char *output)
    {
        const auto &callbacks = rust_backend();
        if (handle_ == nullptr || callbacks.hmac_final == nullptr)
            throw Exception("Rust HMAC finalization failed");
        const size_t written =
            callbacks.hmac_final(handle_, output, MAX_HMAC_SIZE);
        if (written == 0)
            throw Exception("Rust HMAC finalization failed");
        return written;
    }

    size_t size() const
    {
        const auto &callbacks = rust_backend();
        return handle_ != nullptr && callbacks.hmac_size != nullptr
                   ? callbacks.hmac_size(handle_)
                   : 0;
    }

    bool is_initialized() const
    {
        return handle_ != nullptr;
    }

  private:
    void erase()
    {
        if (handle_ != nullptr)
        {
            const auto &callbacks = rust_backend();
            if (callbacks.hmac_free != nullptr)
                callbacks.hmac_free(handle_);
            handle_ = nullptr;
        }
    }

    void *handle_ = nullptr;
};

class TLS1PRF
{
  public:
    static bool PRF(unsigned char *label,
                    size_t label_len,
                    const unsigned char *secret,
                    size_t secret_len,
                    unsigned char *output,
                    size_t output_len)
    {
        const size_t half = (secret_len + 1) / 2;
        std::vector<unsigned char> md5(output_len);
        p_hash(
            CryptoAlgs::MD5,
            secret,
            half,
            label,
            label_len,
            md5.data(),
            output_len);
        p_hash(
            CryptoAlgs::SHA1,
            secret + secret_len / 2,
            half,
            label,
            label_len,
            output,
            output_len);
        for (size_t index = 0; index < output_len; ++index)
            output[index] ^= md5[index];
        return true;
    }

  private:
    static void p_hash(CryptoAlgs::Type algorithm,
                       const unsigned char *secret,
                       size_t secret_len,
                       const unsigned char *seed,
                       size_t seed_len,
                       unsigned char *output,
                       size_t output_len)
    {
        HMACContext hmac(algorithm, secret, secret_len);
        std::array<unsigned char, HMACContext::MAX_HMAC_SIZE> a{};
        hmac.update(seed, seed_len);
        size_t a_len = hmac.final(a.data());

        while (output_len != 0)
        {
            hmac.reset();
            hmac.update(a.data(), a_len);
            hmac.update(seed, seed_len);
            std::array<unsigned char, HMACContext::MAX_HMAC_SIZE> block{};
            const size_t block_len = hmac.final(block.data());
            const size_t take = std::min(output_len, block_len);
            std::memcpy(output, block.data(), take);
            output += take;
            output_len -= take;

            hmac.reset();
            hmac.update(a.data(), a_len);
            a_len = hmac.final(a.data());
        }
    }
};

} // namespace RustCrypto

struct RustCryptoAPI
{
    using CipherContext = RustCrypto::CipherContext;
    using CipherContextAEAD = RustCrypto::CipherContextAEAD;
    using DigestContext = RustCrypto::DigestContext;
    using HMACContext = RustCrypto::HMACContext;
    using TLS1PRF = RustCrypto::TLS1PRF;
};

} // namespace openvpn
