# Android download startup and retry verification

## Scope

Verified on 2026-10-26 with a Lenovo Y700 (TB322FC), Android 16.
All interaction used the primary display (display 0). Initial reproduction and
subset checks used an arm64 development APK with a separate profile and content
root. The final section covers the existing signed installation without clearing
its data. The baseline application revision was `5046e9d`.

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

## Existing installation and full database

The signed arm64 release APK from Actions run `40310818493`, built from
`84a820d5df532059dfda2eccede5a9601f8a7971`, was downloaded through the in-app
browser. Its bytes matched the workflow update manifest, and its signing
certificate matched the installed release. It was installed over the existing
package without clearing application data.

The existing installation had 1,256 queued or running tasks before the update.
Its original source WebViews repeatedly timed out while the plugin VPN remained
connected. After the update, the same database, storage root, VPN profile, and
queue resumed actual chapter acquisition. A force-stop/relaunch also resumed
the remaining queue.

Full database exports before installation, after installation, and after the
restart retained all 118 work IDs and 54,286 chapter IDs. Every work record and
the compared chapter metadata and reading-state fields matched: paths, titles,
chapter numbers, order, source types, release dates, bookmarks, unread flags,
progress, reading timestamps, and discovery timestamps. Categories, work-category
membership, repositories, and installed plugin records also matched.

At the final comparison, downloaded flags had increased from 35,790 to 35,809.
Tiger Brother chapters 169 and 170 and Drug-Eating Genius Mage chapters 668 and
669 changed from undownloaded to downloaded and had newly saved content files.
The two Tiger Brother packages and Return of the Blossoming Blade chapter 35
contained all 234 manifest-listed assets with matching byte sizes and valid ZIP
CRCs. Both checked Mage chapters contained saved text, measuring 8,930 and
7,588 characters. The remaining requested downloads were left running in the
original installation.
