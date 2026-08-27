#[cfg(any(target_os = "android", target_os = "windows"))]
mod engine;
mod finder;
#[cfg(any(target_os = "android", target_os = "windows", test))]
mod netstack;
#[cfg(any(target_os = "android", target_os = "windows", test))]
mod proxy;
pub(crate) mod state;
#[cfg(any(target_os = "android", target_os = "windows", test))]
mod tunnel_config;

pub(crate) use state::PluginVpnState;

const MAX_PROFILE_BYTES: usize = 1024 * 1024;

#[cfg(any(target_os = "windows", test))]
pub(crate) fn windows_webview_browser_args(
    existing: Option<&str>,
    proxy_port: u16,
) -> Result<String, String> {
    const CONFLICTING_ARGUMENTS: &[&str] = &[
        "--no-proxy-server",
        "--proxy-auto-detect",
        "--proxy-bypass-list",
        "--proxy-pac-url",
        "--proxy-server",
    ];
    let existing = existing.unwrap_or_default().trim();
    let lowercase = existing.to_ascii_lowercase();
    if let Some(argument) = lowercase.split_ascii_whitespace().find(|token| {
        CONFLICTING_ARGUMENTS
            .iter()
            .any(|value| token.starts_with(value))
    }) {
        return Err(format!(
            "main WebView has a conflicting proxy browser argument: {argument}"
        ));
    }

    let mut bypass = String::from(
        "<-loopback>;tauri.localhost;asset.localhost;norea-media.localhost;norea.localhost",
    );
    if tauri::is_dev() {
        bypass.push_str(";localhost:1420");
    }
    let required = format!(
        "--proxy-server=http://127.0.0.1:{proxy_port} \
         --proxy-bypass-list=\"{bypass}\" \
         --disable-quic \
         --force-webrtc-ip-handling-policy=disable_non_proxied_udp"
    );
    if existing.is_empty() {
        Ok(required)
    } else {
        Ok(format!("{existing} {required}"))
    }
}

const HOST_CONTROL_DIRECTIVES: &[&str] = &[
    "askpass",
    "auth-user-pass-verify",
    "cd",
    "chroot",
    "client-connect",
    "client-disconnect",
    "down",
    "down-pre",
    "ipchange",
    "learn-address",
    "log",
    "log-append",
    "management",
    "management-client-auth",
    "management-client-pf",
    "management-external-cert",
    "management-external-key",
    "management-query-passwords",
    "management-query-proxy",
    "management-query-remote",
    "management-signal",
    "plugin",
    "http-proxy",
    "http-proxy-user-pass",
    "route-pre-down",
    "route-up",
    "script-security",
    "socks-proxy",
    "status",
    "tls-verify",
    "tmp-dir",
    "up",
    "up-delay",
    "up-restart",
    "writepid",
];

const PROFILE_FILE_DIRECTIVES: &[&str] = &[
    "auth-user-pass",
    "ca",
    "cert",
    "crl-verify",
    "dh",
    "extra-certs",
    "key",
    "pkcs12",
    "relay-extra-ca",
    "relay-tls-auth",
    "secret",
    "static-key",
    "tls-auth",
    "tls-crypt",
    "tls-crypt-v2",
];

const INLINE_DATA_DIRECTIVES: &[&str] = &[
    "ca",
    "cert",
    "crl-verify",
    "dh",
    "extra-certs",
    "key",
    "pkcs12",
    "relay-extra-ca",
    "relay-tls-auth",
    "secret",
    "static-key",
    "tls-auth",
    "tls-crypt",
    "tls-crypt-v2",
];

#[derive(Debug, PartialEq, Eq)]
struct ValidatedProfile {
    remote_host: String,
    requires_username_password: bool,
}

