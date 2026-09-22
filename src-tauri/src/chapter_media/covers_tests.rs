use super::super::paths::{CONTENTS_ROOT_DIR, NOVEL_COVER_MANIFEST_FILE};
use super::*;
use std::{fs, path::Path};

fn novel_cover_manifest(
    file_name: &str,
    source_url: &str,
    updated_at: u64,
    identity: Option<(&str, &str)>,
) -> String {
    let mut manifest = serde_json::json!({
        "contentType": "image/jpeg",
        "fileName": file_name,
        "sourceUrl": source_url,
        "updatedAt": updated_at,
        "version": 1
    });
    if let Some((source_id, novel_path)) = identity {
        manifest["sourceId"] = serde_json::json!(source_id);
        manifest["novelPath"] = serde_json::json!(novel_path);
    }
    manifest.to_string()
}

fn write_novel_cover(
    root: &Path,
    novel_dir_name: &str,
    source_url: &str,
    updated_at: u64,
    identity: Option<(&str, &str)>,
) {
    let novel_dir = root
        .join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join(novel_dir_name);
    fs::create_dir_all(&novel_dir).expect("create novel cover directory");
    fs::write(novel_dir.join("cover.jpg"), b"cover").expect("write novel cover");
    fs::write(
        novel_dir.join(NOVEL_COVER_MANIFEST_FILE),
        novel_cover_manifest("cover.jpg", source_url, updated_at, identity),
    )
    .expect("write novel cover manifest");
}

#[test]
fn novel_cover_lookup_accepts_a_legacy_manifest_in_the_preferred_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Current-Title-novel-path",
        "https://source.test/current.jpg",
        1,
        None,
    );

    let cover =
        novel_cover_read_manifest_at(dir.path(), 7, "demo", "Current Title", "novel/path", None)
            .expect("read preferred cover")
            .expect("preferred cover");

    assert_eq!(
        cover.relative_path,
        "contents/demo/Current-Title-novel-path/cover.jpg"
    );
    assert!(cover.manifest.contains("current.jpg"));
}

#[test]
fn novel_cover_lookup_returns_none_without_an_identity_match() {
    let dir = tempfile::tempdir().expect("tempdir");

    assert!(novel_cover_read_manifest_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        None,
    )
    .expect("read missing cover")
    .is_none());
}

#[test]
fn novel_cover_lookup_ignores_an_empty_cover_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Old-Title-novel-path",
        "https://source.test/old.jpg",
        1,
        Some(("demo", "novel/path")),
    );
    fs::write(
        dir.path()
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Old-Title-novel-path")
            .join("cover.jpg"),
        b"",
    )
    .expect("empty novel cover");

    assert!(novel_cover_read_manifest_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        None,
    )
    .expect("read empty cover")
    .is_none());
}

#[test]
fn novel_cover_lookup_reuses_an_identity_manifest_from_an_older_title_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Old-Title-novel-path",
        "https://source.test/old.jpg",
        1,
        Some(("demo", "novel/path")),
    );

    let cover =
        novel_cover_read_manifest_at(dir.path(), 7, "demo", "Current Title", "novel/path", None)
            .expect("read renamed cover")
            .expect("renamed cover");

    assert_eq!(
        cover.relative_path,
        "contents/demo/Old-Title-novel-path/cover.jpg"
    );
}

#[test]
fn novel_cover_lookup_rejects_a_mismatched_identity_in_the_preferred_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Current-Title-novel-path",
        "https://source.test/other.jpg",
        1,
        Some(("demo", "other/path")),
    );

    assert!(novel_cover_read_manifest_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        None,
    )
    .expect("read mismatched preferred cover")
    .is_none());
}

#[test]
fn novel_cover_lookup_requires_an_exact_source_url_for_a_legacy_fallback() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Old-Title-novel-path",
        "https://source.test/cover.jpg",
        1,
        None,
    );

    assert!(novel_cover_read_manifest_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        None,
    )
    .expect("read legacy cover without a source URL")
    .is_none());
    assert!(novel_cover_read_manifest_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        Some("https://source.test/other.jpg"),
    )
    .expect("read legacy cover with a different source URL")
    .is_none());

    let cover = novel_cover_read_manifest_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        Some("https://source.test/cover.jpg"),
    )
    .expect("read matching legacy cover")
    .expect("matching legacy cover");

    assert_eq!(
        cover.relative_path,
        "contents/demo/Old-Title-novel-path/cover.jpg"
    );
}

#[test]
fn novel_cover_lookup_excludes_a_suffix_collision_using_manifest_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Other-Title-foo-abc",
        "https://source.test/other.jpg",
        1,
        Some(("demo", "foo/abc")),
    );

    assert!(
        novel_cover_read_manifest_at(dir.path(), 7, "demo", "Current Title", "abc", None,)
            .expect("read colliding cover")
            .is_none()
    );
}

