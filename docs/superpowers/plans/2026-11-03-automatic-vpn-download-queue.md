# Automatic VPN download queue implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make accepted downloads visible immediately and run current/new queued work through automatically assigned VPN workers with little setup or interruption.

**Architecture:** Retain the current scheduler, SQLite queue and frozen VPN plans. Add explicit pending VPN ownership, transfer ordinary jobs at chapter boundaries, expand isolated worker contracts to ten and replace per-work setup with one default-ready launch modal and an operational queue.

**Tech stack:** Tauri 2, Rust, Kotlin/Android WebView, React 19, TypeScript, Mantine, Zustand, TanStack Query, SQLite and pnpm/Node 24.

**Spec:** `docs/superpowers/specs/2026-11-03-automatic-vpn-download-queue-design.md`

## Global constraints

- Work on `0.2`; preserve existing staged library-query files and uncommitted logging changes.
- Obtain execution approval before builds/tests, configured signer use, APK installation and Git mutations.
- Build only the requested device ABI; do not use aggregate release scripts. The user later selected Waydroid / `x86_64` for acceptance and deferred Y700 hardware tests.
- VPN count is 1 through 10 globally; worker slots are 0 through 9.
- Default launch requires no settings edits, per-work profile choice or manual range assignment.
- Include current ordinary queued downloads and requests arriving during the active VPN run.
- Preserve in-flight chapter publication, exact job ownership, frozen ranges, checkpoints and explicit user pauses.
- Keep plugin-owned traffic on its sanctioned worker/source fetch path; no raw HTTP fallback or cookie copying.
- Reuse current queue/plan tables. Add pending routing to the canonical internal job payload; do not modify migrations.
- All repository code/docs are English; user-facing UI text belongs in matching English/Korean locale keys.
- All generated evidence and diagnostic instrumentation stay under project-root `.tmp/`.
- No uninstall, app-data reset, file deletion or signing bypass on Y700.
- Do not commit individual scaffolding/planning steps; prepare coherent scoped commits after final acceptance.

## Review focus

1. A restored ordinary job finishes while VPN launch claims its queue row: preserve the completion and never recreate it (Task 3).
2. A cancelled request completes a delayed catalog read: it cannot publish a plan or connect later (Tasks 2 and 5).
3. A busy profile becomes excluded while its waiter is waking: recheck shared eligibility before connection (Task 5).
4. Ten browser/tunnel lifetimes overlap cleanup or a lowered limit: closing/manual leases still occupy capacity (Task 4).
5. The old release has memory-only draft previews before an APK update: preserve their requests or block installation (Task 1).

## File map and interfaces

| Surface | Responsibility |
| --- | --- |
| `.tmp/y700-download-debug-20261103/` | Isolated source candidate, signer checks, temporary diagnostics and actual device evidence |
| `src/lib/tasks/chapter-download-requests.ts` (new) | Immediate request admission before asynchronous job preparation, cancellation and a stable external snapshot |
| `src/components/library/use-library-selection.ts`, `src/components/novel/use-novel-chapter-actions.ts` | Submit existing download intent through admission without changing chapter selection semantics |
| `src/db/queries/chapter-download-queue.ts` (new) | Validated queue snapshots, pending VPN reservation/adoption/cancellation on canonical transactions |
| `src/db/queries/vpn-download-plans.ts`, `src-tauri/src/download_queue.rs`, `src-tauri/src/device_backup.rs` | Enrolled ownership, ordinary lease/delete protection and pending-route preservation |
| `src/lib/tasks/chapter-download.ts`, `src/lib/tasks/scheduler.ts` | Transfer fences, late-owner protection and correct ordinary/VPN dispatch |
| `src/lib/tasks/vpn-download-types.ts`, `vpn-worker-context.ts`, `src/lib/android-scraper.ts` | Shared worker identity and queue-routing contracts |
| Android VPN policy/workers/service/activity files and `AndroidManifest.xml` | Ten isolated, lazily used process slots and exact manual-browser routing |
| `src-tauri/src/plugin_vpn/download_workers.rs` | Ten validated native slots, proxy ownership and generation-scoped cleanup |
| `src/lib/tasks/vpn-download-runtime.ts`, `vpn-download-coordinator.ts`, `vpn-download-ranges.ts`, `vpn-download-drafts.ts` | Automatic run admission, planning, global capacity, profile leases and recovery |
| `src/store/vpn-download.ts`, `VpnDownloadPanel.tsx`, `VpnDownloadSettings.tsx`, `VpnDownloadRanges.tsx`, `src/routes/tasks.tsx` | Accepted defaults, launch modal and VPN-oriented queue without per-work setup |
| `src/styles/tasks.css`, `strings/languages/{en,ko}/app.json` | Existing responsive styling and complete localized UI copy |

