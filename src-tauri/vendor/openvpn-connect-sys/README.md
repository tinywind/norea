# openvpn-connect-rs

Safe, source-built Rust bindings for the OpenVPN 3 Core client API used by
OpenVPN Connect.

The project provides synchronous and Tokio clients, owns every native resource,
and exposes the complete public OpenVPN client, platform callback, TUN, DCO,
External PKI, external transport, and external TUN surfaces without
caller-side `unsafe`.

The client build does not depend on OpenSSL:

- Hickory Resolver handles system DNS and literal IPv4/IPv6 addresses;
- rustls handles TLS 1.2/1.3, mutual TLS, keying-material export, CRLs,
  certificate fingerprints, and OpenVPN certificate policies;
- RustCrypto implements the OpenVPN cipher, AEAD, digest, HMAC, random, and
  TLS PRF interfaces.

Rust 1.88 or newer is required.

## Workspace layout

| Component | Responsibility |
| --- | --- |
| `openvpn-connect-sys` | Builds OpenVPN 3 Core 3.11.7 and Asio from source, applies the compatibility patch, generates the raw C ABI with bindgen, and registers the Rust DNS/TLS/crypto backends. |
| `openvpn-connect` | Safe synchronous client, configuration and credential types, callbacks, native resource ownership, TUN/DCO, External PKI, external transport, and external TUN. |
| `openvpn_connect::tokio` | Session future, bounded async commands, broadcast event/log streams, cancellation, async callbacks, and Tokio-safe packet I/O. |
| `xtask` | Source-package verification for publishing. |

Raw declarations are generated during every sys build from
[`wrapper.h`](openvpn-connect-sys/src/wrapper.h); they are not maintained by
hand. [`bridge.cpp`](openvpn-connect-sys/src/bridge.cpp) catches C++ exceptions
and provides the ownership/vtable boundary that bindgen cannot express safely.
The audited upstream compatibility changes are documented in
[`openvpn-connect-sys/PATCHES.md`](openvpn-connect-sys/PATCHES.md).

## Quick start

Initialize the pinned upstream sources after cloning:

```sh
git submodule update --init --recursive
```

Install a C++17 compiler, CMake, libclang, and LZ4 development files, then run:

```sh
cargo build -p openvpn-connect
cargo test --workspace --all-targets
```

Use `vendor` when an installed target LZ4 library is not available or a static
native adapter is preferred:

```sh
cargo build -p openvpn-connect --features vendor
```

