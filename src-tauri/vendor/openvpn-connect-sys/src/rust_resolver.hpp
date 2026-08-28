// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

#pragma once

#include "wrapper.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <string>
#include <system_error>
#include <vector>

#include <openvpn/io/io.hpp>

namespace openvpn {

template <typename Protocol>
class RustResolver
{
  public:
    using protocol_type = Protocol;
    using results_type = typename Protocol::resolver::results_type;

    explicit RustResolver(openvpn_io::io_context &)
    {
    }

    results_type resolve(const std::string &host,
                         const std::string &service,
                         openvpn_io::error_code &error)
    {
        std::uint16_t port = 0;
        const auto parsed = std::from_chars(
            service.data(), service.data() + service.size(), port);
        if (parsed.ec != std::errc{} || parsed.ptr != service.data() + service.size())
        {
            error = openvpn_io::error::invalid_argument;
            return {};
        }

        std::array<ovpn_rust_ip_address, 64> resolved{};
        std::size_t resolved_len = 0;
        if (!ovpn_rust_backend_resolve(
                reinterpret_cast<const std::uint8_t *>(host.data()),
                host.size(),
                resolved.data(),
                resolved.size(),
                &resolved_len))
        {
            error = openvpn_io::error::host_not_found;
            return {};
        }

        std::vector<typename Protocol::endpoint> endpoints;
        endpoints.reserve(resolved_len);
        for (std::size_t index = 0; index < resolved_len; ++index)
        {
            const auto &address = resolved[index];
            if (address.family == 4)
            {
                openvpn_io::ip::address_v4::bytes_type bytes{};
                std::copy_n(address.octets, bytes.size(), bytes.begin());
                endpoints.emplace_back(openvpn_io::ip::address_v4(bytes), port);
            }
            else if (address.family == 6)
            {
                openvpn_io::ip::address_v6::bytes_type bytes{};
                std::copy_n(address.octets, bytes.size(), bytes.begin());
                endpoints.emplace_back(openvpn_io::ip::address_v6(bytes), port);
            }
        }

        if (endpoints.empty())
        {
            error = openvpn_io::error::host_not_found;
            return {};
        }
        error.clear();
        return results_type::create(
            endpoints.begin(), endpoints.end(), host, service);
    }

    void cancel()
    {
    }
};

} // namespace openvpn
