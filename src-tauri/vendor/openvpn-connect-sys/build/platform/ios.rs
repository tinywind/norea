use std::env;
use std::path::PathBuf;
use std::process::Command;

use super::{BuildTarget, PlatformBuild, apple_library_filename, emit_apple_static_link_libraries};
use crate::LinkMode;

pub(super) struct Ios;

impl PlatformBuild for Ios {
    fn configure_cmake(&self, config: &mut cmake::Config, target: &BuildTarget, _mode: LinkMode) {
        let sdk = apple_sdk(target);
        let c_compiler = target_tool_override("CC", &target.triple)
            .unwrap_or_else(|| xcrun_sdk_tool(sdk, "clang"));
        let cxx_compiler = target_tool_override("CXX", &target.triple)
            .unwrap_or_else(|| xcrun_sdk_tool(sdk, "clang++"));
        config
            .define("CMAKE_SYSTEM_NAME", "iOS")
            .define("CMAKE_OSX_ARCHITECTURES", apple_arch(&target.arch))
            .define("CMAKE_OSX_SYSROOT", sdk)
            .define("CMAKE_C_COMPILER", &c_compiler)
            .define("CMAKE_CXX_COMPILER", &cxx_compiler)
            .define("CMAKE_OBJCXX_COMPILER", &cxx_compiler);
        if let Some(version) = env::var_os("IPHONEOS_DEPLOYMENT_TARGET") {
            config.define("CMAKE_OSX_DEPLOYMENT_TARGET", version);
        }
    }

    fn uses_tun_builder(&self, _target: &BuildTarget) -> bool {
        true
    }

    fn library_filename(&self, _target: &BuildTarget, mode: LinkMode) -> &'static str {
        apple_library_filename(mode)
    }

    fn emit_static_link_libraries(&self, _target: &BuildTarget) {
        emit_apple_static_link_libraries(true);
    }
}

fn apple_sdk(target: &BuildTarget) -> &'static str {
    if target.triple.ends_with("-ios-sim") || target.arch == "x86_64" {
        "iphonesimulator"
    } else {
        "iphoneos"
    }
}

fn target_tool_override(tool: &str, target: &str) -> Option<PathBuf> {
    let underscored = target.replace('-', "_");
    [
        format!("{tool}_{target}"),
        format!("{tool}_{underscored}"),
        format!("TARGET_{tool}"),
        tool.to_owned(),
    ]
    .into_iter()
    .find_map(|variable| env::var_os(variable).map(PathBuf::from))
}

fn xcrun_sdk_tool(sdk: &str, tool: &str) -> PathBuf {
    let output = Command::new("xcrun")
        .args(["--sdk", sdk, "--find", tool])
        .output()
        .unwrap_or_else(|error| panic!("failed to invoke xcrun for {sdk} {tool}: {error}"));
    assert!(
        output.status.success(),
        "xcrun could not locate {tool} in the {sdk} SDK"
    );
    let path = PathBuf::from(
        String::from_utf8(output.stdout)
            .expect("xcrun returned a non-UTF-8 tool path")
            .trim(),
    );
    assert!(
        path.is_file(),
        "xcrun returned a missing {tool} path: {}",
        path.display()
    );
    path
}

fn apple_arch(arch: &str) -> &'static str {
    match arch {
        "aarch64" => "arm64",
        "x86_64" => "x86_64",
        _ => panic!("unsupported Apple architecture: {arch}"),
    }
}
