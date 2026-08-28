#![allow(dead_code, unused_imports)]

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LinkMode {
    Static,
    Dynamic,
}

#[path = "../build/platform/mod.rs"]
mod platform;

use platform::BuildTarget;

fn target(os: &str, environment: &str, arch: &str) -> BuildTarget {
    BuildTarget {
        triple: format!("{arch}-unknown-{os}-{environment}"),
        host: "host-platform".to_owned(),
        os: os.to_owned(),
        environment: environment.to_owned(),
        arch: arch.to_owned(),
    }
}

#[test]
fn selects_android_build_rules() {
    let target = target("android", "", "aarch64");
    let build = platform::for_target(&target);

    assert!(build.uses_tun_builder(&target));
    assert_eq!(
        build.library_filename(&target, LinkMode::Static),
        "libopenvpn3_core.a"
    );
    assert_eq!(
        build.library_filename(&target, LinkMode::Dynamic),
        "libopenvpn3_core.so"
    );
    assert!(!build.supports_rpath(&target));
}

#[test]
fn selects_distinct_macos_and_ios_rules() {
    let macos = target("macos", "", "aarch64");
    let macos_build = platform::for_target(&macos);
    assert!(!macos_build.uses_tun_builder(&macos));
    assert_eq!(
        macos_build.library_filename(&macos, LinkMode::Dynamic),
        "libopenvpn3_core.dylib"
    );
    assert!(macos_build.supports_rpath(&macos));

    let ios = target("ios", "", "aarch64");
    let ios_build = platform::for_target(&ios);
    assert!(ios_build.uses_tun_builder(&ios));
    assert_eq!(
        ios_build.library_filename(&ios, LinkMode::Dynamic),
        "libopenvpn3_core.dylib"
    );
    assert!(!ios_build.supports_rpath(&ios));
}

#[test]
fn selects_linux_and_openharmony_rules_by_environment() {
    let linux = target("linux", "gnu", "aarch64");
    let linux_build = platform::for_target(&linux);
    assert!(!linux_build.uses_tun_builder(&linux));
    assert!(linux_build.supports_rpath(&linux));

    let ohos = target("linux", "ohos", "aarch64");
    let ohos_build = platform::for_target(&ohos);
    assert!(ohos_build.uses_tun_builder(&ohos));
    assert!(ohos_build.supports_rpath(&ohos));
    assert_eq!(
        ohos_build.library_filename(&ohos, LinkMode::Dynamic),
        "libopenvpn3_core.so"
    );
}

#[test]
fn selects_windows_artifacts_for_each_toolchain() {
    let msvc = target("windows", "msvc", "x86_64");
    let msvc_build = platform::for_target(&msvc);
    assert_eq!(
        msvc_build.library_filename(&msvc, LinkMode::Static),
        "openvpn3_core.lib"
    );
    assert_eq!(
        msvc_build.library_filename(&msvc, LinkMode::Dynamic),
        "openvpn3_core.lib"
    );

    let gnu = target("windows", "gnu", "x86_64");
    let gnu_build = platform::for_target(&gnu);
    assert_eq!(
        gnu_build.library_filename(&gnu, LinkMode::Static),
        "libopenvpn3_core.a"
    );
    assert_eq!(
        gnu_build.library_filename(&gnu, LinkMode::Dynamic),
        "libopenvpn3_core.dll.a"
    );
}

#[test]
fn keeps_a_generic_unix_fallback() {
    let target = target("freebsd", "", "x86_64");
    let build = platform::for_target(&target);

    assert!(!build.uses_tun_builder(&target));
    assert_eq!(
        build.library_filename(&target, LinkMode::Dynamic),
        "libopenvpn3_core.so"
    );
    assert!(!build.supports_rpath(&target));
}
