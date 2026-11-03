//! Device state that pauses automatic goal downloads: metered network, battery saver and free space.
//! Explicit downloads ignore these budgets; the frontend decides which work is automatic.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::AppHandle;

static METERED: AtomicBool = AtomicBool::new(false);
static POWER_SAVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadBudgetStatus {
    metered: bool,
    power_save: bool,
    /// Free bytes on the app data volume, or None where the platform query is not implemented.
    free_bytes: Option<u64>,
}

fn status(free_bytes: Option<u64>) -> DownloadBudgetStatus {
    DownloadBudgetStatus {
        metered: METERED.load(Ordering::Relaxed),
        power_save: POWER_SAVE.load(Ordering::Relaxed),
        free_bytes,
    }
}

#[tauri::command]
pub(crate) fn download_budget_status(app: AppHandle) -> DownloadBudgetStatus {
    status(free_bytes(&app))
}

#[cfg(target_os = "android")]
fn free_bytes(app: &AppHandle) -> Option<u64> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    let path = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `path` is NUL-terminated and `stats` points to writable statvfs storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: statvfs returned 0, so it initialized `stats`.
    let stats = unsafe { stats.assume_init() };
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

// Windows metered-network and free-space queries are not wired yet; budgets treat it as unmetered with no space check.
#[cfg(not(target_os = "android"))]
fn free_bytes(_app: &AppHandle) -> Option<u64> {
    None
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidNetworkState_publishMetered(
    _env: jni::EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    metered: jni::sys::jboolean,
) {
    METERED.store(metered == jni::sys::JNI_TRUE, Ordering::Relaxed);
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidPowerState_publish(
    _env: jni::EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    power_save: jni::sys::jboolean,
) {
    POWER_SAVE.store(power_save == jni::sys::JNI_TRUE, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_published_device_state() {
        METERED.store(true, Ordering::Relaxed);
        POWER_SAVE.store(false, Ordering::Relaxed);
        assert_eq!(status(Some(5)), DownloadBudgetStatus { metered: true, power_save: false, free_bytes: Some(5) });
        assert_eq!(serde_json::to_value(status(None)).unwrap(),
            serde_json::json!({ "metered": true, "powerSave": false, "freeBytes": null }));
        METERED.store(false, Ordering::Relaxed);
    }
}
