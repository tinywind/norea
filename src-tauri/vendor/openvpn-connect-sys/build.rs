use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[path = "build/platform/mod.rs"]
mod platform;

use platform::{BuildTarget, PlatformBuild};

const OPENVPN3_PATCH: &str = include_str!("patches/openvpn3.patch");
const ASIO_PATCH: &str = include_str!("patches/asio.patch");

const PREFIX_ENV_VARS: &[(&str, &str)] = &[
    ("OPENVPN3_ASIO_DIR", "asio.hpp"),
    ("OPENVPN3_LZ4_DIR", "lz4.h"),
];
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LinkMode {
    Static,
    Dynamic,
}

#[derive(Clone, Copy)]
struct NativeFeatures {
    dco: bool,
    external_transport: bool,
    external_tun: bool,
}

impl LinkMode {
    fn detect() -> Self {
        if env::var_os("CARGO_FEATURE_VENDOR").is_some() {
            Self::Static
        } else {
            Self::Dynamic
        }
    }

    const fn cmake_type(self) -> &'static str {
        match self {
            Self::Static => "STATIC",
            Self::Dynamic => "SHARED",
        }
    }

    const fn cargo_kind(self) -> &'static str {
        match self {
            Self::Static => "static",
            Self::Dynamic => "dylib",
        }
    }
}

fn main() {
    emit_rerun_rules();
    generate_bindings();
    let sources = prepare_native_sources();

    let target = BuildTarget::from_env();
    let platform = platform::for_target(&target);
    emit_target_tool_rerun_rules(&target.triple);
    let mode = LinkMode::detect();
    let native_features = NativeFeatures {
        dco: env::var_os("CARGO_FEATURE_DCO").is_some(),
        external_transport: env::var_os("CARGO_FEATURE_EXTERNAL_TRANSPORT").is_some(),
        external_tun: env::var_os("CARGO_FEATURE_EXTERNAL_TUN").is_some(),
    };

    let dependencies =
        DependencyPaths::discover(&target.os, target.is_host(), mode, &sources.asio_include);
    let native = compile_openvpn(
        &target,
        platform.as_ref(),
        mode,
        native_features,
        &dependencies,
        &sources.openvpn3,
    );
    emit_discovered_dependency_paths(&dependencies);
    emit_native_link(&native, &target, platform.as_ref(), mode);
}

