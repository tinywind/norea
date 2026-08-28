use std::env;
use std::path::PathBuf;

use super::{BuildTarget, PlatformBuild, unix_library_filename};
use crate::LinkMode;

pub(super) struct Android;

impl PlatformBuild for Android {
    fn configure_cmake(&self, config: &mut cmake::Config, target: &BuildTarget, mode: LinkMode) {
        let ndk = android_ndk();
        config
            .define(
                "CMAKE_TOOLCHAIN_FILE",
                ndk.join("build/cmake/android.toolchain.cmake"),
            )
            .define("ANDROID_ABI", android_abi(&target.arch))
            .define(
                "ANDROID_PLATFORM",
                env::var_os("ANDROID_PLATFORM").unwrap_or_else(|| "android-24".into()),
            )
            .define(
                "ANDROID_STL",
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

    fn emit_static_link_libraries(&self, _target: &BuildTarget) {
        println!("cargo:rustc-link-lib=c++_static");
        println!("cargo:rustc-link-lib=c++abi");
    }
}

fn android_ndk() -> PathBuf {
    for variable in ["ANDROID_NDK_HOME", "ANDROID_NDK_ROOT", "NDK_HOME"] {
        if let Some(path) = env::var_os(variable) {
            let root = PathBuf::from(path);
            assert!(
                root.join("build/cmake/android.toolchain.cmake").is_file(),
                "{variable}={} is not a complete Android NDK root",
                root.display()
            );
            return root;
        }
    }
    panic!("Android NDK is not configured; set ANDROID_NDK_HOME, ANDROID_NDK_ROOT, or NDK_HOME");
}

fn android_abi(arch: &str) -> &'static str {
    match arch {
        "aarch64" => "arm64-v8a",
        "arm" => "armeabi-v7a",
        "x86_64" => "x86_64",
        "x86" => "x86",
        _ => panic!("unsupported Android architecture: {arch}"),
    }
}