### Task 1: Establish safe Y700 diagnostic access and measure the wait

**Files:** Create temporary tools/evidence only under `.tmp/y700-download-debug-20261103/`; later add `docs/test-support/automatic-vpn-download-queue.md` with verified results.

**Consumes:** Installed package `io.github.tinywind.norea`, current source HEAD and the existing environment runner `.tmp/local-logs-20261102/run.py`.
**Produces:** A bounded timing report separating admission, queue persistence, catalog/DB waits, enrollment and connection. Installation either preserves current requests/data with a matching signer or is explicitly blocked.

- [ ] Copy the existing environment runner into this task's evidence directory. It already derives the project/evidence roots from its own location; keep Node 24, JDK 17 and NDK 29 settings intact.
- [ ] Record package version/public signer digest and pending/active work without reading secrets into tool output. Account for every visible legacy draft before restarting the old process. Existing preview Start actions may be used only to preserve already requested work with valid defaults; do not invent profile selections or cancel user work to make an update convenient.
- [ ] Prepare a source archive of HEAD under `.tmp/y700-download-debug-20261103/source-candidate/`. Exclude unrelated logging/library edits. Add temporary release-debugging/measurement hooks only to that candidate; keep the shipping application ID and existing configured release signer.
- [ ] Compare candidate and installed public signing certificates. If they differ, or legacy requests cannot be preserved, do not install. Record the blocker and continue only checks that do not require replacing the user's app.
- [ ] After preservation and signer checks, build only `pnpm exec tauri android build --apk --target aarch64` with the temporary diagnostic configuration. Install with data preservation and inspect actual startup/queue state.
- [ ] Measure the newly added work named by the user and a restored ordinary work. Capture time boundaries and row/task counts, not private URLs, cookies or profile files. Read the actual ordinary concurrency setting. Report which wait dominates before selecting the registration-delay correction.

### Task 2: Admit requests before preparation and honor ordinary concurrency

**Files:** Create `src/lib/tasks/chapter-download-requests.ts` and `.test.ts`; modify both caller hooks, their tests, `src/lib/tasks/chapter-download.ts` and its materialization tests, `src/lib/tasks/scheduler.ts` and relevant scheduler concurrency tests.

**Interfaces:**

```ts
interface ChapterDownloadRequestInput {
  key: string;
  title: string;
  novelIds: readonly number[];
  total?: number;
  prepare(signal: AbortSignal): Promise<ChapterDownloadBatchJob>;
}
submitChapterDownloadRequest(input: ChapterDownloadRequestInput): ChapterDownloadBatchHandle;
cancelChapterDownloadRequest(id: string): void;
getChapterDownloadRequestSnapshot(): readonly ChapterDownloadRequestState[];
subscribeChapterDownloadRequests(listener: () => void): () => void;
```

`ChapterDownloadRequestState` contains `id`, `title`, `novelIds`, `total: number | null`, `phase: "preparing" | "publishing" | "failed"` and `error: string | null`. Import existing batch/job types; do not duplicate them. Exact duplicate pending keys return the existing handle. Cancellation aborts preparation and cancels a child batch if already created. Remove a preparation row after successful materialization; the normal/VPN queue then owns its display.

