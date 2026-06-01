use serde::Deserialize;
#[cfg(target_os = "windows")]
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri::{AppHandle, Manager, Runtime};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};

const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(target_os = "windows")]
const TRAY_ID: &str = "norea-main";
#[cfg(target_os = "windows")]
const TRAY_OPEN_ID: &str = "tray-open";
#[cfg(target_os = "windows")]
const TRAY_QUIT_ID: &str = "tray-quit";
#[cfg(target_os = "windows")]
const TRAY_TASK_ITEM_ID_PREFIX: &str = "tray-task-item";
#[cfg(target_os = "windows")]
const MAX_TRAY_TASK_ITEMS: usize = 8;
#[cfg(target_os = "windows")]
const MAX_MENU_TEXT_CHARS: usize = 96;

#[derive(Debug, Deserialize)]
pub struct TrayTaskProgressItem {
    #[cfg(target_os = "windows")]
    label: String,
}

#[cfg(target_os = "windows")]
pub fn init(app: &mut tauri::App) -> tauri::Result<()> {
    install_close_to_tray_handler(app);
    install_tray(app)
}

#[cfg(not(target_os = "windows"))]
pub fn init(_app: &mut tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_close_to_tray_handler(app: &tauri::App) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let window_to_hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(err) = window_to_hide.hide() {
                log::warn!("hide main window to tray failed: {err}");
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_tray_menu(app, &[])?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Norea")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN_ID => show_main_window(app),
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn build_tray_menu<R: Runtime, M: Manager<R>>(
    manager: &M,
    items: &[TrayTaskProgressItem],
) -> tauri::Result<tauri::menu::Menu<R>> {
    let mut builder = MenuBuilder::new(manager).text(TRAY_OPEN_ID, "Open Norea");

    if !items.is_empty() {
        builder = builder.separator();
        for (index, item) in items.iter().take(MAX_TRAY_TASK_ITEMS).enumerate() {
            let task_item = MenuItem::with_id(
                manager,
                format!("{TRAY_TASK_ITEM_ID_PREFIX}-{index}"),
                menu_text(&item.label, "Task"),
                false,
                None::<&str>,
            )?;
            builder = builder.item(&task_item);
        }
    }

    builder.separator().text(TRAY_QUIT_ID, "Quit Norea").build()
}

#[cfg(target_os = "windows")]
fn menu_text(value: &str, fallback: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = if compact.is_empty() {
        fallback
    } else {
        &compact
    };
    let chars = text.chars().collect::<Vec<_>>();
    let truncated = if chars.len() > MAX_MENU_TEXT_CHARS {
        let mut value = chars
            .into_iter()
            .take(MAX_MENU_TEXT_CHARS.saturating_sub(3))
            .collect::<String>();
        value.push_str("...");
        value
    } else {
        text.to_string()
    };
    truncated.replace('&', "&&")
}

#[cfg(target_os = "windows")]
fn tray_tooltip(summary: &str, has_tasks: bool) -> String {
    if !has_tasks {
        "Norea".to_string()
    } else {
        format!(
            "Norea - {}",
            summary.split_whitespace().collect::<Vec<_>>().join(" ")
        )
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn tray_set_task_progress(
    app: AppHandle,
    summary: String,
    items: Vec<TrayTaskProgressItem>,
) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let menu = build_tray_menu(&app, &items).map_err(|err| format!("build tray menu: {err}"))?;
    tray.set_menu(Some(menu))
        .map_err(|err| format!("set tray menu: {err}"))?;
    if let Err(err) = tray.set_tooltip(Some(tray_tooltip(&summary, !items.is_empty()))) {
        log::warn!("set tray tooltip failed: {err}");
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn tray_set_task_progress(
    app: tauri::AppHandle,
    summary: String,
    items: Vec<TrayTaskProgressItem>,
) -> Result<(), String> {
    let _ = app;
    let _ = summary;
    let _ = items;
    Ok(())
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("show main window from tray failed: main window not found");
        return;
    };
    if let Err(err) = window.show() {
        log::warn!("show main window from tray failed: {err}");
    }
    if let Err(err) = window.unminimize() {
        log::warn!("unminimize main window from tray failed: {err}");
    }
    restore_native_window(&window);
    if let Err(err) = window.set_focus() {
        log::warn!("focus main window from tray failed: {err}");
    }
    restore_native_window(&window);
}

#[cfg(target_os = "windows")]
fn restore_native_window<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd,
        Err(err) => {
            log::warn!("get main window hwnd failed: {err}");
            return;
        }
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
    }
}

#[cfg(not(target_os = "windows"))]
fn restore_native_window<R: Runtime>(_window: &tauri::WebviewWindow<R>) {}
