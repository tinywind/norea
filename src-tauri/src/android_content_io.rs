//! Cross-platform bounded local file inspection/reading and Android JNI content URI helpers.

use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;

const MAX_LOCAL_FILE_READ_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(target_os = "android")]
pub(crate) const ANDROID_ALL_FILES_ACCESS_REQUIRED: &str =
    "All files access is required to use the storage folder.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileDescription {
    pub file_name: String,
    pub mime_type: String,
    pub size: Option<u64>,
}

fn validate_byte_limit(max_bytes: u64) -> Result<(), String> {
    if max_bytes == 0 {
        return Err("local file read: byte limit must be positive".to_string());
    }
    if max_bytes > MAX_LOCAL_FILE_READ_BYTES {
        return Err(format!(
            "local file read: byte limit exceeds {MAX_LOCAL_FILE_READ_BYTES} bytes"
        ));
    }
    Ok(())
}

pub(crate) fn infer_mime_type_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("epub") => "application/epub+zip",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain",
        Some("md" | "markdown") => "text/markdown",
        Some("html" | "htm") => "text/html",
        Some("json") => "application/json",
        Some("zip") => "application/zip",
        Some("ovpn" | "conf") => "application/x-openvpn-profile",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

pub(crate) fn resolve_filesystem_path(path_or_uri: &str) -> Result<PathBuf, String> {
    let trimmed = path_or_uri.trim();
    if trimmed.is_empty() {
        return Err("local file path is empty".to_string());
    }
    if trimmed.starts_with("file://") {
        let parsed =
            tauri::Url::parse(trimmed).map_err(|err| format!("invalid file URL '{trimmed}': {err}"))?;
        return parsed
            .to_file_path()
            .map_err(|()| format!("unsupported file URL '{trimmed}'"));
    }
    Ok(PathBuf::from(trimmed))
}

fn read_reader_bounded<R: Read>(mut reader: R, max_bytes: u64, context: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut limited = (&mut reader).take(max_bytes.saturating_add(1));
    limited
        .read_to_end(&mut output)
        .map_err(|err| format!("{context}: {err}"))?;
    if output.len() as u64 > max_bytes {
        return Err(format!("{context}: file exceeds the {max_bytes} byte limit"));
    }
    Ok(output)
}

pub(crate) fn describe_path_or_uri(path_or_uri: &str) -> Result<LocalFileDescription, String> {
    let trimmed = path_or_uri.trim();
    if trimmed.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            return android::describe_content_uri(trimmed);
        }
        #[cfg(not(target_os = "android"))]
        {
            return Err("content URIs are only supported on Android".to_string());
        }
    }

    let path = resolve_filesystem_path(trimmed)?;
    let metadata = fs::metadata(&path)
        .map_err(|err| format!("local file inspect '{}': {err}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("local file '{}' is not a regular file", path.display()));
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("opened-file")
        .to_string();
    Ok(LocalFileDescription {
        file_name,
        mime_type: infer_mime_type_from_path(&path).to_string(),
        size: Some(metadata.len()),
    })
}

pub(crate) fn open_path_or_uri_read(path_or_uri: &str) -> Result<File, String> {
    let trimmed = path_or_uri.trim();
    if trimmed.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            return android::open_content_uri_file(trimmed, "r");
        }
        #[cfg(not(target_os = "android"))]
        {
            return Err("content URIs are only supported on Android".to_string());
        }
    }
    let path = resolve_filesystem_path(trimmed)?;
    File::open(&path).map_err(|err| format!("open '{}' for reading: {err}", path.display()))
}

pub(crate) fn open_path_or_uri_write_truncate(path_or_uri: &str) -> Result<File, String> {
    let trimmed = path_or_uri.trim();
    if trimmed.starts_with("content://") {
        #[cfg(target_os = "android")]
        {
            return android::open_content_uri_file(trimmed, "wt");
        }
        #[cfg(not(target_os = "android"))]
        {
            return Err("content URIs are only supported on Android".to_string());
        }
    }
    let path = resolve_filesystem_path(trimmed)?;
    File::create(&path).map_err(|err| format!("open '{}' for writing: {err}", path.display()))
}

