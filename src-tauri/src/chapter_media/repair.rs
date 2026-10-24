//! Preserve validated local assets while preparing an incomplete chapter for repair.

use super::manifest::{
    parse_chapter_media_archive_manifest, read_chapter_media_archive_manifest,
    ChapterMediaArchiveManifestState, ExpectedStoredChapterMedia,
};
use super::paths::{MEDIA_ARCHIVE_FILE, MEDIA_DOWNLOAD_DIR};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
};
use zip::ZipArchive;

const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;

fn add_repair_bytes(total: &mut u64, bytes: u64) -> Result<(), String> {
    if bytes > MAX_TOTAL_BYTES - *total {
        return Err("chapter media: repair exceeds total byte limit".into());
    }
    *total += bytes;
    Ok(())
}

pub(super) fn prepare_chapter_media_repair(chapter_dir: &Path) -> Result<HashMap<String, u64>, String> {
    let archives: Vec<_> = [MEDIA_ARCHIVE_FILE, "media.zip.tmp.zip", "media.zip.bak", "media.zip.rollback"]
        .iter().map(|name| chapter_dir.join(name)).filter(|path| path.exists()).collect();
    let mut manifest = match read_chapter_media_archive_manifest(chapter_dir)? {
        ChapterMediaArchiveManifestState::Missing if archives.is_empty() => return Ok(HashMap::new()),
        ChapterMediaArchiveManifestState::Valid(manifest) => manifest.raw,
        _ => return Err("chapter media: a valid manifest is required for repair".into()),
    };
    for file in manifest["media"]["files"].as_array_mut().ok_or("chapter media: missing manifest files")? {
        file["status"] = "stored".into();
    }
    let expected = parse_chapter_media_archive_manifest(&manifest.to_string())?.stored_files;
    if expected.len() > MAX_ENTRIES { return Err("chapter media: too many repair manifest entries".into()); }
    let mut declared = 0;
    for file in &expected {
        if file.bytes > MAX_ENTRY_BYTES { return Err("chapter media: repair asset exceeds byte limit".into()); }
        add_repair_bytes(&mut declared, file.bytes)?;
    }
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).map_err(|err| format!("chapter media: create repair workspace: {err}"))?;
    let mut valid = HashMap::new();
    let mut ambiguous = HashSet::new();
    let mut expanded = 0;
    for archive_path in archives {
        let source = match File::open(&archive_path) {
            Ok(source) => source,
            Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("chapter media: open repair archive: {err}")),
        };
        if source.metadata().map_err(|err| format!("chapter media: inspect repair archive: {err}"))?.len() > MAX_ARCHIVE_BYTES {
            return Err("chapter media: repair archive exceeds byte limit".into());
        }
        match ZipArchive::new(source) {
            Ok(mut archive) => {
                let mut source = File::open(&archive_path).map_err(|err| format!("chapter media: read repair inventory: {err}"))?;
                let duplicates = repair_archive_duplicates(&mut source, archive.central_directory_start())?;
                ambiguous.extend(duplicates.iter().cloned());
                for file in &expected {
                    if valid.contains_key(&file.file_name) || duplicates.contains(&file.file_name.to_ascii_lowercase()) { continue; }
                    let Ok(mut entry) = archive.by_name(&file.file_name) else { continue; };
                    if !entry.is_file() || entry.is_symlink() { continue; }
                    if let Some(bytes) = stage_repair_entry(&mut entry, Some(file), &media_dir, &mut expanded)? {
                        publish_repair_entry(&media_dir, &file.file_name)?;
                        valid.insert(file.file_name.clone(), bytes);
                    }
                }
            }
            Err(_) => {
                let mut source = File::open(&archive_path).map_err(|err| format!("chapter media: reopen repair archive: {err}"))?;
                recover_repair_stream(&mut source, &expected, &media_dir, &mut valid, &mut ambiguous, &mut expanded)?;
            }
        }
    }
    let mut total = valid.values().sum();
    for file in expected.iter().filter(|file| !valid.contains_key(&file.file_name)).collect::<Vec<_>>() {
        if ambiguous.contains(&file.file_name.to_ascii_lowercase()) { continue; }
        match fs::symlink_metadata(media_dir.join(&file.file_name)) {
            Ok(metadata) if metadata.is_file() && file.bytes > 0 && metadata.len() == file.bytes => {
                add_repair_bytes(&mut total, file.bytes)?;
                valid.insert(file.file_name.clone(), file.bytes);
            }
            Ok(_) => {},
            Err(err) if err.kind() == io::ErrorKind::NotFound => {},
            Err(err) => return Err(format!("chapter media: inspect repair asset: {err}")),
        }
    }
    Ok(valid)
}

