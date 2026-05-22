use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[cfg(not(target_os = "android"))]
use std::{
    fs::OpenOptions,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
#[cfg(not(target_os = "android"))]
use tauri_plugin_opener::OpenerExt;

use crate::native_stream::{self, NativeStreamState};

const BYTES_PER_MIB: u64 = 1024 * 1024;
const MAX_UPDATE_BYTES: u64 = 512 * BYTES_PER_MIB;
const MAX_UPDATE_ZIP_ENTRIES: usize = 10_000;
const MAX_UPDATE_ZIP_ENTRY_BYTES: u64 = 256 * BYTES_PER_MIB;
const MAX_UPDATE_ZIP_TOTAL_UNCOMPRESSED_BYTES: u64 = 2 * 1024 * BYTES_PER_MIB;
const MAX_UPDATE_ZIP_COMPRESSION_RATIO: u64 = 100;
const UPDATE_DOWNLOAD_DIR: &str = "Norea Updates";
const UPDATE_HANDLE_DOMAIN: &str = "update";

#[derive(Debug, Clone, Copy)]
struct UpdateZipLimits {
    max_entries: usize,
    max_entry_bytes: u64,
    max_total_uncompressed_bytes: u64,
    max_compression_ratio: u64,
}

impl UpdateZipLimits {
    const DEFAULT: Self = Self {
        max_entries: MAX_UPDATE_ZIP_ENTRIES,
        max_entry_bytes: MAX_UPDATE_ZIP_ENTRY_BYTES,
        max_total_uncompressed_bytes: MAX_UPDATE_ZIP_TOTAL_UNCOMPRESSED_BYTES,
        max_compression_ratio: MAX_UPDATE_ZIP_COMPRESSION_RATIO,
    };
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    build_channel: Option<&'static str>,
    build_time: Option<&'static str>,
    build_version: Option<&'static str>,
    git_sha: Option<&'static str>,
    github_run_attempt: Option<&'static str>,
    github_run_id: Option<&'static str>,
    platform: String,
    target_arch: &'static str,
    target_family: &'static str,
    target_os: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallMetadata {
    size: u64,
    sha256: String,
    signature: Option<String>,
    signing_key_id: Option<String>,
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        build_channel: empty_to_none(option_env!("NOREA_BUILD_CHANNEL")),
        build_time: empty_to_none(option_env!("NOREA_BUILD_TIME")),
        build_version: empty_to_none(option_env!("NOREA_BUILD_VERSION")),
        git_sha: empty_to_none(option_env!("NOREA_GIT_SHA")),
        github_run_attempt: empty_to_none(option_env!("NOREA_GITHUB_RUN_ATTEMPT")),
        github_run_id: empty_to_none(option_env!("NOREA_GITHUB_RUN_ID")),
        platform: current_platform(),
        target_arch: std::env::consts::ARCH,
        target_family: std::env::consts::FAMILY,
        target_os: std::env::consts::OS,
    }
}

#[tauri::command]
pub async fn download_and_open_update(
    app: AppHandle,
    url: String,
    file_name: String,
    metadata: UpdateInstallMetadata,
) -> Result<String, String> {
    if !is_allowed_update_url(&url) {
        return Err("unsupported update host".to_string());
    }

    let updates_dir = update_download_dir(&app)?;
    fs::create_dir_all(&updates_dir)
        .map_err(|err| format!("update directory unavailable: {err}"))?;
    let temp_path = download_update_to_temp_file(&url, &updates_dir, &file_name, &metadata).await?;
    let result = save_and_open_update_file(app, &file_name, &temp_path, &metadata);
    let _ = fs::remove_file(temp_path);
    result
}

#[tauri::command]
#[cfg(not(target_os = "android"))]
pub fn open_downloaded_update() -> Result<String, String> {
    Err("renderer-supplied update bytes are disabled on desktop; use native download".to_string())
}

#[tauri::command]
#[cfg(target_os = "android")]
pub fn open_downloaded_update(
    app: AppHandle,
    url: String,
    file_name: String,
    bytes: Vec<u8>,
    metadata: UpdateInstallMetadata,
) -> Result<String, String> {
    if !is_allowed_update_url(&url) {
        return Err("unsupported update host".to_string());
    }

    save_and_open_update(app, &file_name, bytes, &metadata)
}

#[cfg(not(target_os = "android"))]
async fn download_update_to_temp_file(
    url: &str,
    updates_dir: &Path,
    file_name: &str,
    metadata: &UpdateInstallMetadata,
) -> Result<PathBuf, String> {
    validate_update_metadata(metadata)?;
    let response = reqwest::Client::new()
        .get(url)
        .header(reqwest::header::USER_AGENT, "Norea")
        .send()
        .await
        .map_err(|err| format!("download request failed: {err}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "download failed with HTTP {}",
            response.status().as_u16()
        ));
    }

    if let Some(content_length) = response.content_length() {
        validate_update_size(content_length)?;
        validate_expected_size(content_length, metadata.size)?;
    }

    let (mut temp_file, temp_path) = create_temp_download_file(updates_dir, file_name)?;
    let result = stream_response_to_file(response, &mut temp_file, metadata).await;
    match result {
        Ok(()) => Ok(temp_path),
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            Err(err)
        }
    }
}

