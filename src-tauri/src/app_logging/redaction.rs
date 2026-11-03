use regex::Regex;
use std::sync::OnceLock;

pub(super) fn bounded(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes { return text.to_string(); }
    let mut end = max_bytes.saturating_sub("[truncated]".len());
    while !text.is_char_boundary(end) { end -= 1; }
    format!("{}[truncated]", &text[..end])
}

pub(super) fn redact(text: &str) -> String {
    static HEADERS: OnceLock<Regex> = OnceLock::new();
    static BLOCKS: OnceLock<Vec<Regex>> = OnceLock::new();
    static FIELDS: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static URLS: OnceLock<Regex> = OnceLock::new();
    static USER_INFO: OnceLock<Regex> = OnceLock::new();
    let mut safe = bounded(text, 2 * 1_048_576);
    for pattern in BLOCKS.get_or_init(|| {
        let mut patterns = vec![Regex::new(r"(?is)-----BEGIN [^-\r\n]*(?:PRIVATE KEY|OPENVPN)[^-\r\n]*-----.*?(?:-----END [^-\r\n]*-----|\z)").unwrap()];
        for tag in ["key", "cert", "tls-auth", "tls-crypt", "auth-user-pass"] {
            patterns.push(Regex::new(&format!(r"(?is)<{tag}>.*?(?:</{tag}>|\z)")).unwrap());
        }
        patterns
    }) { safe = pattern.replace_all(&safe, "[REDACTED]").into_owned(); }
    safe = HEADERS.get_or_init(|| Regex::new(r"(?im)\b(authorization|proxy-authorization|set-cookie|cookie)\s*:\s*[^\r\n]*").unwrap())
        .replace_all(&safe, |captures: &regex::Captures<'_>| format!("{}: [REDACTED]", &captures[1])).into_owned();
    safe = FIELDS.get_or_init(|| Regex::new(r#"(?i)(["']?(?:password|passwd|access[_-]?token|refresh[_-]?token|token|secret|api[_-]?key|private[_-]?key|client[_-]?secret|credential|authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n]+)"#).unwrap())
        .replace_all(&safe, |captures: &regex::Captures<'_>| format!("{}[REDACTED]", &captures[1])).into_owned();
    safe = BEARER.get_or_init(|| Regex::new(r#"(?i)\bBearer[ \t]+[^\s"'<> ,;]+"#).unwrap())
        .replace_all(&safe, "Bearer [REDACTED]").into_owned();
    safe = URLS.get_or_init(|| Regex::new(r#"(?i)[a-z][a-z0-9+.-]*://[^\s"'<>]+"#).unwrap()).replace_all(&safe, |captures: &regex::Captures<'_>| {
        let url = USER_INFO.get_or_init(|| Regex::new(r"(?i)^([a-z][a-z0-9+.-]*://)[^/@\s]+@").unwrap())
            .replace(&captures[0], "$1[REDACTED]@");
        match url.find(['?', '#']) { Some(index) => format!("{}?[REDACTED]", &url[..index]), None => url.into_owned() }
    }).into_owned();
    if text.len() > 2 * 1_048_576 && !safe.ends_with("[truncated]") { safe.push_str("[truncated]"); }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_headers_and_bare_bearer_credentials_are_redacted() {
        let text = "{\"Authorization\":\"Bearer json-auth-secret\",\"Cookie\":\"session=json-cookie-secret\"}\n\
            request failed with Bearer standalone-bearer-secret";
        let redacted = redact(text);
        for secret in ["json-auth-secret", "json-cookie-secret", "standalone-bearer-secret"] {
            assert!(!redacted.contains(secret), "Credential remained: {secret}");
        }
    }

    #[test]
    fn non_http_page_urls_do_not_publish_user_info_queries_or_fragments() {
        let redacted = redact("tauri://user:tauri-user-secret@localhost/main?session=tauri-query-secret#fragment-secret \
            content://documents/tree/root?document=content-query-secret");
        for secret in ["tauri-user-secret", "tauri-query-secret", "fragment-secret", "content-query-secret"] {
            assert!(!redacted.contains(secret), "URL credential remained: {secret}");
        }
        assert!(redacted.contains("localhost/main"));
    }

    #[test]
    fn removes_headers_fields_url_credentials_and_private_profile_blocks() {
        let input = "Authorization: Bearer synthetic-auth-secret\nCookie: session=synthetic-cookie-secret\n\
            password=synthetic-password-secret url=https://user:synthetic-url-secret@example.com/path?token=synthetic-token-secret\n\
            <key>synthetic-key-secret</key>\n-----BEGIN PRIVATE KEY-----\nsynthetic-pem-secret\n-----END PRIVATE KEY-----";
        let output = redact(input);
        for secret in ["synthetic-auth-secret", "synthetic-cookie-secret", "synthetic-password-secret", "synthetic-url-secret",
            "synthetic-token-secret", "synthetic-key-secret", "synthetic-pem-secret"] {
            assert!(!output.contains(secret), "secret remained: {secret}");
        }
        assert!(output.contains("[REDACTED]"));
        assert!(output.contains("example.com/path"));
        assert!(!redact("<tls-crypt>unfinished-secret").contains("unfinished-secret"));
    }

    #[test]
    fn utf8_limits_preserve_characters_and_mark_truncation() {
        let result = bounded(&"😀".repeat(400_000), 1_048_576);
        assert!(result.len() <= 1_048_576);
        assert!(result.ends_with("[truncated]"));
        assert!(!result.contains('\u{fffd}'));
        assert_eq!(bounded("unchanged", 100), "unchanged");
    }
}