// The ZIP library indexes by name and hides duplicate central-directory records.
fn repair_archive_duplicates(source: &mut File, start: u64) -> Result<HashSet<String>, String> {
    source.seek(SeekFrom::Start(start)).map_err(|err| format!("chapter media: seek repair directory: {err}"))?;
    let mut names = HashSet::new();
    let mut duplicates = HashSet::new();
    let mut entries = 0;
    let mut declared = 0;
    loop {
        let mut signature = [0; 4];
        source.read_exact(&mut signature).map_err(|err| format!("chapter media: read repair directory: {err}"))?;
        if signature != [80, 75, 1, 2] { break; }
        entries += 1;
        if entries > MAX_ENTRIES { return Err("chapter media: too many repair archive entries".into()); }
        let mut header = [0; 42];
        source.read_exact(&mut header).map_err(|err| format!("chapter media: read repair entry metadata: {err}"))?;
        let bytes = u32::from_le_bytes(header[20..24].try_into().unwrap()) as u64;
        if bytes > MAX_ENTRY_BYTES { return Err("chapter media: repair entry exceeds byte limit".into()); }
        add_repair_bytes(&mut declared, bytes)?;
        let name_length = u16::from_le_bytes(header[24..26].try_into().unwrap()) as usize;
        let extra_length = u16::from_le_bytes(header[26..28].try_into().unwrap()) as i64;
        let comment_length = u16::from_le_bytes(header[28..30].try_into().unwrap()) as i64;
        let mut name = vec![0; name_length];
        source.read_exact(&mut name).map_err(|err| format!("chapter media: read repair entry name: {err}"))?;
        let name = String::from_utf8_lossy(&name).to_ascii_lowercase();
        if !names.insert(name.clone()) { duplicates.insert(name); }
        source.seek(SeekFrom::Current(extra_length + comment_length)).map_err(|err| format!("chapter media: seek repair entry: {err}"))?;
    }
    Ok(duplicates)
}

fn recover_repair_stream(
    source: &mut File,
    expected: &[ExpectedStoredChapterMedia],
    media_dir: &Path,
    valid: &mut HashMap<String, u64>,
    ambiguous: &mut HashSet<String>,
    expanded: &mut u64,
) -> Result<(), String> {
    let by_name: HashMap<_, _> = expected.iter().map(|file| (file.file_name.as_str(), file)).collect();
    let mut names = HashSet::new();
    let mut candidates = HashMap::new();
    let mut entries = 0;
    let result = (|| {
        loop {
            let mut entry = match zip::read::read_zipfile_from_stream(source) {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(zip::result::ZipError::UnsupportedArchive(reason)) => {
                    return Err(format!(
                        "chapter media: unsupported archive stream: {reason}. The original archive was preserved. Restore a complete archive copy and retry."
                    ));
                }
                Err(_) => break,
            };
            entries += 1;
            if entries > MAX_ENTRIES { return Err("chapter media: too many repair archive entries".into()); }
            let name = entry.name().to_owned();
            let folded = name.to_ascii_lowercase();
            if !names.insert(folded.clone()) { ambiguous.insert(folded.clone()); }
            let file = by_name.get(name.as_str()).copied().filter(|_| !valid.contains_key(&name) && !ambiguous.contains(&folded));
            if let Some(bytes) = stage_repair_entry(&mut entry, file, media_dir, expanded)? {
                if file.is_some() { candidates.insert(name, bytes); }
            }
        }
        for (name, bytes) in &candidates {
            if ambiguous.contains(&name.to_ascii_lowercase()) { continue; }
            publish_repair_entry(media_dir, name)?;
            valid.insert(name.clone(), *bytes);
        }
        Ok(())
    })();
    for name in candidates.keys() {
        let temp = media_dir.join(format!("{name}.part"));
        if temp.exists() { fs::remove_file(temp).map_err(|err| format!("chapter media: remove ambiguous repair staging file: {err}"))?; }
    }
    result
}

fn publish_repair_entry(media_dir: &Path, name: &str) -> Result<(), String> {
    fs::rename(media_dir.join(format!("{name}.part")), media_dir.join(name))
        .map_err(|err| format!("chapter media: publish repair asset: {err}"))
}

