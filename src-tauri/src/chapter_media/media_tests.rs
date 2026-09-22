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
        novel_path: Some("novel/path".to_string()),
        chapter_number: Some("1".to_string()),
        chapter_name: Some("Opening".to_string()),
        chapter_position: Some(1),
    }
}

fn stored_media_path(root: &Path, file_name: &str) -> PathBuf {
    root.join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join("Novel-novel-path")
        .join("1-Opening")
        .join(MEDIA_DOWNLOAD_DIR)
        .join(file_name)
}

#[test]
fn store_chapter_media_body_writes_contextual_media_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = store_chapter_media_at_root(
        dir.path(),
        store_input("page.png"),
        ChapterMediaStoreSource::Bytes(vec![1, 2, 3]),
    )
    .expect("store media");

    assert_eq!(src, "norea-media://reader-asset/page.png");
    assert_eq!(
        fs::read(stored_media_path(dir.path(), "page.png")).expect("stored media"),
        vec![1, 2, 3]
    );
    assert!(dir
        .path()
        .join(CONTENTS_ROOT_DIR)
        .join(NO_MEDIA_FILE)
        .exists());
}

#[test]
fn store_chapter_media_file_consumes_source_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source_path = dir.path().join("stream.bin");
    fs::write(&source_path, [7, 8, 9]).expect("write stream");

    let src = store_chapter_media_at_root(
        dir.path(),
        store_input("page.png"),
        ChapterMediaStoreSource::File(source_path.clone()),
    )
    .expect("store media handle");

    assert_eq!(src, "norea-media://reader-asset/page.png");
    assert!(!source_path.exists());
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
