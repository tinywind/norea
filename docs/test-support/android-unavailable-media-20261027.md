# Android unavailable media verification

## Scope

Verified on 2026-10-27 with a Lenovo Y700 (TB322FC), Android 16.
All interaction used the primary display, display 0. The arm64 debug APK used a
separate application profile and content root. The installed application's own
backup supplied the work, chapter, and source plugin records. Its original
chapter files were copied into the test root after recording their SHA-256 hashes.
The baseline application revision was `a6e5da3`.

No content-server code, source plugin code, database schema, or persisted file
format changed.

## Source failure

Newtoki Webtoon work `10557`, chapter sequence `151`, maps to the source chapter
`/webtoon/10557/1482855`. Its manifest lists 57 images. The device already held
56 intact files; `0056-JPbKG_6lioMH.jpg` was unavailable from `manatoki334.net`.
The following chapter was already downloaded.

A fresh page extraction through the device's native scraper returned the same
57 image sources, including the unavailable URL. The source site's image model
had no alternate candidate for image 56. Loading that image in the same native
browser produced the site's `image_load:page_56` failure and left 56 rendered
image elements. The configured image mirror returned HTTP 404 for the same path.
The content server had no saved copy of this chapter.

Refreshing the source page therefore did not supply a replacement image. The
chapter remains incomplete until the source asset or a valid replacement is
available. The application must retain that incomplete state.

## Retry behavior

The previous application let an exhausted per-image fetch error enter its
unlimited task-level network retry policy. This chapter stayed queued indefinitely
with a generic fetch error while other chapters progressed.

Strict offline caching now reports the unavailable asset as a structured media
failure. Download and repair tasks allow four delayed retries for each affected
asset, with delays of 5, 15, 30, and 60 seconds. A persistent failure then appears
in the task failure list with the asset filename and host, and remains manually
retryable. The displayed diagnostic excludes URL credentials and query parameters.

Each task owns its asset counters. VPN readiness, page transport, and temporary
HTTP retries retain their existing policy and do not consume those counters.
Different assets receive separate budgets. Manual retry starts a fresh budget.
Stored valid assets remain reusable, and incomplete packages are not published
as completed downloads.

History eviction counts terminal records separately from running and queued
work. It retains up to 200 terminal records even when thousands of downloads are
pending, so an exhausted asset remains visible and manually retryable.

## Automated checks

- TypeScript type checking passed.
- Frontend tests: 1,959 passed across 166 files.
- The targeted arm64 debug APK build passed.
- The missing-asset classification, diagnostic, bounded task retry, and scheduler
  regressions failed before the implementation and passed afterward.
- Download and repair task binding tests reproduced the exhausted-budget bug
  after four earlier VPN failures. Both passed with independent asset counters.
- Scheduler coverage confirms that another chapter can finish during backoff,
  and that a failed asset receives no further automatic attempts.
- History regression tests reproduced immediate failure eviction beside 250
  queued tasks before the fix. They now retain the failed task and verify that
  201 failures evict only the oldest record while keeping all queued work.
- Scoped static verification: 16 passed, with no remaining actionable findings.

## Device result

The same real chapter reproduced the unlimited retry loop in the baseline debug
APK. After installing the updated debug APK over that profile, five exhausted
media acquisition rounds produced one failed task with zero running or queued
tasks. The primary display showed the missing filename and host in the failure
row, together with a manual retry control.

All 56 previously stored media files retained their original SHA-256 hashes.
The manifest still declared 57 assets and `complete: false`; the unavailable
asset remained remote with zero bytes. No completed chapter body or `media.zip`
was published. A database snapshot confirmed `is_downloaded = 0` and
`media_repair_needed = 1` for chapter `47230`.

The visible manual retry control started another attempt. Its first exhausted
media round received the initial 5-second delay, confirming that the previous
failure did not consume the new budget. The valid files still matched all 56
original hashes. The test queue was then paused through the normal task controls.

## Existing signed installation

The signed arm64 APK from Actions run `40383347458` identifies application
revision `0e2b57b61ed71b29dc476cc1aa6de36dc686f174`. It was downloaded through the
in-app browser. Its size and SHA-256 matched the workflow update manifest, and
its certificate matched the existing installation. Installation used an in-place
update without clearing application data.

Full database exports before and after installation retained all 118 work IDs
and 54,286 chapter IDs. Every work record and the compared chapter metadata and
reading-state fields matched, including chapter paths, titles, numbers, order,
bookmarks, unread flags, progress, release dates, reading timestamps, and discovery
timestamps. Categories,
work-category membership, repositories, and installed plugin records also matched.

The affected work home retained all 158 chapter rows, with 157 downloaded and
the unavailable chapter still incomplete. All 56 original media files retained
their hashes in the original storage root. The existing queue contained over
2,700 tasks; the affected work was moved to the front through the normal task
controls for verification while unrelated downloads continued.

This first full-queue check exposed a second failure: the fifth exhausted round
ended the task, but history eviction immediately removed the failure row because
the active queue exceeded the 200-record history limit. The scheduler log retained
the filename and host, while the visible failure count stayed at zero. The
terminal-record accounting fix above addresses this separately from media retry.

## Final full-queue verification

Actions run `40387591413` produced the final signed arm64 APK from
`69f2726d6cc37ca5222787cc6602abb619f8dfcd`. The in-app browser download again
matched the workflow size, SHA-256, and installed certificate. The in-place
update retained the original storage root, source plugins, VPN configuration,
and queued downloads.

A full export after this update retained all 118 work records and 54,286 chapter
metadata and reading-state records compared above. Categories, memberships,
repositories, and installed plugins also matched. Downloaded flags increased
from 36,921 in the pre-update snapshot to 37,087 in this snapshot; chapter
`47230` remained undownloaded. This interval includes downloads before and after
installation and is not a performance measurement.

The final full-queue run ended the affected task after five exhausted acquisition
rounds. With 2,575 tasks still queued, the primary display retained its failed row,
missing filename and host, and manual retry button. The task screen reported two
failures in total; another work had a separate unavailable asset. Unrelated
downloads continued. The selected chapter's failure was not removed by the backlog.

After a force-stop and relaunch, another full export retained the same 118 work
records, 54,286 chapter metadata and reading-state records, categories, memberships,
repositories, and source plugins. Downloaded flags reached 37,101, while chapter
`47230` remained undownloaded. All 56 intact media files still matched their
original SHA-256 hashes. The work's `novel.json` was byte-for-byte unchanged from
the initial snapshot, and its 57-entry chapter manifest remained incomplete.

The temporary test application, copied test root and import ZIP, temporary VPN
profile copy, debug forwarding, and task log collectors were removed or stopped.
The original application, content root, source VPN profile, and remaining user
queue were preserved. The unavailable source image remains the limit on completing
this chapter; no image was skipped or replaced to claim success.