See [Minimal usage](#minimal-usage) for synchronous and Tokio examples.

## Building

`openvpn-connect-sys` does not ship or download prebuilt native libraries.
Every build compiles the packaged OpenVPN 3 Core and patched Asio sources for
the active Cargo target.

The build copies the required files to `OUT_DIR` and applies the audited patch
set there, leaving both submodules clean. Published `.crate` archives contain
ordinary source snapshots and never require Git or network access at build time.

### Requirements

All modes require:

- a C++17 compiler;
- CMake;
- libclang, used by bindgen.

The default dynamic mode also requires the target's LZ4 development package.
The `vendor` mode builds LZ4 from source and does not require an installed LZ4
library. OpenSSL development files are not required in either mode.

On macOS, Homebrew installations in `/opt/homebrew` and `/usr/local` are
detected automatically:

```sh
brew install lz4
cargo test --workspace
```

The standalone Asio release expected by OpenVPN is vendored as headers. For
dynamic Linux builds, install the LZ4, Clang, CMake, and C++ development
packages. An explicit dependency prefix contains `include/` and, where
applicable, `lib/`.

### Link modes

| `vendor` | OpenVPN adapter | LZ4 | Deployment |
| --- | --- | --- | --- |
| disabled (default) | Source-built shared library | Target's installed shared library | Ship the generated `.so`, `.dylib`, or `.dll` and configure the platform runtime search path. |
| enabled | Source-built static library | Built by `lz4-sys` and linked statically | No separate OpenVPN or LZ4 runtime library is required. |

There are no separate `prebuilt`, `source-build`, `static`, or `dynamic`
features. `vendor` is the single link-mode switch: disabled means a source-built
shared library; enabled means source-built static libraries. DNS, TLS, and
cryptography always come from the Rust dependency graph in both modes.

### Cargo features

| Feature | Default | Purpose |
| --- | --- | --- |
| `tokio` | yes, on `openvpn-connect` | Async client, session future, streams, cancellation, and async callbacks. |
| `vendor` | no | Statically builds the OpenVPN adapter and LZ4. |
| `dco` | no | Enables OpenVPN DCO on Linux or Windows. |
| `external-transport` | no | Replaces Core's transport with a safe Rust packet transport. |
| `external-tun` | no | Replaces Core's TUN implementation with a safe Rust packet interface. |

### Rust-native network and security backends

The native Core adapter calls a process-wide Rust function table registered
before the first client is created:

- **DNS:** Hickory reads the platform resolver configuration and returns IPv4
  and IPv6 endpoints. Queries run on a dedicated runtime, so synchronous calls
  are also safe when the client is invoked from a Tokio context.
- **TLS:** rustls provides TLS 1.2 and TLS 1.3, client certificates, External
  PKI signing, CRLs, SHA-256 peer fingerprints, TLS keying-material export,
  and `tls-cipher`/`tls-ciphersuites`/`tls-groups` filtering.
- **Certificate policy:** `remote-cert-tls`, `remote-cert-ku`,
  `remote-cert-eku`, `ns-cert-type`, `verify-x509-name`, and `tls-remote` are
  enforced during the rustls handshake.
- **Crypto:** RustCrypto provides AES-128/192/256-CBC, AES-256-CTR, DES-CBC,
  3DES-CBC, Blowfish-CBC, AES-128/192/256-GCM, ChaCha20-Poly1305, MD4, MD5,
  SHA-1/224/256/384/512, HMAC, secure random generation, and the OpenVPN TLS
  PRF.

TLS 1.0 and TLS 1.1 are intentionally not provided by rustls. Profiles that
permit older versions still negotiate TLS 1.2 or newer; a maximum below TLS
1.2 is rejected.

Optional native capabilities are compiled directly into the selected source
build:

```sh
# Linux or Windows DCO
cargo build -p openvpn-connect --features dco

# Packet-level replacement for Core's transport and/or TUN implementation
cargo build -p openvpn-connect --features external-transport
cargo build -p openvpn-connect --features external-tun
```

`dco` is accepted only on Linux and Windows. Linux source builds require the
libnl3 development libraries. `external-transport` and `external-tun` compile
the upstream factory macros that its SWIG definition intentionally ignores and
expose safe Rust traits plus thread-safe packet return handles.

Cross targets require their Rust target and a working C/C++/CMake cross
toolchain. Without `vendor`, LZ4 must also be available for that target. The
generic `OPENVPN3_ASIO_DIR` and `OPENVPN3_LZ4_DIR` variables select dependency
prefixes for a dynamic build. Android uses `ANDROID_NDK_HOME`; iOS uses the
active Xcode selected by `xcrun`; OpenHarmony accepts a Native SDK root through
`OHOS_SDK_NATIVE` or the compatible `OHOS_NDK_HOME`. With `vendor`, Cargo's
target-aware `lz4-sys` build provides LZ4 automatically.

The target-specific CMake and linker behavior is isolated behind the platform
build interface in
[`openvpn-connect-sys/build/platform`](openvpn-connect-sys/build/platform).
The main build selects an implementation from the active Cargo target instead
of accumulating platform branches in `build.rs`.

### Platform matrix

| Platform | Rust targets | Tunnel integration | DCO |
| --- | --- | --- | --- |
| Linux | Cargo-supported Linux targets | Native TUN or `external-tun` | optional |
| Windows | MSVC and GNU targets | Native TUN or `external-tun` | optional |
| macOS | Apple desktop targets | Native TUN or `external-tun` | no |
| Android | `aarch64`, ARMv7, x86, x86_64 | Application `VpnService` through `TunBuilder`, or `external-tun` | no |
| iOS | device and simulator targets | Network Extension through `TunBuilder`, or `external-tun` | no |
| OpenHarmony | `aarch64`, ARMv7, x86_64 | Application tunnel through `TunBuilder`, or `external-tun` | no |

### Android cross-compilation

Android supports `aarch64-linux-android`, `armv7-linux-androideabi`,
`i686-linux-android`, and `x86_64-linux-android`. Set `ANDROID_NDK_HOME` (or the
compatible `ANDROID_NDK_ROOT`/`NDK_HOME`) and configure the standard Cargo and
`cc` target compiler variables, or use a cross runner such as `cargo-ndk` which
does that configuration for the application workspace:

```sh
export ANDROID_NDK_HOME=/path/to/android-ndk
export ANDROID_PLATFORM=android-24
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=/path/to/aarch64-linux-android24-clang
export CC_aarch64_linux_android=/path/to/aarch64-linux-android24-clang
export CXX_aarch64_linux_android=/path/to/aarch64-linux-android24-clang++
export AR_aarch64_linux_android=/path/to/llvm-ar
export RANLIB_aarch64_linux_android=/path/to/llvm-ranlib

cargo build --release \
  -p openvpn-connect \
  --target aarch64-linux-android \
  --features vendor
```

The default Android API is 24 and can be overridden through the standard
`ANDROID_PLATFORM` value. `vendor` statically links OpenVPN Core, LZ4, and
libc++ into the final Rust library or application. Without `vendor`, embed
the generated `libopenvpn3_core.so` and the NDK's `libc++_shared.so` in the
application's ABI-specific native library directory.

Android VPN applications implement `EventHandler::socket_protect` and
`TunBuilder` with `VpnService`; the same safe traits also expose every DNS,
route, proxy, MTU, persist, External PKI, external TUN, and external transport
callback without platform-side `unsafe` Rust.

### iOS cross-compilation

iOS supports `aarch64-apple-ios` for devices plus
`aarch64-apple-ios-sim` and `x86_64-apple-ios` for simulators. The sys build
queries the active Xcode toolchain with `xcrun`, selects `iphoneos` or
`iphonesimulator` from the Cargo target, and compiles the OpenVPN client
translation units as Objective-C++ where its UIKit integration requires it.
Set the normal Apple deployment target consistently for Rust and native
dependencies:

```sh
export IPHONEOS_DEPLOYMENT_TARGET=14.0
cargo build --release \
  -p openvpn-connect \
  --target aarch64-apple-ios \
  --features vendor
```

Explicit `CC_<target>` and `CXX_<target>` values override the `xcrun` compiler
selection. A non-`vendor` build produces `libopenvpn3_core.dylib`; embed and
sign it in the application's `Frameworks` directory using the normal Xcode
`@rpath` handling. iOS Network Extension integrations provide their packet
tunnel through the safe `TunBuilder` and callback interfaces.

### OpenHarmony cross-compilation

OpenHarmony uses the same Cargo build interface as every other cross target;
there is no project-specific packager or emulator integration. The supported
Rust targets are `aarch64-unknown-linux-ohos`,
`armv7-unknown-linux-ohos`, and `x86_64-unknown-linux-ohos`.

Set `OHOS_SDK_NATIVE` to the Native SDK root and configure Cargo plus the native
crates with the target compiler in the normal Cargo/cc environment. For example:

```sh
export OHOS_SDK_NATIVE=/path/to/openharmony-sdk/native
export LLVM_BIN="$OHOS_SDK_NATIVE/llvm/bin"

export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER="$LLVM_BIN/aarch64-unknown-linux-ohos-clang"
export CC_aarch64_unknown_linux_ohos="$LLVM_BIN/aarch64-unknown-linux-ohos-clang"
export CXX_aarch64_unknown_linux_ohos="$LLVM_BIN/aarch64-unknown-linux-ohos-clang++"
export AR_aarch64_unknown_linux_ohos="$LLVM_BIN/llvm-ar"
export RANLIB_aarch64_unknown_linux_ohos="$LLVM_BIN/llvm-ranlib"

cargo build --release \
  -p openvpn-connect \
  --target aarch64-unknown-linux-ohos \
  --features vendor
```

Use the equivalent SDK compiler prefix for ARMv7 or x86_64. These are standard
variables consumed by Cargo, `cc`, and `lz4-sys`, so the same
configuration works from a shell, `.cargo/config.toml`, CI cross runner, or a
larger application workspace. `vendor` source-builds and statically links the
native stack; without it, provide the target LZ4 prefix through the documented
`OPENVPN3_LZ4_DIR` variable and the OpenVPN adapter is shared.

Some OHOS SDKs do not provide a file named `libatomic.a` for ARMv7 even though
their compiler runtime implements the required atomics. The sys build queries
the selected target compiler through `-print-libgcc-file-name` and exposes that
runtime under the conventional linker name inside `OUT_DIR`. This is derived
from the active toolchain and does not assume a DevEco installation path or a
Clang version.

## Minimal usage

Tokio applications can await the session directly and retain a cloneable control handle:

```rust,no_run
use openvpn_connect::{Config, Credentials};
use openvpn_connect::tokio::Client;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let profile = std::fs::read_to_string("client.ovpn")?;
    let client = Client::without_callbacks()?;
    let evaluation = client.evaluate(Config::new(profile)).await?;

    if !evaluation.autologin {
        client
            .provide_credentials(Credentials::new("user", "password"))
            .await?;
    }

    let mut events = client.subscribe_events();
    let session = client.connect().await?;
    let control = session.handle();
    tokio::spawn(async move {
        while let Ok(event) = events.recv().await {
            println!("{}: {}", event.name, event.info);
        }
    });

    // `control.pause()`, `resume()`, `reconnect()`, queries, and `stop()` are async.
    // Dropping `session`, or cancelling its CancellationToken, also stops Core safely.
    let status = session.await?;
    println!("{}: {}", status.status, status.message);
    drop(control);
    Ok(())
}
```

The synchronous API remains available for runtimes other than Tokio:

```rust,no_run
use openvpn_connect::{Client, Config, Credentials, Event, EventHandler};

struct Handler;

impl EventHandler for Handler {
    fn event(&self, event: Event) {
        println!("{}: {}", event.name, event.info);
    }
}

let profile = std::fs::read_to_string("client.ovpn")?;
let client = Client::new(Handler)?;
let evaluation = client.evaluate(&Config::new(profile))?;

if !evaluation.autologin {
    client.provide_credentials(&Credentials::new("user", "password"))?;
}

// `connect` blocks until stopped or disconnected; run it on a worker thread.
let control = client.clone();
let worker = std::thread::spawn(move || client.connect());
// ...
control.stop();
worker.join().expect("connection thread panicked")?;
# Ok::<(), Box<dyn std::error::Error>>(())
```

OpenVPN profile parsing and crypto self-test do not require administrator
privileges. Establishing a native TUN interface generally does.

Android, iOS, and OpenHarmony builds enable OpenVPN Core's TunBuilder path.
Implement [`TunBuilder`](openvpn-connect/src/types.rs) on the callback handler
and return it from `EventHandler::tun_builder`; DNS, routes, addresses, MTU,
proxy settings, persistence, establishment, and teardown are all forwarded.
Desktop builds retain Core's native platform TUN implementation.

DCO TunBuilder peer/key lifecycle methods are available on the same trait. With
the `dco` feature, Core is built with `ENABLE_OVPNDCO` on Linux or
`ENABLE_OVPNDCOWIN` on Windows and `Config::dco` defaults to true. Key-bearing
types intentionally omit `Debug` to reduce accidental secret logging.

Tokio applications that obtain certificates, signatures, protected sockets,
or remote overrides from async services can implement
`openvpn_connect::tokio::AsyncEventHandler`. Core waits only on its dedicated
blocking thread while the returned futures run on the active Tokio runtime.

## Examples

Every example is compiled by `cargo test --all-targets`:

- `profile`: merge and fully evaluate a profile;
- `all_config`: compile-checked inventory of every upstream configuration field;
- `sync_client` and `tokio_client`: complete connection lifecycles;
- `platform_callbacks`: TunBuilder, DNS, DCO, remote override, socket protection, and External PKI;
- `async_callbacks`: Tokio-aware External PKI and remote override;
- `external_tun`: packet-level custom TUN integration skeleton;
- `tokio_udp_transport`: functional custom UDP transport driven entirely by Tokio.

For example:

```sh
cargo run -p openvpn-connect --example profile -- client.ovpn
cargo run -p openvpn-connect --example tokio_client -- client.ovpn
cargo run -p openvpn-connect \
  --no-default-features \
  --features vendor,tokio,external-transport \
  --example tokio_udp_transport -- client.ovpn
```

## Tests and E2E

The normal suite validates profile parsing, lifecycle rules, optional capability
rejection, all examples, every Rust crypto algorithm, TLS selectors and
certificate-policy parsing, nested-runtime DNS, platform build selection, and
the native C++→Rust callback table:

```sh
cargo test --workspace --all-targets
cargo test -p openvpn-connect \
  --no-default-features \
  --features vendor,tokio,external-tun,external-transport \
  --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

`tests/api_surface.rs` reads the vendored C++ headers and checks every config
field, client operation, TunBuilder/DCO method, and low-level factory against the
native adapter and safe API. This makes an upstream API change fail CI until it
has a Rust mapping.

The container E2E creates a temporary CA, server and client certificates,
starts a real username/password-protected OpenVPN server and TUN device, builds
the client image without OpenSSL development packages, and runs a
packet-I/O/link-mode matrix covering:

- dynamic native transport with native TUN;
- static external transport with native TUN;
- static native transport with external TUN;
- static external transport with external TUN plus the compiled DCO adapter.

Each topology covers successful synchronous and Tokio sessions, live queries,
pause/resume/reconnect, control messages, certificate-check entry points,
clean stop, cancellation and drop cleanup, one-client/one-session lifecycle
enforcement, server-side `AUTH_FAILED`, and rejection of an invalid
`verify-x509-name` policy. The live connection resolves the server hostname
through Hickory, negotiates a constrained rustls TLS 1.3 suite and group,
performs mutual certificate authentication and TLS keying-material export,
enables dynamic `tls-crypt`, and uses the RustCrypto AES-256-GCM data channel.
The all-feature pass also executes the exhaustive configuration and native
callback/DCO probes.

```sh
openvpn-connect/tests/e2e/run.sh
```

The ignored test can also target an existing server by setting
`OPENVPN_CONNECT_E2E_PROFILE`, `OPENVPN_USERNAME`, `OPENVPN_PASSWORD`,
`OPENVPN_CONNECT_E2E_CA`, `OPENVPN_CONNECT_E2E_CERT`, and
`OPENVPN_CONNECT_E2E_KEY`, then running `cargo test --test e2e -- --ignored`.
The Docker/OrbStack daemon must be running for the bundled harness.

Every optional configuration is checked against the linked native capability
set before evaluation. In particular, the open-source tree does not contain the
proprietary Private Tunnel `altProxy` implementation, so requesting
`Config::alternative_proxy` returns `UnsupportedCapability` instead of being
silently ignored. A custom proxy can be implemented through
`external-transport`.

## Publishing

The sys crate's explicit Cargo `include` list contains the C/C++ bridge, pinned
OpenVPN Core and Asio snapshots, patches, and upstream license files. It
excludes `target/` and every native library format. Build and audit the source
packages before publication:

```sh
cargo xtask package --allow-dirty
```

The audit verifies both submodule commit IDs, opens the generated `.crate`,
checks representative source and license files, and rejects prebuilt `.a`,
`.so`, `.dylib`, `.dll`, or `.lib` files. Cargo then verifies the packaged sys
crate from its unpacked source, so it cannot accidentally depend on
workspace-only paths.

Publish `openvpn-connect-sys` first. Package `openvpn-connect` after the exact
sys version is visible in the registry. The xtask also checks the upper crate's
publish file list.

## Upstream source

`openvpn-connect-sys/vendor/openvpn3` is the pristine OpenVPN 3 Core 3.11.7
submodule at commit `18edfae7e7fd8051c93bd4746ec69be91eb02dbb`.
`openvpn-connect-sys/vendor/asio` is the pristine standalone Asio 1.24.0
submodule at commit `147f7225a96d45a2807a64e443177f621844e51c`.
Their licenses and the complete compatibility patch set are included in the sys
crate source archive; see `openvpn-connect-sys/PATCHES.md`.