fn stage_repair_entry(
    input: &mut impl Read,
    expected: Option<&ExpectedStoredChapterMedia>,
    media_dir: &Path,
    expanded: &mut u64,
) -> Result<Option<u64>, String> {
    let temp = expected.map(|file| media_dir.join(format!("{}.part", file.file_name)));
    let result = (|| {
        let mut output = temp.as_ref().map(File::create).transpose().map_err(|err| format!("chapter media: stage repair asset: {err}"))?;
        let mut bytes = 0;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => count,
                Err(_) => return Ok(None),
            };
            add_repair_bytes(expanded, count as u64)?;
            bytes += count as u64;
            if bytes > MAX_ENTRY_BYTES { return Err("chapter media: repair entry exceeds byte limit".into()); }
            if let Some(output) = &mut output {
                output.write_all(&buffer[..count]).map_err(|err| format!("chapter media: write repair asset: {err}"))?;
            }
        }
        if bytes == 0 || expected.is_some_and(|file| file.bytes > 0 && bytes != file.bytes) { return Ok(None); }
        if let Some(output) = output {
            output.sync_all().map_err(|err| format!("chapter media: sync repair asset: {err}"))?;
        }
        Ok(Some(bytes))
    })();
    if !matches!(result, Ok(Some(_))) {
        if let Some(temp) = temp.filter(|path| path.exists()) {
            fs::remove_file(temp).map_err(|err| format!("chapter media: remove repair staging file: {err}"))?;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    fn fixture(names: &[&str]) -> Vec<u8> {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        for (index, name) in names.iter().enumerate() {
            archive.start_file(*name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
            archive.write_all(&[index as u8 + 1]).unwrap();
        }
        archive.finish().unwrap().into_inner()
    }

    fn write_manifest(path: &Path, names: &[&str]) {
        let manifest = serde_json::json!({"version":1,"complete":false,"updatedAt":1,"media":{"files":names.iter().map(|name| serde_json::json!({"fileName":name,"path":format!("media/{name}"),"sourceUrl":format!("https://source.test/{name}"),"bytes":1,"status":"remote","updatedAt":1})).collect::<Vec<_>>()}});
        fs::write(path.join("manifest.json"), manifest.to_string()).unwrap();
    }

    fn duplicate_fixture(truncated: bool) -> Vec<u8> {
        let mut bytes = fixture(&["first.png", "other.png", "last.png"]);
        for index in 0..bytes.len() - 9 {
            if &bytes[index..index + 9] == b"other.png" {
                bytes[index..index + 9].copy_from_slice(b"first.png");
            }
        }
        if truncated {
            let central = bytes.windows(4).position(|window| window == [80,75,1,2]).unwrap();
            bytes.truncate(central);
        }
        bytes
    }

    #[test]
    fn unknown_entries_count_toward_the_declared_archive_limit() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), &["first.png"]);
        let mut bytes = fixture(&["first.png", "2.png", "3.png", "4.png", "5.png", "6.png", "7.png", "8.png", "9.png"]);
        for index in 0..bytes.len() - 28 {
            if bytes[index..index + 4] == [80,75,1,2] {
                bytes[index + 24..index + 28].copy_from_slice(&(MAX_ENTRY_BYTES as u32).to_le_bytes());
            }
        }
        fs::write(dir.path().join("media.zip"), bytes).unwrap();
        assert!(prepare_chapter_media_repair(dir.path()).unwrap_err().contains("total byte limit"));
        assert!(!dir.path().join("media/first.png").exists());
    }

    #[test]
    fn unknown_stream_entries_count_toward_actual_expanded_bytes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("media.zip"), fixture(&["first.png", "other.png"])).unwrap();
        let mut source = File::open(dir.path().join("media.zip")).unwrap();
        let result = recover_repair_stream(&mut source, &[], dir.path(), &mut HashMap::new(), &mut HashSet::new(), &mut (MAX_TOTAL_BYTES - 1));
        assert!(result.unwrap_err().contains("total byte limit"));
    }

    #[test]
    fn duplicate_physical_entries_count_toward_the_directory_limit() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = fixture(&["first.png"]);
        let central = bytes.windows(4).position(|window| window == [80,75,1,2]).unwrap();
        let end = bytes.windows(4).position(|window| window == [80,75,5,6]).unwrap();
        let mut repeated = Vec::new();
        for _ in 0..=MAX_ENTRIES { repeated.extend_from_slice(&bytes[central..end]); }
        repeated.extend_from_slice(&bytes[end..]);
        fs::write(dir.path().join("directory.bin"), repeated).unwrap();
        let mut source = File::open(dir.path().join("directory.bin")).unwrap();
        assert!(repair_archive_duplicates(&mut source, 0).unwrap_err().contains("too many repair archive entries"));
    }

    #[test]
    fn duplicate_entries_are_not_staged_or_trusted_on_retry() {
        for truncated in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            write_manifest(dir.path(), &["first.png", "last.png"]);
            fs::write(dir.path().join("media.zip"), duplicate_fixture(truncated)).unwrap();
            for _ in 0..2 {
                let sizes = prepare_chapter_media_repair(dir.path()).unwrap();
                assert_eq!(sizes, HashMap::from([("last.png".into(), 1)]));
                assert!(!dir.path().join("media/first.png").exists());
                assert_eq!(fs::read(dir.path().join("media/last.png")).unwrap(), [3]);
            }
        }
    }

    #[test]
    fn unsupported_descriptor_stream_fails_before_publishing_a_repair_plan() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), &["first.png", "other.png"]);
        let mut descriptor = ZipWriter::new_stream(Vec::new());
        descriptor.start_file("other.png", SimpleFileOptions::default().compression_method(CompressionMethod::Deflated)).unwrap();
        descriptor.write_all(&[2]).unwrap();
        let descriptor = descriptor.finish().unwrap().into_inner();
        let mut complete = ZipArchive::new(Cursor::new(&descriptor)).unwrap();
        let mut content = Vec::new();
        complete.by_name("other.png").unwrap().read_to_end(&mut content).unwrap();
        assert_eq!(content, [2]);

        let mut truncated = fixture(&["first.png"]);
        let central = truncated.windows(4).position(|window| window == [80,75,1,2]).unwrap();
        truncated.truncate(central);
        let central = descriptor.windows(4).position(|window| window == [80,75,1,2]).unwrap();
        truncated.extend_from_slice(&descriptor[..central]);
        fs::write(dir.path().join("media.zip"), &truncated).unwrap();
        let manifest = fs::read(dir.path().join("manifest.json")).unwrap();

        let error = prepare_chapter_media_repair(dir.path()).unwrap_err();
        assert!(error.contains("unsupported archive stream"));
        assert!(error.contains("original archive was preserved"));
        assert_eq!(fs::read(dir.path().join("media.zip")).unwrap(), truncated);
        assert_eq!(fs::read(dir.path().join("manifest.json")).unwrap(), manifest);
        assert_eq!(fs::read_dir(dir.path().join("media")).unwrap().count(), 0);
    }

    #[test]
    fn rollback_archive_wins_over_damaged_equal_length_loose_bytes() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), &["first.png"]);
        let original = fixture(&["first.png"]);
        fs::write(dir.path().join("media.zip.rollback"), &original).unwrap();
        fs::create_dir(dir.path().join("media")).unwrap();
        fs::write(dir.path().join("media/first.png"), [99]).unwrap();
        for _ in 0..2 {
            let sizes = prepare_chapter_media_repair(dir.path()).unwrap();
            assert_eq!(sizes, HashMap::from([("first.png".into(), 1)]));
            assert_eq!(fs::read(dir.path().join("media/first.png")).unwrap(), [1]);
            assert_eq!(fs::read(dir.path().join("media.zip.rollback")).unwrap(), original);
            assert!(!dir.path().join("media.zip").exists());
        }
    }

    #[test]
    fn preserves_valid_entries_around_a_bad_crc_and_leaves_the_original_archive_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let files = [("first.png", vec![1, 2, 3]), ("broken.png", vec![41, 42, 43, 44]), ("last.png", vec![7, 8, 9])];
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in &files {
            archive.start_file(*name, SimpleFileOptions::default().compression_method(CompressionMethod::Stored)).unwrap();
            archive.write_all(bytes).unwrap();
        }
        let mut bytes = archive.finish().unwrap().into_inner();
        let offset = bytes.windows(4).position(|window| window == [41, 42, 43, 44]).unwrap();
        bytes[offset] = 0;
        fs::write(dir.path().join("media.zip"), &bytes).unwrap();
        let manifest = serde_json::json!({"version":1,"complete":false,"updatedAt":1,"media":{"files":files.iter().map(|(name, data)| serde_json::json!({"fileName":name,"path":format!("media/{name}"),"sourceUrl":format!("https://source.test/{name}"),"bytes":data.len(),"status":"remote","updatedAt":1})).collect::<Vec<_>>()}});
        fs::write(dir.path().join("manifest.json"), manifest.to_string()).unwrap();
        let sizes = prepare_chapter_media_repair(dir.path()).unwrap();
        assert_eq!(sizes, HashMap::from([("first.png".into(),3),("last.png".into(),3)]));
        assert_eq!(fs::read(dir.path().join("media/first.png")).unwrap(), [1,2,3]);
        assert_eq!(fs::read(dir.path().join("media/last.png")).unwrap(), [7,8,9]);
        assert_eq!(fs::read(dir.path().join("media.zip")).unwrap(), bytes);
        assert!(!dir.path().join("media/broken.png").exists());
        assert!(!dir.path().join("media/broken.png.part").exists());
    }
}
