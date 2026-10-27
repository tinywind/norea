# Android library storage state verification — 2026-10-27

## Scope

Fix the stored-chapter percentage and durable repair-filter membership for chapters whose body exists but whose media package is incomplete. Verification covered the affected Newtoki Webtoon work (`sourceNovelId: 54097394`, local novel ID `107`) on a Lenovo Y700 TB322FC running Android 16. The preceding download-queue and source-challenge investigation was not repeated as a device test.

## Cause and change

Whole-work discovery considered only `content.pdf` and `content.html`. A nonempty `.chapter-content.partial` body was therefore absent from a work scan, even though the single-chapter inspector understood it. Reconciliation could then clear that chapter's cached size and repair state as if its files were missing. The discovered-chapter DTO also omitted inspected body and archive sizes, so reconciliation did not restore those sizes for an incomplete chapter.

Rust filesystem and Android document-provider discovery now include nonempty partial bodies after published PDF and HTML candidates. TypeScript accepts that filename and carries inspected sizes through to bounded database updates and inserts. The existing download-revision guards, published-file precedence, and distinction between stored bodies and complete media packages remain intact. No schema migration or on-disk format change is required.

The existing stored-chapter predicate still uses a downloaded package or a positive body size. Repair flags alone do not count a missing chapter as stored. No percentage rounding workaround was added.

## Baseline evidence

The work contained 395 chapter bodies, but the library displayed 99% stored. Chapters 155 and 285 had zero cached body bytes despite nonempty partial bodies and existing media archives. Two other incomplete chapters already had positive cached body sizes.

| Chapter | Body bytes before | Body bytes after | Media archive bytes after | Complete media package |
| --- | ---: | ---: | ---: | --- |
| 155 | 0 | 67,531 | 5,632,294 | No |
| 285 | 0 | 65,356 | 20,446,135 | No |
| 337 | 79,519 | 79,519 | 27,798,279 | No |
| 352 | 52,428 | 52,428 | 16,995,643 | No |

The pre-update cold-start sample retained the seven currently known repair-filter entries. It did not establish an unconditional startup reset. The scan path that loses partial-only state was reproduced in focused regression fixtures, and restart persistence was verified after correcting that state.

## Automated verification

- Five new TypeScript regression cases failed before the implementation and passed afterward. They cover work and synchronization scans, published incomplete bodies, partial-only bodies, fresh recovery inserts, and measured size persistence.
- The restart cases save and close an actual SQLite database, reopen it, initialize metadata with zero chapter scans, and query the library repair filter and stored counts. Completing the missing media subsequently removes the repair entry.
- Existing concurrency coverage now checks that a newer repair's measured sizes survive a stale scan. The 1,000-chapter case verifies distinct sizes while retaining ten batched update statements.
- Four related TypeScript test files passed: **145 tests** in total. TypeScript type checking passed.
- The new native discovery test passed on the Y700: **1 passed**, with all other native tests filtered out. It covers partial-only discovery, published-file precedence, empty partial exclusion, skipped directories, and unchanged source bodies.

## Signed build and Y700 acceptance

The APK was built locally on the project PC with the repository's release signing identity and installed over the existing application with `adb install -r --no-incremental`. Installation succeeded without uninstalling or resetting application data.

- Package: `io.github.tinywind.norea`
- Version: `0.2.0` / `2000`
- ABI: `arm64-v8a` only
- APK size: `19,540,918` bytes
- APK SHA-256: `0c848174e8fd029b4defabd146bde6e375e4eec5d881853ab4dbe6145e1034c3`
- Signing certificate SHA-256: `d6792257d0d2aba0f7c75941d3c7ab971172752dc677a4951fc52ebb7d16c89f`

The installed application's prior certificate and the new APK certificate matched. Signing material and private device backups are not part of the repository.

1. Opened the affected work once to reconcile its existing stale cache. Its chapter list reported **395 total / 395 cached**.
2. Returned to the library. The affected work displayed **100% stored** and remained in the repair-needed filter.
3. Force-stopped the application, verified that its process exited, and launched a new process. The process ID changed from `19990` to `21938` at `2026-10-27T14:50:40Z`.
4. Without opening any work or starting another chapter scan, the library still displayed the affected work as **100% stored** in the repair-needed filter. The Reading category retained its five entries and All retained its seven entries.
5. Exported a fresh backup after restart. It retained **118 works and 54,302 chapters**. Novel metadata, chapter identities and reading state, category assignments, repositories, and installed plugins matched the pre-update backup. Measured storage sizes were reconciled; two chapter update timestamps also advanced.
6. The original partial bodies, manifests, and media archives for chapters 155 and 285 retained identical SHA-256 hashes across all six files.

Missing media remained incomplete throughout acceptance. No target chapter body or archive was replaced to make the percentage reach 100%.
