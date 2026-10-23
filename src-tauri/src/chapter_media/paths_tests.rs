use super::*;
use std::path::Path;

#[test]
fn content_novel_dir_preserves_source_identity_without_names_or_database_ids() {
    for (id, name) in [(0, "Original title"), (7, "Renamed title")] {
        let dir = content_novel_dir_at(Path::new("root"), "demo", id, Some("book-source"), Some(name))
            .expect("resolve plugin-owned novel directory");
        assert_eq!(dir, Path::new("root/contents/demo/book-source"));
        assert_eq!(relative_storage_path(Path::new("root"), &dir.join("cover.jpg")).unwrap(),
            "contents/demo/book-source/cover.jpg");
    }
}

#[test]
fn content_novel_dir_requires_safe_plugin_and_source_novel_ids() {
    let oversized = "\u{00E9}".repeat(121);
    for id in [None, Some(""), Some("../book"), Some(".book"), Some(" book"),
        Some("book."), Some("book "), Some("CON.txt"), Some("lpt0"), Some("com9.json"),
        Some("book.PARTIAL"), Some("book.norea-sync-backup"), Some("a/b"), Some("a\\b"),
        Some("a:b"), Some("a?b"), Some("a\0b"), Some(oversized.as_str())] {
        assert!(content_novel_dir_at(Path::new("root"), "demo", 7, id, Some("Title")).is_err(), "{id:?}");
    }
    for plugin_id in ["", "../source", "con", "source.tmp", "source/other", "Source", "source--other", "source_1", "-source", "source-"] {
        assert!(content_novel_dir_at(Path::new("root"), plugin_id, 7, Some("book"), None).is_err(), "{plugin_id:?}");
    }
    let maximum = "\u{00E9}".repeat(120);
    assert!(content_novel_dir_at(Path::new("root"), "demo", 7, Some(&maximum), None).is_ok());
}

#[test]
fn content_chapter_dir_uses_canonical_numbers_without_chapter_names() {
    for (number, position, expected) in [(Some("002.500"), Some(10), "2.5"),
        (Some("0"), Some(10), "0"), (Some("00100"), None, "100"), (None, Some(8), "8")] {
        let dir = content_chapter_dir_at(Path::new("root"), "demo", 7, Some("book"), Some("Novel title"),
            42, number, Some("Chapter title"), position).unwrap();
        assert_eq!(dir, Path::new("root/contents/demo/book").join(expected));
    }
}

#[test]
fn content_chapter_dir_rejects_invalid_explicit_numbers() {
    for number in ["", " ", "chapter-1", "../1", "-1", "NaN", "Infinity", "1/2", "1e21", "1e-7", "+1", " 1", "1 ", "1e0", "0x1"] {
        assert!(content_chapter_dir_at(Path::new("root"), "demo", 7, Some("book"), None,
            42, Some(number), None, Some(8)).is_err(), "{number:?}");
    }
}

#[test]
fn content_chapter_dir_requires_a_positive_position_when_the_number_is_missing() {
    for position in [None, Some(0), Some(-1)] {
        assert!(content_chapter_dir_at(Path::new("root"), "demo", 7, Some("book"), None,
            42, None, None, position).is_err());
    }
}

#[test]
fn chapter_identity_lookup_matches_complete_directory_names() {
    let fixture_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.tmp/chapter-path-tests");
    fs::create_dir_all(&fixture_root).unwrap();
    let root = tempfile::tempdir_in(fixture_root).unwrap();
    for relative in ["contents/demo/book/1", "contents/demo/book/10", "contents/demo/other-book/1", "contents/demo/book11/1"] {
        fs::create_dir_all(root.path().join(relative)).unwrap();
    }
    assert_eq!(content_chapter_dirs_matching_segments(&root.path().join("contents/demo"), "book", "1").unwrap(),
        [root.path().join("contents/demo/book/1")]);
    assert_eq!(content_chapter_dirs_matching_identity(root.path(), "demo", 7, "book", 42, Some("1"), Some(8)).unwrap(),
        [root.path().join("contents/demo/book/1")]);
}
