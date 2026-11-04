# Waydroid Task Notification Verification

Date: 2026-11-01. Device: local Waydroid, Android 13, x86_64.

## Build and isolation

The tested APK used the current app implementation with a temporary Vite
transform exposing the real scheduler, plugin, storage, and database modules
to the app WebView debugger. Two installed API 0.2 fixture plugins used the
normal plugin fetch and chapter acquisition paths against a local HTTP server.

- Package: `io.github.tinywind.norea.qa20261101notifications.debug`.
- Storage: `Documents/NoreaQANotifications20261101`, selected through Android's
  folder picker.
- Build: `pnpm exec tauri android build --apk --debug --target x86_64` with a
  temporary QA configuration.
- APK SHA-256:
  `eaf095b6d19014c93f280e5137c7fabd89e6c2e6af927265ba0a4ebf842966cb`.

The temporary package override, module exposure, and loopback-only HTTP
exception were removed from the worktree configuration after testing. Existing
Waydroid app packages, their data, and the Y700 devices were preserved.

## Device acceptance results

| Scenario | Observed result |
| --- | --- |
| Concurrent chapter downloads and metadata refreshes | Separate native cards: downloads ID 1101 and metadata ID 1102, each with its own action. Android may bundle multiple cards under the app's expandable system group. |
| Pause metadata from its native card | Only `libraryMetadata` paused; chapter downloads continued and wrote additional files. |
| Pause downloads, then resume metadata | Only `downloads` remained paused; a metadata source task ran while download tasks stayed queued. |
| Resume downloads | Both group pause flags cleared and work continued without discarding jobs. |
| Tap a task notification body | The app moved from the library route to `/tasks`. |
| Two blocked plugins on the same host | Cloudflare and CAPTCHA fixture responses created separate native identities: `(source/qa-notification-a, 1201)` and `(source/qa-notification-b, 1201)`. |
| Progress notifications off | Verification cards remained available; the required execution anchor used quiet ID 1001. |
| Tap source A while the app is in the background | The app entered the foreground on `/tasks` and opened A's browser profile at its protected chapter URL. |
| Complete A's verification and confirm the source request | Only A's block and native verification card disappeared. B's block and card remained. |
| Cold source B notification action | After stopping the QA execution service, backgrounding the app, and using `am kill`, the old process was absent. The retained notification's verification action launched a new process and opened B's protected chapter WebView. |
| Source browser session isolation | B still displayed its challenge after A had been verified on the same host. |
| Complete B's verification and confirm the source request | B's block and verification card disappeared, and its chapter download completed. |
| Metadata HTTP 500 in completion-only mode | The task failed and the native result reported total 1, succeeded 0, failed 1, cancelled 0. No progress card remained. |
| All source work waiting for verification | The QA foreground service held no active partial wake lock. |

Final storage inspection found 33 downloaded chapters for A and one for B.
Both protected chapter 33 files existed as 3,326-byte `content.html` files in
their respective plugin/work directories. The final scheduler had no running
or queued tasks and no source-access blocks. Its one failed record came from
the intentional metadata HTTP 500 check.

Verification used local challenge fixtures and an actual browser-cookie round
trip. External Cloudflare services, physical-device VPN behavior, battery
consumption, and Android 15+ foreground-service quota expiry were outside this
device run.

## Automated checks and review

- TypeScript type check passed.
- Vitest: 178 files, 2,124 tests passed.
- Android JVM: 122 tests passed.
- Rust notification model: 10 tests passed on the Waydroid x86_64 runner.
- Scoped integration review: nine applicable verifiers passed.
- `git diff --check` passed.

Regression coverage includes a restored queue whose verification source is the
1,035th job, a running local-file check before a verification candidate becomes
queued, stale source revisions, rapid source switches during URL reconstruction,
failed native publication retries, overlapping completion waves, mixed batch
outcomes, and progress updates without rescanning task history.

Windows notification payload/XML models and action routing have automated
coverage. Windows-only bindings and installed Windows notification behavior
require validation on Windows. Pause/resume actions use the running process;
body and source-verification actions use the existing registered `norea` URI
scheme.

