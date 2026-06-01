use serde::Deserialize;
#[cfg(target_os = "windows")]
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder, Window};
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
const MAX_TOOLTIP_TASK_ITEMS: usize = 4;
#[cfg(target_os = "windows")]
const MAX_TOOLTIP_LINE_CHARS: usize = 96;
#[cfg(target_os = "windows")]
const MAX_TOOLTIP_TEXT_CHARS: usize = 240;

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
    let Some(window) = main_window(app.handle()) else {
        log::warn!("install close-to-tray failed: main window not found");
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
    let menu = build_tray_menu(app)?;

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
fn build_tray_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<tauri::menu::Menu<R>> {
    MenuBuilder::new(manager)
        .text(TRAY_OPEN_ID, "Open Norea")
        .separator()
        .text(TRAY_QUIT_ID, "Quit Norea")
        .build()
}

#[cfg(target_os = "windows")]
fn truncate_text(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() <= max_chars {
        return value.to_string();
    }

    let mut truncated = chars
        .into_iter()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

#[cfg(target_os = "windows")]
fn tooltip_line(value: &str, fallback: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = if compact.is_empty() {
        fallback
    } else {
        &compact
    };
    truncate_text(text, max_chars)
}

#[cfg(target_os = "windows")]
fn tray_tooltip(summary: &str, items: &[TrayTaskProgressItem]) -> String {
    if items.is_empty() {
        return "Norea".to_string();
    }

    let mut lines = vec![format!(
        "Norea - {}",
        tooltip_line(summary, "Tasks", MAX_TOOLTIP_LINE_CHARS)
    )];
    lines.extend(
        items
            .iter()
            .take(MAX_TOOLTIP_TASK_ITEMS)
            .map(|item| tooltip_line(&item.label, "Task", MAX_TOOLTIP_LINE_CHARS)),
    );
    truncate_text(&lines.join("\n"), MAX_TOOLTIP_TEXT_CHARS)
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
    if let Err(err) = tray.set_tooltip(Some(tray_tooltip(&summary, &items))) {
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
    let Some(window) = main_window(app).or_else(|| recreate_main_window(app)) else {
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
fn restore_native_window<R: Runtime>(window: &Window<R>) {
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
fn restore_native_window<R: Runtime>(_window: &Window<R>) {}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    if let Some(window) = app.get_window(MAIN_WINDOW_LABEL) {
        return Some(window);
    }

    let mut windows = app.windows();
    if windows.len() == 1 {
        return windows.drain().map(|(_, window)| window).next();
    }

    let labels = windows.keys().cloned().collect::<Vec<_>>().join(", ");
    log::warn!("main window label '{MAIN_WINDOW_LABEL}' not found; windows=[{labels}]");
    None
}

fn recreate_main_window<R: Runtime>(app: &AppHandle<R>) -> Option<Window<R>> {
    let result = match app.config().app.windows.first() {
        Some(config) => {
            let mut config = config.clone();
            config.label = MAIN_WINDOW_LABEL.to_string();
            WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build())
        }
        None => WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, Default::default()).build(),
    };

    match result {
        Ok(_) => app.get_window(MAIN_WINDOW_LABEL),
        Err(err) => {
            log::warn!("recreate main window from tray failed: {err}");
            None
        }
    }
}
