use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressNotificationPayload {
    tag: String,
    title: String,
    status: String,
    value: f32,
    value_string: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressNotificationUpdateResult {
    Succeeded,
    Failed,
    NotFound,
    Unsupported,
}

const MAX_PROGRESS_TEXT_CHARS: usize = 128;

fn progress_text(value: String) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_PROGRESS_TEXT_CHARS)
        .collect()
}

fn progress_value(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(target_os = "windows")]
fn notification_app_id(app: &AppHandle) -> String {
    use std::path::MAIN_SEPARATOR as SEP;

    let identifier = app.config().identifier.clone();
    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return identifier;
    };
    let Some(exe_dir) = exe.parent() else {
        return identifier;
    };
    let current_dir = exe_dir.display().to_string();
    if current_dir.ends_with(format!("{SEP}target{SEP}debug").as_str())
        || current_dir.ends_with(format!("{SEP}target{SEP}release").as_str())
    {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        identifier
    }
}

#[cfg(target_os = "windows")]
fn progress_payload(
    payload: DownloadProgressNotificationPayload,
) -> tauri_winrt_notification::Progress {
    tauri_winrt_notification::Progress {
        tag: progress_text(payload.tag),
        title: progress_text(payload.title),
        status: progress_text(payload.status),
        value: progress_value(payload.value),
        value_string: progress_text(payload.value_string),
    }
}

#[cfg(target_os = "windows")]
fn update_progress_notification(
    app_id: &str,
    progress: &tauri_winrt_notification::Progress,
) -> windows::core::Result<tauri_winrt_notification::NotificationUpdateResult> {
    use windows::{
        core::HSTRING,
        Foundation::Collections::StringMap,
        UI::Notifications::{NotificationData, ToastNotificationManager},
    };

    let map = StringMap::new()?;
    map.Insert(
        &HSTRING::from("progressTitle"),
        &HSTRING::from(&progress.title),
    )?;
    map.Insert(
        &HSTRING::from("progressStatus"),
        &HSTRING::from(&progress.status),
    )?;
    map.Insert(
        &HSTRING::from("progressValue"),
        &HSTRING::from(progress.value.to_string()),
    )?;
    map.Insert(
        &HSTRING::from("progressValueString"),
        &HSTRING::from(&progress.value_string),
    )?;

    let data = NotificationData::CreateNotificationDataWithValuesAndSequenceNumber(&map, 0)?;
    let toast_notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
    toast_notifier.UpdateWithTag(&data, &HSTRING::from(&progress.tag))
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn task_notification_show_download_progress(
    app: AppHandle,
    payload: DownloadProgressNotificationPayload,
) -> Result<(), String> {
    let progress = progress_payload(payload);
    tauri_winrt_notification::Toast::new(&notification_app_id(&app))
        .title(&progress.title)
        .text1(&progress.status)
        .sound(None)
        .progress(&progress)
        .show()
        .map_err(|err| format!("show download progress notification: {err}"))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn task_notification_show_download_progress(
    app: AppHandle,
    payload: DownloadProgressNotificationPayload,
) -> Result<(), String> {
    let _ = (app, payload);
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn task_notification_update_download_progress(
    app: AppHandle,
    payload: DownloadProgressNotificationPayload,
) -> Result<ProgressNotificationUpdateResult, String> {
    let progress = progress_payload(payload);
    let result = update_progress_notification(&notification_app_id(&app), &progress)
        .map_err(|err| format!("update download progress notification: {err}"))?;

    match result {
        tauri_winrt_notification::NotificationUpdateResult::Succeeded => {
            Ok(ProgressNotificationUpdateResult::Succeeded)
        }
        tauri_winrt_notification::NotificationUpdateResult::Failed => {
            Ok(ProgressNotificationUpdateResult::Failed)
        }
        tauri_winrt_notification::NotificationUpdateResult::NotificationNotFound => {
            Ok(ProgressNotificationUpdateResult::NotFound)
        }
        _ => Ok(ProgressNotificationUpdateResult::Failed),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn task_notification_update_download_progress(
    app: AppHandle,
    payload: DownloadProgressNotificationPayload,
) -> Result<ProgressNotificationUpdateResult, String> {
    let _ = (app, payload);
    Ok(ProgressNotificationUpdateResult::Unsupported)
}