fn validate_profile(bytes: &[u8]) -> Result<ValidatedProfile, String> {
    if bytes.is_empty() {
        return Err("OpenVPN profile is empty".to_string());
    }
    if bytes.len() > MAX_PROFILE_BYTES {
        return Err(format!(
            "OpenVPN profile exceeds the {MAX_PROFILE_BYTES}-byte limit"
        ));
    }
    if bytes.contains(&0) {
        return Err("OpenVPN profile contains binary data".to_string());
    }
    let profile =
        std::str::from_utf8(bytes).map_err(|_| "OpenVPN profile must be UTF-8 text".to_string())?;

    let mut inline_block: Option<String> = None;
    let mut connection_block = false;
    let mut remote_host = None;
    let mut requires_username_password = false;

    for (index, raw_line) in profile.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim();
        if let Some(block) = inline_block.as_deref() {
            if inline_closing_tag(line).is_some_and(|closing| closing.eq_ignore_ascii_case(block)) {
                inline_block = None;
            }
            continue;
        }
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(block) = inline_closing_tag(line) {
            if block.eq_ignore_ascii_case("connection") && connection_block {
                connection_block = false;
                continue;
            }
            return Err(format!(
                "OpenVPN profile line {line_number}: unexpected inline closing tag '</{block}>'"
            ));
        }
        if let Some(block) = inline_opening_tag(line) {
            let block = block.to_ascii_lowercase();
            if block == "connection" {
                if connection_block {
                    return Err(format!(
                        "OpenVPN profile line {line_number}: nested '<connection>' blocks are not supported"
                    ));
                }
                connection_block = true;
                continue;
            }
            if connection_block {
                return Err(format!(
                    "OpenVPN profile line {line_number}: inline data blocks inside '<connection>' are not supported"
                ));
            }
            if block == "auth-user-pass" {
                return Err(format!(
                    "OpenVPN profile line {line_number}: inline username and password data is not allowed"
                ));
            }
            if !INLINE_DATA_DIRECTIVES.contains(&block.as_str()) {
                return Err(format!(
                    "OpenVPN profile line {line_number}: unsupported inline block '<{block}>'"
                ));
            }
            inline_block = Some(block);
            continue;
        }

        let tokens = directive_tokens(line)
            .map_err(|error| format!("OpenVPN profile line {line_number}: {error}"))?;
        let Some((directive, arguments)) = tokens.split_first() else {
            continue;
        };
        let directive = directive.to_ascii_lowercase();

        if HOST_CONTROL_DIRECTIVES.contains(&directive.as_str()) {
            return Err(format!(
                "OpenVPN profile line {line_number}: unsupported directive '{directive}'"
            ));
        }
        if matches!(directive.as_str(), "config" | "include") {
            return Err(format!(
                "OpenVPN profile line {line_number}: external file directive '{directive}' is not allowed"
            ));
        }
        if PROFILE_FILE_DIRECTIVES.contains(&directive.as_str()) {
            let external_argument = arguments
                .first()
                .is_some_and(|argument| !argument.eq_ignore_ascii_case("[inline]"));
            if external_argument {
                return Err(format!(
                    "OpenVPN profile line {line_number}: external file for '{directive}' is not allowed"
                ));
            }
            if directive == "auth-user-pass" {
                if arguments
                    .first()
                    .is_some_and(|argument| argument.eq_ignore_ascii_case("[inline]"))
                {
                    return Err(format!(
                        "OpenVPN profile line {line_number}: inline username and password data is not allowed"
                    ));
                }
                requires_username_password = true;
            }
        }
        if directive == "dev"
            && arguments
                .first()
                .is_some_and(|value| value.eq_ignore_ascii_case("tap"))
        {
            return Err("OpenVPN TAP profiles are not supported".to_string());
        }
        if directive == "dev-type"
            && arguments
                .first()
                .is_some_and(|value| value.eq_ignore_ascii_case("tap"))
        {
            return Err("OpenVPN TAP profiles are not supported".to_string());
        }
        if directive == "remote" && remote_host.is_none() {
            let host = arguments
                .first()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!("OpenVPN profile line {line_number}: remote host is missing")
                })?;
            remote_host = Some(host.to_string());
        }
    }

    if let Some(block) = inline_block {
        return Err(format!("OpenVPN inline block '<{block}>' is not closed"));
    }
    if connection_block {
        return Err("OpenVPN inline block '<connection>' is not closed".to_string());
    }

    Ok(ValidatedProfile {
        remote_host: remote_host
            .ok_or_else(|| "OpenVPN profile has no remote server".to_string())?,
        requires_username_password,
    })
}

fn inline_opening_tag(line: &str) -> Option<&str> {
    let tag = line.strip_prefix('<')?.strip_suffix('>')?;
    (!tag.starts_with('/') && inline_tag_name(tag)).then_some(tag)
}

fn inline_closing_tag(line: &str) -> Option<&str> {
    let tag = line.strip_prefix("</")?.strip_suffix('>')?;
    inline_tag_name(tag).then_some(tag)
}

fn inline_tag_name(tag: &str) -> bool {
    !tag.is_empty()
        && tag
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || value == b'-')
}

