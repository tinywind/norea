# Android source navigation regression verification

Verified on 2026-09-29 using a Lenovo Y700 (TB320FC), Android 15, and the
arm64 development APK. The production app installation was not replaced.
The baseline application revision was `ddd854f`.

## Reproduced failures

A live source changed its origin by redirecting the configured base URL.
The Android scraper had two distinct failures:

- When the requested URL was also the context URL, the redirected document
  could never complete context preparation. It failed after 15 seconds.
- When a different requested path required fallback navigation, the old
  document's `onPageFinished` could complete preparation before the fallback
  navigation started. The subsequent navigation discarded the injected fetch,
  leaving its completion callback unresolved until the 30-second timeout.

A separate recovery failure occurred after a main-frame connection error.
`currentUrl` still contained the requested HTTP URL while the actual document
was `chrome-error://chromewebdata/` with an opaque origin. The next same-origin
request reused that error document and failed again. With a local fixture,
closing the first connection caused both that request and a subsequent healthy
request to fail before this change.

## Corrective behavior

`AndroidScraperContextNavigation` now distinguishes waiting, fallback
navigation, and a ready document. A pending fallback rejects completion events
until its navigation has started, and a redirected root request accepts its
final HTTP document. Duplicate, cancelled, and non-HTTP completion events are
ignored. Existing safe-method and request-path handling remains in place.

The scraper separately tracks whether its current context is ready. Main-frame
network and certificate errors invalidate it and return explicit errors;
subsequent requests navigate again instead of reusing a browser error page.
Certificate errors are still cancelled, never bypassed. Failed images and
other subresources do not fail the main document. HTTP challenge responses
remain HTTP responses for the existing challenge-handling path.

No source traffic was moved to a raw HTTP client. Source-specific browser
profiles, cookies, the local proxy, and VPN fail-closed routing are preserved.
No private source plugin changes were necessary for these host-side fixes.

## Automated verification

- The targeted `pnpm exec tauri android build --apk --debug --target aarch64`
  build succeeded, including TypeScript and Vite production asset generation.
- After the final Kotlin changes, `:app:testUniversalDebugUnitTest` and
  `:app:assembleUniversalDebug` succeeded using the unchanged arm64 native
  library from that build. The native Rust Gradle task was excluded only for
  this Kotlin-only incremental assembly.
- Android unit tests: 82 passed across 11 suites, including nine new navigation
  policy regression tests; no failures or errors.
- Frontend tests: 1,092 passed across 93 files.
- `git diff --check` passed.

## Installed-device regression checks

Two temporary loopback HTTP servers were exposed to the device through scoped
ADB reverse mappings. Requests used the installed application's native scraper
bridge, its real WebViews, and its local proxy, not a replacement fetch client.
The fixture listeners and their reverse mappings were removed after the run.

| Case | Result | Measured request time |
| --- | --- | --- |
| Context and request share a root URL that redirects to another origin | HTTP 200 at the redirected root | 277 ms |
| Redirected context requires fallback to the original requested path and query | HTTP 200; path and query preserved | 140 ms |
| Main-frame server closes its connection | Explicit `ERR_EMPTY_RESPONSE`, not a preparation timeout | 66 ms |
| Healthy same-origin request immediately after the previous failure | HTTP 200 | 93 ms |
| An image connection fails but the main document is healthy | HTTP 200 | 148 ms |
| Main document returns an HTTP challenge status | HTTP 403 preserved as an HTTP response | 124 ms |
| A second request in the same source uses its session | Session cookie retained | 15 ms |
| A different source requests the same origin | Previous source's session cookie absent | 153 ms |

All eight installed-device regression checks passed. These measurements are
individual observations, not performance guarantees.

## Live network observations and limits

With the device awake and the development app foregrounded, the original live
root request completed in 896 ms and its listing request in 475 ms after the
fix. Both returned HTTP 403 Cloudflare challenge responses from the redirected
host rather than timing out. This proves transport/completion recovery, not
successful challenge clearance or end-to-end content parsing.

The official VPN Gate API returned 96 servers, including 31 Korean candidates,
in 2,080 ms during the final foreground query. The real Settings > Data > Find
public servers dialog also displayed 96 rows. A foreground discovery failure
was not reproduced. A screen-off/background probe did encounter a name
resolution failure; the same API worked after foregrounding. That observation
alone does not identify the cause of the originally reported discovery issue.

A Korean TCP VPN Gate profile connected through the application's embedded
engine. HTTPS through the device's local tunnel proxy returned HTTP 200 for a
control domain and for an IP-based diagnostic endpoint, which reported `KR`.
However, that selected relay closed the live source's TLS handshake. The same
closure was observed with an independent HTTPS client through the same tunnel,
so it was not specific to the source HTML parser. The exact cause of the relay
or destination path rejection was not established.

An external OpenVPN application was not available on this device for an
independent system-VPN comparison. External browser sessions were not imported
into application WebViews. Live challenge clearance, full source browsing, and
all external VPN combinations are therefore not claimed as passing.
