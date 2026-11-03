# Library filtering during content synchronization

Date: 2026-11-03. Scope: library presentation queries and metadata notifications.

## Cause and correction

Library filtering, summaries, source filters and category counts used the same
serialized SQLite connection as synchronization writes. Those writes retain
their queue slot while publishing metadata to storage. Changing a filter could
therefore leave the library waiting for unrelated storage work. The inspected
Android snapshot/install and Rust upload paths already use worker executors.

The library now requests the existing read-only WAL connection, which returns
the last committed data while a write is pending. Query helpers retain queued
reads by default. Mutation target selection, write preconditions and transactions
keep their existing serialized ordering. No schema or storage format changes.

Metadata-change notifications inside the existing rollback/publication scope
are delivered after that scope succeeds, including its database commit. Failed
scopes discard their pending notifications. This prevents a committed reader
from caching an early pre-commit invalidation without a later refresh.

## Regression verification

A real SQLite WAL test holds an uncommitted title change while running the
actual query functions registered by the library hook. Before the fix, both
commit and rollback cases exceeded the one-second test deadline. After the fix,
the page and all panels return committed data while mutation selection remains
queued. After release, the queued selection and a subsequent page query observe
the correct committed or rolled-back result.

Two additional tests verify notification delivery after success and suppression
after rollback. Existing synchronization, storage recovery and metadata tests
also pass: 254 tests in the focused publication/recovery/sync run.

The worktree contains an unrelated, unfinished logging feature. Verification of
this fix alone used a temporary archive of HEAD `3848a40` with only the nine
source/test files listed below overlaid. That candidate passed all 204 test
files / 2,586 tests and `pnpm tsc`. The combined worktree passed 205 files /
2,593 tests. The separate logging changes are excluded from this fix's commit.

## Waydroid measurement

An isolated x86_64 QA APK ran on Waydroid API 33 at `192.168.240.112:5555`,
package `io.github.tinywind.norea.qaperf20261103.debug`. It used a new granted
SAF folder, `Documents/NoreaLibraryLatency20261103`, and one owned work/chapter.
Production app data and Y700 were not used.

Temporary Vite-only exports call the real database and query functions after
the normal bootstrap fence. A transaction changes the title, holds for two
seconds, then rolls back. The old queued read mode and the fixed committed
mode are compared in the same APK with identical data.

| Measurement | Result |
| --- | --- |
| Queued page/summary/category control | 2,021.9 ms |
| Committed page/summary/category group | 4.9 ms |
| Actual library filter query readiness | 263.9 ms |
| Filtered library DOM displayed, including the 200 ms search debounce | 288.8 ms |
| Queued control still pending when the filtered view appeared | Yes |
| Committed title visible; uncommitted title absent | Yes |
| 20 ms timer callbacks during the held write | 100 |
| Observed main-thread tasks over 50 ms during this measurement | 0 |

This is a controlled queue-contention test with a small fixture, not a full
server-upload throughput benchmark or an input-to-photon measurement. It does
not establish that all large-library rendering or transfer-related stalls are
eliminated. The event loop remained responsive in this reproduced case.

APK SHA-256: `0b998af50f9e9849f769b2a577b8ba8b3ae20e98fe183b9c321cca7fef94bb75`.
Build: `pnpm exec tauri android build --apk --debug --split-per-abi --target x86_64`
with the temporary QA configuration. This APK includes the current unrelated
logging work; the clean-base candidate tests separately verify the fix without it.
The temporary package ID and debugger exports are not committed.

Evidence is under `.tmp/content-sync-ui-latency-20261103/`; command logs are
under `.tmp/local-logs-20261102/library-*.log`. The first incomplete seed and
unsupported raw Android storage setup were rejected and excluded from the
measurement. The final fixture has a valid source-owned identity and a real
persisted SAF grant. An initial query-ready snapshot preceded React's DOM
update; the final measurement explicitly waits for the filtered DOM while the
writer is still held.

## Affected files

| File | First affected line |
| --- | --- |
| `src/components/library/use-library-query.ts` | 80 |
| `src/db/queries/novel.ts` | 444 |
| `src/db/queries/category.ts` | 1 |
| `src/db/client-readonly.test.ts` | 7 |
| `src/lib/work-metadata.ts` | 30 |
| `src/lib/work-metadata-publication.test.ts` | 1 |
| `src/components/ChapterCleanupPanel.tsx` | 53 |
| `src/components/LibrarySettingsPanel.tsx` | 29 |
| `src/components/novel/NovelCategoryEditor.tsx` | 30 |
| `docs/test-support/library-sync-query-latency.md` | 1 |