#[cfg(target_os = "android")]
async fn download_update_to_temp_file(
    _url: &str,
    _updates_dir: &Path,
    _file_name: &str,
    _metadata: &UpdateInstallMetadata,
) -> Result<PathBuf, String> {
    Err("native update downloads are disabled on Android".to_string())
}

#[tauri::command]
pub fn open_downloaded_update_handle(
    app: AppHandle,
    state: State<'_, NativeStreamState>,
    handle: String,
    file_name: String,
    metadata: UpdateInstallMetadata,
) -> Result<String, String> {
    let source_path =
        native_stream::take_finished_path(&app, &state, &handle, Some(UPDATE_HANDLE_DOMAIN))?;
    let result = save_and_open_update_file(app, &file_name, &source_path, &metadata);
    let _ = fs::remove_file(source_path);
    result
}

#[cfg(target_os = "android")]
fn save_and_open_update(
    app: AppHandle,
    file_name: &str,
    bytes: Vec<u8>,
    metadata: &UpdateInstallMetadata,
) -> Result<String, String> {
    verify_update_bytes(&bytes, metadata)?;
    let updates_dir = update_download_dir(&app)?;
    fs::create_dir_all(&updates_dir)
        .map_err(|err| format!("update directory unavailable: {err}"))?;

    let archive_path = updates_dir.join(sanitize_file_name(file_name));
    fs::write(&archive_path, &bytes).map_err(|err| format!("download save failed: {err}"))?;
    open_update_artifact(&app, file_name, &archive_path, &updates_dir)
}

fn save_and_open_update_file(
    app: AppHandle,
    file_name: &str,
    source_path: &Path,
    metadata: &UpdateInstallMetadata,
) -> Result<String, String> {
    verify_update_file(source_path, metadata)?;
    let updates_dir = update_download_dir(&app)?;
    fs::create_dir_all(&updates_dir)
        .map_err(|err| format!("update directory unavailable: {err}"))?;

    let archive_path = updates_dir.join(sanitize_file_name(file_name));
    copy_file_with_limit(source_path, &archive_path, metadata.size)?;
    open_update_artifact(&app, file_name, &archive_path, &updates_dir)
}

fn open_update_artifact(
    app: &AppHandle,
    file_name: &str,
    archive_path: &Path,
    updates_dir: &Path,
) -> Result<String, String> {
    let is_archive = is_zip_archive_file(archive_path)?;
    let installer_path = if is_installer_file_name(file_name) {
        archive_path.to_path_buf()
    } else if is_archive {
        extract_installer_from_zip(&archive_path, &updates_dir)?
    } else {
        archive_path.to_path_buf()
    };

    mark_executable_if_needed(&installer_path)?;
    open_installer(app, &installer_path)?;

    Ok(installer_path.to_string_lossy().to_string())
}

fn update_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        Ok(app
            .path()
            .app_cache_dir()
            .map_err(|err| format!("app cache directory unavailable: {err}"))?
            .join(UPDATE_DOWNLOAD_DIR))
    }

    #[cfg(not(target_os = "android"))]
    {
        Ok(app
            .path()
            .download_dir()
            .map_err(|err| format!("downloads directory unavailable: {err}"))?
            .join(UPDATE_DOWNLOAD_DIR))
    }
}

