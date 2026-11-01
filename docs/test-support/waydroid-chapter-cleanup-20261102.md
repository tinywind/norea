# Device chapter cleanup verification

## Environment

- Waydroid Android 13, x86_64, isolated package `io.github.tinywind.norea.qa20261102cleanup.debug`.
- Dedicated SAF tree `Documents/NoreaQACleanup20261102`; two fixture sources, two overlapping categories, and a separate local content server.
- Fourteen chapters downloaded through the source WebView and uploaded through the app before varying local/server asset inventories. Physical Y700 devices and existing app storage were not changed.
- Targeted x86_64 debug APK built and installed successfully. SHA-256: `1fe3c7c75b04c96d202313eca4243e9fd53d5d2706a78d320c856a6712cf218f`.
- QA exports, application ID and cleartext network configuration were temporary and are absent from the committed app.

## Results

All four selectors were exercised through the installed app's preview and cleanup services, using real SQLite, Android SAF and server requests. The initial deletion also used Settings -> Data, preview, confirmation and result UI.

| Server condition, read chapters in category A | Preview chapter IDs | Result |
| --- | --- | --- |
| Contains all device content | 1, 2, 5 | Includes full server copies and a server superset of a partial local copy |
| Coverage at least local | 1, 2, 3, 5 | Also includes different 8/10 asset subsets |
| Present | 1, 2, 3, 4, 5, 8 | Also includes lower coverage and an available body with missing media archive |
| Ignore server | 1, 2, 3, 4, 5, 6, 8 | Includes a server-deleted chapter |

- The default all-category UI preview selected chapters 1, 2, 5 and 49. Confirmation deleted exactly those four; there were no failures or extra deletions.
- Subsequent coverage, presence and ignore-server runs deleted 1, 2 and 1 additional chapters respectively. Ignore-server used an unreachable server address and reported zero checked servers.
- A selected-category filter with no category produced zero targets and disabled deletion. Category choices and all four server options were present in the installed UI.
- A read-state change after preview skipped the changed chapter without deleting it.
- Cancelling after the first completed deletion reported 1 deleted and 4 cancelled; all four remaining payloads were still eligible afterward.
- Chapter identity, names, order, read flags, progress, bookmarks and category assignments matched the pre-cleanup database snapshot. All retained work/chapter metadata files matched their original bytes.
- Force-stop/relaunch preserved the metadata and deletion state. A complete chapter and an incomplete 8/10 chapter were both downloaded again from the server.
- During another cleanup, an unrelated chapter download in the same work completed successfully. Cleanup deleted its two fixed targets without cancelling or deleting the new chapter.
- The test server's 37 content files had identical hashes before and after cleanup/redownload.
- A 1,032-candidate preview completed in 34.8 seconds. Concurrent route transitions took 18, 49 and 67 ms. A 16 ms event-loop sampling timer had a 16 ms p95 gap and a 116 ms maximum gap. These are one-run observations, not a general performance guarantee.

## Automated verification

- `pnpm tsc`: passed with Node 24 and pnpm 10.27.0.
- `pnpm test`: 184 files, 2,196 tests passed.
- Focused Android JVM inventory suite: 8 tests passed.
- Native Rust inventory tests executed on Waydroid x86_64: 5 passed; backup restore-cache regression: 1 passed.
- Content server: typecheck/build passed; 190 tests passed.
- Project checks covered IPC/storage contracts, data access, error handling, architecture, UI, English-only source and localization.
- `git diff --check`: passed.

The host's default pnpm executable initially selected a different runtime and refused to replace `node_modules` without a terminal. No dependency replacement was performed; checks succeeded with the documented Node 24/pnpm 10 environment. Linux-host Rust tests were blocked by missing `pkg-config`; the native tests above ran on the requested Android target.

## Server delivery

The read-only inventory endpoint was committed and pushed in content-server commit `10cd32111a785fbd6e304cc9e2e296e09f84e237`. Its [Docker workflow](https://github.com/tinywind/norea-content-server/actions/runs/41332709896) succeeded. The verified image digest `sha256:927425b58768519ceed5c2ad33d8e5dd963916526d43b2f1e3fa20746a09d20d` was deployed to `tinywind-SER` using the existing compose service.

Health, authorized full/presence inventories, unauthorized rejection, catalog and admin reads passed. Configuration, volumes, schema, credentials and existing records were preserved: 118 works, 52,905 chapters, 7 devices and 7,014 reading records. Cleanup never sends server content mutations.

## Limits

Provider permission errors, partial-deletion failures, server revision races, late writes and queued repair cancellation have automated regression coverage. Revoking a live SAF grant, killing the process during a native deletion, and simultaneous live repair/upload were not reproduced end to end on Waydroid. Restart was tested after settled cancellation/deletion. Server missing and deleted responses currently share the missing-chapter exclusion label.

Local imported works require a matching per-chapter server-download proof before cleanup. Older server-imported local chapters without that proof are excluded; downloading them from the server again records proof. This prevents a work-level server association from authorizing deletion of unrelated local originals. Canonical-directory ambiguity also excludes a chapter.

Raw evidence is retained locally under `.tmp/device-chapter-cleanup-20261102/`; it is not committed.

## Affected app files

| File | First affected line |
| --- | --- |
| `docs/content-sync.md` | 243 |
| `docs/release-compatibility.md` | 166 |
| `docs/superpowers/plans/2026-11-02-device-chapter-cleanup.md` | 1 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidChapterMediaStore.kt` | 118 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidChapterPayloadInventory.kt` | 1 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidStorageBridge.kt` | 30 |
| `src-tauri/gen/android/app/src/test/java/io/github/tinywind/norea/AndroidChapterPayloadInventoryTest.kt` | 1 |
| `src-tauri/src/backup.rs` | 544 |
| `src-tauri/src/chapter_media.rs` | 7 |
| `src-tauri/src/chapter_media/inventory.rs` | 1 |
| `src-tauri/src/chapter_media/repair.rs` | 99 |
| `src-tauri/src/lib.rs` | 176 |
| `src/components/ChapterCleanupPanel.test.tsx` | 1 |
| `src/components/ChapterCleanupPanel.tsx` | 1 |
| `src/db/queries/chapter-cleanup.test.ts` | 1 |
| `src/db/queries/chapter-cleanup.ts` | 1 |
| `src/db/queries/content-deletion.test.ts` | 18 |
| `src/db/queries/content-deletion.ts` | 30 |
| `src/db/queries/content-sync.ts` | 64 |
| `src/lib/android-storage.ts` | 17 |
| `src/lib/chapter-cleanup.ts` | 1 |
| `src/lib/chapter-content/inventory.test.ts` | 1 |
| `src/lib/chapter-content/inventory.ts` | 1 |
| `src/lib/chapter-content/storage-platform.ts` | 5 |
| `src/lib/chapter-download-writes.ts` | 22 |
| `src/lib/content-sync/chapter-inventory.test.ts` | 1 |
| `src/lib/content-sync/chapter-inventory.ts` | 1 |
| `src/lib/content-sync/sync.test.ts` | 8 |
| `src/lib/content-sync/sync.ts` | 4 |
| `src/lib/tasks/chapter-cleanup.test.ts` | 1 |
| `src/lib/tasks/chapter-cleanup.ts` | 1 |
| `src/lib/tasks/chapter-download.test.ts` | 103 |
| `src/lib/tasks/chapter-download.ts` | 1681 |
| `src/routes/settings.tsx` | 25 |
| `strings/languages/en/app.json` | 444 |
| `strings/languages/ko/app.json` | 444 |
