# Windows chapter extraction redirect regression

Verified on Windows x64 on 2026-09-29, starting from `2847323`, with Newtoki
Novel plugin `1.0.18` and the supplied OpenVPN profile connected through Norea.
No VPN credentials, private plugin addresses, cookies, or chapter text are
included in this report.

## Failure and cause

The installed application's log showed chapter downloads 1 through 4 failing
with `timed out preparing extract context` at the configured source origin.
All four chapter records still had `is_downloaded = 0` and zero content bytes.
The persistent download queue was empty.

The earlier Windows navigation fix covered `webview_fetch`, which serves source
discovery and metadata. Downloads use the separate `webview_extract` path.
That path still required its preparation page to remain at the original origin,
so a successful redirect to the source's current domain exhausted its timeout.
The previous source-navigation smoke test did not include saving chapter content.

## Change

Extraction now prepares the complete chapter URL, waits for a fresh ready HTTP
document, and accepts the actual redirected destination. It installs the
document-start script there and reloads that document. This avoids losing the
`window.name` script carrier during a cross-site redirect, which matters for
sources that capture closed shadow roots before page scripts execute.

Preparation clears previous result state and internal result fragments. A
`performance.timeOrigin` snapshot prevents accepting the old document while a
navigation is pending. Fragment-only changes update the requested fragment
before reloading; non-HTTP targets retain their original navigation behavior.
Challenge retries use the same preparation flow, replacing the old unawaited
reset navigation.

The tradeoff is one preparatory chapter load before the extraction reload.
This change retains native source WebViews, per-source cookies, VPN routing,
executor cancellation, and resource capture. It introduces no raw HTTP fallback,
plugin-specific workaround, schema change, or content-storage migration.

## Verification

The Windows Rust suite passed all 227 tests, including four new regressions for
exact redirected URLs, fresh document identity, fragment-only URLs, and the
HTTP-only reload policy. The actual Cargo-built library test executable ran with
a Common Controls v6 sidecar manifest to satisfy the local Windows loader.

The Windows x64 debug NSIS build was installed. All 18 synthetic checks passed
through its real `webview_extract` command, covering both the background
`pool:0` and immediate executors:

- Same-origin extraction and redirected preparation with a different landing path.
- Cross-site redirects from `127.0.0.1` to `localhost`.
- Document-start injection before inline scripts and capture of closed shadow roots.
- Exact chapter paths, queries, repeat requests, and changed fragments.
- Cookie retention within a source and isolation between sources.
- A delayed destination with a late result from the previous document.
- Cancellation of active and queued requests followed by successful recovery.

The synthetic loopback checks ran with the VPN disconnected for local routing.
After reconnecting the supplied profile through Settings, selecting chapter 2 in
the actual novel UI and downloading the selection completed successfully in the
background. Its database record and saved UTF-8 HTML file both contained 17,522
bytes. Read-only inspection found 6,416 text characters, 239 paragraphs, no script
elements, and no partial content file.

## Installed release

The final Windows x64 release NSIS build completed and replaced the debug
installation. The app's stored VPN profile matched the supplied attachment,
and the VPN reconnected successfully.

Chapter 1 remained uncached before this verification. Selecting it in the novel
UI and downloading the selection produced `completed = 1`, `failed = 0` in the
task screen. Its database record changed to `is_downloaded = 1`, with 14,439
content bytes matching the saved HTML file. Read-only inspection found 5,267
text characters, 192 paragraphs, no script elements, and no partial content
file. Chapter 2's previously verified download remained intact after the
release installation. These checks used the actual installed plugin and native
background extraction path; no content or download state was inserted manually.

The temporary fixture listeners were stopped after their checks.
