use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

const DESKTOP_OPEN_FILES_EVENT: &str = "desktop-open-files";
const MAX_DESKTOP_OPEN_FILE_BYTES: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOpenFileDescriptor {
    id: String,
    file_name: String,
    mime_type: String,
    size: u64,
}

#[derive(Debug)]
struct DesktopOpenFileEntry {
    descriptor: DesktopOpenFileDescriptor,
    path: PathBuf,
}

#[derive(Debug, Default)]
struct DesktopOpenFileRegistry {
    entries: Vec<DesktopOpenFileEntry>,
    next_id: u64,
}

impl DesktopOpenFileRegistry {
    fn enqueue_args<I, S>(&mut self, args: I, cwd: &Path) -> usize
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut added = 0;
        for arg in args {
            let path = PathBuf::from(arg.as_ref());
            let path = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            let Some(mime_type) = supported_mime_type(&path) else {
                continue;
            };
            let Some(file_name) = path.file_name().and_then(OsStr::to_str).map(str::to_string)
            else {
                continue;
            };
            let Ok(path) = fs::canonicalize(path) else {
                continue;
            };
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() || self.entries.iter().any(|entry| entry.path == path) {
                continue;
            }

            self.next_id += 1;
            self.entries.push(DesktopOpenFileEntry {
                descriptor: DesktopOpenFileDescriptor {
                    id: format!("desktop-open-{}", self.next_id),
                    file_name,
                    mime_type: mime_type.to_string(),
                    size: metadata.len(),
                },
                path,
            });
            added += 1;
        }
        added
    }

    fn descriptors(&self) -> Vec<DesktopOpenFileDescriptor> {
        self.entries
            .iter()
            .map(|entry| entry.descriptor.clone())
            .collect()
    }

    fn take(&mut self, id: &str) -> Result<DesktopOpenFileEntry, String> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.descriptor.id == id)
            .ok_or_else(|| "desktop file open: invalid file handle".to_string())?;
        Ok(self.entries.remove(index))
    }
}

#[derive(Debug, Default)]
pub struct DesktopOpenFileState(Mutex<DesktopOpenFileRegistry>);

impl DesktopOpenFileState {
    pub fn from_process_args() -> Self {
        let mut registry = DesktopOpenFileRegistry::default();
        let cwd = std::env::current_dir().unwrap_or_default();
        registry.enqueue_args(std::env::args_os().skip(1), &cwd);
        Self(Mutex::new(registry))
    }

    fn enqueue_args<I, S>(&self, args: I, cwd: &Path) -> Result<usize, String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.0
            .lock()
            .map_err(|_| "desktop file open: state lock poisoned".to_string())
            .map(|mut registry| registry.enqueue_args(args, cwd))
    }

    fn descriptors(&self) -> Result<Vec<DesktopOpenFileDescriptor>, String> {
        self.0
            .lock()
            .map_err(|_| "desktop file open: state lock poisoned".to_string())
            .map(|registry| registry.descriptors())
    }

    fn take(&self, id: &str) -> Result<DesktopOpenFileEntry, String> {
        self.0
            .lock()
            .map_err(|_| "desktop file open: state lock poisoned".to_string())?
            .take(id)
    }
}

pub fn enqueue_new_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    let state = app.state::<DesktopOpenFileState>();
    match state.enqueue_args(args, Path::new(&cwd)) {
        Ok(0) => {}
        Ok(_) => {
            if let Err(err) = app.emit(DESKTOP_OPEN_FILES_EVENT, ()) {
                log::warn!("desktop file open: emit event failed: {err}");
            }
        }
        Err(err) => log::warn!("{err}"),
    }
}

#[tauri::command]
pub fn desktop_open_file_list(
    state: State<'_, DesktopOpenFileState>,
) -> Result<Vec<DesktopOpenFileDescriptor>, String> {
    state.descriptors()
}

#[tauri::command]
pub fn desktop_open_file_take(
    id: String,
    state: State<'_, DesktopOpenFileState>,
) -> Result<Response, String> {
    let entry = state.take(&id)?;
    if entry.descriptor.size > MAX_DESKTOP_OPEN_FILE_BYTES {
        return Err(format!(
            "desktop file open: file exceeds the {MAX_DESKTOP_OPEN_FILE_BYTES} byte limit"
        ));
    }
    let metadata = fs::metadata(&entry.path).map_err(|err| {
        format!(
            "desktop file open: inspect '{}': {err}",
            entry.path.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() != entry.descriptor.size {
        return Err("desktop file open: file changed before it could be read".to_string());
    }
    let bytes = fs::read(&entry.path)
        .map_err(|err| format!("desktop file open: read '{}': {err}", entry.path.display()))?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn desktop_open_file_discard(
    id: String,
    state: State<'_, DesktopOpenFileState>,
) -> Result<(), String> {
    state.take(&id)?;
    Ok(())
}

fn supported_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        "pdf" => Some("application/pdf"),
        "epub" => Some("application/epub+zip"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_extensions_case_insensitively() {
        assert_eq!(
            supported_mime_type(Path::new("Book.TXT")),
            Some("text/plain")
        );
        assert_eq!(
            supported_mime_type(Path::new("Book.Pdf")),
            Some("application/pdf")
        );
        assert_eq!(
            supported_mime_type(Path::new("Book.MD")),
            Some("text/markdown")
        );
        assert_eq!(
            supported_mime_type(Path::new("Book.ePUB")),
            Some("application/epub+zip")
        );
        assert_eq!(supported_mime_type(Path::new("Book.html")), None);
    }

    #[test]
    fn queues_only_existing_supported_files() {
        let root =
            std::env::temp_dir().join(format!("norea-desktop-file-open-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test directory");
        fs::write(root.join("Book.EPUB"), b"epub").expect("write supported file");
        fs::write(root.join("Book.html"), b"html").expect("write unsupported file");

        let mut registry = DesktopOpenFileRegistry::default();
        let added = registry.enqueue_args(
            ["Book.EPUB", "Book.html", "Missing.pdf", "Book.EPUB"],
            &root,
        );

        assert_eq!(added, 1);
        assert_eq!(
            registry.descriptors(),
            vec![DesktopOpenFileDescriptor {
                id: "desktop-open-1".to_string(),
                file_name: "Book.EPUB".to_string(),
                mime_type: "application/epub+zip".to_string(),
                size: 4,
            }]
        );

        fs::remove_dir_all(root).expect("remove test directory");
    }
}