pub(crate) fn read_path_or_uri_bounded(
    path_or_uri: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    validate_byte_limit(max_bytes)?;
    let trimmed = path_or_uri.trim();
    if !trimmed.starts_with("content://") {
        let path = resolve_filesystem_path(trimmed)?;
        let metadata = fs::metadata(&path)
            .map_err(|err| format!("local file inspect '{}': {err}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("local file '{}' is not a regular file", path.display()));
        }
        if metadata.len() > max_bytes {
            return Err(format!(
                "local file '{}' exceeds the {max_bytes} byte limit",
                path.display()
            ));
        }
        let file =
            File::open(&path).map_err(|err| format!("local file read '{}': {err}", path.display()))?;
        return read_reader_bounded(file, max_bytes, "local file read");
    }

    let file = open_path_or_uri_read(trimmed)?;
    read_reader_bounded(file, max_bytes, "content URI read")
}

#[tauri::command]
pub async fn local_file_describe(path_or_uri: String) -> Result<LocalFileDescription, String> {
    tauri::async_runtime::spawn_blocking(move || describe_path_or_uri(&path_or_uri))
        .await
        .map_err(|err| format!("local file describe task: {err}"))?
}

#[tauri::command]
pub async fn local_file_read(path_or_uri: String, max_bytes: u64) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_path_or_uri_bounded(&path_or_uri, max_bytes)
    })
    .await
    .map_err(|err| format!("local file read task: {err}"))??;
    Ok(Response::new(bytes))
}

