use super::super::content::inspect_content_chapter_dir;
use super::super::manifest::parse_chapter_media_archive_manifest;
use super::super::paths::{
    CHAPTER_MEDIA_MANIFEST_FILE, CONTENTS_ROOT_DIR, MEDIA_ARCHIVE_FILE, MEDIA_DOWNLOAD_DIR,
};
use super::super::publication::{
    archive_backup_path, archive_rollback_path, chapter_media_archive_publication_paths,
    chapter_media_manifest_backup_path, chapter_media_manifest_path,
    chapter_media_manifest_publication_paths, chapter_media_manifest_rollback_path,
    remove_stale_chapter_media_archive_publication_files, write_chapter_media_manifest,
};
use super::*;
use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read},
    path::{Path, PathBuf},
    sync::Arc,
};
use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

#[test]
fn write_chapter_media_manifest_replaces_existing_manifest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manifest_path = dir.path().join(CHAPTER_MEDIA_MANIFEST_FILE);

    write_chapter_media_manifest(
        &manifest_path,
        &serde_json::json!({
            "version": 1,
            "complete": false,
            "media": { "files": [{ "fileName": "old.png" }] }
        }),
    )
    .expect("write initial manifest");
    write_chapter_media_manifest(
        &manifest_path,
        &serde_json::json!({
            "version": 1,
            "complete": true,
            "media": { "files": [{ "fileName": "new.png" }] }
        }),
    )
    .expect("replace manifest");

    let manifest = fs::read_to_string(&manifest_path).expect("read replaced media manifest");
    assert!(manifest.contains("new.png"));
    assert!(!manifest.contains("old.png"));
    assert!(!manifest_path.with_extension("json.tmp").exists());
    assert!(!chapter_media_manifest_backup_path(&manifest_path).exists());
}

#[test]
fn manifest_publication_replaces_current_when_recovery_slots_are_occupied() {
    let dir = tempfile::tempdir().expect("tempdir");
    let manifest_path = dir.path().join(CHAPTER_MEDIA_MANIFEST_FILE);
    let backup_path = chapter_media_manifest_backup_path(&manifest_path);
    let rollback_path = chapter_media_manifest_rollback_path(&manifest_path);
    fs::write(&manifest_path, b"current").expect("write current manifest");
    fs::write(&backup_path, b"recovery").expect("write recovery manifest");
    fs::write(&rollback_path, b"blocked").expect("write rollback blocker");

    write_chapter_media_manifest(
        &manifest_path,
        &serde_json::json!({
            "version": 1,
            "complete": true,
            "updatedAt": 1,
            "media": { "files": [] }
        }),
    )
    .expect("publish manifest");

    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).expect("read published manifest"))
            .expect("parse published manifest");
    assert_eq!(manifest["complete"], true);
    assert!(!backup_path.exists());
    assert!(!rollback_path.exists());
}

fn write_recovery_manifest(chapter_dir: &Path, complete: bool, files: serde_json::Value) {
    write_chapter_media_manifest(
        &chapter_media_manifest_path(chapter_dir),
        &serde_json::json!({
            "version": 1,
            "complete": complete,
            "updatedAt": 1,
            "media": { "files": files }
        }),
    )
    .expect("write recovery manifest");
}

fn stored_manifest_file(file_name: &str, bytes: u64) -> serde_json::Value {
    serde_json::json!({
        "bytes": bytes,
        "contentType": "image/png",
        "fileName": file_name,
        "path": format!("media/{file_name}"),
        "sourceUrl": format!("https://example.test/{file_name}"),
        "status": "stored",
        "updatedAt": 1
    })
}

#[test]
fn chapter_media_manifest_rejects_unsafe_stored_file_names() {
    let manifest = serde_json::json!({
        "version": 1,
        "complete": false,
        "updatedAt": 1,
        "media": { "files": [stored_manifest_file("page:stream.png", 5)] }
    });

    let error = parse_chapter_media_archive_manifest(&manifest.to_string())
        .expect_err("reject unsafe stored media name");

    assert!(error.contains("invalid stored media path"));
}

fn remote_manifest_file(file_name: &str) -> serde_json::Value {
    serde_json::json!({
        "bytes": 0,
        "fileName": file_name,
        "path": format!("media/{file_name}"),
        "sourceUrl": format!("https://example.test/{file_name}"),
        "status": "remote",
        "updatedAt": 1
    })
}

