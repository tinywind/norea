# Windows source navigation and webtoon media recovery

Investigated on Windows x64 on 2026-09-29, starting from `b11844b`, using the
installed Naver Webtoon plugin `1.0.5` and the application's existing VPN
connection. No private plugin repository URL, credentials, cookies, VPN
configuration, or chapter content is included here.

## Reproduction and cause

Opening the uncached Naver title `836848` from the source listing left the
opening-detail modal visible after 64,814 ms, with no novel page or chapter
records. Installed-app logs showed repeated CDN cover failures on the same
`immediate` scraper executor, often about 17 seconds apart.

Source cards requested their cover images with `priority: "deferred"`.
Android forwarded this priority, but the Windows transport discarded it and
immediately submitted every request to the native executor's FIFO mutex.
The selected novel's API requests therefore waited behind the entire cover
backlog before their native request timeouts even started.

The plugin reads title metadata and then sequential chapter pages. A dispatcher
that only selects the next pending high-priority request is insufficient:
cover requests can still occupy the gaps between chapter-page requests.

After cancelling the blocked task, one retry failed with a browser network
error at the Naver API. A subsequent request through the same native source
WebView returned HTTP 200, and the actual plugin opened title `836848` with 45
chapters. This distinguished the request backlog from an API that always fails.
The change does not replace browser fetches or modify Naver endpoints or CORS.

Testing the first release with the priority fix exposed a second failure. The
uncached title `821597` failed after 16,560 ms, and a retry failed after 16,369 ms.
Debug logs showed that preparing the `comic.naver.com` root timed out before the
transport fell back to the mobile source origin, where the browser fetch failed.
The image CDN followed the same unsuccessful sequence.

Keeping the source WebView, VPN, and headers unchanged but preparing the exact
API URL returned HTTP 200 in 1,166 ms. Preparing the exact image URL returned HTTP
200 and 49,261 bytes in 1,714 ms. The target resources were reachable even when
their origin roots did not provide a usable browser document.

## Change

The Windows transport now admits one native fetch at a time per executor and
orders waiting requests by their existing priority, retaining FIFO order for
equal priorities. Independent deferred cover requests wait for the current
source task to release its executor, including gaps between sequential page
requests. A deferred request belonging to that task can still execute.

Display covers use their own abort signal instead of inheriting ownership of a
running source task. Aborting a queued request removes only that request.
Aborting active work releases admission only after native completion and the
cancellation IPC have both settled. Explicit executor cancellation removes its
waiting requests and allows subsequent work to recover.

A cover's read-only captured-response lookup now cancels only its own wait,
without cancelling unrelated browser work. Captured stream-handle cancellation
retains its existing behavior. Browser profiles, session cookies, VPN routing,
and the Android dispatcher are unchanged.

The native Windows transport now tries the exact request URL after an unusable
origin root and before a cross-origin source context. This additional navigation
candidate is limited to GET and HEAD, preserves paths and query strings, and
does not change an explicitly supplied same-origin context. Other HTTP methods
retain their previous candidates. Existing cancellation and redirect handling
continue to apply.

An already running cover fetch must finish or cancel before the next fetch can
start. This bounds interference to the active request instead of every queued
cover; the change does not make a slow network request instantaneous.

## Existing webtoon content and offline media

Newtoki Webtoon `1.0.13` opened title `60914825` after the user completed the site
browser's manual challenge. Its first chapter appeared downloaded with 5,605,581
media bytes, but inspection found 38 stored images and 111 remote images in the
149-image final HTML. These were visible, full-size chapter images.

File timestamps showed that this was an existing archive from 2026-08-25 being
adopted into a newly created database row, rather than a new incomplete transfer.
Reconciliation unconditionally cleared the media-repair flag during adoption.
The plugin contract intentionally keeps final HTML readable and treats archive
completion as completion of its stored subset; neither is a promise that all
images are local. Recovery must therefore preserve that content and accurately
restore the need for explicit media repair, without changing normal download
shortcuts or deleting the existing archive. Fresh chapter downloads are checked
separately from this legacy-content recovery.

## Automated verification

The initial focused regression run failed five of the eight tests then present.
After implementation and additional cancellation coverage, all 93 tests passed
across these five files:

