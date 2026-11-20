# Security Policy

## Supported Versions

Security fixes are applied to the active `0.2` development line and published in
the latest prerelease and release builds for Windows (`x64`, `ARM64`) and
Android (`ARM64`, `x86_64`).

| Version / Channel | Supported |
| --- | --- |
| `0.2` (latest build / [`dev-0.2`](https://github.com/tinywind/norea/releases/tag/dev-0.2)) | Yes |
| Older `0.2` commits or snapshots | No — update to the latest build first |
| `< 0.2` | No |

Linux, macOS, and iOS builds are not published or supported.

Android **tracing APKs** (`*-tracing.apk`) are intentionally built with
`android:debuggable="true"` for local diagnostics and are not intended for
everyday use.

## Reporting a Vulnerability

Please report suspected security vulnerabilities privately through GitHub
Private Vulnerability Reporting:

- https://github.com/tinywind/norea/security/advisories/new

Do **not** open a public GitHub issue, pull request, or discussion for an
undisclosed vulnerability.

When submitting a report, include as much of the following as you can:

- Platform and build details (Windows or Android, architecture, OS/WebView
  version, and Norea build version or commit).
- Affected component (for example: Rust host / Tauri IPC, SQLite or local/SAF
  file I/O, `norea-media` protocol or reader HTML/EPUB/PDF sanitization, main
  WebView vs. scraper WebView boundary, Android update verification, VPN
  routing, backup import/export, sync client, or plugin validation).
- Minimal reproduction steps or proof of concept.
- Expected security impact.

**Do not attach real secrets** such as VPN private keys, content-server
authentication keys, site login cookies, or personal backups containing private
credentials.

## Scope

### In scope

Issues in the Norea application (`tinywind/norea`), including:

- Isolation between the main application WebView and external site scraper
  WebViews, script injection boundaries, and navigation/origin checks.
- Untrusted chapter/media rendering and sanitization (`norea-media` CSP
  sandboxing, HTML/Markdown/EPUB/PDF import and reader handling).
- Local and Android file I/O boundaries (Tauri commands, `AndroidNativeIo`,
  SAF URI handling, backup restore validation, and path traversal protections).
- Protection of sensitive local state (VPN private keys, device/server
  authentication keys, browser sessions, Android OS backup opt-out, and log
  redaction).
- Update metadata validation and Android APK integrity/signer verification.
- VPN routing fail-closed behavior and route-transition network gating.
- Dependency vulnerabilities that affect Norea's shipped Windows or Android
  builds.

### Reported elsewhere

- **Norea Content Server** (server API, admin console, Docker deployment,
  server-side storage): report in
  [tinywind/norea-content-server](https://github.com/tinywind/norea-content-server/security).
- **Source plugins and plugin catalogs**: report plugin-specific issues in
  [tinywind/norea-plugins](https://github.com/tinywind/norea-plugins) or the
  third-party plugin repository that publishes the plugin.

### Out of scope

- Vulnerabilities in third-party source websites or their authentication and
  anti-bot systems.
- Malicious third-party plugins explicitly installed by a user from an untrusted
  repository or local file (however, escapes of Norea's documented host or
  WebView boundaries are in scope).
- Debuggability of explicitly labeled Android `tracing` APKs.
- Attacks requiring physical, root, or local administrator access to an already
  compromised device.
- Unsupported platforms (Linux, macOS, iOS) or upstream `lnreader/lnreader`
  compatibility.
- Automated scanner findings without a demonstrated impact in Norea (see
  [SECURITY_CHECKS.md](https://github.com/tinywind/norea/blob/0.2/SECURITY_CHECKS.md)
  for documented vendor backports and static-analysis contexts).

## Response and Disclosure

Norea is maintained on a best-effort basis:

- **Acknowledgement**: we aim to respond within 7 days in the private advisory
  thread.
- **Remediation**: confirmed vulnerabilities are prioritized by severity and
  fixed on the `0.2` branch, followed by updated Windows and Android builds.
- **Disclosure**: please allow reasonable time for a fix and updated build
  before public disclosure. Once resolved, a GitHub Security Advisory may be
  published, with credit if you would like to be acknowledged.

## Security Maintenance

Repository-specific security boundaries, vendor backports, and static-analysis
disposition notes are maintained in
[SECURITY_CHECKS.md](https://github.com/tinywind/norea/blob/0.2/SECURITY_CHECKS.md).
