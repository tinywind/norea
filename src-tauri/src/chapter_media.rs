//! Native chapter media persistence, grouped by storage responsibility.

mod archives;
mod cache;
mod content;
mod covers;
mod manifest;
mod media;
mod paths;
mod protocol;
mod publication;
mod restore;
mod transfer;
mod types;

// Command glob exports retain Tauri-generated __cmd__ wrapper macros.
pub use archives::*;
pub use cache::*;
pub use content::*;
pub use covers::*;
pub use media::*;
pub use paths::*;
pub use protocol::*;
pub use restore::*;
pub use transfer::*;
pub use types::*;

async fn chapter_media_blocking<T, F>(context: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("chapter media: {context} task: {err}"))?
}
