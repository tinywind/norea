# Windows source navigation regression verification

Verified on 2026-09-29 with Windows x64 and the user-supplied OpenVPN profile
connected through the application. Workspace baseline: `008ba03`. The original
installed application was version `0.2.0`, using Newtoki Novel plugin `1.0.18`.
No profile, VPN endpoint, certificate, private key, cookie, or private plugin
download address is included in this report.

## Reproduced failure

The source's configured root redirected to a different origin. Its foreground
site browser followed that redirect and displayed the source successfully.
The installed native background fetch instead failed while preparing its
browser context after 16,171 ms.

Windows context preparation required the ready document to retain the
configured origin. A completed cross-origin redirect could therefore never
satisfy that condition. Android had received related navigation recovery in
`bea7883`, but that change did not update the Windows implementation.

Both foreground and background traffic used the application's source WebView
and embedded VPN proxy. The difference was context preparation, not a failed
VPN connection or the source HTML parser.

## Change

Windows fetch preparation now accepts a redirected HTTP document. When the
request differs from its context URL, it navigates to the original requested
path and query before selecting the final fetch URL. A document's
`performance.timeOrigin` distinguishes the previous ready document from the
pending navigation, preventing an early fetch that navigation would discard.
Transient null results while a new WebView initializes remain pending.

Only GET and HEAD requests use the prepared final URL. Other methods retain
their original URL and request data. When a rewritten URL changes origin,
case-insensitive `Authorization` headers are removed to preserve the browser's
[cross-origin redirect behavior](https://fetch.spec.whatwg.org/#http-redirect-fetch).
Same-origin requests retain their authorization headers.

The implementation changes the Windows fetch path only. Source profiles,
browser cookies, source identity, cancellation, VPN routing, TLS certificate
verification, and fail-closed behavior remain in place. No raw HTTP fallback,
source-specific workaround, or private plugin change was introduced.

## Automated verification

Seven added regression tests cover redirected root requests, unchanged-origin
requests, requested path and query preservation, stale and non-HTTP documents,
fallback to the original origin, safe-method URL selection, and authorization
header handling across origins.

The full Windows Rust suite passed: 223 tests, no failures. Cargo built the
actual library test executable with `cargo test --lib --no-run`. The executable
was copied to a temporary directory and run with a Common Controls v6 sidecar
manifest, resolving the previously documented `STATUS_ENTRYPOINT_NOT_FOUND`
loader issue. The test executable and production test bodies were not replaced
with an isolated runner or alternative implementation.

## Installed debug application

The Windows x64 debug NSIS installer built and installed successfully. With the
supplied VPN connected, the corrected native root fetch returned HTTP 200 in
4,201 ms. The actual plugin's popular listing returned 49 entries, and keyword
search returned 49 entries. Opening a novel detail page loaded 318 chapters.
These checks exercised the installed app and its source plugin, not a separate
HTTP client. Timings are individual observations, not performance guarantees.

## Installed release regression checks

The final `pnpm tauri build --bundles nsis` Windows x64 release build completed,
and its installer replaced the debug installation successfully. All 13 checks
below passed through the installed application's native `webview_fetch` command,
real WebViews, and local proxy. Two temporary loopback servers supplied the
fixtures with the app VPN disconnected for local routing.

| Case | Result |
| --- | --- |
| Root redirects across origins | HTTP 200 at the final root, 887 ms |
| Context redirects and request needs a different path and query | Exact requested path and query retained, 1,617 ms |
| Context stays on its original origin | Requested path and query retained |
| Main-frame connection closes, then a healthy request follows | Healthy request recovered with HTTP 200 in 184 ms |
| An image connection fails | Main request returned HTTP 200 |
| Main document is an HTTP challenge | HTTP 403 preserved |
| Same source makes another request | Session cookie retained |
| Another source requests the same origin | Earlier source's cookie absent |
| Same-origin POST | Method, body, and headers preserved |
| POST after cross-origin context navigation | Original POST destination and body preserved |
| HEAD after cross-origin context navigation | HEAD method, path, query, and empty body preserved |
| Same-origin request has Authorization | Header retained |
| Safe request is rewritten across origins | Authorization removed |

The deliberately closed connection still reports the existing preparation
timeout, measured at 16,570 ms. This change prevents that error document from
poisoning subsequent requests; it does not introduce earlier Windows network
error reporting. The measurements above are single observations.

After the fixtures, the supplied VPN was reconnected through the Settings UI.
The final installed release again loaded 49 popular entries and 49 keyword
search results without a source error. Temporary fixture listeners were stopped.
