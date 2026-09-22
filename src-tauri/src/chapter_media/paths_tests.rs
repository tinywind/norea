use super::*;
use std::path::Path;

#[test]
fn content_novel_dir_accepts_a_path_without_a_persisted_novel_id() {
    let dir = content_novel_dir_at(
        Path::new("root"),
        "demo",
        0,
        Some("/foo//bar"),
        Some("Novel"),
    )
    .expect("resolve source search novel directory");

    assert_eq!(
        dir,
        Path::new("root")
            .join(CONTENTS_ROOT_DIR)
            .join("demo")
            .join("Novel-foo--bar")
    );
    assert_eq!(
        relative_storage_path(Path::new("root"), &dir.join("cover.jpg"))
            .expect("resolve native cover path"),
        "contents/demo/Novel-foo--bar/cover.jpg"
    );
}

#[test]
fn content_novel_dir_rejects_a_missing_id_and_path() {
    let error = content_novel_dir_at(Path::new("root"), "demo", 0, None, Some("Novel"))
        .expect_err("reject an unidentified novel directory");

    assert_eq!(error, "chapter media: invalid novel id");
}

#[test]
fn content_novel_dir_rejects_a_negative_id_even_with_a_path() {
    assert!(content_novel_dir_at(
        Path::new("root"),
        "demo",
        -1,
        Some("novel/path"),
        Some("Novel"),
    )
    .is_err());
}