#[cfg(not(target_os = "android"))]
fn open_installer(app: &AppHandle, installer_path: &Path) -> Result<(), String> {
    app.opener()
        .open_path(installer_path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| format!("installer open failed: {err}"))
}

#[cfg(target_os = "android")]
fn open_installer(_app: &AppHandle, _installer_path: &Path) -> Result<(), String> {
    Ok(())
}

fn empty_to_none(value: Option<&'static str>) -> Option<&'static str> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn current_platform() -> String {
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };

    if os == "android" {
        return match std::env::consts::ARCH {
            "aarch64" => "android-arm64".to_string(),
            "x86_64" => "android-x86_64".to_string(),
            other => format!("android-{other}"),
        };
    }

    format!("{os}-{arch}")
}

fn is_allowed_update_url(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }

    match parsed.host_str() {
        Some("github.com") => parsed.path().starts_with("/tinywind/norea/"),
        Some("api.github.com") => parsed.path().starts_with("/repos/tinywind/norea/"),
        _ => false,
    }
}

fn sanitize_file_name(file_name: &str) -> String {
    let sanitized: String = file_name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            item if item.is_control() => '-',
            item => item,
        })
        .collect();
    let trimmed = sanitized.trim_matches(['.', ' ', '-']);

    if trimmed.is_empty() {
        "norea-update".to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_zip_archive_file(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|err| format!("artifact open failed: {err}"))?;
    let mut header = [0u8; 4];
    let read = file
        .read(&mut header)
        .map_err(|err| format!("artifact header read failed: {err}"))?;
    Ok(is_zip_archive_header(&header[..read]))
}

fn is_zip_archive_header(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"PK\x05\x06")
        || bytes.starts_with(b"PK\x07\x08")
}

fn is_installer_file_name(file_name: &str) -> bool {
    installer_priority(file_name).is_some()
}

fn extract_installer_from_zip(zip_path: &Path, updates_dir: &Path) -> Result<PathBuf, String> {
    extract_installer_from_zip_with_limits(zip_path, updates_dir, UpdateZipLimits::DEFAULT)
}

fn extract_installer_from_zip_with_limits(
    zip_path: &Path,
    updates_dir: &Path,
    limits: UpdateZipLimits,
) -> Result<PathBuf, String> {
    let zip_file = File::open(zip_path).map_err(|err| format!("artifact open failed: {err}"))?;
    let mut archive =
        zip::ZipArchive::new(zip_file).map_err(|err| format!("artifact unzip failed: {err}"))?;

    if archive.len() > limits.max_entries {
        return Err(format!(
            "artifact has {} entries, which exceeds the {} entry limit",
            archive.len(),
            limits.max_entries
        ));
    }

    let mut selected_index: Option<(usize, u8)> = None;
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|err| format!("artifact entry read failed: {err}"))?;
        validate_zip_entry_metadata(&entry, limits)?;
        total_uncompressed = add_update_zip_total(total_uncompressed, entry.size(), limits)?;
        if entry.is_dir() {
            normalize_safe_zip_entry_path(entry.name())?;
            continue;
        }
        let entry_name = safe_zip_entry_file_name(entry.name())?;
        let Some(priority) = installer_priority(&entry_name) else {
            continue;
        };
        if selected_index
            .map(|(_, selected_priority)| priority < selected_priority)
            .unwrap_or(true)
        {
            selected_index = Some((index, priority));
        }
    }

    let (index, _) = selected_index.ok_or_else(|| {
        "artifact did not contain a supported installer for this platform".to_string()
    })?;
    let mut entry = archive
        .by_index(index)
        .map_err(|err| format!("installer entry read failed: {err}"))?;
    validate_zip_entry_metadata(&entry, limits)?;
    let entry_name = safe_zip_entry_file_name(entry.name())?;
    let target_path = updates_dir.join(sanitize_file_name(&entry_name));
    let mut output =
        File::create(&target_path).map_err(|err| format!("installer create failed: {err}"))?;
    let copied = copy_with_limit(&mut entry, &mut output, limits.max_entry_bytes)?;
    validate_expected_size(copied, entry.size())?;

    Ok(target_path)
}

fn validate_update_metadata(metadata: &UpdateInstallMetadata) -> Result<(), String> {
    validate_update_size(metadata.size)?;
    normalize_sha256(&metadata.sha256)?;
    let _ = metadata.signature.as_deref();
    let _ = metadata.signing_key_id.as_deref();
    Ok(())
}

