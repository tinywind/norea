# Android partial media verification

## Scope and cause

Verified on 2026-10-27 with a Lenovo Y700 (TB322FC), Android 16. All device
interaction used display 0; the extended Moonlight display was left untouched.
The baseline application revision was `69f2726`. The partial-media fix is
`3f5ad165d710cdbef503db2ff4c51a9b9012daee`; the Android empty-ZIP validation
supplement is `72a15dc544010b40f84f223555fe20566855ce83`.

An exhausted network error in strict offline caching stopped the media batch,
preventing later assets from being attempted. Temporary HTTP failures also
stopped the batch. The strict incomplete check then threw before archive
creation. Native finalization separately marked a stored subset complete even
when the manifest retained remote assets.

Acquisition now continues after individual asset failures and archives the
validated stored files before reporting the actual missing-asset count.
Transient failures retain bounded retries and Retry-After handling. Native
finalization keeps partial manifests incomplete and creates a valid empty ZIP
when no asset was acquired. It preserves existing damaged archives and recovery
copies when there is no validated stored replacement. Cancellation, source
access verification, VPN readiness, and storage failures retain their separate
handling.

No database schema, source plugin, content-server source, or package version
changed. The existing manifest inventory and ZIP inspection still determine
chapter completeness. Partial ZIPs do not become completed downloads or
complete server packages.

## Automated checks

- TypeScript checking passed.
- Frontend tests: 1,963 passed across 166 files, including the commit and push hooks.
- Android JVM tests: 105 passed across 15 classes.
- The targeted arm64 debug APK build passed, including Rust and Kotlin changes.
- Frontend regressions failed before implementation and passed afterward. They
  verify that later assets beyond the first worker window are attempted after
  network, temporary HTTP, and permanent HTTP failures; available assets are
  archived; and the error contains only actual failed assets.
- Retry tests cover aggregated transient HTTP and network failures, Retry-After,
  and the exhausted per-asset budget.
- The Android Rust test binary passed 217 tests with one explicit exclusion:
  `download_cache::tests::delete_work_run_clears_bulk_novel_cache_end_to_end`.
  That test reaches an unimplemented method in Tauri 2.11.1's Android mock
  runtime. The earlier unfiltered run exposed this limitation; it was not
  counted as a passing test.
- Three existing test helpers derive temporary fixture directories from the
  host compile path. For device execution only, their fixture base was mapped
  to a writable directory under `/data/local/tmp/`. Their implementations and
  assertions were unchanged, and the source mappings were restored after
  compilation. The production APK used the normal source files.
- All 30 archive tests passed on the Y700. The added preservation regression
  failed before its fix, then passed for damaged final, temporary, backup, and
  rollback archives, with byte-identical manifests and original artifacts.
- Five scoped static verification reports passed after the preservation fix.
- A direct Android SAF bridge probe exposed an additional empty-inventory
  validation issue: Java's `ZipInputStream` accepted a 25-byte non-ZIP file as
  an empty archive. Empty archives now require a valid zero-entry ZIP end
  record, matching comment length, and no trailing data. The new malformed
  empty-archive regression failed before the fix; the full JVM suite passed
  afterward. Valid empty archives with and without comments remain accepted.

Linux host Rust testing was unavailable because the host lacks DBus development
libraries. The native checks above ran on the requested Android device instead.

## Copied real-content test

Newtoki Webtoon work `54204320`, chapter sequence `243`, maps to source chapter
`/webtoon/54204320/kp-54204320-66567622`. The source labels it episode 242 because
the app's sequence includes the prologue. Sequence 244, labeled episode 243,
was already complete and was not used as the failing test case.

Before testing, the original sequence-243 directory was copied and its 41
stored media files were hashed. Its manifest declared 117 assets, with 76
remote entries and no `media.zip`. A separate debug application and selected
storage root used these copied files and actual work, chapter, and plugin
records from the application's own backup.

The normal chapter download action acquired 75 additional assets and published
a 12,504,417-byte ZIP containing 116 entries. ZIP CRC inspection passed. All 41
original asset hashes and their stored timestamps were unchanged. One SVG
remained remote: `0014-8vEq4gnkDRTZ.svg` on `newtoki468.com`.

After the retry budget ended, the primary display showed one failed chapter
and a diagnostic naming exactly one missing asset. The manifest retained all
117 entries and `complete: false`; no final chapter body was published. This
reproduces the requested partial-success behavior without hiding the remaining
failed asset. The historical report of 82 failures was not independently
reproduced as an exact count.

After an in-place debug update and relaunch, another normal download action
reused the 116 stored entries and attempted the remaining asset. Every ZIP
entry retained its SHA-256 hash. The same single missing asset remained in the
failure diagnostic. Direct fresh-page extraction probes timed out. A later
check opened the chapter through the app's visible site browser and scrolled to
page 14. The fresh page used the same SVG URL; its image fired an error with
zero natural width and height. The source viewer then displayed
`image_load:page_14`. This establishes the browser failure observed during the
check, without assuming that the origin has permanently deleted the asset.

