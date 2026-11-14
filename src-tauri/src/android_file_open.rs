use std::sync::Mutex;

#[cfg(target_os = "android")]
use tauri::{AppHandle, Emitter, Manager};
#[cfg(any(target_os = "android", test))]
use tauri::Url;
use tauri::State;

#[cfg(target_os = "android")]
const ANDROID_OPEN_FILES_EVENT: &str = "android-open-files";

#[derive(Debug, Default)]
struct AndroidOpenFileRegistry {
    urls: Vec<String>,
}

impl AndroidOpenFileRegistry {
    #[cfg(any(target_os = "android", test))]
    fn enqueue(&mut self, urls: impl IntoIterator<Item = Url>) -> usize {
        let mut added = 0;
        for url in urls {
            if !matches!(url.scheme(), "content" | "file") {
                continue;
            }
            let url = url.to_string();
            if self.urls.contains(&url) {
                continue;
            }
            self.urls.push(url);
            added += 1;
        }
        added
    }

    fn take(&mut self) -> Vec<String> {
        std::mem::take(&mut self.urls)
    }
}

#[derive(Debug, Default)]
pub struct AndroidOpenFileState(Mutex<AndroidOpenFileRegistry>);

impl AndroidOpenFileState {
    #[cfg(target_os = "android")]
    fn enqueue(&self, urls: Vec<Url>) -> Result<usize, String> {
        self.0
            .lock()
            .map_err(|_| "android file open: state lock poisoned".to_string())
            .map(|mut registry| registry.enqueue(urls))
    }

    fn take(&self) -> Result<Vec<String>, String> {
        self.0
            .lock()
            .map_err(|_| "android file open: state lock poisoned".to_string())
            .map(|mut registry| registry.take())
    }
}

#[cfg(target_os = "android")]
pub fn enqueue_opened_urls(app: &AppHandle, urls: Vec<Url>) {
    let state = app.state::<AndroidOpenFileState>();
    match state.enqueue(urls) {
        Ok(0) => {}
        Ok(_) => {
            if let Err(err) = app.emit(ANDROID_OPEN_FILES_EVENT, ()) {
                log::warn!("android file open: emit event failed: {err}");
            }
        }
        Err(err) => log::warn!("{err}"),
    }
}

#[tauri::command]
pub fn android_open_file_url_take(
    state: State<'_, AndroidOpenFileState>,
) -> Result<Vec<String>, String> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queues_supported_android_file_urls_once() {
        let mut registry = AndroidOpenFileRegistry::default();
        let urls = [
            Url::parse("content://documents/Book.epub").expect("content URL"),
            Url::parse("file:///storage/emulated/0/Book.pdf").expect("file URL"),
            Url::parse("https://example.test/Book.pdf").expect("https URL"),
            Url::parse("content://documents/Book.epub").expect("duplicate URL"),
        ];

        assert_eq!(registry.enqueue(urls), 2);
        assert_eq!(
            registry.take(),
            vec![
                "content://documents/Book.epub".to_string(),
                "file:///storage/emulated/0/Book.pdf".to_string(),
            ]
        );
        assert!(registry.take().is_empty());
    }
}
