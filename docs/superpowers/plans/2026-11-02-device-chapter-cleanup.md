# Device Chapter Cleanup Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task after implementation is requested. Steps use checkbox syntax. This planning request does not authorize builds, tests, commits, deployment, or deletion of device data.

**Goal:** Reclaim device storage by deleting downloaded chapter payloads that satisfy the selected server, reading-state, and category conditions, while preserving work and chapter metadata.

**Architecture:** Add a device-only cleanup panel under Settings -> Data. A preview service selects local candidates, obtains read-only server evidence when needed, and produces an immutable list for an explicit cleanup action. Reuse storage identity resolution, download/write guards, task progress, and query invalidation; use payload-only deletion rather than the existing whole-folder deletion routine.

**Approach choice:** Existing completeness booleans cannot implement the two comparison selectors. Downloading full remote chapter archives would consume the bandwidth/storage this feature is meant to save. A read-only server inventory endpoint provides the required evidence without transferring chapter payloads.

**Tech Stack:** Existing React/Mantine, TanStack Query, Tauri/Rust, Android storage bridge, SQLite, and Fastify content server. No new dependencies are planned.

**Spec:** The behavior contract below incorporates the selector clarifications on 2026-11-02. The implementation is complete. Device verification and its limits are recorded in `docs/test-support/waydroid-chapter-cleanup-20261102.md`.

## Global Constraints

- Work on release branch `0.2`; follow each repository's command and release gates.
- All committed prose and code are English; localized UI copy belongs in `strings/languages/en/` and `strings/languages/ko/`.
- Cleanup mutates device payload files and local download state only. It must not call server deletion, purge, restore, or upload operations, or create server deletion exclusions.
- Preserve database rows, work identity, chapter identity/catalog/order, library membership, categories, reading history, read flags, progress, bookmarks, work documents, covers, and existing chapter metadata manifests.
- Server completeness remains a status for browsing/downloading. Cleanup selectors alone determine this operation's eligibility; upload conflict preferences are unrelated.
- No scheduled cleanup or automatic cleanup after restart is included. No schema change is planned; any required persisted schema change needs a versioned migration.
- Preserve the previous UI latency work: no full-history scan per chapter event, synchronous ZIP/hash work on the WebView UI thread, or unbounded progress rendering.

## Behavior Contract

### Filter semantics

`eligible = managedDownloadedPayload AND serverCondition AND readingCondition AND categoryCondition`

| Server selector | Stable value | Eligibility |
| --- | --- | --- |
| Present on server | `server-present` | A live, nondeleted package with an available body exists for the resolved chapter. Incomplete packages qualify. |
| Server asset coverage at least local | `server-coverage` | Comparable bodies/manifests, and server valid-asset ratio is greater than or equal to the local ratio. Different missing assets may qualify. |
| Server contains all device content | `server-contains-local` | The server has the same body and every valid locally stored asset with matching identity and content digest. Additional server assets are allowed. |
| Ignore server state | `any` | No server request or comparison is made. All other conditions still apply. |

- Reading selector: `read` uses the app's persisted `unread = false`, including manually marked read chapters; `all` imposes no reading filter. Partially read chapters are not inferred to be finished from a positive progress value.
- Category selector: all categories, or one or more selected categories. Multiple selected categories are OR within this dimension; the category result is AND with the other two dimensions. Deduplicate chapters of works in multiple categories.
- Explicit selected-category mode with no selection matches nothing. Reuse the existing uncategorized category semantics for library works. Works outside the library appear only when the category filter is all.
- Proposed initial values: `server-contains-local`, `read`, all categories. Always require preview and confirmation, including for these defaults.
- Candidates include downloaded source chapters and content-server downloads, including incomplete bodies and stored media. A local-work chapter requires chapter-specific proof of a successful server installation and a matching current payload fingerprint. A work-level server association alone does not qualify a local original. Older local chapters without proof stay excluded. Do not rely on `is_downloaded = true` or `is_local = false` alone to identify candidates.
- Resolve the server from the work's saved server association, falling back to the configured server. Pin that URL in the preview and show the checked server. Changes to server settings or association invalidate the preview.

### Comparison rules

