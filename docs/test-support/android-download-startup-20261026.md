# Android download startup and retry verification

## Scope

Verified on 2026-10-26 with a Lenovo Y700 (TB322FC), Android 16, using an
arm64 development APK. All interaction used the primary display (display 0).
The production installation, its database, content folder, and VPN settings
were preserved. Downloads used a separate development profile and content root.
The baseline application revision was `5046e9d`.

## Reproduced failures and changes

The installed application repeatedly timed out while extracting chapters from
three source plugins. A controlled page extraction through the native Android
scraper also timed out after eight seconds. Enabling offscreen prerastering
allowed the same foreground extraction to finish in 278 ms. Background scraper
WebViews retain their full capture dimensions outside the visible viewport;
their capture pages must still render there.

Chapter-link navigation previously evaluated a script even when its WebView
had no prepared document. It now requires a ready document at the target origin.
A new, invalidated, or different-origin document navigates directly to the target.
A ready document retains the existing next-chapter link optimization.

A separate persistent-queue failure appeared during recovery from an unavailable
plugin VPN. Retrying a failed task successfully saved the chapter but left its
backend queue row. The scheduler replays the task specification on manual retry;
it does not reattach the original task handle's completion observers.
Successful local, server, and source paths now remove the queue row inside the
replayed operation. Source-access deferral does not remove it. The rejection
observer remains responsible for failures and cancellation before execution.

No database schema or plugin contract changed. Source traffic still uses the
scraper WebViews, source profiles, cookies, and the existing VPN routing.

## Automated checks

- TypeScript type checking passed.
- Frontend tests: 1,951 passed across 166 files.
- Android unit tests: 103 passed across 15 suites.
- The three manual-retry regression cases failed before the queue fix and passed
  afterward. They cover successful source acquisition, server acquisition, and
  already-present local content after an initial VPN failure.
- A separate regression case verifies that source-access deferral retains the
  persisted job.
- The targeted arm64 debug APK build passed.

## Device checks

The installed release package does not allow `run-as` database access. Its own
backup export provided the database snapshot: 118 works, 54,286 chapters, and
three installed source plugins. The local snapshot's SHA-256 matched the export
still stored on the Y700. Every selected work, chapter, and installed-plugin
record matched that export field for field.

The development profile restored three real works and two pending chapters per
work from this snapshot. It used no content server, so these were source plugin
downloads rather than server downloads.

| Source | Work | Chapters | Result |
| --- | --- | --- | --- |
| `naver-webtoon` | Tiger Brother | 169, 170 | Both downloaded |
| `newtoki-novel` | Drug-Eating Genius Mage | 668, 669 | Both downloaded |
| `newtoki-webtoon` | Return of the Blossoming Blade | 26, 27 | Both downloaded |

All four image packages had complete manifests. Their 342 listed assets existed
in the corresponding ZIPs, matched the recorded byte sizes, and passed ZIP CRC
checks. Both novel chapters contained saved text content, rather than a challenge
or advertising placeholder.

The private sources initially returned a country restriction because the separate
test profile had no VPN. Importing the device's existing profile and connecting
through the application's normal VPN controls restored access. An unrelated
public relay rejected authentication; fail-closed traffic blocking remained in
effect during that failure.

A local native-bridge fixture exercised three concurrent cold source WebViews,
three retained-document requests, and a source switch on an existing executor.
All seven foreground extractions succeeded in 161-246 ms. After a cold restart,
all seven passed again in 164-200 ms. These are individual measurements, not
performance guarantees. A picker-backgrounded probe and a probe during VPN
failure were excluded from this foreground regression result.

The final APK retained all six downloaded flags and had zero backend queue rows
after installation and after a force-stop/relaunch. A saved novel chapter also
opened in the reader with its local text intact. A controlled tunnel interruption
in the test profile recovered through the existing connection restoration path;
the chapter downloaded again and its persisted queue row was removed. This
recovery check is separate from the manual-retry regression tests above.