#[cfg(target_os = "android")]
mod android {
    use super::{LocalFileDescription, ANDROID_ALL_FILES_ACCESS_REQUIRED};
    use jni::{
        errors::ThrowRuntimeExAndDefault,
        jni_sig, jni_str,
        objects::{JClass, JString},
        refs::Global,
        EnvUnowned, JValue, JavaVM,
    };
    use serde::Deserialize;
    use std::{
        collections::HashMap,
        fs::File,
        os::fd::FromRawFd,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicI64, Ordering},
            LazyLock, Mutex, OnceLock,
        },
    };
    use tokio::sync::oneshot;

    struct AndroidNativeIoBridge {
        class: Global<JClass<'static>>,
        java_vm: JavaVM,
    }

    static BRIDGE: OnceLock<AndroidNativeIoBridge> = OnceLock::new();
    static NEXT_PICK_ID: AtomicI64 = AtomicI64::new(1);
    static PENDING_PICKS: LazyLock<Mutex<HashMap<i64, oneshot::Sender<String>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    #[derive(Deserialize)]
    struct PickResultPayload {
        status: String,
        root: Option<String>,
        error: Option<String>,
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_io_github_tinywind_norea_AndroidNativeIo_register(
        mut env: EnvUnowned<'_>,
        class: JClass<'_>,
    ) {
        env.with_env(|env| -> jni::errors::Result<()> {
            let _ = BRIDGE.set(AndroidNativeIoBridge {
                java_vm: env.get_java_vm()?,
                class: env.new_global_ref(class)?,
            });
            Ok(())
        })
        .resolve::<ThrowRuntimeExAndDefault>();
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_io_github_tinywind_norea_AndroidNativeIo_completeStorageRootPick(
        mut env: EnvUnowned<'_>,
        _class: JClass<'_>,
        request_id: jni::sys::jlong,
        result_json: JString<'_>,
    ) {
        env.with_env(|env| -> jni::errors::Result<()> {
            let payload = result_json.try_to_string(env)?;
            if let Ok(mut pending) = PENDING_PICKS.lock() {
                if let Some(sender) = pending.remove(&request_id) {
                    let _ = sender.send(payload);
                }
            }
            Ok(())
        })
        .resolve::<ThrowRuntimeExAndDefault>();
    }

    fn bridge() -> Result<&'static AndroidNativeIoBridge, String> {
        BRIDGE
            .get()
            .ok_or_else(|| "Android native I/O bridge is not initialized.".to_string())
    }

    fn error_message(error: jni::errors::Error) -> String {
        match error {
            jni::errors::Error::CaughtJavaException { msg, .. } => msg,
            _ => error.to_string(),
        }
    }

    pub(super) fn is_all_files_access_granted() -> Result<bool, String> {
        let bridge = bridge()?;
        bridge
            .java_vm
            .attach_current_thread_for_scope(|env| {
                env.call_static_method(
                    &bridge.class,
                    jni_str!("isAllFilesAccessGranted"),
                    jni_sig!("()Z"),
                    &[],
                )?
                .z()
            })
            .map_err(error_message)
    }

    pub(super) fn ensure_all_files_access() -> Result<(), String> {
        if is_all_files_access_granted()? {
            Ok(())
        } else {
            Err(ANDROID_ALL_FILES_ACCESS_REQUIRED.to_string())
        }
    }

    pub(super) fn external_storage_root_path() -> PathBuf {
        let Ok(bridge) = bridge() else {
            return PathBuf::from("/storage/emulated/0");
        };
        bridge
            .java_vm
            .attach_current_thread_for_scope(|env| {
                let value = env
                    .call_static_method(
                        &bridge.class,
                        jni_str!("externalStorageRootPath"),
                        jni_sig!("()Ljava/lang/String;"),
                        &[],
                    )?
                    .l()?;
                env.cast_local::<JString>(value)?.try_to_string(env)
            })
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/storage/emulated/0"))
    }

    pub(super) fn scan_file(path: &Path) {
        let Ok(bridge) = bridge() else {
            return;
        };
        let path_str = path.to_string_lossy();
        let _: jni::errors::Result<()> = bridge.java_vm.attach_current_thread_for_scope(|env| {
            let path_jstr = env.new_string(path_str.as_ref())?;
            env.call_static_method(
                &bridge.class,
                jni_str!("scanFile"),
                jni_sig!("(Ljava/lang/String;)V"),
                &[JValue::from(&path_jstr)],
            )?;
            Ok(())
        });
    }

    pub(super) fn describe_content_uri(uri: &str) -> Result<LocalFileDescription, String> {
        let bridge = bridge()?;
        let raw_json = bridge
            .java_vm
            .attach_current_thread_for_scope(|env| {
                let uri_jstr = env.new_string(uri)?;
                let value = env
                    .call_static_method(
                        &bridge.class,
                        jni_str!("describeContentUri"),
                        jni_sig!("(Ljava/lang/String;)Ljava/lang/String;"),
                        &[JValue::from(&uri_jstr)],
                    )?
                    .l()?;
                env.cast_local::<JString>(value)?.try_to_string(env)
            })
            .map_err(error_message)?;
        serde_json::from_str(&raw_json)
            .map_err(|err| format!("parse content URI description: {err}"))
    }

    pub(super) fn open_content_uri_file(uri: &str, mode: &str) -> Result<File, String> {
        let bridge = bridge()?;
        let fd = bridge
            .java_vm
            .attach_current_thread_for_scope(|env| {
                let uri_jstr = env.new_string(uri)?;
                let mode_jstr = env.new_string(mode)?;
                env.call_static_method(
                    &bridge.class,
                    jni_str!("openContentUriFd"),
                    jni_sig!("(Ljava/lang/String;Ljava/lang/String;)I"),
                    &[JValue::from(&uri_jstr), JValue::from(&mode_jstr)],
                )?
                .i()
            })
            .map_err(error_message)?;
        if fd < 0 {
            return Err("Android content resolver returned an invalid file descriptor.".to_string());
        }
        // SAFETY: `AndroidNativeIo.openContentUriFd` calls `ParcelFileDescriptor.detachFd()`,
        // transferring exclusive ownership of the open OS file descriptor to Rust.
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub(super) async fn pick_storage_root() -> Result<Option<String>, String> {
        let bridge = bridge()?;
        let request_id = NEXT_PICK_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        PENDING_PICKS
            .lock()
            .map_err(|_| "Android storage picker lock poisoned.".to_string())?
            .insert(request_id, tx);

        let start_error = bridge
            .java_vm
            .attach_current_thread_for_scope(|env| -> jni::errors::Result<Option<String>> {
                let value = env
                    .call_static_method(
                        &bridge.class,
                        jni_str!("startStorageRootPick"),
                        jni_sig!("(J)Ljava/lang/String;"),
                        &[JValue::Long(request_id)],
                    )?
                    .l()?;
                if value.is_null() {
                    return Ok(None);
                }
                env.cast_local::<JString>(value)?.try_to_string(env).map(Some)
            })
            .map_err(error_message);

        match start_error {
            Ok(None) => {}
            Ok(Some(err)) | Err(err) => {
                if let Ok(mut pending) = PENDING_PICKS.lock() {
                    pending.remove(&request_id);
                }
                return Err(err);
            }
        }

        let payload_raw = rx
            .await
            .map_err(|_| "Android storage picker closed without a result.".to_string())?;
        let payload: PickResultPayload = serde_json::from_str(&payload_raw)
            .map_err(|err| format!("parse Android storage picker result: {err}"))?;
        match payload.status.as_str() {
            "picked" => {
                let root = payload
                    .root
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "No storage folder was selected.".to_string())?;
                Ok(Some(root))
            }
            "cancelled" => Ok(None),
            _ => Err(payload
                .error
                .unwrap_or_else(|| "Storage folder picker failed.".to_string())),
        }
    }

    pub(super) fn install_update_apk(
        path: &Path,
        expected_size: u64,
        expected_sha256: &str,
    ) -> Result<(), String> {
        let bridge = bridge()?;
        let expected_size = i64::try_from(expected_size)
            .map_err(|_| "Update size metadata overflows signed length.".to_string())?;
        let path_str = path.to_string_lossy();
        bridge
            .java_vm
            .attach_current_thread_for_scope(|env| {
                let path_jstr = env.new_string(path_str.as_ref())?;
                let sha_jstr = env.new_string(expected_sha256)?;
                env.call_static_method(
                    &bridge.class,
                    jni_str!("installUpdateApk"),
                    jni_sig!("(Ljava/lang/String;JLjava/lang/String;)V"),
                    &[
                        JValue::from(&path_jstr),
                        JValue::Long(expected_size),
                        JValue::from(&sha_jstr),
                    ],
                )?;
                Ok(())
            })
            .map_err(error_message)
    }
}