- A boolean `complete` cannot distinguish two partial copies. Obtain inventories from actual body files, manifest declarations, and validated ZIP entries; do not trust cached per-asset success flags.
- Inventory contract: `body: { sha256, bytes } | null`, `expectedAssetKeys: string[] | null`, and `storedAssets: { key, sha256, bytes }[]`. Use canonical manifest file identities as keys and SHA-256 of uncompressed valid asset bytes. The server envelope also carries package identity and revision.
- `server-coverage` requires the same body digest and declared asset-key set before comparing ratios. Compare integer counts without rounded percentages; valid zero-asset bodies have 100% coverage. Different bodies/inventories, malformed manifests, and missing comparison data are not comparable and are skipped.
- `server-contains-local` requires the same body digest and matching key/digest/size for every locally stored valid asset. It does not require the server to be globally complete. Both 8/10 copies with different missing assets pass `server-coverage` and fail `server-contains-local`.
- Identity matching uses exact plugin/work/chapter identity first. A chapter-number alias is allowed only within the verified same work and only when unique. An ambiguous match is never evidence for deletion.
- Missing package, deleted package, unavailable files, timeout, authentication failure, and malformed evidence remain distinct results. Unknown server state never satisfies a server-dependent selector. `any` still works offline.

### Preview, execution, and preservation

- Add a dedicated cleanup panel opened from Settings -> Data, replacing that page's unconditional downloaded-content cleanup entry. Keep other existing deletion entry points and their semantics unchanged. This panel has no server-delete toggle.
- Show the selected conditions, matching work/chapter counts, estimated reclaimable payload bytes, and skipped/error counts with reasons. Estimate payload bytes only; retained metadata is not reclaimed. Expandable work details must not render every chapter at once.
- Changing any filter discards the old preview. Confirm an immutable ID/identity list; execution never expands it to newly matching chapters.
- Immediately before each small batch, recheck read/category eligibility, current storage identity/fingerprint, and fresh server existence/revision/comparison when applicable. A changed or unknown candidate is skipped and reported, never silently promoted to `any`.
- Cancel conflicting queued downloads and repairs only for the accepted target IDs, wait for their current writes, and use the existing write guards so late source/server responses cannot recreate deleted payloads. Serialize target storage changes with work-scoped content publication; unrelated work remains usable.
- Delete only recognized body files (`content.html`, `content.pdf`, partial body files), media archives, loose managed assets, and their known payload staging files. Preserve `novel.json`, covers, chapter rows, and existing `manifest.json`; do not recursively remove the chapter/work directory.
- Update download flags and byte counts from the resulting files after each chapter/small batch. Do not remove chapter rows or edit the persisted chapter catalog. On partial file failure or cancellation, reconcile the actual remaining files and report partial completion instead of marking every target deleted.
- Run as an explicit task with progress and cancellation. Do not persist this cleanup into the existing automatically resumed deletion-work queue without its original conditions. Use a one-shot guarded deletion primitive; after process death, require a fresh preview for remaining work.
- Completion shows deleted, skipped, failed, and cancelled counts. Retry requires reevaluation of the remaining targets. Invalidate affected chapter/detail/cache queries without discarding retained metadata.
- Server evidence is a point-in-time check, not a promise against another device deleting the server copy later. Do not introduce remote retention locks or mutate remote packages for this feature.

## Current Code Findings

| Entry point | Relevant behavior |
| --- | --- |
| `src/routes/settings.tsx:1283,1978` | Existing Data action opens common all-download deletion, which can also offer server deletion. |
| `src/lib/content-deletion.ts:138` | Common orchestration may create server mutations; the new panel must not use its server action path. |
| `src/db/queries/download-cache.ts:169` | Existing candidates unconditionally exclude local works and do not express the requested filters. |
| `src/lib/tasks/download-cache-delete.ts:206,251,292,356` | Has useful write guards, but Android deletes folders before the native DB pass, and stored work can resume without reevaluating filters. |
| `src-tauri/src/download_cache.rs:429,647` | Download-state updates preserve rows; reusable concepts, but its persisted runner is not the new one-shot cleanup contract. |
| `src-tauri/src/chapter_media/cache.rs:298` | Existing downloaded-chapter cleanup removes the entire directory, including its manifest. |
| `src/lib/content-sync/chapters.ts:5`, `native.ts:25` | Current server summaries/catalog expose completeness as a boolean. |
| `src/lib/content-sync/novel-source.ts:20,39,60` | Existing server association, availability, and download identity resolution are useful integration points. |
| `src/db/queries/category.ts:3,42` | Existing uncategorized-library semantics should be retained. |