- [ ] Write failing tests with a held preparation promise. Assert a synchronous preparing snapshot, one handle for repeated keys, cancellation before/after child creation and no late enqueue after cancellation. Keep the hook's current all/missing/unread selection assertions.
- [ ] Add a scheduler regression with concurrency three and three gated background download jobs: all three start. An interactive task must still use its independent executor; preserve task priority/preemption tests.
- [ ] Run RED: `pnpm test src/lib/tasks/chapter-download-requests.test.ts src/lib/tasks/scheduler.test.ts src/components/novel/use-novel-chapter-actions.test.ts`. A library hook regression belongs in `src/components/library/use-library-selection.test.ts` if no existing file covers the mutation.
- [ ] Implement admission and update only download submission in the hooks. Keep queued mutation preconditions and existing metadata/selection behavior. For persistent ordinary batches, resolve `materialized` only after their backend queue write succeeds, without waiting for chapter completion; cover a held/failed queue write in the admission regression. Remove the implicit foreground-minus-one background reduction when background concurrency follows the user's setting; retain an explicitly supplied background limit.
- [ ] Run the focused tests and `pnpm tsc`. Verify the device-measured registration bottleneck separately from the preparing indicator; do not claim the indicator alone fixed storage latency.

### Task 3: Persist pending routing and transfer queue ownership safely

**Files:** Create `src/db/queries/chapter-download-queue.ts` and `.test.ts`; modify `src/lib/tasks/chapter-download.ts`, `vpn-download-plans.ts` and tests; modify `src-tauri/src/download_queue.rs`, `device_backup.rs` and their existing unit tests.

**Interfaces:** Add `vpnBatchId?: string` to the existing canonical `ChapterDownloadJob` and Rust `ChapterDownloadQueueJob`. It identifies a pending/run-owned job before a plan exists. Keep `vpnPlanId`/`vpnRangeId` for enrolled ownership.

```ts
interface StoredQueuedChapterDownload {
  job: ChapterDownloadJob;
  jobJson: string;
  updatedAtMs: number;
}
listOrdinaryChapterDownloadJobs(): Promise<StoredQueuedChapterDownload[]>;
listPendingVpnDownloadJobs(): Promise<StoredQueuedChapterDownload[]>;
enqueuePendingVpnDownloadJobs(batchId: string, jobs: readonly ChapterDownloadJob[]): Promise<void>;
adoptOrdinaryChapterDownloadJobs(batchId: string, expected: readonly StoredQueuedChapterDownload[]): Promise<ChapterDownloadJob[]>;
cancelPendingVpnDownloadBatch(batchId: string): Promise<number>;
beginChapterDownloadVpnHandover(): Promise<ChapterDownloadVpnHandover>;
```

`ChapterDownloadVpnHandover` exposes ready `jobs`, `pending: readonly { job: StoredQueuedChapterDownload; settled: Promise<void> }[]`, `commitReady(batchId: string): Promise<readonly ChapterDownloadJob[]>` and idempotent `release(): void`. Commit performs the query helper's ownership transfer before retiring old handles. It can be called again after a pending settlement to claim that original cohort's remaining unfinished jobs. It never recaptures unrelated new jobs. An in-flight chapter is not ready until its publication and old-owner cleanup settle; it must not hold unrelated ready jobs. Every later callback checks the current run/cancellation epoch before admission.

Export `parseStoredChapterDownloadJob(row: Pick<ChapterDownloadQueue, "chapterId" | "jobJson">): ChapterDownloadJob` from the existing plan-query boundary by naming/reusing its current parser, rather than casting arbitrary `JSON.parse` output. Queue snapshots retain the exact stored `jobJson` for compare-and-swap; reserializing a native DTO is not an equivalent raw snapshot.