## Direct Android storage checks

The copied 116-entry chapter directory was moved aside within the disposable
test root. A manifest containing its one actual remote asset then exercised
`AndroidStorageBridge.archiveDirectory` through the running app and the selected
SAF root. With no stored files, finalization produced a valid 22-byte empty ZIP
and retained `complete: false`.

After the empty-ZIP validation fix, separate damaged `media.zip`,
`media.zip.tmp.zip`, `media.zip.bak`, and `media.zip.rollback` fixtures all failed
finalization without changing either the damaged bytes or the manifest. No
empty final ZIP replaced those artifacts. A final clean attempt again produced
the valid empty ZIP. These were direct native storage checks in the test
application; the normal chapter-download integration used the full copied
117-asset inventory above.

## Signed update and original data

Actions run `40442258928` succeeded for commit
`72a15dc544010b40f84f223555fe20566855ce83`. Its CI workflow also passed. The
signed arm64 APK is available with SHA-256
`4fe97a5401bbae81d2b77337b57f0090322a091d396d2c319d0e47780a7ee6c0`.

A full backup exported before installation passed ZIP CRC inspection and held
118 work records and 54,286 chapter records. The original application's work
home retained 306 chapters, 305 downloaded, and its normal download menu offered
exactly one chapter. All 41 original media files still matched their initial
hashes before the signed update.

The in-app browser's artifact save, normal Actions artifact link, and direct
Release asset save all timed out. After the user authorized GitHub CLI download,
the signed release containing the library repair filter, commit `1a8c7fa`, was
installed over the original application. The replacement certificate matched
the installed certificate. Both backups retained 118 works and 54,286 chapters;
all work metadata, chapter metadata, reading state, categories, memberships,
repositories, and installed plugins compared unchanged. Existing queued
downloads continued and changed only download state. The work document still
contained the same 306 chapter titles after restart.

### Synthetic CDN context follow-up

The original application exposed another acquisition failure before media HTTP
requests started. Its synthetic CDN documents emitted completion callbacks
without a page-start callback, while the navigation state machine required a
start event. The missing event left cross-origin media requests waiting until
the preparation timeout.

Commit `9918c4ff6618c137be93528307d7629c7df038be` gives each synthetic document
a unique URL and accepts only its matching completion. Older documents at the
same origin, stale callbacks from other origins, canceled navigation, and
duplicate completion events remain rejected. Ordinary source redirects and
fallback navigation keep their existing behavior.

The context regression suite first failed two assertions. After the fix, all
108 Android JVM tests across 15 classes passed, along with the targeted arm64
debug APK build. Three live cross-origin requests through the native scraper
and its normal foreground-service lease returned HTTP 200. Two scoped static
verification reports passed. The commit and push hooks passed TypeScript
checking and 1,972 frontend tests across 168 files.

Actions run `40449765012` built the signed release for that commit. The arm64
APK SHA-256 is
`a0537e627f891011be9449d8c94be8973a5e149ea00426510d98542948c18b27`.
Its update metadata identifies the same run and commit. The checksum,
certificate, presence of the context fix, and installed APK bytes were checked
before testing the original content root again.

That normal download acquired 75 more assets and published a 12,504,417-byte
ZIP with 116 entries. ZIP CRC inspection passed, and all 41 original asset
hashes matched the archived entries. The manifest retained 117 declared assets,
one remote SVG, and `complete: false`. Automatic retries used one missing asset
rather than acquiring the already stored 116 again. After the bounded retry
budget ended, the original application displayed one failed chapter with a
diagnostic naming exactly `0014-8vEq4gnkDRTZ.svg`.

After a cold restart, all 116 ZIP entry hashes still matched, and ZIP CRC
inspection passed again. The final exported backup retained 118 works and
54,286 chapters. All work metadata, chapter metadata, reading state, categories,
memberships, repositories, and installed plugins compared unchanged against
the backup before either signed update. The continuing user queue increased
completed chapter flags from 37,527 to 37,547; the incomplete target remained
uncompleted. The work document was byte-identical, including its 306 chapter
titles.

The library repair tag was also checked in the original application: selecting
it narrowed the reading category to the affected works, changing the source
narrowed that result further, and disabling it restored the category's 43 works.
Its selected state and affected works survived restart. Temporary partial
chapters from the user's continuing queue can enter and leave the tag while
their media state changes.

The earlier copied-content test application, copied storage root, import ZIP,
temporary VPN profile copy, native test executables, and debug forwarding were
removed after verification. The follow-up debug application and forwarding
were also removed; it never selected an external root or imported a VPN
profile. The original application, content root, VPN profile, and user queue
were preserved.

## Content-server restart policy

The local `norea-content-server` container was stopped and used
`unless-stopped`. Its host compose configuration was changed to `restart: always`
and the container was recreated with the same pinned image, state volume,
content bind mount, and port 18087. Docker reported it running and healthy with
the new policy. Both the local and public `/api/v1/capabilities` endpoints
returned HTTP 200. No server database was reset. OneDrive remained stopped as
requested.