#[test]
fn novel_cover_lookup_selects_the_latest_matching_manifest() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "First-Title-novel-path",
        "https://source.test/first.jpg",
        2,
        Some(("demo", "novel/path")),
    );
    write_novel_cover(
        dir.path(),
        "Second-Title-novel-path",
        "https://source.test/second.jpg",
        3,
        Some(("demo", "novel/path")),
    );

    let cover =
        novel_cover_read_manifest_at(dir.path(), 7, "demo", "Current Title", "novel/path", None)
            .expect("read latest cover")
            .expect("latest cover");

    assert_eq!(
        cover.relative_path,
        "contents/demo/Second-Title-novel-path/cover.jpg"
    );
}

#[test]
fn novel_cover_lookup_prefers_the_current_title_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Current-Title-novel-path",
        "https://source.test/current.jpg",
        1,
        Some(("demo", "novel/path")),
    );
    write_novel_cover(
        dir.path(),
        "Old-Title-novel-path",
        "https://source.test/old.jpg",
        2,
        Some(("demo", "novel/path")),
    );

    let cover =
        novel_cover_read_manifest_at(dir.path(), 7, "demo", "Current Title", "novel/path", None)
            .expect("read preferred cover")
            .expect("preferred cover");

    assert_eq!(
        cover.relative_path,
        "contents/demo/Current-Title-novel-path/cover.jpg"
    );
}

#[test]
fn novel_cover_lookup_breaks_updated_at_ties_by_relative_path() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Second-Title-novel-path",
        "https://source.test/second.jpg",
        3,
        Some(("demo", "novel/path")),
    );
    write_novel_cover(
        dir.path(),
        "First-Title-novel-path",
        "https://source.test/first.jpg",
        3,
        Some(("demo", "novel/path")),
    );

    let cover =
        novel_cover_read_manifest_at(dir.path(), 7, "demo", "Current Title", "novel/path", None)
            .expect("read deterministic cover")
            .expect("deterministic cover");

    assert_eq!(
        cover.relative_path,
        "contents/demo/First-Title-novel-path/cover.jpg"
    );
}

#[test]
fn novel_cover_store_reuses_a_matching_identity_title_directory() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Old-Title-novel-path",
        "https://source.test/cover.jpg",
        1,
        Some(("demo", "novel/path")),
    );
    let manifest = novel_cover_manifest(
        "new-cover.webp",
        "https://source.test/cover.jpg",
        2,
        Some(("demo", "novel/path")),
    );

    novel_cover_store_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        "new-cover.webp",
        b"new cover",
        &manifest,
    )
    .expect("store cover in the existing title directory");

    let old_title_dir = dir
        .path()
        .join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join("Old-Title-novel-path");
    assert_eq!(
        fs::read(old_title_dir.join("new-cover.webp")).expect("read updated cover"),
        b"new cover"
    );
    assert_eq!(
        fs::read_to_string(old_title_dir.join(NOVEL_COVER_MANIFEST_FILE))
            .expect("read updated manifest"),
        manifest
    );
    assert!(!old_title_dir.join("cover.jpg").exists());
    assert!(!dir
        .path()
        .join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join("Current-Title-novel-path")
        .exists());
}

#[test]
fn novel_cover_store_does_not_reuse_a_legacy_title_fallback() {
    let dir = tempfile::tempdir().expect("tempdir");
    write_novel_cover(
        dir.path(),
        "Old-Title-novel-path",
        "https://source.test/cover.jpg",
        1,
        None,
    );
    let manifest = novel_cover_manifest(
        "cover.jpg",
        "https://source.test/cover.jpg",
        2,
        Some(("demo", "novel/path")),
    );

    novel_cover_store_at(
        dir.path(),
        7,
        "demo",
        "Current Title",
        "novel/path",
        "cover.jpg",
        b"new cover",
        &manifest,
    )
    .expect("store cover in the current title directory");

    let old_title_dir = dir
        .path()
        .join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join("Old-Title-novel-path");
    let current_title_dir = dir
        .path()
        .join(CONTENTS_ROOT_DIR)
        .join("demo")
        .join("Current-Title-novel-path");
    assert_eq!(
        fs::read(old_title_dir.join("cover.jpg")).expect("read legacy cover"),
        b"cover"
    );
    assert_eq!(
        fs::read(current_title_dir.join("cover.jpg")).expect("read current cover"),
        b"new cover"
    );
    assert_eq!(
        fs::read_to_string(current_title_dir.join(NOVEL_COVER_MANIFEST_FILE))
            .expect("read current manifest"),
        manifest
    );
}
