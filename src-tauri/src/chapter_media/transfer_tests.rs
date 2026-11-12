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
fn chapter_storage_move_restores_the_original_directory_on_rollback() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/source-a/a/1";
    let target = "contents/source-b/b/2";
    write_downloaded_chapter(dir.path(), source, b"source body");
    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(), vec![transfer_entry("1", source, target)], "move-1", false, true,
    ).expect("prepare move");
    assert!(!dir.path().join(source).exists(), "moves must not retain a byte copy");
    assert_eq!(fs::read(dir.path().join(target).join("content.html")).unwrap(), b"source body");
    rollback_chapter_storage_transfer_at_root(dir.path(), &preparation).expect("rollback move");
    rollback_chapter_storage_transfer_at_root(dir.path(), &preparation).expect("repeat rollback");
    assert_eq!(fs::read(dir.path().join(source).join("content.html")).unwrap(), b"source body");
    assert!(!dir.path().join(target).exists());
}

#[test]
fn interrupted_move_recovers_from_the_plan_without_a_native_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let source = "contents/source-a/a/1";
    let target = "contents/source-b/b/2";
    let entry = transfer_entry("1", source, target);
    write_downloaded_chapter(dir.path(), source, b"only body");
    fs::create_dir_all(dir.path().join(target).parent().unwrap()).unwrap();
    fs::write(transfer_marker_path(&dir.path().join(source), "interrupted").unwrap(), MOVE_MARKER).unwrap();
    let stage = transfer_sibling_path(&dir.path().join(target), "interrupted", "stage").unwrap();
    fs::rename(dir.path().join(source), &stage).unwrap();
    rollback_transfer_entry(dir.path(), &entry, "interrupted").unwrap();
    rollback_transfer_entry(dir.path(), &entry, "interrupted").unwrap();
    assert_eq!(fs::read(dir.path().join(source).join("content.html")).unwrap(), b"only body");
    assert!(!stage.exists());
}

#[test]
fn moved_chapter_rollback_preserves_both_bodies_when_source_is_occupied() {
    let dir = tempfile::tempdir().unwrap();
    let source = "contents/source-a/a/1";
    let target = "contents/source-b/b/2";
    write_downloaded_chapter(dir.path(), source, b"moved body");
    let preparation = prepare_chapter_storage_transfer_at_root(dir.path(), vec![transfer_entry("1", source, target)], "occupied", false, true).unwrap();
    write_downloaded_chapter(dir.path(), source, b"new source body");
    assert!(rollback_chapter_storage_transfer_at_root(dir.path(), &preparation).unwrap_err().contains("occupied source"));
    assert_eq!(fs::read(dir.path().join(source).join("content.html")).unwrap(), b"new source body");
    assert_eq!(fs::read(dir.path().join(target).join("content.html")).unwrap(), b"moved body");
}

#[test]
fn move_rollback_removes_an_incomplete_marker_without_deleting_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = "contents/source-a/a/1";
    let entry = transfer_entry("1", source, "contents/source-b/b/2");
    write_downloaded_chapter(dir.path(), source, b"original body");
    fs::write(transfer_marker_path(&dir.path().join(source), "marker").unwrap(), b"{").unwrap();
    rollback_transfer_entry(dir.path(), &entry, "marker").unwrap();
    assert_eq!(fs::read(dir.path().join(source).join("content.html")).unwrap(), b"original body");
}

#[test]
fn moved_chapter_finalization_keeps_the_only_body_and_clears_its_marker() {
    let dir = tempfile::tempdir().unwrap();
    let source = "contents/source-a/a/1";
    let target = "contents/source-b/b/2";
    write_downloaded_chapter(dir.path(), source, b"moved body");
    let preparation = prepare_chapter_storage_transfer_at_root(dir.path(), vec![transfer_entry("1", source, target)], "final", false, true).unwrap();
    finalize_chapter_storage_transfer_at_root(dir.path(), &preparation).unwrap();
    finalize_chapter_storage_transfer_at_root(dir.path(), &preparation).unwrap();
    assert!(!dir.path().join(source).exists());
    assert!(!has_transfer_marker(&dir.path().join(target), "final").unwrap());
    assert_eq!(fs::read(dir.path().join(target).join("content.html")).unwrap(), b"moved body");
}

