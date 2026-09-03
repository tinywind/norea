use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::{BuildTarget, PlatformBuild, unix_library_filename};
use crate::LinkMode;

pub(crate) const SDK_NATIVE_ENV: &str = "OHOS_SDK_NATIVE";

pub(super) struct OpenHarmony;

impl PlatformBuild for OpenHarmony {
    fn configure_cmake(&self, config: &mut cmake::Config, target: &BuildTarget, mode: LinkMode) {
        let sdk = sdk_native();
        config
            .define(
                "CMAKE_TOOLCHAIN_FILE",
                sdk.join("build/cmake/ohos.toolchain.cmake"),
            )
            .define("OHOS_ARCH", ohos_arch(&target.arch))
            .define(
                "OHOS_STL",
                if mode == LinkMode::Static {
                    "c++_static"
                } else {
                    "c++_shared"
                },
            );
    }

    fn uses_tun_builder(&self, _target: &BuildTarget) -> bool {
        true
    }

    fn library_filename(&self, _target: &BuildTarget, mode: LinkMode) -> &'static str {
        unix_library_filename(mode)
    }

    fn finish(&self, lib_dir: &Path, target: &BuildTarget) {
        if target.arch == "arm" {
            install_atomic_compatibility_archive(lib_dir, target);
        }
    }

    fn supports_rpath(&self, _target: &BuildTarget) -> bool {
        true
    }

    fn emit_static_link_libraries(&self, _target: &BuildTarget) {
        println!("cargo:rustc-link-lib=c++_static");
        println!("cargo:rustc-link-lib=c++abi");
        println!("cargo:rustc-link-lib=unwind");
        println!("cargo:rustc-link-lib=pthread");
    }
}

fn install_atomic_compatibility_archive(lib_dir: &Path, target: &BuildTarget) {
    // Rust's tier-2 ARMv7 OHOS target requests `-latomic`, while the official
    // SDK exposes those exact __atomic_* implementations only through its
    // compiler-rt builtins archive. Give the SDK archive the conventional
    // linker name in this build output; no prebuilt library enters the crate.
    let sdk = sdk_native();
    let compiler = target_c_compiler(target, &sdk);
    let output = Command::new(&compiler)
        .arg("-print-libgcc-file-name")
        .output()
        .unwrap_or_else(|error| panic!("failed to query {}: {error}", compiler.display()));
    assert!(
        output.status.success(),
        "{} could not locate its compiler runtime",
        compiler.display()
    );
    let builtins = PathBuf::from(
        String::from_utf8(output.stdout)
            .expect("target compiler returned a non-UTF-8 runtime path")
            .trim(),
    );
    assert!(
        builtins.is_file(),
        "target compiler runtime does not exist: {}",
        builtins.display()
    );
    let atomic = lib_dir.join("libatomic.a");
    fs::copy(&builtins, &atomic).unwrap_or_else(|error| {
        panic!(
            "failed to expose {} as {}: {error}",
            builtins.display(),
            atomic.display()
        )
    });
}

fn target_c_compiler(target: &BuildTarget, sdk: &Path) -> PathBuf {
    let prefix = match target.arch.as_str() {
        "aarch64" => "aarch64",
        "arm" => "armv7",
        "x86_64" => "x86_64",
        arch => panic!("unsupported OpenHarmony compiler architecture: {arch}"),
    };
    sdk.join(format!("llvm/bin/{prefix}-unknown-linux-ohos-clang"))
}

fn sdk_native() -> PathBuf {
    let (candidate, source) = if let Some(path) = env::var_os(SDK_NATIVE_ENV) {
        (PathBuf::from(path), SDK_NATIVE_ENV)
    } else if let Some(path) = env::var_os("OHOS_NDK_HOME") {
        let root = PathBuf::from(path);
        let native = root.join("native");
        (
            if native.join("sysroot").is_dir() {
                native
            } else {
                root
            },
            "OHOS_NDK_HOME",
        )
    } else {
        panic!("OpenHarmony Native SDK is not configured; set {SDK_NATIVE_ENV} or OHOS_NDK_HOME");
    };
    assert!(
        candidate.join("sysroot").is_dir()
            && candidate.join("build/cmake/ohos.toolchain.cmake").is_file(),
        "{source}={} is not a complete OpenHarmony Native SDK root",
        candidate.display()
    );
    candidate
}

fn ohos_arch(arch: &str) -> &'static str {
    match arch {
        "aarch64" => "arm64-v8a",
        "arm" => "armeabi-v7a",
        "x86_64" => "x86_64",
        _ => panic!("unsupported OpenHarmony architecture: {arch}"),
    }
}