fn write_test_media_archive(chapter_dir: &Path, entries: &[(&str, &[u8])]) {
    let archive_file =
        File::create(chapter_dir.join(MEDIA_ARCHIVE_FILE)).expect("create media archive");
    let mut archive = ZipWriter::new(BufWriter::new(archive_file));
    for (file_name, body) in entries {
        archive
            .start_file(*file_name, SimpleFileOptions::default())
            .expect("start media archive entry");
        io::copy(&mut &body[..], &mut archive).expect("write media archive entry");
    }
    archive.finish().expect("finish media archive");
}

fn recovery_chapter_dir(root: &Path) -> PathBuf {
    root.join(CONTENTS_ROOT_DIR)
        .join("source")
        .join("Novel-path")
        .join("1-Chapter")
}

#[test]
fn chapter_media_finalization_uses_one_lock_per_chapter() {
    use std::sync::TryLockError;

    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    let first_lock = chapter_media_finalization_lock(&chapter_dir).expect("first lock");
    let second_lock = chapter_media_finalization_lock(&chapter_dir).expect("second lock");
    assert!(Arc::ptr_eq(&first_lock, &second_lock));

    let _guard = first_lock.lock().expect("lock chapter finalization");
    assert!(matches!(
        second_lock.try_lock(),
        Err(TryLockError::WouldBlock)
    ));
}

#[test]
fn chapter_media_recovery_archives_complete_loose_media_before_adoption() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        true,
        serde_json::json!([
            stored_manifest_file("page.png", 5),
            remote_manifest_file("fallback.png")
        ]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(inspection.media_bytes > 0);
    assert!(!media_dir.exists());
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let archive_file = File::open(&archive_path).expect("open recovered archive");
    let mut archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 1);
    let mut body = Vec::new();
    archive
        .by_name("page.png")
        .expect("open recovered entry")
        .read_to_end(&mut body)
        .expect("read recovered entry");
    assert_eq!(body, b"image");
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
            .expect("read finalized manifest"),
    )
    .expect("parse finalized manifest");
    assert_eq!(manifest["complete"], true);
}

#[test]
fn chapter_media_recovery_adopts_final_content_with_missing_stored_media() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("adopt final content");

    assert_eq!(inspection.status, "present");
    assert_eq!(inspection.content_bytes, 7);
    assert_eq!(inspection.media_bytes, 0);
    assert!(media_dir.is_dir());
    assert!(!chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
            .expect("read incomplete manifest"),
    )
    .expect("parse incomplete manifest");
    assert_eq!(manifest["complete"], false);
}

#[test]
fn chapter_media_recovery_adopts_final_content_with_unexpected_loose_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
    fs::write(media_dir.join("stale.part"), b"partial").expect("write unexpected media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("adopt final content");

    assert_eq!(inspection.status, "present");
    assert_eq!(inspection.content_bytes, 7);
    assert_eq!(inspection.media_bytes, 0);
    assert!(media_dir.join("page.png").is_file());
    assert!(media_dir.join("stale.part").is_file());
    assert!(!chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
}

#[cfg(unix)]
#[test]
fn chapter_media_recovery_rejects_a_chapter_directory_symlink_escape() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().expect("tempdir");
    let external_dir = tempfile::tempdir().expect("external tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(chapter_dir.parent().expect("chapter parent"))
        .expect("create chapter parent");
    let external_chapter_dir = external_dir.path().join("chapter");
    let external_media_dir = external_chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&external_media_dir).expect("create external media dir");
    fs::write(external_chapter_dir.join("content.html"), b"chapter")
        .expect("write external content");
    fs::write(external_media_dir.join("page.png"), b"image").expect("write external media");
    write_recovery_manifest(
        &external_chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );
    symlink(&external_chapter_dir, &chapter_dir).expect("create chapter symlink");

    let error = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect_err("reject chapter symlink escape");

    assert!(error.contains("symbolic link"));
    assert!(external_media_dir.join("page.png").is_file());
    assert!(!external_chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(chapter_media_manifest_path(&external_chapter_dir))
            .expect("read external manifest"),
    )
    .expect("parse external manifest");
    assert_eq!(manifest["complete"], false);
}

