use super::*;
use std::path::Path;

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
        "/contents/demo/Sample-Novel-novel/cover.jpg"
    ));
    assert!(!is_novel_cover_media_path(
        "/contents/demo/Sample-Novel-novel/cover.json"
    ));
    assert!(!is_novel_cover_media_path(
        "/contents/demo/Sample-Novel-novel/1-Opening/page.jpg"
    ));
}

#[test]
fn non_image_media_preserves_extension_fallback() {
    assert_eq!(
        media_mime_type(Path::new("audio.mp3"), b"not-an-image"),
        "audio/mpeg"
    );
}