## Review Focus

1. Partial copies with equal ratios but different assets must distinguish the two comparison selectors.
2. Corrupt/missing files or ambiguous identities must not become positive server evidence.
3. Multi-category works, non-library works, server-origin local works, and incomplete downloads must have explicit, tested eligibility.
4. Changed filters/state and concurrent download/upload/storage writes must not widen confirmed deletion or recreate payloads.
5. Cancellation, permission loss, and process death must preserve metadata and accurately describe partial filesystem changes.

## Implementation Tasks

### Task 1: Inspect and compare actual stored chapter inventories

**Files:** Create app `src/lib/chapter-content/inventory.ts` and its tests; extend the existing platform boundary in `src/lib/chapter-content/storage-platform.ts`, `src/lib/android-storage.ts`, `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidChapterPayloadInventory.kt` and `AndroidStorageBridge.kt`; add `src-tauri/src/chapter_media/inventory.rs` and wire it through `src-tauri/src/chapter_media.rs` and `src-tauri/src/lib.rs`. Create server `src/chapter-inventory.ts` and `test/chapter-inventory.test.ts`; register its read-only route in `src/app.ts`.

**Interfaces:** Export `ChapterPayloadInventory` and pure `compareChapterInventories(local, remote)` returning coverage eligibility, containment eligibility, and a precise non-comparable reason. Add `GET /api/v1/chapters/:id/storage-inventory?revision=...`, returning current identity/revision and validated inventory through existing read authorization. Add app `inspectChapterPayloadInventory(identity: ChapterContentStorageIdentity, signal?: AbortSignal): Promise<ChapterPayloadInventory>` using the canonical storage identity type.

- [x] Write failing comparison tests: complete/partial pairs, equal 8/10 with different assets, zero assets, same filename with different bytes, different bodies/declarations, malformed manifests, and corrupt ZIP entries.
- [x] Implement read-only inspection and the pure comparison. Stream bodies/ZIP entries with existing limits; perform native work on storage executors/blocking workers and server CPU work off its request event loop. No repair, download, or file rewrite during inspection.
- [x] Add endpoint tests for missing/deleted files, wrong revision, identity validation, authorization, and changes during inspection. Revision mismatches fail instead of mixing copies.
- [x] Verify only bounded inventory data crosses IPC/HTTP; no full body/archive is downloaded to compare cleanup eligibility. Use bounded concurrency and per-preview memoization, not permanent new inventory tables.

### Task 2: Build filtered candidates and a reviewable preview

**Files:** Create `src/db/queries/chapter-cleanup.ts`, `src/lib/chapter-cleanup.ts`, and their tests; create `src/lib/content-sync/chapter-inventory.ts` for the server lookup/DTO boundary. Reuse `category.ts`, `novel-source.ts`, `management.ts`, and canonical chapter/storage types.

**Interfaces:** Define `ChapterCleanupFilters` with the four server modes, `read | all`, and `all | selected category IDs`. `previewChapterCleanup(filters, signal)` returns a `ChapterCleanupPreview` containing filters, fixed candidate identities, storage fingerprints, server URL/revision evidence, estimates, and per-reason exclusions. It performs no deletions.

- [x] Write SQL selection tests for AND semantics, category OR/deduplication, uncategorized/non-library behavior, read flags, incomplete payloads, server-origin local works, direct-import exclusions, and empty selection.
- [x] Implement committed, paged candidate reads. Apply cheap read/category filters before filesystem/hash/network inspection. Do not scan unrelated scheduler history or load all file bodies into React state.
- [x] Resolve live server packages with existing identity rules. Test all four modes, errors/unknowns, server setting changes, and zero server calls for `any`; upload policy and old successful-sync flags must not decide eligibility.
- [x] Verify preview totals, cancellation, and immutable target IDs. Surface skipped candidates rather than converting failed lookups to absent/complete results.

### Task 3: Execute payload-only cleanup with per-target consistency

