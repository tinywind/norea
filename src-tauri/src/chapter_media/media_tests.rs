use super::super::paths::{
    CONTENTS_ROOT_DIR, MEDIA_ARCHIVE_FILE, MEDIA_DOWNLOAD_DIR, NO_MEDIA_FILE,
};
use super::*;
use std::{
    fs::{self, File},
    io::{self, BufWriter},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, ZipWriter};

fn store_input(file_name: &str) -> ChapterMediaStoreInput {
    ChapterMediaStoreInput {
        chapter_id: 42,
        file_name: file_name.to_string(),
        novel_id: Some(7),
        source_id: Some("demo".to_string()),
        novel_name: Some("Novel".to_string()),
        source_novel_id: Some("novel-id".to_string()),
        chapter_number: Some("1".to_string()),
        chapter_name: Some("Opening".to_string()),
        chapter_position: Some(1),
    }
}

fn stored_media_path(root: &Path, file_name: &str) -> PathBuf {
    root.join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join("novel-id")
        .join("1")
        .join(MEDIA_DOWNLOAD_DIR)
        .join(file_name)
}

#[test]
fn store_chapter_media_file_consumes_source_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source_path = dir.path().join("stream.bin");
    fs::write(&source_path, [7, 8, 9]).expect("write stream");

    let src = store_chapter_media_at_root(
        dir.path(),
        store_input("page.png"),
        source_path.clone(),
    )
    .expect("store media handle");

    assert_eq!(src, "norea-media://reader-asset/page.png");
    assert!(!source_path.exists());
    assert!(dir.path().join(CONTENTS_ROOT_DIR).join(NO_MEDIA_FILE).exists());
    assert_eq!(
        fs::read(stored_media_path(dir.path(), "page.png")).expect("stored media"),
        vec![7, 8, 9]
    );
}

#[test]
fn media_path_from_chapter_dir_does_not_extract_archived_media() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = dir.path().join("chapter");
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    {
        let archive_file = File::create(&archive_path).expect("create archive");
        let mut archive = ZipWriter::new(BufWriter::new(archive_file));
        archive
            .start_file("page.png", SimpleFileOptions::default())
            .expect("start archive entry");
        io::copy(&mut &b"image-body"[..], &mut archive).expect("write archive entry");
        archive.finish().expect("finish archive");
    }

    let path =
        media_path_from_chapter_dir(&chapter_dir, "page.png").expect("resolve archived media");
    let body = media_body_from_chapter_dir(&chapter_dir, "page.png")
        .expect("read archived media")
        .expect("archived media body");

    assert!(path.is_none());
    assert_eq!(body, b"image-body");
    assert!(!chapter_dir
        .join(MEDIA_DOWNLOAD_DIR)
        .join("page.png")
        .exists());
}

#[test]
fn resolve_regular_file_len_reads_actual_bytes_when_stat_reports_zero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let non_empty = dir.path().join("0007-7.jpg");
    let payload = vec![0xffu8; 183_222];
    fs::write(&non_empty, &payload).expect("write image");

    assert_eq!(
        resolve_regular_file_len(&non_empty, 0, "chapter media: read loose media file")
            .expect("measure non-empty file when stat reports 0"),
        183_222
    );
    assert_eq!(
        resolve_regular_file_len(&non_empty, 183_222, "chapter media: read loose media file")
            .expect("use non-zero reported length"),
        183_222
    );

    let empty = dir.path().join("empty.jpg");
    fs::write(&empty, []).expect("write empty file");
    assert_eq!(
        resolve_regular_file_len(&empty, 0, "chapter media: read loose media file")
            .expect("measure actually empty file"),
        0
    );
}

#[test]
fn copy_file_without_copy_file_range_preserves_multi_buffer_payload() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("source.bin");
    let part = dir.path().join("part.bin");
    let payload: Vec<u8> = (0..183_222u32).map(|value| (value % 251) as u8).collect();
    fs::write(&source, &payload).expect("write source");

    let copied = copy_file_without_copy_file_range(&source, &part).expect("copy payload");

    assert_eq!(copied, payload.len() as u64);
    assert_eq!(fs::read(&part).expect("read part"), payload);
    assert_eq!(fs::metadata(&part).expect("stat part").len(), payload.len() as u64);
}