#[test]
fn finalization_retains_a_move_stage_when_the_final_target_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let source = "contents/source-a/a/1";
    let target = "contents/source-b/b/2";
    write_downloaded_chapter(dir.path(), source, b"only body");
    let preparation = prepare_chapter_storage_transfer_at_root(dir.path(), vec![transfer_entry("1", source, target)], "stage", false, true).unwrap();
    let stage = transfer_sibling_path(&dir.path().join(target), "stage", "stage").unwrap();
    fs::rename(dir.path().join(target), &stage).unwrap();
    assert!(finalize_chapter_storage_transfer_at_root(dir.path(), &preparation).is_err());
    assert_eq!(fs::read(stage.join("content.html")).unwrap(), b"only body");
}

#[test]
fn chapter_storage_transfer_copies_the_complete_directory_before_finalize() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/source-a/novel-a/1";
    let target = "contents/source-b/novel-b/1";
    write_downloaded_chapter(dir.path(), source, b"source chapter");

    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-1",
        false,
        false,
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
    let source = "contents/source-a/novel-a/1";
    let target = "contents/source-b/novel-b/1";
    write_downloaded_chapter(dir.path(), source, b"source chapter");
    write_downloaded_chapter(dir.path(), target, b"target chapter");

    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-2",
        false,
        false,
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
    let source = "contents/source-a/novel-a/1";
    let target = "contents/source-b/novel-b/1";
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
        false,
        false,
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
    let source = "contents/source-a/novel-a/1";
    let target = "contents/source-b/novel-b/1";
    write_downloaded_chapter(dir.path(), source, b"source chapter");
    let preparation = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry("chapter-1", source, target)],
        "transfer-retry",
        false,
        false,
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
    let source_one = "contents/source-a/novel-a/1";
    let source_two = "contents/source-a/novel-a/2";
    let target = "contents/source-b/novel-b/1";
    write_downloaded_chapter(dir.path(), source_one, b"one");
    write_downloaded_chapter(dir.path(), source_two, b"two");

    let error = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![
            transfer_entry("chapter-1", source_one, target),
            transfer_entry("chapter-2", source_two, target),
        ],
        "transfer-4",
        false,
        false,
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
    let source_one = "contents/source-a/novel-a/1";
    let source_two = "contents/source-a/novel-a/2";
    let target_one = "contents/source-b/novel-b/1";
    let target_two = "contents/source-b/novel-b/2";
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
        false,
        false,
    )
    .expect_err("reject source symlink");

    assert!(error.contains("symbolic link"));
    assert!(!dir.path().join(target_one).exists());
    assert!(!dir.path().join(target_two).exists());
    assert!(dir.path().join(source_one).is_dir());
    assert!(dir.path().join(source_two).is_dir());
}

#[test]
fn strict_renumber_preflights_all_targets_before_copying() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source_one = "contents/bookkor/novel/900001";
    let source_two = "contents/bookkor/novel/900002";
    let target_one = "contents/bookkor/novel/1";
    let target_two = "contents/bookkor/novel/2";
    write_downloaded_chapter(dir.path(), source_one, b"first original");
    write_downloaded_chapter(dir.path(), source_two, b"second original");
    write_downloaded_chapter(dir.path(), target_two, b"unrelated target");

    let error = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![
            transfer_entry("one", source_one, target_one),
            transfer_entry("two", source_two, target_two),
        ],
        "renumber-target-conflict",
        true,
        false,
    )
    .expect_err("an occupied target must stop the whole plan");

    assert!(error.contains("target must be absent"));
    assert!(!dir.path().join(target_one).exists());
    assert_eq!(
        fs::read(dir.path().join(target_two).join("content.html")).expect("existing target"),
        b"unrelated target"
    );
    assert!(dir.path().join(source_one).is_dir());
    assert!(dir.path().join(source_two).is_dir());
}

