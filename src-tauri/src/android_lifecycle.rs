use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

static APP: OnceLock<AppHandle> = OnceLock::new();
static ANDROID_PIPE: OnceLock<tauri::wry::JniHandle> = OnceLock::new();
static ACTIVITY: Mutex<ActivityState> = Mutex::new(ActivityState {
    resumed: None,
    pending_destructions: 0,
});

#[derive(Default)]
struct ActivityState {
    resumed: Option<i32>,
    pending_destructions: u32,
}

impl ActivityState {
    fn publish(&mut self, id: i32, resumed: bool) {
        if resumed {
            self.resumed = Some(id);
        } else if self.resumed == Some(id) {
            self.resumed = None;
        }
    }

    fn ready(&self) -> bool {
        self.resumed.is_some() && self.pending_destructions == 0
    }

    fn publish_destruction(&mut self, id: i32, completed: bool) {
        if completed {
            self.pending_destructions -= 1;
        } else {
            self.publish(id, false);
            self.pending_destructions += 1;
        }
    }
}

pub(crate) fn initialize(app: &AppHandle) -> tauri::Result<()> {
    let _ = APP.set(app.clone());
    app.get_webview_window("main")
        .expect("main WebView configuration is missing")
        .with_webview(|webview| {
            let _ = ANDROID_PIPE.set(webview.jni_handle());
        })
}

fn restore_main_window(app: &AppHandle) {
    if app.get_webview_window("main").is_some() || !ACTIVITY.lock().unwrap().ready() {
        return;
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("main WebView configuration is missing");
    if let Err(error) =
        WebviewWindowBuilder::from_config(app, config).and_then(|builder| builder.build())
    {
        log::error!("could not restore the Android main WebView: {error}");
    }
}

pub(crate) fn request_main_window_restore() {
    if !ACTIVITY.lock().unwrap().ready() {
        return;
    }
    if let (Some(app), Some(pipe)) = (APP.get(), ANDROID_PIPE.get()) {
        let app = app.clone();
        let pipe = *pipe;
        // Use the pipe as a cleanup barrier even after its original Activity is gone; no JNI objects are accessed.
        tauri::async_runtime::spawn_blocking(move || {
            pipe.exec(move |_, _, _| {
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || restore_main_window(&handle)) {
                    log::error!("could not schedule Android main WebView restoration: {error}");
                }
            });
        });
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidActivityLifecycle_publish(
    _env: jni::EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    activity_id: jni::sys::jint,
    resumed: jni::sys::jboolean,
) {
    ACTIVITY.lock().unwrap().publish(activity_id, resumed);
    if resumed {
        request_main_window_restore();
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_io_github_tinywind_norea_AndroidActivityLifecycle_publishDestruction(
    _env: jni::EnvUnowned<'_>,
    _class: jni::objects::JClass<'_>,
    activity_id: jni::sys::jint,
    completed: jni::sys::jboolean,
) {
    ACTIVITY
        .lock()
        .unwrap()
        .publish_destruction(activity_id, completed);
    if completed {
        request_main_window_restore();
    }
}

#[cfg(test)]
mod tests {
    use super::ActivityState;

    #[test]
    fn pausing_an_old_activity_keeps_its_successor_resumed() {
        let mut state = ActivityState::default();
        state.publish(1, true);
        state.publish(2, true);
        state.publish(1, false);
        assert_eq!(state.resumed, Some(2));
        assert!(state.ready());
    }

    #[test]
    fn replacement_waits_for_all_activity_destruction_to_finish() {
        let mut state = ActivityState::default();
        state.publish(1, true);
        state.publish_destruction(1, false);
        state.publish(2, true);
        state.publish_destruction(3, false);
        assert!(!state.ready());
        state.publish_destruction(1, true);
        assert!(!state.ready());
        state.publish_destruction(3, true);
        assert!(state.ready());
        state.publish(2, false);
        assert!(!state.ready());
    }
}