```text
src/lib/http/scraper-transport.test.ts
src/lib/tasks/scraper-queue.test.ts
src/lib/http.test.ts
src/lib/http/plugin-fetch-vpn.test.ts
src/lib/novel-cover-storage.test.ts
```

Coverage includes priority propagation, cover-backlog bypass, whole-task
reservation across page requests, task-owned deferred requests, independent
executors, FIFO ties, queued cancellation, both cancellation-settlement orders,
explicit cancellation and recovery, and continuation after a native failure.
An integration regression also confirms that aborting a delayed cover cache
lookup neither cancels an active detail request nor removes its queued next
page. That regression was observed failing before the cache-abort fix.

Two native regressions failed before adding the exact-address fallback. All 232
Rust library tests then passed, including five new tests covering fallback
ordering, absent source contexts, safe methods, explicit same-origin contexts,
and duplicate root candidates. The Windows debug application also built
successfully.

The rebuilt Windows debug application passed all 16 native fixture checks on
both the immediate and background executors. Three loopback origins returned
204, empty 403, or indefinitely loading HTML at their roots while serving valid
API and image resources at exact paths. No CORS permission was provided. Checks
covered exact JSON and PNG bytes, custom headers, path/query preservation,
missing source context, and HEAD semantics. The in-app VPN was temporarily
disconnected only for these local fixtures and reconnected before live-source
testing.

The media-repair metadata change passed 121 focused storage, database, and
download tests. Coverage includes already-downloaded rows, new adoption, stale
repair flags, local and remote images, empty HTML, PDF handling, inaccessible
storage, and a file disappearing after inspection. The full frontend suite
passed all 1,126 tests across 95 files.

## Live Windows debug verification

The app's VPN connection was active for all live source actions. Neither test
chapter selected for a fresh download had an existing final HTML, partial HTML,
manifest, or media archive.

| Check | Observed result |
| --- | --- |
| Uncached Naver title `821597` | Opened in 6,007 ms; 112 chapters persisted |
| Cancel opening Naver title `828715` | Opening modal closed and remained on the source listing |
| Retry title `828715` | Opened in 20,553 ms |
| Resume Naver chapter `883` | 103 images, 7,917,510 archive bytes, no remote image references |
| Fresh Naver chapter `884` | 95 images, 7,496,554 archive bytes, no remote image references |
| Fresh Newtoki Webtoon chapter `1129` | 135 images, 16,656,813 archive bytes, no remote image references |
| Explicit repair of legacy Newtoki chapter `928` | All 149 HTML images local; 25,799,241 archive bytes |

All four archives passed entry-count, decompressed-size, CRC32, image-signature,
manifest, and database byte-count checks. Their final HTML had no unresolved
image references, and their partial files were absent after completion.
The repaired legacy archive retains older assets and manifest records; its 187
stored entries all passed validation, while the final HTML references only
local images. Old unreferenced remote manifest records do not indicate missing
chapter images.

## Final installed release verification

The final Windows x64 release, including all three fixes, was packaged as
`Norea_0.2.0_x64-setup.exe` and installed successfully. The installed application's
frontend asset was `index-BsJTtrJt.js`. With its VPN connected, the previously
uncached Naver title `783053` opened in 22,717 ms and persisted 257 chapters.

The installed release then reopened all four downloaded chapters with external
traffic blocked by the application's VPN proxy. All images completed loading
with nonzero natural dimensions, and none used remote URLs:

| Source | Chapter | Loaded images | Failed images |
| --- | --- | --- | --- |
| Naver Webtoon | `883` | 103 / 103 | 0 |
| Naver Webtoon | `884` | 95 / 95 | 0 |
| Newtoki Webtoon | `1129` | 135 / 135 | 0 |
| Newtoki Webtoon, repaired legacy content | `928` | 149 / 149 | 0 |

A separate legacy chapter, `1013`, still had one remote image in its existing
HTML. Opening it in the final release preserved its downloaded content, restored
`media_repair_needed = 1`, and displayed the enabled chapter-media repair action.
This verified adoption metadata independently of the already repaired chapter.

After verification, the VPN was reconnected, the original next-chapter automatic
download preference was restored, and the installed app was restarted without
the temporary WebView debugging port. The local fixture server was stopped.