#[cfg(target_os = "android")]
pub(crate) fn ensure_all_files_access() -> Result<(), String> {
    android::ensure_all_files_access()
}

#[cfg(target_os = "android")]
pub(crate) fn external_storage_root_path() -> PathBuf {
    android::external_storage_root_path()
}

#[cfg(target_os = "android")]
pub(crate) fn scan_file(path: &Path) {
    android::scan_file(path);
}

#[cfg(target_os = "android")]
pub(crate) async fn pick_storage_root() -> Result<Option<String>, String> {
    android::pick_storage_root().await
}

#[cfg(target_os = "android")]
pub(crate) fn install_update_apk(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), String> {
    android::install_update_apk(path, expected_size, expected_sha256)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_and_reads_bounded_local_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let epub = temp.path().join("Book Title.epub");
        fs::write(&epub, b"epub-payload").expect("write epub");

        let description = describe_path_or_uri(&epub.to_string_lossy()).expect("describe");
        assert_eq!(
            description,
            LocalFileDescription {
                file_name: "Book Title.epub".to_string(),
                mime_type: "application/epub+zip".to_string(),
                size: Some(12),
            }
        );

        let file_url = tauri::Url::from_file_path(&epub).expect("file url");
        let bytes = read_path_or_uri_bounded(file_url.as_str(), 12).expect("read exact");
        assert_eq!(bytes, b"epub-payload");

        let err = read_path_or_uri_bounded(file_url.as_str(), 11).expect_err("exceeds limit");
        assert!(err.contains("exceeds the 11 byte limit"), "{err}");
    }
}
