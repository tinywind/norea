use std::env;
use std::path::Path;

use crate::LinkMode;

mod android;
mod ios;
mod linux;
mod macos;
mod ohos;
mod unix;
mod windows;

pub(crate) use ohos::SDK_NATIVE_ENV as OHOS_SDK_NATIVE_ENV;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BuildTarget {
    pub(crate) triple: String,
    pub(crate) host: String,
    pub(crate) os: String,
    pub(crate) environment: String,
    pub(crate) arch: String,
}

impl BuildTarget {
    pub(crate) fn from_env() -> Self {
        Self {
            triple: env::var("TARGET").expect("Cargo must set TARGET"),
            host: env::var("HOST").expect("Cargo must set HOST"),
            os: env::var("CARGO_CFG_TARGET_OS").expect("Cargo must set target OS"),
            environment: env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default(),
            arch: env::var("CARGO_CFG_TARGET_ARCH").expect("Cargo must set target architecture"),
        }
    }

    pub(crate) fn is_host(&self) -> bool {
        self.triple == self.host
    }
}

pub(crate) trait PlatformBuild {
    fn configure_cmake(&self, _config: &mut cmake::Config, target: &BuildTarget, _mode: LinkMode) {
        warn_for_cross_target(target);
    }

    fn uses_tun_builder(&self, _target: &BuildTarget) -> bool {
        false
    }

    fn library_filename(&self, target: &BuildTarget, mode: LinkMode) -> &'static str;

    fn finish(&self, _lib_dir: &Path, _target: &BuildTarget) {}

    fn supports_rpath(&self, _target: &BuildTarget) -> bool {
        false
    }

    fn emit_static_link_libraries(&self, target: &BuildTarget);
}

pub(crate) fn for_target(target: &BuildTarget) -> Box<dyn PlatformBuild> {
    if target.environment == "ohos" {
        Box::new(ohos::OpenHarmony)
    } else {
        match target.os.as_str() {
            "android" => Box::new(android::Android),
            "ios" => Box::new(ios::Ios),
            "linux" => Box::new(linux::Linux),
            "macos" => Box::new(macos::MacOs),
            "windows" => Box::new(windows::Windows),
            _ => Box::new(unix::Unix),
        }
    }
}

pub(super) const fn unix_library_filename(mode: LinkMode) -> &'static str {
    match mode {
        LinkMode::Static => "libopenvpn3_core.a",
        LinkMode::Dynamic => "libopenvpn3_core.so",
    }
}

pub(super) const fn apple_library_filename(mode: LinkMode) -> &'static str {
    match mode {
        LinkMode::Static => "libopenvpn3_core.a",
        LinkMode::Dynamic => "libopenvpn3_core.dylib",
    }
}

pub(super) fn emit_apple_static_link_libraries(include_uikit: bool) {
    println!("cargo:rustc-link-lib=c++");
    for framework in [
        "CoreFoundation",
        "IOKit",
        "CoreServices",
        "SystemConfiguration",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    if include_uikit {
        println!("cargo:rustc-link-lib=framework=UIKit");
    }
}

pub(super) fn warn_for_cross_target(target: &BuildTarget) {
    if !target.is_host() {
        println!(
            "cargo:warning=building {} requires a working Cargo/CMake cross compiler and target dependencies",
            target.triple
        );
    }
}
