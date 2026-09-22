use super::super::paths::{
    CHAPTER_MEDIA_MANIFEST_FILE, CHAPTER_PARTIAL_CONTENT_FILE, MEDIA_ARCHIVE_FILE,
    MEDIA_DOWNLOAD_DIR,
};
use super::super::types::{ChapterStorageTransferEntry, ChapterStorageTransferOutcome};
use super::*;
use std::{fs, path::Path};

fn transfer_entry(entry_id: &str, source: &str, target: &str) -> ChapterStorageTransferEntry {
    ChapterStorageTransferEntry {
        entry_id: entry_id.to_string(),
        source_relative_dir: source.to_string(),
        target_relative_dir: target.to_string(),
    }
}

fn write_downloaded_chapter(root: &Path, relative_dir: &str, body: &[u8]) {
    let chapter_dir = root.join(relative_dir);
    fs::create_dir_all(chapter_dir.join(MEDIA_DOWNLOAD_DIR)).expect("create chapter storage");
    fs::write(chapter_dir.join("content.html"), body).expect("write chapter content");
    fs::write(
        chapter_dir.join(MEDIA_DOWNLOAD_DIR).join("page.png"),
        b"image",
    )
    .expect("write chapter media");
    fs::write(chapter_dir.join(MEDIA_ARCHIVE_FILE), b"archive").expect("write media archive");
    fs::write(chapter_dir.join(CHAPTER_MEDIA_MANIFEST_FILE), b"manifest")
        .expect("write media manifest");
}

#[test]
fn chapter_storage_transfer_copies_the_complete_directory_before_finalize() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/source-a/Novel-a/1-Opening";
    let target = "contents/source-b/Novel-b/1-Opening";
    write_downloaded_chapter(dir.path(), source, b"source chapter");

    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-1",
    )
    .expect("prepare transfer");

    assert_eq!(
        preparation.entries[0].outcome,
        ChapterStorageTransferOutcome::CopiedSource
    );
    assert_eq!(preparation.entries[0].media_bytes, 12);
    assert!(dir.path().join(source).is_dir());
    assert_eq!(
        fs::read(dir.path().join(target).join("content.html")).expect("target content"),
        b"source chapter"
    );
    assert_eq!(
        fs::read(
            dir.path()
                .join(target)
                .join(MEDIA_DOWNLOAD_DIR)
                .join("page.png")
        )
        .expect("target media"),
        b"image"
    );
    assert!(dir.path().join(target).join(MEDIA_ARCHIVE_FILE).is_file());
    assert!(dir
        .path()
        .join(target)
        .join(CHAPTER_MEDIA_MANIFEST_FILE)
        .is_file());

    finalize_chapter_storage_transfer_at_root(dir.path(), &preparation).expect("finalize transfer");
    finalize_chapter_storage_transfer_at_root(dir.path(), &preparation)
        .expect("finalize transfer again");
    assert!(!dir.path().join(source).exists());
    assert!(dir.path().join(target).is_dir());
}

#[test]
fn chapter_storage_transfer_keeps_an_existing_target_download() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/source-a/Novel-a/1-Opening";
    let target = "contents/source-b/Novel-b/1-Opening";
    write_downloaded_chapter(dir.path(), source, b"source chapter");
    write_downloaded_chapter(dir.path(), target, b"target chapter");

    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-2",
    )
    .expect("prepare transfer");

    assert_eq!(
        preparation.entries[0].outcome,
        ChapterStorageTransferOutcome::KeptTarget
    );
    assert_eq!(
        fs::read(dir.path().join(target).join("content.html")).expect("target content"),
        b"target chapter"
    );
    assert!(dir.path().join(source).is_dir());
}