#[cfg(target_os = "android")]
fn verify_update_bytes(bytes: &[u8], metadata: &UpdateInstallMetadata) -> Result<(), String> {
    validate_update_metadata(metadata)?;
    let size = u64::try_from(bytes.len()).map_err(|_| "update size is too large".to_string())?;
    validate_update_size(size)?;
    validate_expected_size(size, metadata.size)?;
    let actual_sha256 = sha256_hex(bytes);
    validate_expected_sha256(&actual_sha256, &metadata.sha256)
}

fn verify_update_file(path: &Path, metadata: &UpdateInstallMetadata) -> Result<(), String> {
    validate_update_metadata(metadata)?;
    let file_size = fs::metadata(path)
        .map_err(|err| format!("update metadata read failed: {err}"))?
        .len();
    validate_update_size(file_size)?;
    validate_expected_size(file_size, metadata.size)?;

    let mut file = File::open(path).map_err(|err| format!("update open failed: {err}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| format!("update read failed: {err}"))?;
        if read == 0 {
            break;
        }
        let read_u64 = u64::try_from(read).map_err(|_| "update read size overflow".to_string())?;
        total = total
            .checked_add(read_u64)
            .ok_or_else(|| "update size overflow".to_string())?;
        validate_update_size(total)?;
        hasher.update(&buffer[..read]);
    }
    validate_expected_size(total, metadata.size)?;
    let actual_sha256 = format!("{:x}", hasher.finalize());
    validate_expected_sha256(&actual_sha256, &metadata.sha256)
}

#[cfg(not(target_os = "android"))]
async fn stream_response_to_file(
    mut response: reqwest::Response,
    output: &mut File,
    metadata: &UpdateInstallMetadata,
) -> Result<(), String> {
    let mut hasher = Sha256::new();
    let mut total = 0u64;

    loop {
        let Some(chunk) = response
            .chunk()
            .await
            .map_err(|err| format!("download read failed: {err}"))?
        else {
            break;
        };
        let chunk_len =
            u64::try_from(chunk.len()).map_err(|_| "download chunk size overflow".to_string())?;
        total = total
            .checked_add(chunk_len)
            .ok_or_else(|| "download size overflow".to_string())?;
        validate_update_size(total)?;
        output
            .write_all(&chunk)
            .map_err(|err| format!("download save failed: {err}"))?;
        hasher.update(&chunk);
    }

    output
        .flush()
        .map_err(|err| format!("download flush failed: {err}"))?;
    validate_expected_size(total, metadata.size)?;
    let actual_sha256 = format!("{:x}", hasher.finalize());
    validate_expected_sha256(&actual_sha256, &metadata.sha256)
}

fn validate_update_size(size: u64) -> Result<(), String> {
    if size > MAX_UPDATE_BYTES {
        return Err(format!(
            "update is {size} bytes, which exceeds the {MAX_UPDATE_BYTES} byte limit"
        ));
    }
    Ok(())
}

fn validate_expected_size(actual: u64, expected: u64) -> Result<(), String> {
    if actual != expected {
        return Err("update size does not match metadata".to_string());
    }
    Ok(())
}

fn validate_expected_sha256(actual: &str, expected: &str) -> Result<(), String> {
    let expected = normalize_sha256(expected)?;
    if actual != expected {
        return Err("update SHA-256 does not match metadata".to_string());
    }
    Ok(())
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("update metadata SHA-256 is invalid".to_string());
    }
    Ok(normalized)
}

#[cfg(target_os = "android")]
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(not(target_os = "android"))]
fn create_temp_download_file(
    updates_dir: &Path,
    file_name: &str,
) -> Result<(File, PathBuf), String> {
    let sanitized = sanitize_file_name(file_name);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("download temp clock failed: {err}"))?
        .as_nanos();
    let pid = std::process::id();

    for attempt in 0..16 {
        let path = updates_dir.join(format!("{sanitized}.{pid}.{now}.{attempt}.tmp"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("download temp create failed: {err}")),
        }
    }

    Err("download temp create failed: no unique file name available".to_string())
}

