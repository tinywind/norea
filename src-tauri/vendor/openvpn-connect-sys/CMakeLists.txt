cmake_minimum_required(VERSION 3.16)

project(openvpn-connect-sys LANGUAGES C CXX)

set(OPENVPN_CONNECT_LIBRARY_TYPE "STATIC" CACHE STRING "STATIC or SHARED")
set_property(CACHE OPENVPN_CONNECT_LIBRARY_TYPE PROPERTY STRINGS STATIC SHARED)
set(OPENVPN_CONNECT_OPENVPN3_DIR
    "${CMAKE_CURRENT_SOURCE_DIR}/vendor/openvpn3"
    CACHE PATH "OpenVPN 3 Core source root")

if(NOT OPENVPN_CONNECT_LIBRARY_TYPE STREQUAL "STATIC" AND
   NOT OPENVPN_CONNECT_LIBRARY_TYPE STREQUAL "SHARED")
    message(FATAL_ERROR "OPENVPN_CONNECT_LIBRARY_TYPE must be STATIC or SHARED")
endif()

set(OPENVPN_CONNECT_CLIENT_SOURCE
    "${OPENVPN_CONNECT_OPENVPN3_DIR}/client/ovpncli.cpp")

add_library(openvpn3_core ${OPENVPN_CONNECT_LIBRARY_TYPE}
    src/bridge.cpp
    "${OPENVPN_CONNECT_CLIENT_SOURCE}"
    "${OPENVPN_CONNECT_OPENVPN3_DIR}/openvpn/crypto/data_epoch.cpp"
)

# OpenVPN's iOS client path calls UIKit from inline headers. Compile the two
# translation units which include the client API as Objective-C++ while
# keeping the portable core sources in their original C/C++ languages.
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    enable_language(OBJCXX)
    set_source_files_properties(
        src/bridge.cpp
        "${OPENVPN_CONNECT_CLIENT_SOURCE}"
        PROPERTIES LANGUAGE OBJCXX
    )
endif()

set_target_properties(openvpn3_core PROPERTIES
    C_STANDARD 99
    C_STANDARD_REQUIRED ON
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
    POSITION_INDEPENDENT_CODE ON
    WINDOWS_EXPORT_ALL_SYMBOLS ON
)

target_include_directories(openvpn3_core PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${OPENVPN_CONNECT_OPENVPN3_DIR}"
    "${OPENVPN_CONNECT_ASIO_INCLUDE}"
    "${OPENVPN_CONNECT_LZ4_INCLUDE}"
)

target_compile_definitions(openvpn3_core PRIVATE
    ASIO_STANDALONE
    USE_ASIO
    USE_RUST_CRYPTO
    HAVE_LZ4
    ENABLE_EXTERNAL_PKI
    OPENVPN_GREMLIN
)

if(OPENVPN_CONNECT_FORCE_NULL_TUN)
    target_compile_definitions(openvpn3_core PRIVATE OPENVPN_FORCE_TUN_NULL)
endif()

if(OPENVPN_CONNECT_USE_TUN_BUILDER)
    target_compile_definitions(openvpn3_core PRIVATE USE_TUN_BUILDER)
endif()

if(OPENVPN_CONNECT_EXTERNAL_TRANSPORT)
    target_compile_definitions(openvpn3_core PRIVATE OPENVPN_EXTERNAL_TRANSPORT_FACTORY)
endif()

if(OPENVPN_CONNECT_EXTERNAL_TUN)
    target_compile_definitions(openvpn3_core PRIVATE OPENVPN_EXTERNAL_TUN_FACTORY)
endif()

if(OPENVPN_CONNECT_ENABLE_DCO)
    if(WIN32)
        target_compile_definitions(openvpn3_core PRIVATE ENABLE_OVPNDCOWIN)
        target_link_libraries(openvpn3_core PRIVATE bcrypt)
    elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux")
        find_path(OPENVPN_CONNECT_LIBNL_INCLUDE netlink/netlink.h PATH_SUFFIXES libnl3)
        find_library(OPENVPN_CONNECT_LIBNL_LIBRARY NAMES nl-3)
        find_library(OPENVPN_CONNECT_LIBNL_GENL_LIBRARY NAMES nl-genl-3)
        if(NOT OPENVPN_CONNECT_LIBNL_INCLUDE OR
           NOT OPENVPN_CONNECT_LIBNL_LIBRARY OR
           NOT OPENVPN_CONNECT_LIBNL_GENL_LIBRARY)
            message(FATAL_ERROR "DCO requires libnl-3 and libnl-genl-3 development files")
        endif()
        # ovpn-dco creates/removes its network interface through the SITNL
        # implementation; without this selector tunmethods.hpp exposes only
        # the iproute backend and OvpnDcoClient cannot resolve iface_new/del.
        target_compile_definitions(openvpn3_core PRIVATE
            ENABLE_OVPNDCO
            OPENVPN_USE_SITNL
        )
        target_include_directories(openvpn3_core PRIVATE "${OPENVPN_CONNECT_LIBNL_INCLUDE}")
        target_link_libraries(openvpn3_core PRIVATE
            "${OPENVPN_CONNECT_LIBNL_LIBRARY}"
            "${OPENVPN_CONNECT_LIBNL_GENL_LIBRARY}"
        )
    else()
        message(FATAL_ERROR "DCO is supported only on Linux and Windows")
    endif()
endif()

if(WIN32)
    target_compile_definitions(openvpn3_core PRIVATE
        _WIN32_WINNT=0x0600
        TAP_WIN_COMPONENT_ID=tap0901
        _CRT_SECURE_NO_WARNINGS
        ASIO_DISABLE_LOCAL_SOCKETS
    )
    if(MSVC)
        set_property(TARGET openvpn3_core PROPERTY
            MSVC_RUNTIME_LIBRARY "MultiThreaded")
        target_compile_options(openvpn3_core PRIVATE /bigobj)
    endif()
else()
    target_compile_options(openvpn3_core PRIVATE
        -Wno-deprecated-declarations
        -Wno-unused-parameter
        -Wno-deprecated-copy
    )
endif()

if(OPENVPN_CONNECT_LZ4_LIBRARY_DIR)
    target_link_directories(openvpn3_core PRIVATE "${OPENVPN_CONNECT_LZ4_LIBRARY_DIR}")
endif()

target_link_libraries(openvpn3_core PRIVATE lz4)

if(APPLE)
    target_link_libraries(openvpn3_core PRIVATE
        "-framework CoreFoundation"
        "-framework IOKit"
        "-framework CoreServices"
        "-framework SystemConfiguration"
    )
    if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
        target_link_libraries(openvpn3_core PRIVATE "-framework UIKit")
    endif()
elseif(WIN32)
    target_link_libraries(openvpn3_core PRIVATE
        fwpuclnt iphlpapi wininet setupapi rpcrt4 wtsapi32 ws2_32 wsock32
    )
else()
    find_package(Threads REQUIRED)
    target_link_libraries(openvpn3_core PRIVATE Threads::Threads)
endif()

install(TARGETS openvpn3_core
    ARCHIVE DESTINATION lib
    LIBRARY DESTINATION lib
    RUNTIME DESTINATION bin
)