#[test]
fn strict_renumber_preserves_unfinished_sources_before_copying() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source_one = "contents/bookkor/novel/900001";
    let source_two = "contents/bookkor/novel/900002";
    let target_one = "contents/bookkor/novel/1";
    let target_two = "contents/bookkor/novel/2";
    write_downloaded_chapter(dir.path(), source_one, b"first original");
    fs::create_dir_all(dir.path().join(source_two)).expect("partial source directory");
    let partial = dir
        .path()
        .join(source_two)
        .join(CHAPTER_PARTIAL_CONTENT_FILE);
    fs::write(&partial, b"irreplaceable unfinished download").expect("partial source");

    let error = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![
            transfer_entry("one", source_one, target_one),
            transfer_entry("two", source_two, target_two),
        ],
        "renumber-partial-source",
        true,
        false,
    )
    .expect_err("an unfinished source must not become an empty chapter");

    assert!(error.contains("unfinished content"));
    assert!(!dir.path().join(target_one).exists());
    assert!(!dir.path().join(target_two).exists());
    assert_eq!(
        fs::read(partial).expect("partial source remains"),
        b"irreplaceable unfinished download"
    );
}

#[test]
fn persisted_renumber_intent_recovers_without_the_native_receipt() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/bookkor/novel/900001";
    let target = "contents/bookkor/novel/1";
    let entry = transfer_entry("one", source, target);
    let token = "persisted-renumber-intent";
    write_downloaded_chapter(dir.path(), source, b"original chapter");

    let receipt =
        prepare_chapter_storage_transfer_at_root(dir.path(), vec![entry.clone()], token, true, false)
            .expect("prepare with persisted token");
    assert_eq!(receipt.token, token);
    let intent = ChapterStorageTransferPreparation {
        token: token.to_string(),
        entries: vec![transfer_prepared_entry(
            dir.path(),
            entry,
            ChapterStorageTransferOutcome::CopiedSource,
            false,
            None,
        )
        .expect("reconstruct rollback from durable intent")],
    };

    rollback_chapter_storage_transfer_at_root(dir.path(), &intent).expect("recover lost response");
    assert!(dir.path().join(source).is_dir());
    assert!(!dir.path().join(target).exists());
    write_downloaded_chapter(dir.path(), target, b"a later unrelated download");
    rollback_chapter_storage_transfer_at_root(dir.path(), &intent).expect("idempotent recovery");
    assert_eq!(
        fs::read(dir.path().join(target).join("content.html")).expect("unmarked target remains"),
        b"a later unrelated download"
    );
}

#[test]
fn persisted_renumber_intent_removes_only_its_interrupted_stage() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = "contents/bookkor/novel/900001";
    let target = "contents/bookkor/novel/1";
    let token = "interrupted-renumber";
    write_downloaded_chapter(dir.path(), source, b"original chapter");
    let own_stage =
        transfer_sibling_path(&dir.path().join(target), token, "stage").expect("stage path");
    let other_stage = transfer_sibling_path(&dir.path().join(target), "another-operation", "stage")
        .expect("other stage");
    fs::create_dir_all(&own_stage).expect("interrupted stage");
    fs::write(own_stage.join("content.html"), b"partial copy").expect("interrupted copy");
    fs::create_dir_all(&other_stage).expect("other operation stage");
    let intent = ChapterStorageTransferPreparation {
        token: token.to_string(),
        entries: vec![transfer_prepared_entry(
            dir.path(),
            transfer_entry("one", source, target),
            ChapterStorageTransferOutcome::CopiedSource,
            false,
            None,
        )
        .expect("durable intent")],
    };
    rollback_chapter_storage_transfer_at_root(dir.path(), &intent)
        .expect("recover interrupted copy");
    assert!(!own_stage.exists());
    assert!(other_stage.is_dir());
    assert!(dir.path().join(source).is_dir());
}

#[test]
fn strict_renumber_rejects_crossed_paths_and_retains_missing_sources() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first = "contents/bookkor/novel/1";
    let second = "contents/bookkor/novel/2";
    let error = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![
            transfer_entry("one", first, second),
            transfer_entry("two", second, first),
        ],
        "renumber-cycle",
        true,
        false,
    )
    .expect_err("cycles must be rejected even when both directories are absent");
    assert!(error.contains("disjoint"));

    let receipt = prepare_chapter_storage_transfer_at_root(
        dir.path(),
        vec![transfer_entry(
            "one",
            "contents/bookkor/novel/900001",
            first,
        )],
        "renumber-not-downloaded",
        true,
        false,
    )
    .expect("an absent source is a metadata-only chapter");
    assert_eq!(
        receipt.entries[0].outcome,
        ChapterStorageTransferOutcome::SourceNotDownloaded
    );
    assert!(!dir.path().join(first).exists());
}