fn copy_file_with_limit(source: &Path, target: &Path, expected_size: u64) -> Result<(), String> {
    let mut input =
        File::open(source).map_err(|err| format!("update source open failed: {err}"))?;
    let mut output = File::create(target).map_err(|err| format!("download save failed: {err}"))?;
    let copied = copy_with_limit(&mut input, &mut output, MAX_UPDATE_BYTES)?;
    validate_expected_size(copied, expected_size)
}

fn copy_with_limit<R: Read, W: Write>(
    input: &mut R,
    output: &mut W,
    max_bytes: u64,
) -> Result<u64, String> {
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|err| format!("update copy read failed: {err}"))?;
        if read == 0 {
            break;
        }
        let read_u64 = u64::try_from(read).map_err(|_| "update copy size overflow".to_string())?;
        let next = total
            .checked_add(read_u64)
            .ok_or_else(|| "update copy size overflow".to_string())?;
        if next > max_bytes {
            return Err(format!("update stream exceeds the {max_bytes} byte limit"));
        }
        output
            .write_all(&buffer[..read])
            .map_err(|err| format!("update copy write failed: {err}"))?;
        total = next;
    }
    output
        .flush()
        .map_err(|err| format!("update copy flush failed: {err}"))?;
    Ok(total)
}

fn validate_zip_entry_metadata<R: Read>(
    entry: &zip::read::ZipFile<'_, R>,
    limits: UpdateZipLimits,
) -> Result<(), String> {
    if is_zip_symlink(entry.unix_mode()) {
        return Err("artifact contains an unsafe symlink entry".to_string());
    }
    if entry.size() > limits.max_entry_bytes {
        return Err(format!(
            "artifact entry is {} bytes, which exceeds the {} byte limit",
            entry.size(),
            limits.max_entry_bytes
        ));
    }
    validate_zip_compression_ratio(entry.compressed_size(), entry.size(), limits)
}

fn validate_zip_compression_ratio(
    compressed_size: u64,
    uncompressed_size: u64,
    limits: UpdateZipLimits,
) -> Result<(), String> {
    if uncompressed_size == 0 {
        return Ok(());
    }
    if compressed_size == 0 {
        return Err("artifact entry has an invalid compressed size".to_string());
    }
    let max_uncompressed = compressed_size.saturating_mul(limits.max_compression_ratio);
    if uncompressed_size > max_uncompressed {
        return Err("artifact entry compression ratio is too high".to_string());
    }
    Ok(())
}

fn add_update_zip_total(
    total: u64,
    entry_size: u64,
    limits: UpdateZipLimits,
) -> Result<u64, String> {
    let next = total
        .checked_add(entry_size)
        .ok_or_else(|| "artifact uncompressed size overflow".to_string())?;
    if next > limits.max_total_uncompressed_bytes {
        return Err(format!(
            "artifact total uncompressed size is {next} bytes, which exceeds the {} byte limit",
            limits.max_total_uncompressed_bytes
        ));
    }
    Ok(next)
}

fn safe_zip_entry_file_name(name: &str) -> Result<String, String> {
    let normalized = normalize_safe_zip_entry_path(name)?;
    if normalized.ends_with('/') {
        return Err("artifact entry name is invalid".to_string());
    }
    normalized
        .rsplit('/')
        .next()
        .map(ToString::to_string)
        .ok_or_else(|| "artifact entry name is invalid".to_string())
}

fn normalize_safe_zip_entry_path(name: &str) -> Result<String, String> {
    if name.contains('\0') {
        return Err("artifact contains an unsafe entry name".to_string());
    }
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err("artifact contains an unsafe entry name".to_string());
    }
    let path = normalized.trim_end_matches('/');
    if path.is_empty() {
        return Err("artifact contains an unsafe entry name".to_string());
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("artifact contains an unsafe entry name".to_string());
        }
    }
    Ok(normalized)
}