fn directive_tokens(line: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    let mut escaped = false;

    for character in line.chars() {
        if escaped {
            token.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                token.push(character);
            }
            continue;
        }
        if matches!(character, '\'' | '"') {
            quote = Some(character);
            continue;
        }
        if matches!(character, '#' | ';') && token.is_empty() {
            break;
        }
        if character.is_whitespace() {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
            continue;
        }
        token.push(character);
    }
    if escaped {
        return Err("trailing escape".to_string());
    }
    if quote.is_some() {
        return Err("unterminated quoted value".to_string());
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INLINE_PROFILE: &str = r#"
client
dev tun
proto udp
remote vpn.example.test 1194
<ca>
-----BEGIN CERTIFICATE-----
script-security 3
-----END CERTIFICATE-----
</ca>
<cert>
-----BEGIN CERTIFICATE-----
certificate
-----END CERTIFICATE-----
</cert>
<key>
-----BEGIN PRIVATE KEY-----
private-key
-----END PRIVATE KEY-----
</key>
"#;

    #[test]
    fn accepts_a_unified_inline_tun_profile() {
        let validated = validate_profile(INLINE_PROFILE.as_bytes()).expect("valid profile");

        assert_eq!(validated.remote_host, "vpn.example.test");
        assert!(!validated.requires_username_password);
    }

    #[test]
    fn detects_profiles_that_need_username_and_password() {
        let profile = format!("{INLINE_PROFILE}\nauth-user-pass\n");

        let validated = validate_profile(profile.as_bytes()).expect("valid profile");

        assert!(validated.requires_username_password);
    }

    #[test]
    fn accepts_remote_directives_inside_connection_blocks() {
        let profile = INLINE_PROFILE
            .replace("remote vpn.example.test 1194\n", "")
            .replace(
                "proto udp\n",
                "<connection>\nproto udp\nremote vpn.example.test 1194\n</connection>\n",
            );

        let validated = validate_profile(profile.as_bytes()).expect("valid connection block");

        assert_eq!(validated.remote_host, "vpn.example.test");
    }

    #[test]
    fn rejects_external_profile_file_references() {
        for directive in [
            "ca ca.crt",
            "cert client.crt",
            "key client.key",
            "pkcs12 client.p12",
            "tls-auth ta.key 1",
            "tls-crypt tls.key",
            "auth-user-pass credentials.txt",
            "config nested.ovpn",
        ] {
            let profile = format!("{INLINE_PROFILE}\n{directive}\n");
            let error = validate_profile(profile.as_bytes()).expect_err(directive);

            assert!(error.contains("external file"), "{directive}: {error}");
        }
    }

    #[test]
    fn rejects_commands_that_can_mutate_or_control_the_host() {
        for directive in [
            "up run.cmd",
            "down run.cmd",
            "route-up run.cmd",
            "plugin malicious.dll",
            "management 127.0.0.1 7505",
            "log vpn.log",
            "status vpn.status",
            "writepid vpn.pid",
        ] {
            let profile = format!("{INLINE_PROFILE}\n{directive}\n");
            let error = validate_profile(profile.as_bytes()).expect_err(directive);

            assert!(
                error.contains("unsupported directive"),
                "{directive}: {error}"
            );
        }
    }

    #[test]
    fn rejects_inline_block_validation_bypasses_and_saved_credentials() {
        for profile in [
            format!(
                "{}\n<connection>\nup run.cmd\n</connection>\n",
                INLINE_PROFILE.replace("remote vpn.example.test 1194\n", "")
            ),
            format!("{INLINE_PROFILE}\n<unsupported>\nup run.cmd\n</unsupported>\n"),
            format!("{INLINE_PROFILE}\n<auth-user-pass>\nreader\npassword\n</auth-user-pass>\n"),
        ] {
            assert!(validate_profile(profile.as_bytes()).is_err(), "{profile}");
        }
    }

    #[test]
    fn rejects_tap_and_profiles_without_a_remote() {
        let tap = INLINE_PROFILE.replace("dev tun", "dev tap");
        assert!(validate_profile(tap.as_bytes())
            .unwrap_err()
            .contains("TAP"));

        let no_remote = INLINE_PROFILE.replace("remote vpn.example.test 1194", "");
        assert!(validate_profile(no_remote.as_bytes())
            .unwrap_err()
            .contains("remote"));
    }

    #[test]
    fn rejects_binary_and_oversized_profiles() {
        assert!(validate_profile(b"client\0remote vpn.example.test").is_err());
        assert!(validate_profile(&vec![b'a'; MAX_PROFILE_BYTES + 1]).is_err());
    }

    #[test]
    fn builds_fail_closed_windows_webview_proxy_arguments() {
        let arguments = windows_webview_browser_args(Some("--custom-switch"), 43127)
            .expect("browser arguments");

        assert!(arguments.starts_with("--custom-switch "));
        assert!(arguments.contains("--proxy-server=http://127.0.0.1:43127"));
        assert!(arguments.contains("<-loopback>;tauri.localhost"));
        assert!(arguments.contains("--disable-quic"));
        assert!(arguments.contains("disable_non_proxied_udp"));
        assert!(!arguments.contains("msSmartScreenProtection"));
    }

    #[test]
    fn rejects_conflicting_windows_webview_proxy_arguments() {
        for argument in [
            "--no-proxy-server",
            "--proxy-auto-detect",
            "--proxy-bypass-list=example.test",
            "--proxy-pac-url=https://example.test/proxy.pac",
            "--proxy-server=http://127.0.0.1:8080",
        ] {
            assert!(
                windows_webview_browser_args(Some(argument), 43127).is_err(),
                "{argument}"
            );
        }
    }
}