#[test]
fn chapter_media_recovery_combines_existing_archive_and_loose_media() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("new.png"), b"newer").expect("write new loose media");
    write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([
            stored_manifest_file("old.png", 3),
            stored_manifest_file("new.png", 5)
        ]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(!media_dir.exists());
    let archive_file =
        File::open(chapter_dir.join(MEDIA_ARCHIVE_FILE)).expect("open combined archive");
    let mut archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 2);
    let mut old_body = Vec::new();
    archive
        .by_name("old.png")
        .expect("open old entry")
        .read_to_end(&mut old_body)
        .expect("read old entry");
    assert_eq!(old_body, b"old");
    let mut new_body = Vec::new();
    archive
        .by_name("new.png")
        .expect("open new entry")
        .read_to_end(&mut new_body)
        .expect("read new entry");
    assert_eq!(new_body, b"newer");
}

#[test]
fn chapter_media_recovery_removes_partial_loose_copy_of_a_complete_archive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("new.png"), b"newer").expect("write leftover loose media");
    write_test_media_archive(&chapter_dir, &[("old.png", b"old"), ("new.png", b"older")]);
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    let rollback_path = archive_rollback_path(&archive_path);
    fs::copy(&archive_path, &backup_path).expect("copy archive backup");
    fs::copy(&archive_path, &rollback_path).expect("copy archive rollback");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([
            stored_manifest_file("old.png", 3),
            stored_manifest_file("new.png", 5)
        ]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(!media_dir.exists());
    assert!(!backup_path.exists());
    assert!(!rollback_path.exists());
    let archive_file = File::open(&archive_path).expect("open complete archive");
    let mut archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 2);
    let mut new_body = Vec::new();
    archive
        .by_name("new.png")
        .expect("open rebuilt entry")
        .read_to_end(&mut new_body)
        .expect("read rebuilt entry");
    assert_eq!(new_body, b"newer");
}

#[test]
fn chapter_media_recovery_restores_an_interrupted_manifest_backup() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    let backup_path = chapter_media_manifest_backup_path(&manifest_path);
    fs::write(
        &backup_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "complete": false,
            "updatedAt": 1,
            "media": { "files": [stored_manifest_file("page.png", 5)] }
        }))
        .expect("encode backup manifest"),
    )
    .expect("write backup manifest");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(manifest_path.is_file());
    assert!(!backup_path.exists());
    assert!(!media_dir.exists());
    assert!(chapter_dir.join(MEDIA_ARCHIVE_FILE).is_file());
}

#[test]
fn chapter_media_recovery_prefers_valid_manifest_temp_over_valid_final() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([remote_manifest_file("page.png")]),
    );
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    let temp_path = manifest_path.with_extension("json.tmp");
    fs::write(
        &temp_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "version": 1,
            "complete": false,
            "updatedAt": 0,
            "media": { "files": [stored_manifest_file("page.png", 5)] }
        }))
        .expect("encode temp manifest"),
    )
    .expect("write temp manifest");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(!temp_path.exists());
    assert!(!media_dir.exists());
    assert!(chapter_dir.join(MEDIA_ARCHIVE_FILE).is_file());
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).expect("read recovered manifest"))
            .expect("parse recovered manifest");
    assert_eq!(manifest["complete"], true);
    assert_eq!(manifest["media"]["files"][0]["status"], "stored");
}

#[test]
fn chapter_media_recovery_uses_backup_when_the_final_manifest_is_invalid() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    let backup_path = chapter_media_manifest_backup_path(&manifest_path);
    fs::copy(&manifest_path, &backup_path).expect("copy recovery manifest");
    fs::write(&manifest_path, b"invalid manifest").expect("corrupt final manifest");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(!backup_path.exists());
    assert!(!media_dir.exists());
    let manifest: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).expect("read recovered manifest"))
            .expect("parse recovered manifest");
    assert_eq!(manifest["complete"], true);
}

#[test]
fn chapter_media_recovery_restores_an_interrupted_manifest_rollback() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("page.png"), b"image").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    let rollback_path = chapter_media_manifest_rollback_path(&manifest_path);
    fs::rename(&manifest_path, &rollback_path).expect("stage manifest rollback");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(manifest_path.is_file());
    assert!(!rollback_path.exists());
    assert!(!media_dir.exists());
    assert!(chapter_dir.join(MEDIA_ARCHIVE_FILE).is_file());
}