fn is_zip_symlink(unix_mode: Option<u32>) -> bool {
    unix_mode
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

fn installer_priority(name: &str) -> Option<u8> {
    let lower_name = name.to_ascii_lowercase();

    match std::env::consts::OS {
        "windows" if lower_name.ends_with(".exe") => Some(0),
        "windows" if lower_name.ends_with(".msi") => Some(1),
        "linux" if lower_name.ends_with(".appimage") => Some(0),
        "linux" if lower_name.ends_with(".deb") => Some(1),
        "linux" if lower_name.ends_with(".rpm") => Some(2),
        "android" => android_apk_priority(&lower_name),
        _ => None,
    }
}

fn android_apk_priority(name: &str) -> Option<u8> {
    if !name.ends_with(".apk") {
        return None;
    }

    if is_current_android_arch_apk(name) {
        return Some(0);
    }
    if is_universal_android_apk(name) {
        return Some(1);
    }
    if is_other_android_arch_apk(name) {
        return None;
    }

    Some(2)
}

fn is_current_android_arch_apk(name: &str) -> bool {
    match std::env::consts::ARCH {
        "aarch64" => name.contains("arm64") || name.contains("aarch64"),
        "x86_64" => name.contains("x86_64") || name.contains("x64"),
        "arm" => name.contains("armeabi") || name.contains("armv7"),
        "x86" => name.contains("x86") && !name.contains("x86_64"),
        _ => false,
    }
}

fn is_other_android_arch_apk(name: &str) -> bool {
    let known_arch = [
        "arm64", "aarch64", "armeabi", "armv7", "x86_64", "x64", "x86",
    ];
    known_arch.iter().any(|token| name.contains(token)) && !is_current_android_arch_apk(name)
}

fn is_universal_android_apk(name: &str) -> bool {
    name.contains("universal") || name.contains("fat")
}

#[cfg(unix)]
fn mark_executable_if_needed(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let is_app_image = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("AppImage"));
    if !is_app_image {
        return Ok(());
    }

    let mut permissions = fs::metadata(path)
        .map_err(|err| format!("installer metadata failed: {err}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|err| format!("installer permission update failed: {err}"))
}

#[cfg(not(unix))]
fn mark_executable_if_needed(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufWriter, Cursor};
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    fn test_zip_limits() -> UpdateZipLimits {
        UpdateZipLimits {
            max_entries: 8,
            max_entry_bytes: 16,
            max_total_uncompressed_bytes: 64,
            max_compression_ratio: MAX_UPDATE_ZIP_COMPRESSION_RATIO,
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).expect("create zip");
        let mut zip = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, body) in entries {
            zip.start_file(*name, options).expect("start file");
            zip.write_all(body).expect("write body");
        }
        zip.finish().expect("finish zip");
    }

    fn metadata_for(bytes: &[u8]) -> UpdateInstallMetadata {
        UpdateInstallMetadata {
            sha256: sha256_hex(bytes),
            signature: None,
            signing_key_id: None,
            size: u64::try_from(bytes.len()).expect("test size"),
        }
    }

    #[cfg(target_os = "windows")]
    fn installer_fixture_names() -> (&'static str, &'static str) {
        ("norea.exe", "norea.msi")
    }

    #[cfg(target_os = "linux")]
    fn installer_fixture_names() -> (&'static str, &'static str) {
        ("norea.AppImage", "norea.deb")
    }

    #[cfg(target_os = "android")]
    fn installer_fixture_names() -> (&'static str, &'static str) {
        if cfg!(target_arch = "aarch64") {
            ("norea-arm64.apk", "norea-universal.apk")
        } else if cfg!(target_arch = "x86_64") {
            ("norea-x86_64.apk", "norea-universal.apk")
        } else {
            ("norea-universal.apk", "norea.apk")
        }
    }

    #[test]
    fn update_url_allowlist_parses_scheme_host_and_path() {
        assert!(is_allowed_update_url(
            "https://github.com/tinywind/norea/releases/download/v0.1.0/norea.zip"
        ));
        assert!(is_allowed_update_url(
            "https://api.github.com/repos/tinywind/norea/releases/latest"
        ));
        assert!(!is_allowed_update_url(
            "http://github.com/tinywind/norea/releases/download/v0.1.0/norea.zip"
        ));
        assert!(!is_allowed_update_url(
            "https://github.com.evil/tinywind/norea/releases/download/v0.1.0/norea.zip"
        ));
        assert!(!is_allowed_update_url(
            "https://user@github.com/tinywind/norea/releases/download/v0.1.0/norea.zip"
        ));
        assert!(!is_allowed_update_url(
            "https://github.com/tinywind/not-norea/releases/download/v0.1.0/norea.zip"
        ));
    }

    #[test]
    fn copy_with_limit_rejects_oversized_download_stream() {
        let mut input = Cursor::new(vec![1, 2, 3, 4, 5]);
        let mut output = Vec::new();

        let result = copy_with_limit(&mut input, &mut output, 4);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("limit"), "error was: {err}");
        assert!(output.is_empty());
    }

    #[test]
    fn verify_update_bytes_rejects_size_mismatch() {
        let bytes = b"norea";
        let mut metadata = metadata_for(bytes);
        metadata.size += 1;

        let error = verify_update_bytes(bytes, &metadata).unwrap_err();

        assert!(error.contains("size does not match metadata"));
    }

    #[test]
    fn verify_update_bytes_rejects_digest_mismatch() {
        let bytes = b"norea";
        let mut metadata = metadata_for(bytes);
        metadata.sha256 = "0".repeat(64);

        let error = verify_update_bytes(bytes, &metadata).unwrap_err();

        assert!(error.contains("SHA-256 does not match metadata"));
    }

    #[test]
    fn validate_update_size_rejects_oversized_updates() {
        let error = validate_update_size(MAX_UPDATE_BYTES + 1).unwrap_err();

        assert!(error.contains("exceeds"));
    }

    #[test]
    fn validate_zip_compression_ratio_rejects_suspicious_entries() {
        let error = validate_zip_compression_ratio(
            1,
            MAX_UPDATE_ZIP_COMPRESSION_RATIO + 1,
            UpdateZipLimits::DEFAULT,
        )
        .unwrap_err();

        assert!(error.contains("compression ratio"));
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    #[test]
    fn zip_extraction_selects_highest_priority_installer_entry() {
        let (preferred, fallback) = installer_fixture_names();
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("artifact.zip");
        write_zip(
            &zip_path,
            &[(fallback, b"fallback"), (preferred, b"preferred")],
        );

        let extracted =
            extract_installer_from_zip_with_limits(&zip_path, dir.path(), test_zip_limits())
                .expect("extract installer");

        assert_eq!(
            extracted.file_name().and_then(|name| name.to_str()),
            Some(preferred)
        );
        assert_eq!(fs::read(extracted).expect("read extracted"), b"preferred");
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    #[test]
    fn zip_extraction_rejects_traversal_installer_entry() {
        let (preferred, _) = installer_fixture_names();
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("artifact.zip");
        let traversal = format!("../{preferred}");
        write_zip(&zip_path, &[(traversal.as_str(), b"installer")]);

        let result =
            extract_installer_from_zip_with_limits(&zip_path, dir.path(), test_zip_limits());

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("unsafe entry name"), "error was: {err}");
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    #[test]
    fn zip_extraction_rejects_oversized_selected_entry() {
        let (preferred, _) = installer_fixture_names();
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("artifact.zip");
        let body = vec![0; 5];
        write_zip(&zip_path, &[(preferred, body.as_slice())]);
        let limits = UpdateZipLimits {
            max_entry_bytes: 4,
            ..test_zip_limits()
        };

        let result = extract_installer_from_zip_with_limits(&zip_path, dir.path(), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("byte limit"), "error was: {err}");
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    #[test]
    fn zip_extraction_rejects_excessive_entry_count() {
        let (preferred, _) = installer_fixture_names();
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("artifact.zip");
        write_zip(&zip_path, &[("README.txt", b"readme"), (preferred, b"ok")]);
        let limits = UpdateZipLimits {
            max_entries: 1,
            ..test_zip_limits()
        };

        let result = extract_installer_from_zip_with_limits(&zip_path, dir.path(), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("entry limit"), "error was: {err}");
    }

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
    #[test]
    fn zip_extraction_rejects_excessive_total_uncompressed_size() {
        let (preferred, _) = installer_fixture_names();
        let dir = tempdir().expect("tempdir");
        let zip_path = dir.path().join("artifact.zip");
        write_zip(
            &zip_path,
            &[("README.txt", b"readme"), (preferred, b"installer")],
        );
        let limits = UpdateZipLimits {
            max_entry_bytes: 16,
            max_total_uncompressed_bytes: 6,
            ..test_zip_limits()
        };

        let result = extract_installer_from_zip_with_limits(&zip_path, dir.path(), limits);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("total uncompressed"), "error was: {err}");
    }
}