fn emit_rerun_rules() {
    for path in [
        "build/platform",
        "CMakeLists.txt",
        "src/wrapper.h",
        "src/bridge.cpp",
        "patches/openvpn3.patch",
        "patches/asio.patch",
        "vendor/asio/asio/include",
        "vendor/openvpn3/client",
        "vendor/openvpn3/openvpn",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    for (variable, _) in PREFIX_ENV_VARS {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    for variable in [
        "OHOS_NDK_HOME",
        platform::OHOS_SDK_NATIVE_ENV,
        "ANDROID_NDK_HOME",
        "ANDROID_NDK_ROOT",
        "NDK_HOME",
        "ANDROID_PLATFORM",
        "DEVELOPER_DIR",
        "SDKROOT",
        "IPHONEOS_DEPLOYMENT_TARGET",
        "DEP_LZ4_INCLUDE",
        "DEP_LZ4_ROOT",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
}

fn emit_target_tool_rerun_rules(target: &str) {
    let underscored = target.replace('-', "_");
    for tool in ["CC", "CXX"] {
        for variable in [
            format!("{tool}_{target}"),
            format!("{tool}_{underscored}"),
            format!("TARGET_{tool}"),
            tool.to_owned(),
        ] {
            println!("cargo:rerun-if-env-changed={variable}");
        }
    }
}

struct NativeSources {
    openvpn3: PathBuf,
    asio_include: PathBuf,
}

fn prepare_native_sources() -> NativeSources {
    let manifest = PathBuf::from(
        env::var_os("CARGO_MANIFEST_DIR").expect("Cargo must set CARGO_MANIFEST_DIR"),
    );
    let upstream_openvpn3 = manifest.join("vendor/openvpn3");
    let upstream_asio = manifest.join("vendor/asio/asio/include");
    require_submodule_source(
        &upstream_openvpn3.join("client/ovpncli.cpp"),
        "vendor/openvpn3",
    );
    require_submodule_source(&upstream_asio.join("asio.hpp"), "vendor/asio");

    let staging = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR"))
        .join("patched-native-source");
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .unwrap_or_else(|error| panic!("failed to reset {}: {error}", staging.display()));
    }

    let openvpn3 = staging.join("openvpn3");
    copy_tree(&upstream_openvpn3.join("client"), &openvpn3.join("client"));
    copy_tree(
        &upstream_openvpn3.join("openvpn"),
        &openvpn3.join("openvpn"),
    );
    apply_unified_patch(&openvpn3, OPENVPN3_PATCH);

    let asio = staging.join("asio");
    let asio_include = asio.join("asio/include");
    copy_tree(&upstream_asio, &asio_include);
    apply_unified_patch(&asio, ASIO_PATCH);

    NativeSources {
        openvpn3,
        asio_include,
    }
}

fn require_submodule_source(path: &Path, submodule: &str) {
    assert!(
        path.is_file(),
        "missing {submodule}; initialize sources with `git submodule update --init --recursive` before building"
    );
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination)
        .unwrap_or_else(|error| panic!("failed to create {}: {error}", destination.display()));
    let entries = fs::read_dir(source)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", source.display()));
    for entry in entries {
        let entry = entry.expect("failed to read native source entry");
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .expect("failed to read native source file type");
        if file_type.is_dir() {
            copy_tree(&source_path, &destination_path);
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).unwrap_or_else(|error| {
                panic!(
                    "failed to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            });
        } else {
            panic!("unsupported native source entry: {}", source_path.display());
        }
    }
}

fn apply_unified_patch(root: &Path, patch: &str) {
    for section in patch.split("diff --git ").filter(|value| !value.is_empty()) {
        apply_file_patch(root, section);
    }
}

fn apply_file_patch(root: &Path, section: &str) {
    let lines: Vec<&str> = section.lines().collect();
    let relative = lines
        .iter()
        .find_map(|line| line.strip_prefix("+++ b/"))
        .expect("patch section has no destination path");
    let path = root.join(relative);
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read patch target {}: {error}", path.display()));
    let had_final_newline = source.ends_with('\n');
    let original: Vec<&str> = source.lines().collect();
    let mut output = Vec::with_capacity(original.len());
    let mut cursor = 0;
    let mut index = 0;

    while index < lines.len() {
        let Some(header) = lines[index].strip_prefix("@@ ") else {
            index += 1;
            continue;
        };
        let start = old_hunk_start(header);
        let hunk_cursor = start.saturating_sub(1);
        assert!(
            hunk_cursor >= cursor && hunk_cursor <= original.len(),
            "invalid hunk position for {}",
            path.display()
        );
        output.extend(
            original[cursor..hunk_cursor]
                .iter()
                .map(ToString::to_string),
        );
        cursor = hunk_cursor;
        index += 1;

        while index < lines.len() && !lines[index].starts_with("@@ ") {
            let line = lines[index];
            if line == "\\ No newline at end of file" {
                index += 1;
                continue;
            }
            let (marker, text) = line.split_at(1);
            match marker {
                " " => {
                    verify_patch_line(&path, &original, cursor, text);
                    output.push(text.to_owned());
                    cursor += 1;
                }
                "-" => {
                    verify_patch_line(&path, &original, cursor, text);
                    cursor += 1;
                }
                "+" => output.push(text.to_owned()),
                _ => break,
            }
            index += 1;
        }
    }

    output.extend(original[cursor..].iter().map(ToString::to_string));
    let mut patched = output.join("\n");
    if had_final_newline {
        patched.push('\n');
    }
    fs::write(&path, patched)
        .unwrap_or_else(|error| panic!("failed to write patch target {}: {error}", path.display()));
}

fn old_hunk_start(header: &str) -> usize {
    header
        .split_whitespace()
        .next()
        .and_then(|range| range.strip_prefix('-'))
        .and_then(|range| range.split(',').next())
        .and_then(|start| start.parse().ok())
        .expect("invalid unified patch hunk header")
}

fn verify_patch_line(path: &Path, original: &[&str], cursor: usize, expected: &str) {
    let actual = original.get(cursor).unwrap_or_else(|| {
        panic!(
            "patch for {} extends beyond the source at line {}",
            path.display(),
            cursor + 1
        )
    });
    assert_eq!(
        *actual,
        expected,
        "source drift while applying patch to {} at line {}",
        path.display(),
        cursor + 1
    );
}

fn generate_bindings() {
    let bindings = bindgen::Builder::default()
        .header("src/wrapper.h")
        .allowlist_function("ovpn_.*")
        .allowlist_type("ovpn_.*")
        .derive_default(true)
        .generate_comments(true)
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .expect("failed to generate OpenVPN C ABI bindings; is libclang installed?");

    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must set OUT_DIR"));
    bindings
        .write_to_file(out.join("bindings.rs"))
        .expect("failed to write generated OpenVPN bindings");
}

#[derive(Debug)]
struct NativeLibrary {
    lib_dir: PathBuf,
    runtime_dir: Option<PathBuf>,
    _library_file: PathBuf,
}

#[derive(Debug)]
struct DependencyPaths {
    asio_include: PathBuf,
    lz4_include: PathBuf,
    lz4_lib: Option<PathBuf>,
}

impl DependencyPaths {
    fn discover(
        target_os: &str,
        host_build: bool,
        mode: LinkMode,
        patched_asio_include: &Path,
    ) -> Self {
        if mode == LinkMode::Static {
            return Self::vendored(patched_asio_include);
        }

        let asio_include = dependency_prefix_override("OPENVPN3_ASIO_DIR", "asio.hpp").map_or_else(
            || patched_asio_include.to_path_buf(),
            |prefix| prefix.join("include"),
        );
        let lz4 = dependency_prefix(
            "OPENVPN3_LZ4_DIR",
            "lz4.h",
            target_os,
            host_build,
            &["lz4", "lz4"],
        );
        Self {
            asio_include: absolute(asio_include),
            lz4_include: absolute(lz4.join("include")),
            lz4_lib: library_dir(&lz4).map(absolute),
        }
    }

    fn vendored(patched_asio_include: &Path) -> Self {
        let lz4_include = cargo_metadata_path("DEP_LZ4_INCLUDE", "lz4-sys");
        let lz4_root = cargo_metadata_path("DEP_LZ4_ROOT", "lz4-sys");

        Self {
            asio_include: absolute(patched_asio_include.to_path_buf()),
            lz4_include: absolute(lz4_include),
            lz4_lib: library_dir_or_root(&lz4_root).map(absolute),
        }
    }
}

fn dependency_prefix_override(env_var: &str, header: &str) -> Option<PathBuf> {
    let prefix = PathBuf::from(env::var_os(env_var)?);
    assert_header(&prefix, header, env_var);
    Some(prefix)
}

fn cargo_metadata_path(variable: &str, dependency: &str) -> PathBuf {
    env::var_os(variable).map_or_else(
        || {
            panic!(
                "Cargo did not provide {variable} from {dependency}; the `vendor` feature requires its source-built native metadata"
            )
        },
        PathBuf::from,
    )
}

fn dependency_prefix(
    env_var: &str,
    header: &str,
    target_os: &str,
    host_build: bool,
    mac_formulae: &[&str],
) -> PathBuf {
    if let Some(prefix) = dependency_prefix_override(env_var, header) {
        return prefix;
    }

    if host_build && (target_os == "macos" || target_os == "ios") {
        for homebrew_root in ["/opt/homebrew/opt", "/usr/local/opt"] {
            for formula in mac_formulae {
                let prefix = Path::new(homebrew_root).join(formula);
                if prefix.join("include").join(header).is_file() {
                    return prefix;
                }
            }
        }
    }

    if host_build {
        let system = PathBuf::from("/usr");
        if system.join("include").join(header).is_file() {
            return system;
        }
    }

    panic!(
        "could not find {header} for {target_os}; install its development package, set {env_var} to the target dependency prefix, or enable the `vendor` feature"
    );
}

fn assert_header(prefix: &Path, header: &str, env_var: &str) {
    assert!(
        prefix.join("include").join(header).is_file(),
        "{env_var}={} does not contain include/{header}",
        prefix.display()
    );
}

fn library_dir(prefix: &Path) -> Option<PathBuf> {
    [prefix.join("lib"), prefix.join("lib64")]
        .into_iter()
        .find(|path| path.is_dir())
}

fn library_dir_or_root(prefix: &Path) -> Option<PathBuf> {
    library_dir(prefix).or_else(|| prefix.is_dir().then(|| prefix.to_path_buf()))
}

fn absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .expect("failed to read current directory")
            .join(path)
    }
}

fn compile_openvpn(
    target: &BuildTarget,
    platform: &dyn PlatformBuild,
    mode: LinkMode,
    features: NativeFeatures,
    dependencies: &DependencyPaths,
    openvpn3_source: &Path,
) -> NativeLibrary {
    let mut config = cmake::Config::new(".");
    config
        .define("OPENVPN_CONNECT_LIBRARY_TYPE", mode.cmake_type())
        .define("OPENVPN_CONNECT_OPENVPN3_DIR", openvpn3_source)
        .define("OPENVPN_CONNECT_ASIO_INCLUDE", &dependencies.asio_include)
        .define("OPENVPN_CONNECT_LZ4_INCLUDE", &dependencies.lz4_include)
        .define("OPENVPN_CONNECT_FORCE_NULL_TUN", "OFF")
        .define(
            "OPENVPN_CONNECT_ENABLE_DCO",
            if features.dco { "ON" } else { "OFF" },
        )
        .define(
            "OPENVPN_CONNECT_EXTERNAL_TRANSPORT",
            if features.external_transport {
                "ON"
            } else {
                "OFF"
            },
        )
        .define(
            "OPENVPN_CONNECT_EXTERNAL_TUN",
            if features.external_tun { "ON" } else { "OFF" },
        )
        .define(
            "OPENVPN_CONNECT_USE_TUN_BUILDER",
            if platform.uses_tun_builder(target) {
                "ON"
            } else {
                "OFF"
            },
        );

    if let Some(path) = &dependencies.lz4_lib {
        config.define("OPENVPN_CONNECT_LZ4_LIBRARY_DIR", path);
    }
    platform.configure_cmake(&mut config, target, mode);

    let destination = config.build();
    let lib_dir = destination.join("lib");
    platform.finish(&lib_dir, target);
    let runtime = destination.join("bin");
    let library_file = lib_dir.join(platform.library_filename(target, mode));
    assert!(
        library_file.is_file(),
        "CMake completed but did not produce {}",
        library_file.display()
    );
    NativeLibrary {
        lib_dir,
        runtime_dir: runtime.is_dir().then_some(runtime),
        _library_file: library_file,
    }
}

fn emit_native_link(
    native: &NativeLibrary,
    target: &BuildTarget,
    platform: &dyn PlatformBuild,
    mode: LinkMode,
) {
    println!(
        "cargo:rustc-link-search=native={}",
        native.lib_dir.display()
    );
    println!("cargo:rustc-link-lib={}=openvpn3_core", mode.cargo_kind());

    if mode == LinkMode::Dynamic {
        if platform.supports_rpath(target) {
            emit_rpath(&native.lib_dir);
            if let Some(runtime) = &native.runtime_dir {
                emit_rpath(runtime);
            }
        }
        return;
    }

    platform.emit_static_link_libraries(target);
}

fn emit_discovered_dependency_paths(dependencies: &DependencyPaths) {
    for path in [&dependencies.lz4_lib].into_iter().flatten() {
        println!("cargo:rustc-link-search=native={}", path.display());
    }
}

fn emit_rpath(path: &Path) {
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", path.display());
}