#[test]
fn chapter_media_recovery_publishes_a_valid_interrupted_archive_temp() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("new.png"), b"newer").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([
            stored_manifest_file("old.png", 3),
            stored_manifest_file("new.png", 5)
        ]),
    );
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
    fs::rename(&archive_path, &backup_path).expect("move old archive to backup");
    write_test_media_archive(&chapter_dir, &[("old.png", b"old"), ("new.png", b"newer")]);
    fs::rename(&archive_path, &temp_path).expect("move new archive to temp");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(archive_path.is_file());
    assert!(!backup_path.exists());
    assert!(!temp_path.exists());
    assert!(!media_dir.exists());
    let archive_file = File::open(&archive_path).expect("open published archive");
    let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 2);
}

#[test]
fn chapter_media_recovery_publishes_exact_temp_when_all_slots_exist() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    let rollback_path = archive_rollback_path(&archive_path);
    let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    write_test_media_archive(&chapter_dir, &[]);
    fs::rename(&archive_path, &backup_path).expect("stage archive backup");
    write_test_media_archive(&chapter_dir, &[]);
    fs::rename(&archive_path, &rollback_path).expect("stage archive rollback");
    write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
    fs::rename(&archive_path, &temp_path).expect("stage exact archive temp");
    write_test_media_archive(&chapter_dir, &[]);

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(archive_path.is_file());
    assert!(!backup_path.exists());
    assert!(!rollback_path.exists());
    assert!(!temp_path.exists());
    let archive_file = File::open(&archive_path).expect("open published archive");
    let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 1);
}

#[test]
fn chapter_media_recovery_combines_archive_backup_with_loose_media() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("new.png"), b"newer").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([
            stored_manifest_file("old.png", 3),
            stored_manifest_file("new.png", 5)
        ]),
    );
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
    fs::rename(&archive_path, &backup_path).expect("move archive to backup");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(archive_path.is_file());
    assert!(!backup_path.exists());
    assert!(!media_dir.exists());
    let archive_file = File::open(&archive_path).expect("open combined archive");
    let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 2);
}

#[test]
fn chapter_media_recovery_combines_archive_rollback_with_loose_media() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(media_dir.join("new.png"), b"newer").expect("write loose media");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([
            stored_manifest_file("old.png", 3),
            stored_manifest_file("new.png", 5)
        ]),
    );
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    let rollback_path = archive_rollback_path(&archive_path);
    write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
    fs::rename(&archive_path, &rollback_path).expect("stage archive rollback");
    write_test_media_archive(&chapter_dir, &[]);
    fs::rename(&archive_path, &backup_path).expect("stage incomplete archive backup");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(archive_path.is_file());
    assert!(!backup_path.exists());
    assert!(!rollback_path.exists());
    assert!(!media_dir.exists());
    let archive_file = File::open(&archive_path).expect("open combined archive");
    let archive = ZipArchive::new(BufReader::new(archive_file)).expect("read archive");
    assert_eq!(archive.len(), 2);
}

#[test]
fn chapter_media_recovery_adopts_final_content_with_incomplete_archive_candidates() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([
            stored_manifest_file("old.png", 3),
            stored_manifest_file("new.png", 5)
        ]),
    );
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    write_test_media_archive(&chapter_dir, &[("old.png", b"old")]);
    fs::rename(&archive_path, &backup_path).expect("move archive to backup");
    fs::copy(&backup_path, &temp_path).expect("copy partial archive temp");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("adopt final content");

    assert_eq!(inspection.status, "present");
    assert_eq!(inspection.content_bytes, 7);
    assert_eq!(inspection.media_bytes, 0);
    assert!(!archive_path.exists());
    assert!(backup_path.is_file());
    assert!(temp_path.is_file());
}

#[test]
fn chapter_media_recovery_finishes_from_an_existing_valid_archive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(inspection.media_bytes > 0);
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
            .expect("read finalized manifest"),
    )
    .expect("parse finalized manifest");
    assert_eq!(manifest["complete"], true);
}

#[test]
fn chapter_media_recovery_does_not_reopen_a_structurally_complete_archive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    fs::write(chapter_dir.join(MEDIA_ARCHIVE_FILE), b"not-opened")
        .expect("write structurally complete archive");
    write_recovery_manifest(
        &chapter_dir,
        true,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("completed chapter");

    assert_eq!(inspection.status, "present");
    assert_eq!(inspection.media_bytes, 10);
}