The existing five-second global toast design and backup completion/failure
toast lifetime were preserved as requested. Error ownership and duplicate
suppression were updated independently of those presentation choices.

## Affected files

| File | First affected line |
| --- | --- |
| [`src-tauri/gen/android/app/src/main/AndroidManifest.xml`](../../src-tauri/gen/android/app/src/main/AndroidManifest.xml#L88) | 88 |
| [`src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidAppBridges.kt`](../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidAppBridges.kt#L77) | 77 |
| [`src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidTaskNotificationActions.kt`](../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidTaskNotificationActions.kt#L1) | 1 |
| [`src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidTaskNotifications.kt`](../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidTaskNotifications.kt#L1) | 1 |
| [`src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/MainActivity.kt`](../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/MainActivity.kt#L45) | 45 |
| [`src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/TaskForegroundService.kt`](../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/TaskForegroundService.kt#L4) | 4 |
| [`src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/TaskNotificationState.kt`](../../src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/TaskNotificationState.kt#L1) | 1 |
| [`src-tauri/gen/android/app/src/test/java/io/github/tinywind/norea/TaskNotificationStateTest.kt`](../../src-tauri/gen/android/app/src/test/java/io/github/tinywind/norea/TaskNotificationStateTest.kt#L1) | 1 |
| [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs#L102) | 102 |
| [`src-tauri/src/task_notifications.rs`](../../src-tauri/src/task_notifications.rs#L2) | 2 |
| [`src/components/ContentServerBrowse.tsx`](../../src/components/ContentServerBrowse.tsx#L32) | 32 |
| [`src/components/LibrarySettingsPanel.tsx`](../../src/components/LibrarySettingsPanel.tsx#L27) | 27 |
| [`src/components/PluginVpnFinder.tsx`](../../src/components/PluginVpnFinder.tsx#L192) | 192 |
| [`src/components/ReadingStateSettings.tsx`](../../src/components/ReadingStateSettings.tsx#L19) | 19 |
| [`src/components/TaskNotifications.test.ts`](../../src/components/TaskNotifications.test.ts#L10) | 10 |
| [`src/components/TaskNotifications.tsx`](../../src/components/TaskNotifications.tsx#L1) | 1 |
| [`src/components/WindowsTaskNotificationBridge.test.ts`](../../src/components/WindowsTaskNotificationBridge.test.ts#L1) | 1 |
| [`src/components/WindowsTaskNotificationBridge.tsx`](../../src/components/WindowsTaskNotificationBridge.tsx#L3) | 3 |
| [`src/components/library/LibraryCategoryDialogs.tsx`](../../src/components/library/LibraryCategoryDialogs.tsx#L51) | 51 |
| [`src/components/library/LibraryLocalImport.tsx`](../../src/components/library/LibraryLocalImport.tsx#L64) | 64 |
| [`src/components/library/use-library-query.ts`](../../src/components/library/use-library-query.ts#L62) | 62 |
| [`src/components/library/use-library-selection.ts`](../../src/components/library/use-library-selection.ts#L1) | 1 |
| [`src/components/novel/NovelCategoryEditor.tsx`](../../src/components/novel/NovelCategoryEditor.tsx#L28) | 28 |
| [`src/components/novel/ServerChapterManager.tsx`](../../src/components/novel/ServerChapterManager.tsx#L56) | 56 |
| [`src/components/novel/use-local-novel-editor.tsx`](../../src/components/novel/use-local-novel-editor.tsx#L89) | 89 |
| [`src/components/novel/use-novel-chapter-actions.tsx`](../../src/components/novel/use-novel-chapter-actions.tsx#L1) | 1 |
| [`src/components/novel/use-novel-metadata.ts`](../../src/components/novel/use-novel-metadata.ts#L170) | 170 |
| [`src/lib/deep-link.test.ts`](../../src/lib/deep-link.test.ts#L1) | 1 |
| [`src/lib/deep-link.ts`](../../src/lib/deep-link.ts#L1) | 1 |
| [`src/lib/runtime/error-toast.test.ts`](../../src/lib/runtime/error-toast.test.ts#L1) | 1 |
| [`src/lib/runtime/error-toast.ts`](../../src/lib/runtime/error-toast.ts#L4) | 4 |
| [`src/lib/tasks/android-notification-groups.test.ts`](../../src/lib/tasks/android-notification-groups.test.ts#L1) | 1 |
| [`src/lib/tasks/android-notifications.test.ts`](../../src/lib/tasks/android-notifications.test.ts#L60) | 60 |
| [`src/lib/tasks/android-notifications.ts`](../../src/lib/tasks/android-notifications.ts#L4) | 4 |
| [`src/lib/tasks/chapter-download.test.ts`](../../src/lib/tasks/chapter-download.test.ts#L141) | 141 |
| [`src/lib/tasks/chapter-download.ts`](../../src/lib/tasks/chapter-download.ts#L143) | 143 |
| [`src/lib/tasks/native-notification-actions.ts`](../../src/lib/tasks/native-notification-actions.ts#L1) | 1 |
| [`src/lib/tasks/scheduler-group-pause.test.ts`](../../src/lib/tasks/scheduler-group-pause.test.ts#L1) | 1 |
| [`src/lib/tasks/scheduler.ts`](../../src/lib/tasks/scheduler.ts#L67) | 67 |
| [`src/lib/tasks/source-access-browser.test.ts`](../../src/lib/tasks/source-access-browser.test.ts#L1) | 1 |
| [`src/lib/tasks/source-access-coordinator.ts`](../../src/lib/tasks/source-access-coordinator.ts#L37) | 37 |
| [`src/lib/tasks/source-access-notifications.test.ts`](../../src/lib/tasks/source-access-notifications.test.ts#L1) | 1 |
| [`src/lib/tasks/source-access-notifications.ts`](../../src/lib/tasks/source-access-notifications.ts#L1) | 1 |
| [`src/lib/tasks/task-notification-actions.test.ts`](../../src/lib/tasks/task-notification-actions.test.ts#L1) | 1 |
| [`src/lib/tasks/task-notification-actions.ts`](../../src/lib/tasks/task-notification-actions.ts#L1) | 1 |
| [`src/lib/tasks/task-notification-model.test.ts`](../../src/lib/tasks/task-notification-model.test.ts#L1) | 1 |
| [`src/lib/tasks/task-notification-model.ts`](../../src/lib/tasks/task-notification-model.ts#L2) | 2 |
| [`src/lib/tasks/task-types.ts`](../../src/lib/tasks/task-types.ts#L6) | 6 |
| [`src/lib/tasks/tray-progress.test.ts`](../../src/lib/tasks/tray-progress.test.ts#L1) | 1 |
| [`src/lib/tasks/tray-progress.ts`](../../src/lib/tasks/tray-progress.ts#L4) | 4 |
| [`src/main.tsx`](../../src/main.tsx#L10) | 10 |
| [`src/routes/__root.tsx`](../../src/routes/__root.tsx#L1) | 1 |
| [`src/routes/browse.tsx`](../../src/routes/browse.tsx#L302) | 302 |
| [`src/routes/downloads.tsx`](../../src/routes/downloads.tsx#L8) | 8 |
| [`src/routes/history.tsx`](../../src/routes/history.tsx#L789) | 789 |
| [`src/routes/library.tsx`](../../src/routes/library.tsx#L206) | 206 |
| [`src/routes/novel-merge.tsx`](../../src/routes/novel-merge.tsx#L528) | 528 |
| [`src/routes/novel.tsx`](../../src/routes/novel.tsx#L90) | 90 |
| [`src/routes/reader.tsx`](../../src/routes/reader.tsx#L51) | 51 |
| [`src/routes/settings.tsx`](../../src/routes/settings.tsx#L397) | 397 |
| [`src/routes/source.tsx`](../../src/routes/source.tsx#L246) | 246 |
| [`src/routes/updates.tsx`](../../src/routes/updates.tsx#L518) | 518 |
| [`strings/languages/en/app.json`](../../strings/languages/en/app.json#L219) | 219 |
| [`strings/languages/ko/app.json`](../../strings/languages/ko/app.json#L219) | 219 |
| [`waydroid-task-notifications-20261101.md`](waydroid-task-notifications-20261101.md#L1) | 1 |