- [ ] Write real-SQLite regressions for new pending jobs, exact-owner duplicate admission, conflicting owners, held ordinary completion during claim, stale snapshots, cancelled requests and transaction rollback. No test may accept delete-then-recreate as preserving a queue row.
- [ ] Add Rust queue regressions: ordinary lease, overwrite and removal ignore pending/enrolled VPN ownership; job serialization retains `vpnBatchId`. Add device-backup coverage for pending routes and existing completed/read/library data.
- [ ] Add frontend handover regressions: ready jobs transfer while an unrelated chapter/manual session remains open; completed chapters are excluded; late ordinary cleanup cannot delete transferred jobs; failure releases only the untransferred dispatch fence.
- [ ] Run RED: `pnpm test src/db/queries/chapter-download-queue.test.ts src/db/queries/vpn-download-plans.test.ts` and `cargo test --lib download_queue` from `src-tauri`.
- [ ] Implement native predicates and canonical payload preservation, then the transaction helpers and handover. Extend `createVpnDownloadPlan` to adopt only its exact pending batch owner atomically; preserve its current fresh-insert behavior and conflict rejection.
- [ ] Run the focused frontend tests, `cargo test --lib download_queue`, relevant `device_backup` tests and `pnpm tsc`. Treat pre-existing unrelated native failures separately with names/evidence, not as passing.

### Task 4: Extend the isolated worker contract to ten slots

**Files:** Modify `src/lib/tasks/vpn-download-types.ts`, `vpn-worker-context.ts`, `scheduler.ts`, `vpn-download-coordinator.ts`, `src/lib/android-scraper.ts`, `src/store/vpn-download.ts`; Rust `plugin_vpn/download_workers.rs`; Kotlin `AndroidVpnWorkerPolicy.kt`, `AndroidVpnDownloadWorkers.kt`, `AndroidVpnDownloadWorkerService.kt`, `AndroidVpnDownloadWorkerActivity.kt`; Android main manifest and focused tests.

**Interfaces:** Export `MAX_VPN_DOWNLOAD_WORKERS = 10`, `VpnDownloadWorkerSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9` and `isVpnDownloadWorkerSlot(value: unknown): value is VpnDownloadWorkerSlot` from the existing types module. Use the canonical slot type rather than a second union. Preserve native command names and queue format `vpn:<slot>:<generation>`.

`VpnDownloadCoordinator.setWorkerLimit(limit: number): void` validates integer counts 1 through 10. Replace the fixed pair with ten lazily occupied lease slots. Kotlin reports a supported maximum of ten; native Rust worker resources must not eagerly start ten tunnels or retain ten worker processes without demand.

- [ ] Add failing boundary tests for slots 2 and 9, rejection of -1/10/fractions, stale generations and exact route cleanup. Cover three and ten simultaneous scheduler/coordinator owners and a lowered live limit while a lease closes or manual verification remains open.
- [ ] Add Kotlin policy/manifest coverage for all ten distinct service/activity/process mappings. Keep the current profile/proxy isolation and manual-browser identity assertions.
- [ ] Run RED: `pnpm test src/lib/tasks/scheduler-vpn-workers.test.ts src/lib/tasks/vpn-download-coordinator.test.ts src/lib/android-vpn-download-workers.test.ts src/lib/plugin-vpn-download-workers.test.ts`; `cargo test --lib plugin_vpn::download_workers` from `src-tauri`; focused JVM `AndroidVpnWorkerPolicyTest` through the environment runner.
- [ ] Implement every identity/capability/dispatch boundary together. Search remaining production `[01]`, `slot > 1`, two-element arrays, service/activity ternaries and hard-coded capability checks; distinguish unrelated two-state/test values.
- [ ] Run the same focused tests and `pnpm tsc`. Verify generation-floor, private profile validation, proxy separation and cleanup behavior at slot 9. Do not treat TypeScript accepting slot 9 as native acceptance.

### Task 5: Run automatic enrollment and recovery without per-work setup

**Files:** Modify `src/lib/tasks/vpn-download-runtime.ts`, `vpn-download-coordinator.ts`, `vpn-download-ranges.ts`, `vpn-download-drafts.ts`, their tests and `src/store/vpn-download.ts`.

**Consumes:** Task 2 admission, Task 3 pending ownership/handover and Task 4 capacity.
**Produces:**