#[test]
fn chapter_storage_transfer_restores_an_invalid_target_on_rollback() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/source-a/Novel-a/1-Opening";
    let target = "contents/source-b/Novel-b/1-Opening";
    write_downloaded_chapter(dir.path(), source, b"source chapter");
    fs::create_dir_all(dir.path().join(target)).expect("create partial target");
    fs::write(
        dir.path().join(target).join(CHAPTER_PARTIAL_CONTENT_FILE),
        b"partial",
    )
    .expect("write partial target");

    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-3",
    )
    .expect("prepare transfer");

    assert!(preparation.entries[0].replaced_target);
    rollback_chapter_storage_transfer_at_root(dir.path(), &preparation).expect("rollback transfer");
    rollback_chapter_storage_transfer_at_root(dir.path(), &preparation)
        .expect("rollback transfer again");
    assert!(dir.path().join(source).is_dir());
    assert_eq!(
        fs::read(dir.path().join(target).join(CHAPTER_PARTIAL_CONTENT_FILE))
            .expect("restored partial target"),
        b"partial"
    );
    assert!(!dir.path().join(target).join("content.html").exists());
}

#[test]
fn repeated_transfer_rollback_does_not_remove_a_new_target_download() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/source-a/Novel-a/1-Opening";
    let target = "contents/source-b/Novel-b/1-Opening";
    write_downloaded_chapter(dir.path(), source, b"source chapter");
    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-retry",
    )
    .expect("prepare transfer");

    rollback_chapter_storage_transfer_at_root(dir.path(), &preparation).expect("rollback transfer");
    write_downloaded_chapter(dir.path(), target, b"new target chapter");
    rollback_chapter_storage_transfer_at_root(dir.path(), &preparation)
        .expect("repeat rollback transfer");

    assert_eq!(
        fs::read(dir.path().join(target).join("content.html")).expect("new target content"),
        b"new target chapter"
    );
}

#[test]
fn chapter_storage_transfer_rejects_invalid_and_duplicate_target_paths() {
    assert!(safe_chapter_storage_relative_dir("contents/source/novel").is_err());
    assert!(safe_chapter_storage_relative_dir("chapter-media/source/novel/chapter").is_err());
    assert!(safe_chapter_storage_relative_dir("contents/source/../novel/chapter").is_err());
    assert!(safe_chapter_storage_removal_relative_dir("contents/source/novel").is_ok());
    assert!(safe_chapter_storage_removal_relative_dir("contents/source").is_err());

    let dir = tempfile::tempdir().expect("tempdir");
    let source_one = "contents/source-a/Novel-a/1-Opening";
    let source_two = "contents/source-a/Novel-a/2-Next";
    let target = "contents/source-b/Novel-b/1-Opening";
    write_downloaded_chapter(dir.path(), source_one, b"one");
    write_downloaded_chapter(dir.path(), source_two, b"two");

    let error = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![
            transfer_entry("chapter-1", source_one, target),
            transfer_entry("chapter-2", source_two, target),
        ],
        "transfer-4",
    )
    .expect_err("reject duplicate target");

    assert!(error.contains("duplicate target"));
    assert!(!dir.path().join(target).exists());
}

#[cfg(unix)]
#[test]
fn chapter_storage_transfer_rolls_back_prior_entries_after_copy_failure() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().expect("tempdir");
    let source_one = "contents/source-a/Novel-a/1-Opening";
    let source_two = "contents/source-a/Novel-a/2-Next";
    let target_one = "contents/source-b/Novel-b/1-Opening";
    let target_two = "contents/source-b/Novel-b/2-Next";
    write_downloaded_chapter(dir.path(), source_one, b"one");
    write_downloaded_chapter(dir.path(), source_two, b"two");
    symlink(
        dir.path().join(source_one).join("content.html"),
        dir.path().join(source_two).join("unsafe-link"),
    )
    .expect("create source symlink");

    let error = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![
            transfer_entry("chapter-1", source_one, target_one),
            transfer_entry("chapter-2", source_two, target_two),
        ],
        "transfer-5",
    )
    .expect_err("reject source symlink");

    assert!(error.contains("symbolic link"));
    assert!(!dir.path().join(target_one).exists());
    assert!(!dir.path().join(target_two).exists());
    assert!(dir.path().join(source_one).is_dir());
    assert!(dir.path().join(source_two).is_dir());
}
