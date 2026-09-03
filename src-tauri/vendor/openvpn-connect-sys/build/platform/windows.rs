use super::{BuildTarget, PlatformBuild};
use crate::LinkMode;

pub(super) struct Windows;

impl PlatformBuild for Windows {
    fn library_filename(&self, target: &BuildTarget, mode: LinkMode) -> &'static str {
        match (target.environment.as_str(), mode) {
            ("msvc", _) => "openvpn3_core.lib",
            (_, LinkMode::Static) => "libopenvpn3_core.a",
            (_, LinkMode::Dynamic) => "libopenvpn3_core.dll.a",
        }
    }

    fn emit_static_link_libraries(&self, target: &BuildTarget) {
        for library in [
            "fwpuclnt", "iphlpapi", "wininet", "setupapi", "rpcrt4", "wtsapi32", "ws2_32",
            "wsock32",
        ] {
            println!("cargo:rustc-link-lib={library}");
        }
        if target.environment != "msvc" {
            println!("cargo:rustc-link-lib=stdc++");
            println!("cargo:rustc-link-lib=winpthread");
        }
    }
}