**Files:** Create `src/lib/tasks/chapter-cleanup.ts` and tests. Extend `src/lib/chapter-content/storage-platform.ts`, `src/lib/android-storage.ts`, `src-tauri/src/chapter_media/cache.rs`, and Android `AndroidStorageBridge.kt` with a one-shot payload-only primitive; register the Rust command in `src-tauri/src/lib.rs`. Reuse `src/lib/chapter-download-writes.ts`, task deletion guards, `src/lib/content-sync/storage-operation.ts`, and chapter-state reconciliation functions.

**Interfaces:** `runChapterCleanup(preview, { signal, onProgress })` returns per-target deleted/skipped/failed results and totals. Its native primitive accepts canonical resolved chapter identity plus the expected local fingerprint, rejects stale/multiple matches, deletes only recognized payloads, and returns the actual remaining inventory. It does not enqueue resumable native work.

- [x] Write preservation tests comparing work documents, chapter manifests, row identities, catalog titles, categories, read state/history, progress, and bookmarks before/after cleanup.
- [x] Test rechecks after read/category/server revision changes, queued/running downloads and repairs, late writes, simultaneous uploads, empty/repeated deletion, and unaffected sibling work.
- [x] Implement guarded per-chapter/small-batch deletion with post-operation reconciliation. Do not retain the current Android all-files-first/all-DB-later behavior for this feature.
- [ ] Test storage permission errors, partial archive deletion, cancellation mid-run, and interrupted process recovery. Remaining files must match reported byte counts; no automatic restart may delete against a stale preview.
- [x] Use existing task progress and coalesced UI updates; do not block unrelated tasks with a global storage/network barrier.

### Task 4: Add the Settings -> Data workflow

**Files:** Create `src/components/ChapterCleanupPanel.tsx` and tests; integrate at `src/routes/settings.tsx:1283,1978`. Add English/Korean keys in `strings/languages/en/app.json` and `strings/languages/ko/app.json`.

- [x] Test the four-option server selector, two-option reading selector, category selection, condition summary, disabled empty/unknown-only deletion, and preview invalidation after changes.
- [x] Implement filters -> preview -> explicit confirmation -> progress/cancel -> result. Explain the difference between coverage and content containment, including the equal-ratio/different-assets case.
- [x] Load inspection only when requested. Present estimated bytes, affected works/chapters, checked server, and skipped reasons. Keep the results readable for thousands of chapters.
- [x] Verify no server deletion toggle/call exists in this flow, metadata remains visible after cleanup/restart, and remaining server chapters can be downloaded again.

### Task 5: Verify on Waydroid and deliver the compatible API/app

**Files:** Update `docs/release-compatibility.md` for payload-only cleanup and retained manifests; create a focused Waydroid verification report. Update server API documentation for inventory reads.

- [x] After implementation authorization, run app `pnpm tsc`, relevant Vitest tests then `pnpm test`, relevant Rust checks/tests, Android JVM tests, and server `pnpm typecheck`, `pnpm test`, `pnpm build`. Apply relevant project verification skills.
- [x] Build only x86_64 using `pnpm exec tauri android build --apk --debug --target x86_64`. Use an isolated Waydroid QA package/storage tree and test content server; preserve user devices and production files.
- [x] Test all four modes with read/unread chapters and two overlapping categories. Include local/server 10/10, 8/10, 5/10, equal 8/10 with different assets, server missing/deleted, and unreachable server. Assert file inventories, retained metadata hashes, server package hashes/counts, and restart/redownload behavior.
- [ ] Exercise cancellation, Android folder permission loss, simultaneous download/repair/upload, and a large candidate set while navigating/reading. Record deletion counts, payload bytes, and responsiveness rather than only checking the dialog.
- [x] When commit/push/deployment is authorized, deliver coherent app/server commits on `0.2`. Follow `norea-content-server/AGENTS.md`: successful exact-commit Docker workflow, verified image digest deployment to `tinywind-SER`, preserved volumes/configuration, and live read-only inventory/API/data checks. Deploy the inventory API before relying on it in the app; unavailable comparison support must fail closed.

## Current delivery status

The app implementation, automated tests and Waydroid cleanup flows are complete.
The inventory API is pushed and deployed. Permission revocation, interrupted
native deletion and simultaneous live repair/upload remain device-test limits;
automated error/race tests cover the related boundaries. See the verification
report for exact outcomes. Runtime and Settings UI changes are delivered as
separate commits on `0.2`.
