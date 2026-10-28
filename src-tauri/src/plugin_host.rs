use std::io::{Cursor, Read};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

const DEFAULT_MAX_ARCHIVE_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const HARD_MAX_ENTRY_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct PluginZipEntryInfo {
    name: String,
    compressed_size: u64,
    uncompressed_size: u64,
    is_file: bool,
}

#[derive(Deserialize)]
pub struct PluginZipReadOptions {
    path: Option<String>,
    extension: Option<String>,
    max_bytes: Option<u64>,
}

fn open_archive(bytes: Vec<u8>) -> Result<ZipArchive<Cursor<Vec<u8>>>, String> {
    if bytes.len() > DEFAULT_MAX_ARCHIVE_BYTES {
        return Err("ZIP archive is larger than the plugin host limit.".to_string());
    }

    ZipArchive::new(Cursor::new(bytes)).map_err(|err| format!("Invalid ZIP archive: {err}"))
}

fn is_safe_entry_name(name: &str) -> bool {
    !name.starts_with('/')
        && !name.starts_with('\\')
        && !name.contains("..")
        && !name.contains('\0')
}

fn requested_entry_index(
    archive: &mut ZipArchive<Cursor<Vec<u8>>>,
    options: &PluginZipReadOptions,
) -> Result<usize, String> {
    let extension = options
        .extension
        .as_ref()
        .map(|value| value.trim_start_matches('.').to_ascii_lowercase());

    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|err| format!("Could not inspect ZIP entry: {err}"))?;
        let name = file
            .name()
            .map_err(|err| format!("Could not decode ZIP entry name: {err}"))?;
        if !file.is_file() || !is_safe_entry_name(&name) {
            continue;
        }

        if let Some(path) = options.path.as_deref() {
            if name.as_ref() == path {
                return Ok(index);
            }
            continue;
        }

        if let Some(extension) = extension.as_deref() {
            let suffix = format!(".{extension}");
            if name.to_ascii_lowercase().ends_with(&suffix) {
                return Ok(index);
            }
            continue;
        }

        return Ok(index);
    }

    Err("No matching ZIP file entry was found.".to_string())
}

async fn plugin_zip_blocking<T, F>(context: &'static str, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| format!("Plugin ZIP {context} task failed: {err}"))?
}

fn plugin_zip_list_sync(bytes: Vec<u8>) -> Result<Vec<PluginZipEntryInfo>, String> {
    let mut archive = open_archive(bytes)?;
    let mut entries = Vec::with_capacity(archive.len());

    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|err| format!("Could not inspect ZIP entry: {err}"))?;
        let name = file
            .name()
            .map_err(|err| format!("Could not decode ZIP entry name: {err}"))?;
        let is_file = file.is_file() && is_safe_entry_name(&name);
        entries.push(PluginZipEntryInfo {
            name: name.into_owned(),
            compressed_size: file.compressed_size(),
            uncompressed_size: file.size(),
            is_file,
        });
    }

    Ok(entries)
}

fn plugin_zip_read_file_sync(
    bytes: Vec<u8>,
    options: PluginZipReadOptions,
) -> Result<Vec<u8>, String> {
    let mut archive = open_archive(bytes)?;
    let index = requested_entry_index(&mut archive, &options)?;
    let mut file = archive
        .by_index(index)
        .map_err(|err| format!("Could not open ZIP entry: {err}"))?;
    let max_bytes = options
        .max_bytes
        .unwrap_or(DEFAULT_MAX_ENTRY_BYTES)
        .min(HARD_MAX_ENTRY_BYTES);

    if file.size() > max_bytes {
        return Err("ZIP entry is larger than the plugin host limit.".to_string());
    }

    let mut output = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut output)
        .map_err(|err| format!("Could not read ZIP entry: {err}"))?;
    Ok(output)
}

#[tauri::command]
pub async fn plugin_zip_list(bytes: Vec<u8>) -> Result<Vec<PluginZipEntryInfo>, String> {
    plugin_zip_blocking("list", move || plugin_zip_list_sync(bytes)).await
}

#[tauri::command]
pub async fn plugin_zip_read_file(
    bytes: Vec<u8>,
    options: PluginZipReadOptions,
) -> Result<Vec<u8>, String> {
    plugin_zip_blocking("read", move || plugin_zip_read_file_sync(bytes, options)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    #[test]
    fn non_ascii_zip_entry_names_are_preserved_for_listing_and_reading() {
        let name = "chapter-\u{00e9}.txt";
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file(name, SimpleFileOptions::default()).unwrap();
        writer.write_all(b"chapter body").unwrap();
        let bytes = writer.finish().unwrap().into_inner();

        let entries = plugin_zip_list_sync(bytes.clone()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, name);
        assert!(entries[0].is_file);

        let content = plugin_zip_read_file_sync(bytes, PluginZipReadOptions {
            path: Some(name.to_string()),
            extension: None,
            max_bytes: None,
        }).unwrap();
        assert_eq!(content, b"chapter body");
    }

    #[test]
    fn invalid_utf8_zip_entry_names_are_rejected() {
        let name = "chapter-\u{00e9}.txt";
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file(name, SimpleFileOptions::default()).unwrap();
        writer.write_all(b"chapter body").unwrap();
        let mut bytes = writer.finish().unwrap().into_inner();
        for index in 0..bytes.len() - 1 {
            if bytes[index..index + 2] == [0xc3, 0xa9] {
                bytes[index] = 0xff;
            }
        }

        assert!(plugin_zip_list_sync(bytes.clone()).is_err());
        assert!(plugin_zip_read_file_sync(bytes, PluginZipReadOptions {
            path: Some(name.to_string()),
            extension: None,
            max_bytes: None,
        }).is_err());
    }
}