#[test]
fn chapter_media_recovery_cleans_stale_archive_publication_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
    write_recovery_manifest(
        &chapter_dir,
        true,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let backup_path = archive_backup_path(&archive_path);
    let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    fs::copy(&archive_path, &backup_path).expect("copy stale archive backup");
    fs::write(&temp_path, b"invalid temp").expect("write stale archive temp");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    assert!(archive_path.is_file());
    assert!(!backup_path.exists());
    assert!(!temp_path.exists());
}

#[test]
fn chapter_media_recovery_cleans_stale_manifest_publication_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_test_media_archive(&chapter_dir, &[("page.png", b"image")]);
    write_recovery_manifest(
        &chapter_dir,
        true,
        serde_json::json!([stored_manifest_file("page.png", 5)]),
    );
    let manifest_paths = chapter_media_manifest_publication_paths(&chapter_dir);
    for path in &manifest_paths {
        fs::write(path, b"stale manifest publication file")
            .expect("write stale manifest publication file");
    }

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.status, "present");
    for path in manifest_paths {
        assert!(!path.exists());
    }
}

#[test]
fn clear_content_media_artifacts_removes_transaction_files() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = dir.path().join("chapter");
    fs::create_dir_all(chapter_dir.join(MEDIA_DOWNLOAD_DIR)).expect("create media dir");
    let archive_path = chapter_dir.join(MEDIA_ARCHIVE_FILE);
    let manifest_path = chapter_media_manifest_path(&chapter_dir);
    let mut paths = vec![archive_path, manifest_path];
    paths.extend(chapter_media_archive_publication_paths(&chapter_dir));
    paths.extend(chapter_media_manifest_publication_paths(&chapter_dir));
    for path in &paths {
        fs::write(path, b"transaction artifact").expect("write transaction artifact");
    }

    clear_content_media_artifacts(&chapter_dir).expect("clear media artifacts");

    assert!(!chapter_dir.join(MEDIA_DOWNLOAD_DIR).exists());
    for path in paths {
        assert!(!path.exists());
    }
}

#[cfg(unix)]
#[test]
fn stale_archive_publication_symlink_is_preserved() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = dir.path().join("chapter");
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    let target_path = dir.path().join("target");
    fs::write(&target_path, b"target").expect("write target");
    let temp_path = chapter_dir.join(format!("{MEDIA_ARCHIVE_FILE}.tmp"));
    symlink(&target_path, &temp_path).expect("create temp symlink");

    remove_stale_chapter_media_archive_publication_files(&chapter_dir)
        .expect_err("reject publication symlink");

    assert!(fs::symlink_metadata(&temp_path)
        .expect("inspect temp symlink")
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&target_path).expect("read target"), b"target");
}

#[test]
fn chapter_media_recovery_completes_remote_only_manifest_without_an_archive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    let media_dir = chapter_dir.join(MEDIA_DOWNLOAD_DIR);
    fs::create_dir_all(&media_dir).expect("create empty media dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");
    write_recovery_manifest(
        &chapter_dir,
        false,
        serde_json::json!([remote_manifest_file("fallback.png")]),
    );

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("recovered chapter");

    assert_eq!(inspection.media_bytes, 0);
    assert!(!media_dir.exists());
    assert!(!chapter_dir.join(MEDIA_ARCHIVE_FILE).exists());
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(chapter_media_manifest_path(&chapter_dir))
            .expect("read finalized manifest"),
    )
    .expect("parse finalized manifest");
    assert_eq!(manifest["complete"], true);
}

#[test]
fn chapter_media_recovery_keeps_manifestless_legacy_content_present() {
    let dir = tempfile::tempdir().expect("tempdir");
    let chapter_dir = recovery_chapter_dir(dir.path());
    fs::create_dir_all(&chapter_dir).expect("create chapter dir");
    fs::write(chapter_dir.join("content.html"), b"chapter").expect("write content");

    let inspection = inspect_content_chapter_dir(dir.path(), &chapter_dir, "content.html")
        .expect("inspect chapter")
        .expect("legacy chapter");

    assert_eq!(inspection.status, "present");
    assert_eq!(inspection.media_bytes, 0);
}
