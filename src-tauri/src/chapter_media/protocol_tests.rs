use super::*;
use std::path::Path;

#[test]
fn media_documents_are_sandboxed_without_changing_svg_bytes() {
    let body = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>parent.postMessage('executed','*')</script><rect width="10" height="10"/></svg>"#.to_vec();
    for request_path in [
        "/contents/demo/novel-id/cover.svg",
        "/contents/demo/novel-id/1/page.svg",
    ] {
        let response = norea_media_success_response(
            request_path,
            body.clone(),
            "image/svg+xml",
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), &body);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/svg+xml");
        let policy = response.headers().get(header::CONTENT_SECURITY_POLICY)
            .expect("Untrusted media documents require a sandbox policy")
            .to_str().unwrap();
        assert!(policy.split(';').any(|directive| directive.trim() == "sandbox"));
        assert!(policy.split(';').any(|directive| directive.trim() == "default-src 'none'"));
        assert!(policy.split(';').any(|directive| directive.trim() == "style-src 'unsafe-inline'"));
        assert!(policy.split(';').any(|directive| directive.trim() == "img-src data:"));
        assert!(!policy.contains("allow-scripts"));
        assert!(!policy.contains("allow-same-origin"));
        if request_path.ends_with("/cover.svg") {
            assert_eq!(response.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
        } else {
            assert!(response.headers().get(header::CACHE_CONTROL).is_none());
        }
    }
}

#[test]
fn image_signature_overrides_disguised_media_extension() {
    let cases: &[(&[u8], &str)] = &[
        (b"\xff\xd8\xff\xe0image-body", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\nimage-body", "image/png"),
        (b"GIF89aimage-body", "image/gif"),
        (b"RIFF\x08\x00\x00\x00WEBPimage-body", "image/webp"),
        (b"BMimage-body", "image/bmp"),
        (
            b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00avifmif1",
            "image/avif",
        ),
    ];

    for (body, expected) in cases {
        assert_eq!(
            norea_media_content_type(Path::new("page.woff"), body),
            *expected
        );
        assert_eq!(media_mime_type(Path::new("page.css"), body), *expected);
    }
}

#[test]
fn only_novel_cover_media_paths_use_the_immutable_cache_policy() {
    assert!(is_novel_cover_media_path(
        "/contents/demo/novel-id/cover.jpg"
    ));
    assert!(!is_novel_cover_media_path(
        "/contents/demo/novel-id/cover.json"
    ));
    assert!(!is_novel_cover_media_path(
        "/contents/demo/novel-id/1/page.jpg"
    ));
}

#[test]
fn non_image_media_preserves_extension_fallback() {
    assert_eq!(
        media_mime_type(Path::new("audio.mp3"), b"not-an-image"),
        "audio/mpeg"
    );
}

#[test]
fn prepares_and_serves_reader_media_cache_from_archive_and_directory() {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    let temp = tempfile::tempdir().expect("tempdir");
    let storage_root = temp.path().join("storage");
    let cache_base = temp.path().join("cache/reader-media");
    let chapter_dir = storage_root.join("contents/demo/book/1");
    fs::create_dir_all(chapter_dir.join("media")).expect("create media dir");
    fs::write(chapter_dir.join("media/0001-direct.png"), b"\x89PNG\r\n\x1a\ndirect")
        .expect("write direct media");
    fs::write(chapter_dir.join("media/0002-incomplete.png.part"), b"partial")
        .expect("write partial media");

    let archive_file = File::create(chapter_dir.join("media.zip")).expect("create zip");
    let mut writer = ZipWriter::new(archive_file);
    writer
        .start_file("0003-archived.jpg", SimpleFileOptions::default())
        .expect("start zip entry");
    writer.write_all(b"\xff\xd8\xffarchived").expect("write zip entry");
    writer.finish().expect("finish zip");

    prepare_reader_media_cache_at(
        &storage_root,
        &cache_base,
        "contents/demo/book/1/media",
        "contents/demo/book/1/media.zip",
        "28-token_1",
    )
    .expect("prepare reader cache");

    let (direct_body, direct_mime) =
        read_reader_media_cache_body(&cache_base, "reader-asset/~cache/28-token_1/0001-direct.png")
            .expect("serve direct cached media");
    assert_eq!(direct_body, b"\x89PNG\r\n\x1a\ndirect");
    assert_eq!(direct_mime, "image/png");

    let (archived_body, archived_mime) = read_reader_media_cache_body(
        &cache_base,
        "reader-asset/~cache/28-token_1/0003-archived.jpg",
    )
    .expect("serve archived cached media");
    assert_eq!(archived_body, b"\xff\xd8\xffarchived");
    assert_eq!(archived_mime, "image/jpeg");

    let missing_partial = read_reader_media_cache_body(
        &cache_base,
        "reader-asset/~cache/28-token_1/0002-incomplete.png.part",
    )
    .expect_err("skip .part files");
    assert_eq!(missing_partial.0, StatusCode::NOT_FOUND);

    let traversal = read_reader_media_cache_body(
        &cache_base,
        "reader-asset/~cache/../0001-direct.png",
    )
    .expect_err("reject invalid token");
    assert_eq!(traversal.0, StatusCode::BAD_REQUEST);
}
