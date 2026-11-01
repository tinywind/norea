# Waydroid UI Latency Verification

Date: 2026-11-01. Device: local Waydroid, Android 13, x86_64.

## Changes

Scheduler transitions and successive batches now defer full snapshot rebuilding
until the next frame. Explicit reads still return current state. A 100 ms timer
publishes pending state if a hidden WebView stops producing animation frames;
the first callback cancels the other callback.

Metadata publications identify the affected work. Detail and chapter query
invalidation follows that identity. Hidden novel pages suspend their queries
and download subscriptions, then catch up when activated. Download status
initialization reads only the current novel's chapter IDs.

Reader detail, novel, chapter list, and stored-content metadata reads use the
committed read connection. If inspected content artifacts match committed
metadata, reading does not enqueue a redundant metadata write. Missing files,
changed asset completeness, and other mismatches retain reconciliation through
the writer queue. The persisted schema is unchanged.

## Device setup

The baseline was the previously installed notification QA APK built from
`734237f6f9e02962a17d70d50b29cae204f9f349`. The final APK used the current
implementation with temporary debugger exports of the real app modules.
Both used package `io.github.tinywind.norea.qa20261101notifications.debug`
and the existing `Documents/NoreaQANotifications20261101` storage tree.
Existing production app data and physical Y700 devices were preserved.

Two API 0.2 fixture plugins used normal plugin fetch, page acquisition,
SQLite, and Android folder storage paths. A local server returned 64 chapters
per work with a 1.5-second response delay. The final QA configuration allowed
HTTP only for loopback and the app's local origin. An intermediate run failed
because that temporary exception was missing; its measurements were discarded.
A manifest merger conflict in the temporary exception was corrected before the
successful final build.

Build command: `pnpm exec tauri android build --apk --debug --target x86_64`
with a temporary QA configuration. Final APK SHA-256:
`0ea6b5cff3a6e6414a69d3be8c77d221301a410c6c23f6fbe9420c3abcc620e3`.
The package override, debugger exports, and network exception are not committed.

## Measurements

| Check | Baseline | Final APK |
| --- | --- | --- |
| Isolated scheduler: enqueue 2,000 paused jobs in batches of 16 | 125 full rebuilds; 76.2 ms enqueue loop | Zero eager rebuilds; one explicit-read rebuild; 46.3 ms enqueue loop |
| Eight real chapter downloads alongside four full metadata refreshes | 8 downloads and 4 refreshes succeeded | 8 downloads and 4 refreshes succeeded |
| 24 alternating novel, task, and reader route transitions during that work | Median 65.9 ms; maximum 100.4 ms | Median 65.9 ms; maximum 84.6 ms |
| Main-thread long tasks in the concurrent flow | 6, maximum 67 ms | 5, maximum 76 ms |
| Frame intervals in the concurrent flow | 95th percentile 33.4 ms | 95th percentile 33.4 ms |

The scheduler benchmark used a separate instance of the installed production
scheduler class. It measures queue bookkeeping, not network speed. The route
measurement includes navigation and two animation frames; it is not an
input-to-photon measurement. These single-run fixture results establish reduced
queue work and functional behavior, not a general frame-rate improvement.

With a real SQLite write transaction held for two seconds, the final reader
loaded the unchanged 3,326-character stored body in 30.9 ms. The writer and a
queued control read were still pending when it finished. Both completed after
the transaction was released, at approximately 2,004 ms.

After opening both novel pages, publishing a change for the hidden work caused
zero detail fetches while marking its cached chapter query stale. Returning to
that work fetched its detail and chapter list once each and cleared the stale
state. The unrelated visible work was not refetched.

## Background and interaction checks

An additional eight-chapter batch continued after Android Home hid the app.
Pausing downloads while it was hidden updated native notification ID 1101 to
its paused state, showing five of eight completed chapters. Tapping the native notification's resume button cleared the group pause and
started the remaining three jobs while the app remained hidden. All eight
chapters completed with zero failures or cancellations; native notification
1202 reported the same result and the scheduler returned to zero active jobs.

## Automated verification

- TypeScript type check passed.
- Vitest: 179 files and 2,140 tests passed.
- Regression coverage includes held animation frames, frame/timer cancellation,
  batched snapshot rebuild counts, hidden page catch-up, scoped invalidation,
  incomplete stored content, and real SQLite WAL reads during a pending write.
- Independent review covered UI interaction, frontend contracts, storage schema,
  QA data isolation, English policy, data access, layer boundaries, error handling,
  and release compatibility. The held-frame publication issue found in review
  was fixed and re-reviewed.

## Limits

Artifact inspection still performs native storage I/O. A reader that must repair
missing or mismatched metadata can still wait for the writer. Large source HTML
parsing and native notification reconstruction were not moved to other threads.
The small fixture did not reproduce every physical-device workload or establish
that all frame stalls are eliminated. Existing pre-commit metadata publication
timing remains unchanged; source refresh also publishes after its transaction.
Toast design and completion/failure toast lifetime were preserved.

## Affected files

| File | First affected line |
| --- | --- |
| [docs/test-support/waydroid-ui-latency-20261101.md](../../docs/test-support/waydroid-ui-latency-20261101.md#L1) | 1 |
| [src/components/novel/use-novel-download-statuses.test.ts](../../src/components/novel/use-novel-download-statuses.test.ts#L6) | 6 |
| [src/components/novel/use-novel-download-statuses.ts](../../src/components/novel/use-novel-download-statuses.ts#L4) | 4 |
| [src/components/runtime/StorageRecovery.test.tsx](../../src/components/runtime/StorageRecovery.test.tsx#L8) | 8 |
| [src/components/runtime/StorageRecovery.tsx](../../src/components/runtime/StorageRecovery.tsx#L5) | 5 |
| [src/db/client-readonly.test.ts](../../src/db/client-readonly.test.ts#L57) | 57 |
| [src/db/queries/chapter.ts](../../src/db/queries/chapter.ts#L191) | 191 |
| [src/db/work-metadata.ts](../../src/db/work-metadata.ts#L552) | 552 |
| [src/lib/chapter-content-storage.test.ts](../../src/lib/chapter-content-storage.test.ts#L9) | 9 |
| [src/lib/chapter-content-storage.ts](../../src/lib/chapter-content-storage.ts#L1) | 1 |
| [src/lib/plugins/sync-novel.test.ts](../../src/lib/plugins/sync-novel.test.ts#L174) | 174 |
| [src/lib/plugins/sync-novel.ts](../../src/lib/plugins/sync-novel.ts#L409) | 409 |
| [src/lib/reader-chapter.test.ts](../../src/lib/reader-chapter.test.ts#L62) | 62 |
| [src/lib/reader-chapter.ts](../../src/lib/reader-chapter.ts#L40) | 40 |
| [src/lib/tasks/scheduler-snapshot.test.ts](../../src/lib/tasks/scheduler-snapshot.test.ts#L1) | 1 |
| [src/lib/tasks/scheduler.test.ts](../../src/lib/tasks/scheduler.test.ts#L669) | 669 |
| [src/lib/tasks/scheduler.ts](../../src/lib/tasks/scheduler.ts#L92) | 92 |
| [src/lib/work-metadata.ts](../../src/lib/work-metadata.ts#L26) | 26 |
| [src/routes/novel.test.tsx](../../src/routes/novel.test.tsx#L51) | 51 |
| [src/routes/novel.tsx](../../src/routes/novel.tsx#L61) | 61 |
| [src/routes/reader.tsx](../../src/routes/reader.tsx#L60) | 60 |