```ts
interface VpnDownloadLaunchOptions {
  workerCount: number;
  captchaPolicy: VpnDownloadChallengePolicy;
  cloudflarePolicy: VpnDownloadChallengePolicy;
}
startVpnDownloadRun(options: VpnDownloadLaunchOptions): Promise<void>;
pauseVpnDownloadRun(): Promise<void>;
resumeVpnDownloadRun(): Promise<void>;
cancelVpnDownloadRun(): Promise<void>;
```

Define these with canonical runtime/types modules, not UI-local contracts. Extend the stable runtime snapshot with run identity/status, preparing work, active/connecting/closing counts and owned chapter IDs needed to suppress duplicate ordinary rows. Keep existing range actions for targeted controls. Existing enrolled plans retain identity/attempts/pauses instead of being rewritten into a new batch.

- [ ] Write runtime regressions for one launch adopting ordinary jobs and legacy drafts; future requests joining the same run; immediate preparation display; held catalog/cancel races; no usable profile; busy-only profiles; and interrupted restart with pending versus enrolled jobs.
- [ ] Add planner tests for automatic contiguous partitioning, selected gaps, fewer selected chapters/profiles than worker count and fair progress across works. Do not create empty running ranges or fail merely because fewer than ten profiles exist.
- [ ] Add coordinator regressions for exclusion arriving during a waiter wake, cancellation during cleanup, offline recovery, same-chapter tunnel replacement and all-excluded exhaustion affecting only that range. Local storage/plugin errors must not exclude the VPN pool. An explicitly user-paused range must not resume on an unrelated eligibility event.
- [ ] Run RED: `pnpm test src/lib/tasks/vpn-download-runtime.test.ts src/lib/tasks/vpn-download-ranges.test.ts src/lib/tasks/vpn-download-coordinator.test.ts`.
- [ ] Implement the run APIs. Capture one accepted options snapshot and run batch identity. Reserve/persist jobs before execution; call the handover's `commitReady` for the initial cohort and after its pending settlements, checking the run epoch each time. Start prepared work automatically and process works independently. Select approved profiles without UI assignments and recheck leases/eligibility after awaits. Replace the old manual-draft start dependency, retaining a legacy draft conversion path only for live in-memory work already present at launch.
- [ ] Keep an active run's admission fence through automatic recovery. Pause/cancel must stop late admission/connection and preserve explicit user intent. Pending jobs must never be leased onto the ordinary route after restart. Preserve the old current-plan checkpoint contract.
- [ ] Run the focused suites, notification/ownership regressions and `pnpm tsc`. Record which recovery paths were newly exercised versus existing behavior retained.

### Task 6: Replace setup panels with a default-ready modal and VPN queue

**Files:** Modify `src/components/VpnDownloadPanel.tsx`, `VpnDownloadSettings.tsx`, `VpnDownloadRanges.tsx`, their tests, `src/routes/tasks.tsx`, `src/styles/tasks.css`, and both `app.json` locale files. Add a focused Tasks integration test if existing route tests do not cover the combined queue.

**Consumes:** Task 2 admission snapshot and Task 5 run snapshot/actions. `VpnDownloadSettings` becomes the optional launch-options editor; it must not mutate persisted settings merely because a control changed in an unsubmitted modal. `VpnDownloadRanges` becomes read-only assignment/progress plus operational controls; remove profile selectors, position editors and per-work draft Start actions.

- [ ] Write failing render/interaction tests for opening and dismissing the modal, default Start with no edits, optional count 1 through 10, visible unsupported/no-profile reasons, no per-work assignment controls and disabling duplicate submissions.
- [ ] Add tests for preparing-before-catalog completion, work/range progress, automatic waiting reasons, single-range failure, exact pause/resume/cancel targets, hidden-page subscriptions and no duplicated VPN chapter rows in the ordinary queue.
- [ ] Run RED using the existing `VpnDownloadSettings`, `VpnDownloadRanges`, `VpnDownloadMarkup` and new Tasks integration suites.
- [ ] Implement with existing Mantine/modal/settings primitives. Use one dialog, sensible focus return and existing responsive tokens. Default challenge behavior is next-profile; keep an explicit pause option in the optional controls. Render preparation and work status even when no native worker has been allocated yet.
- [ ] Integrate request cancellation and run controls with Tasks' existing pause/cancel actions; do not leave an invisible background VPN run alive after Cancel all. Keep unrelated task groups visible and usable.
- [ ] Run focused UI/i18n tests and `pnpm tsc`. Inspect the actual Y700 screen at its current scale, plus a narrow layout, and verify no clipped controls or duplicate queues. No new breakpoint conventions or fixed-pixel scaling workaround.

### Task 7: Verify the combined change, review and deliver scoped commits

**Files:** `docs/test-support/automatic-vpn-download-queue.md`, the two approved design/plan documents and the explicit changed-path manifest under `.tmp/y700-download-debug-20261103/`.

- [ ] Refresh the clean-base candidate with only this feature's explicit paths/hunks, excluding logging and the separate staged library fix. Run full `pnpm test` and `pnpm tsc`; run relevant Rust queue/VPN/device-backup tests and the complete focused JVM VPN policy suite. Preserve actual exit codes and failures.
- [ ] Run applicable Norea verification skills for data access, plugin fetch, IPC/structured types, storage/release compatibility, interaction/i18n and responsive/scaled UI changes. Review findings before making scoped corrections. Do not run unrelated verification/fixer agents automatically.
- [ ] Build only the Y700 `aarch64` APK from the feature candidate. Recheck signer, request preservation, shipping application ID and the absence of unrelated logging/temporary instrumentation in the production candidate before installation.
- [ ] On Y700, test the originally delayed newly added work; compare restored work admission, ordinary count three and VPN counts above two. Exercise configured limits 1, 3 and 10 where approved profile/network supply permits, including slot 9. Record actual simultaneous live workers separately from merely queued/configured work. Document any unmet ten-connection acceptance instead of claiming it from mocks.
- [ ] Exercise same-chapter recovery, busy-profile wakeup, offline/online, pause/resume/cancel, cancellation during preparation, app restart and preserved downloaded/read/library state. Confirm that Start requires no settings edits and no per-work VPN setup is visible.
- [ ] Obtain a fresh read-only review of this feature's full diff and resolve confirmed findings. Reviewers must not absorb or edit the pre-existing logging/library work. Repeat affected checks after fixes.
- [ ] Update the verification document with actual results and limits. Inspect `git diff --check` and exact staged contents. Prepare separate native ownership, native worker, frontend runtime/concurrency and frontend UI commits as appropriate; do not split behavioral changes into formatting-only noise or bypass hooks.
- [ ] Commit only verified feature paths/hunks with the required `<type>(<module>): <imperative summary>` format. Preserve the user's unrelated index. Push `0.2` only under the execution approval; a non-fast-forward rejection stops the push and requires user guidance.
- [ ] Confirm commit IDs and remote result, list affected files/line anchors in the Korean conclusion and save confirmed decisions plus one concise handoff. Unresolved Y700/signing/network acceptance must remain visible, not be marked complete.

## Self-review

All specification sections map to Tasks 1 through 7. Each task has a focused
RED/GREEN loop or a concrete diagnostic/delivery gate. Interfaces retain the
canonical batch/job/worker contracts; `vpnBatchId` is pending routing and never
replaces enrolled plan/range identity. Raw stored JSON is used for ownership CAS.
The five review-focus conditions have explicit owning regression steps. Self-review
also clarified that ordinary materialization includes durable queue admission and
that one in-flight chapter cannot block ready transfers for unrelated work.

## Execution status

The user approved inline execution, tests/builds, matching-signer updates and scoped
commits/push. Tasks 2 through 6, clean-candidate verification and the independent
review's behavioral fix pass are complete. The user later selected Waydroid for
acceptance and deferred Y700. The final x86_64 APK passed the documented Waydroid
smoke checks without an uninstall or data reset. Original Y700 timing and actual
three/ten-tunnel overlap remain unverified. See
`docs/test-support/automatic-vpn-download-queue.md` for results and limits.
