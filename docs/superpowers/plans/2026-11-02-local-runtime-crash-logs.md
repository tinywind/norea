# Local Runtime and Crash Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist bounded, level-filtered operational logs and independent crash reports in the user's Norea folder, with writable fallback destinations.

**Architecture:** Keep platform-native file storage: Kotlin owns Android SAF, MediaStore, lifecycle and cross-process coordination; Rust owns Windows filesystem output. Reuse the existing logging entry points and frontend setting, install crash capture before normal initialization, and preserve the restore startup fence.

**Tech Stack:** Existing Tauri 2.12.5, tauri-plugin-log 2.10.1/its exported fern API, Rust log/serde, Kotlin/Android SDK 36 and existing AndroidX test dependencies. Use regex 1.13.1, already present transitively in Cargo.lock, as a direct Rust dependency for bounded text redaction; do not upgrade unrelated dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-local-runtime-crash-logs-design.md`

## Global constraints

- Runtime files and crash files each have an independent limit of 1,048,576 bytes per file and ten retained files, including the active runtime file.
- Prefer selected storage `logs/`, then public Downloads/Norea/logs, then app/OS temporary logs. Honor SAF and MediaStore ownership; never reset the selected root.
- Preserve `trace`, `debug`, `info`, `warn`, `error`, `off`; crashes remain enabled at `off`.
- Windows and Android only. Use Waydroid at its verified ADB address for device tests; do not use Y700. Build only x86_64 for these checks.
- Preserve the repository's `0.2` branch rule; do not create or switch to another working branch without user direction.
- No new Tauri plugin, remote telemetry, production crash control, schema migration or backup-format change.
- Use English outside locale JSON files, preserve managed-path link checks and the pre-SQL restore fence, and never import persisted frontend stores from the early crash module.
- Put generated outputs and harnesses under `.tmp/local-logs-20261102/`; retain regression tests in the source tree.
- Do not commit partial feature work. After all checks, split native/backend and frontend changes into coherent commits, then push `0.2`; this preserves the user's requested development/test-before-commit order.
- Use the environment in `docs/development.md`: Node 24, pnpm 10.27.0, JDK 17, SDK/build tools 36 and NDK 29.0.14206865.

## Review focus

1. Primary storage disappears during append/rotation: preserve existing files and retry in a writable destination (Tasks 1, 2, 7).
2. A persisted `off` level or concurrent level change: queued/worker/startup traffic must not bypass the current native filter (Tasks 3, 4, 7).
3. Concurrent worker writes, restart and clock rollback: preserve creation order, count the active file, and never overwrite reports (Tasks 1, 2, 7).
4. Panic during runtime logging or an unresponsive provider: fatal reporting must not wait indefinitely on the runtime queue/lock or swallow default termination (Tasks 3, 4, 7).
5. Huge/malformed native traces and credential-bearing messages: keep reports bounded, exclude raw memory and clearly label unavailable evidence (Tasks 1, 5, 6).

## File boundaries

Android main sources are under `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/`:

- `AppLogPolicy.kt`: levels/categories, metadata, bounded UTF-8 formatting and redaction.
- `AppLogFiles.kt`: rotation, creation order, ownership and retention using log-specific destinations.
- `AndroidLogDestinations.kt`: selected SAF/raw root, app-owned MediaStore Downloads and private temporary adapters.
- `AndroidAppLogging.kt`: installed application state, native level mirror, bounded runtime worker and synchronous crash path.
- `AppLog.kt`: adapter for the app's existing Android Log calls, preserving explicit verbose-tag checks.
- `AndroidCrashReports.kt`: uncaught Java exceptions and previous-process recovery.
- `AndroidNativeCrashTrace.kt`: bounded extraction of non-memory tombstone diagnostics.
- `AndroidAppLoggingBridge.kt`: kept JNI bridge methods, with no general filesystem authority exposed to JS.
- `NoreaApplication.kt`: application-level installation before activity startup.

Rust:

- `src-tauri/src/app_logging.rs`: logger installation, levels, metadata, panic hook and frontend-crash command.
- `src-tauri/src/app_logging/files.rs`: portable filesystem store used by Windows and real-file unit tests.
- `src-tauri/src/app_logging/android.rs`: JNI forwarding through the registered JavaVM/class.
- `src-tauri/src/app_logging/redaction.rs`: bounded redaction shared by Rust runtime/crash output.
- `src-tauri/src/lib.rs`: delegate existing commands, register the crash command and initialize logging before fallible startup work.

Frontend: `src/lib/runtime-crash.ts` and its test, plus `src/bootstrap.ts`/its test. Keep `src/lib/logging.ts` and `src/store/logging.ts` wire/settings compatibility.

Test-only Android components belong under `src/debug/` or `src/androidTest/`, never main application classes. Verification documentation belongs in `docs/test-support/local-runtime-crash-logs.md`.

Kotlin unit tests live under `src-tauri/gen/android/app/src/test/java/io/github/tinywind/norea/`. The shorter `src/debug/` and `src/androidTest/` paths in this plan are relative to `src-tauri/gen/android/app/`.

## Verification harness contracts

Create these temporary harnesses when their first owning test task needs them:

- `jvm-tests.sh [Gradle test filters]`: export the documented JDK/SDK/NDK and Node environment, then run `:app:testX86_64DebugUnitTest` from `src-tauri/gen/android`.
- `native-tests.sh [Rust test filters]`: follow the existing `.tmp/vpn-profile-workers/native-tests.sh` x86_64 build/push/run flow, but use this feature's evidence and device-temporary directories. Always pass the verified Waydroid serial.
- `build-qa.py [--android-test]`: assert that a preceding narrow patch has changed Gradle's application ID to `io.github.tinywind.norea.qalogs20261102`, then invoke the single-target Tauri debug build and optionally `:app:assembleX86_64DebugAndroidTest`. The helper must not rewrite source files or identifiers itself. Use a temporary Tauri configuration changing only the frontend output location. Restore the application ID with a narrow patch after packaging and verify no shipping-ID diff remains.
- `device-tests.py [--class TestClassOrMethod]`: inspect APK identities, install only the QA/test APKs on Waydroid, run their AndroidJUnitRunner manually, save output and fail on test/instrumentation failures even when the ADB command itself exits zero. Never invoke an unfiltered connected-device Gradle task.

QA application code retains its original Java/JNI namespace. Derive launch/test components from APK metadata rather than assuming that their class names follow the temporary application ID.

### Task 1: Bounded log policy and rotation

**Files:** Create `AppLogPolicy.kt`, `AppLogFiles.kt`; create `AppLogPolicyTest.kt` and `AppLogFilesTest.kt` in the existing Kotlin unit-test package.

**Interfaces:** Define `AppLogCategory { RUNTIME, CRASH }`, `AppLogLevel` with the six existing string values, and `AppLogIdentity(applicationId: String, version: String, platform: String, processId: Int, processName: String)`. Define `AppRuntimeRecord(level: AppLogLevel, target: String, thread: String, message: String, utcMillis: Long)` and `AppLogFile(id: String, name: String, sequence: Long, sizeBytes: Long)`.

`AppLogDestination` exposes `key: String`, `files(category): List<AppLogFile>`, `create(category, sequence): AppLogFile`, `append(file, bytes: ByteArray, flush: Boolean): Unit`, and `delete(file): Boolean`. Implement `AppLogFiles(namespace: String, stateDirectory: File, destinations: () -> List<AppLogDestination>)` with `write(category: AppLogCategory, bytes: ByteArray): AppLogWriteResult`; result is either `Saved(location: String)` or `Unavailable(message: String)`.

- [ ] Write tests against real temporary files through a test-only destination adapter. Pin boundaries and oldest-first removal with independent literal expectations:

  ```kotlin
  repeat(12) { index -> store.write(AppLogCategory.RUNTIME, exactlyOneMiB("record-$index")) }
  assertEquals(10, runtimeFiles().size)
  assertTrue(runtimeFiles().all { it.length() <= 1_048_576L })
  assertFalse(allRuntimeText().contains("record-0\n"))
  assertTrue(allRuntimeText().contains("record-11\n"))
  ```

  Define the test helpers locally: `exactlyOneMiB(marker: String): ByteArray` is the marker plus newline padded with ASCII spaces to exactly 1,048,576 bytes; `runtimeFiles(): List<File>` lists actual owned runtime files; `allRuntimeText(): String` reads those files. None belongs in production sources.

  Also cover active-file append after reopening, runtime/crash independence, concurrent writers, clock rollback, linked/unrelated-file preservation, partial-write/rotation failure fallback and every destination failing. Keep test helpers under test sources.
- [ ] Add formatting/redaction tests: all six levels, UTF-8 expansion, CR/LF record injection, Authorization/Cookie/password/token values, URL credentials/query secrets and key/profile blocks. A huge crash must remain at most 1,048,576 bytes with an explicit truncation marker; an ordinary formatted runtime record is capped at 16,384 bytes.
- [ ] Run `./gradlew :app:testX86_64DebugUnitTest --tests 'io.github.tinywind.norea.AppLog*Test'` from the Android project; confirm behavioral RED before changing the policy.
- [ ] Implement the policy. Serialize sequence/retention changes using the app-private coordination file; sequence must not reset with process/time changes. Only parsed names in this app/category namespace are owned. Retry failed records in the next destination, without recursive logging.
- [ ] Rerun the targeted tests to GREEN and record evidence; defer the feature commit to Task 7.

### Task 2: Real Android destinations

**Files:** Create `AndroidLogDestinations.kt`; extend test coverage with `AndroidLogDestinationsTest.kt` and `src/androidTest/java/io/github/tinywind/norea/AndroidAppLoggingDeviceTest.kt`. Modify `src-tauri/gen/android/app/build.gradle.kts` only to set the existing AndroidX instrumentation runner.

**Interfaces:** Implement `AndroidLogDestinations(context: Context)` with `candidates(): List<AppLogDestination>`, `stateDirectory: File` and `readSelectedRoot(): String?`. It consumes Task 1's namespace/category/file types and reads the existing `chapter-media-storage-root.txt` locations, without altering them.

- [ ] Write failing adapter tests for actual selected-root output, revoked grants, app-owned MediaStore files, protected unrelated files and the temporary fallback. Device tests use the target app context and a dedicated QA root.
- [ ] Create the `build-qa.py` and `device-tests.py` harnesses defined above, run targeted JVM tests and build/run the instrumentation tests with the explicitly isolated test application. Confirm the missing adapter behavior, not a compiler/environment failure, is RED.
- [ ] Implement selected raw/SAF, MediaStore Downloads and private-cache adapters. Use persisted grants, app-owned MediaStore selection, exclusive creation, append rather than truncate, and regular/no-follow managed-file opens. Normalize only trusted roots, not managed children. Honor failed deletes without deleting unrelated data or masking the failure.
- [ ] Test a primary directory replaced by an owned blocking fixture and an actually revoked SAF grant. For the otherwise-unrevocable app-owned Downloads capability, use a clearly labeled provider-denial test context; verify real private-file output and report that denial injection honestly.
- [ ] Run GREEN adapter tests, including two processes sharing the coordination lock. Defer the commit.

### Task 3: Application lifecycle, Java capture and runtime queue

**Files:** Create `AndroidAppLogging.kt`, `AppLog.kt`, `AndroidCrashReports.kt`, `NoreaApplication.kt`, and their unit tests. Modify the main Android manifest's application name. Route existing app Log imports in the nine discovered Kotlin source files and the two fully qualified calls in `AndroidAppBridges.kt` through `AppLog`.

**Interfaces:** `AndroidAppLogging.install(context: Context): Unit`; `enqueueRuntime(level: String, target: String, thread: String, message: String): Boolean`; `writeCrash(kind: String, message: String, detail: String): AppLogWriteResult`; `setLevel(level: String): Unit`; `currentLevel(): String`. `AndroidCrashReports.installUncaughtHandler(context: Context): Unit` installs once and chains the previous handler.

- [ ] Add RED tests for persisted `off` before startup, native-level updates across processes, queue saturation/drop counts, throwable cause/suppressed stacks and default-handler chaining after write failure. Queue capacity is 256 records, with bounded runtime records from Task 1.
- [ ] Add a blocked-provider/held-runtime-lock regression: crash capture must produce a temporary report without waiting for runtime work to complete. Use latches and a bounded crash-publication wait, not timing-dependent arbitrary sleeps.
- [ ] Implement application installation before activity startup. Do not load the Rust library early merely to install the Java handler. Runtime file writes run off the UI thread, recheck the shared level when draining, and report dropped counts without reentering the logger. Crash output uses independent bounded capture/staging and flushes before default termination; give public publication a total 1,500 ms deadline and retain its valid temporary report if publication stalls. Do not leave an unbounded publication-task queue.
- [ ] Implement the Android Log signatures used today: `d`, `w` and their actual throwable overloads, `VERBOSE`, and `isLoggable`. Preserve the explicit platform verbose-tag opt-in for scraper URL/cookie detail; changing the app level alone must not enable extra cookie reads. Add `i`/`e`/`v` only where the new application pipeline actually calls them.
- [ ] Run targeted lifecycle/policy tests and `:app:testX86_64DebugUnitTest`; inspect every failure and record results. Defer the commit.

### Task 4: Rust logger, Windows storage and JNI connection

**Files:** Create the Rust files listed in File boundaries and `AndroidAppLoggingBridge.kt`; modify `src-tauri/src/lib.rs`, `MainActivity.kt`, `Cargo.toml` and the app entry in `Cargo.lock`. Add Rust unit/process-exit tests inside the logging modules.

**Interfaces:** `app_logging::install_panic_hook(): ()`, `initialize(application_id: &str): Result<(), String>`, `configure(app: &AppHandle): Result<(), String>`, `set_runtime_level(level: &str): Result<(), String>`, `emit_runtime(record: &log::Record<'_>): ()`, and `record_crash(kind: &str, message: &str, detail: &str): Result<(), String>`.

`FileLogStore::new(namespace: String, state_dir: PathBuf, roots: Vec<PathBuf>) -> Self` exposes `write_runtime(&mut self, text: &str) -> Result<PathBuf, String>` and `write_crash(&mut self, text: &str) -> Result<PathBuf, String>`. It uses the same 1,048,576/10 bounds and safe ownership rules; it compiles for Windows and native unit tests, not a Linux app target.

The kept bridge exports `register()` to native, plus `enqueueRuntime(level, target, thread, message): Boolean`, `writeCrash(kind, message, detail): String?` (null means no destination), `setLevel(level): Unit` and `currentLevel(): String`. Register JavaVM/class using the existing JNI 0.22.4 pattern. Call registration before the existing Rustls bridge initialization in `MainActivity.onCreate`, before `super.onCreate` can enter Tauri.

- [ ] Write RED real-file tests for Windows-store policy, secret redaction, fallback, restart and linked targets. Add a subprocess panic test that verifies a bounded report exists before abnormal exit, including at `off` and while runtime logging is blocked.
- [ ] Compile native tests for `x86_64-linux-android` and run them on Waydroid with a dedicated `.tmp/local-logs-20261102/native-tests.sh` harness following the existing VPN harness; confirm behavioral RED.
- [ ] Implement Rust metadata/redaction and the platform sinks. Reuse fern from tauri-plugin-log for the existing dependency filters. Install the global logger before fallible proxy/Tauri work and use the log plugin with `skip_logger()` so it neither installs a second logger nor writes default private log files. Windows runtime writes use a bounded 256-record background queue; crash output does not wait for that queue. The JNI bridge may load `app_lib` using the existing bridge pattern when activity registration runs, not while installing the application's Java handler.
- [ ] Initialize panic capture first; when full metadata/storage is unavailable, use a safe bounded temporary report. Chain the previous panic hook, bypass runtime level filtering for crashes, and never recurse through log macros after sink failure. Use the same 1,500 ms public-publication deadline while retaining a flushed temporary report. On Windows, start from known native settings/temp paths and refresh selected/Downloads paths from the app handle before SQL preload. Preserve the restore guard before SQL and remove the unconditional final reset to `info`.
- [ ] Delegate the existing `set_runtime_log_level` and `write_frontend_log` entry points without changing their JSON arguments. Persist the native level copy while applying the requested in-process filter; report persistence failures rather than claiming durability.
- [ ] Rerun native logging tests to GREEN, compile the x86_64 APK and run the complete native suite, retaining any known baseline failures by name. Defer commits.

### Task 5: Early frontend crash events

**Files:** Create `src/lib/runtime-crash.ts`, `src/lib/runtime-crash.test.ts`; modify `src/bootstrap.ts`, `src/bootstrap.test.ts` and register the command in Rust logging/lib modules.

**Interfaces:** `installRuntimeCrashCapture(): void` is idempotent and imports no persisted store. Rust command `record_frontend_crash(app: AppHandle, crash: FrontendCrash) -> Result<(), String>` consumes `FrontendCrash { kind, message, stack, url }`; kind is `error | unhandledRejection`, message is required, and stack/url are optional strings. No frontend-supplied destination or filename is accepted.

- [ ] Write RED tests that dispatch real browser error/rejection events while the bootstrap restore-check promise is pending. Assert the original message/stack reaches `record_frontend_crash`, the app module remains unimported until the fence passes, browser-only execution makes no IPC call, repeated installation adds no duplicate listeners, and reporting failure does not generate another unhandled rejection.
- [ ] Run `pnpm test src/lib/runtime-crash.test.ts src/bootstrap.test.ts`; confirm the missing capture is RED.
- [ ] Implement the small capture module and call it before `start()`. Native code bounds and redacts all fields independently, uses the crash sink regardless of the runtime level, and acknowledges actual crash capture rather than ordinary runtime queue acceptance.
- [ ] Rerun the focused tests, `pnpm tsc` and the full `pnpm test`. Keep the existing logging settings format and ordinary console filtering unchanged. Defer the frontend commit until Task 7.

### Task 6: Previous Android crashes and bounded native trace extraction

**Files:** Create `AndroidNativeCrashTrace.kt` and `AndroidNativeCrashTraceTest.kt`; extend `AndroidCrashReports.kt` and its tests.

**Interfaces:** `readNativeCrashTrace(input: InputStream): NativeCrashTraceResult` returns either a bounded `Summary(signal: String?, abortReason: String?, frames: List<NativeCrashFrame>, limitation: String?)` or `Unavailable(reason: String)`. `NativeCrashFrame` contains optional module/function/build-ID/relative-PC fields only. `AndroidCrashReports.collectPreviousCrashes(context: Context): Unit` records crash/ANR exit entries, not ordinary force-stops, and deduplicates recovered exit identities.

- [ ] Add RED golden-byte tests based on the official Android tombstone schema linked from the Android native debugging guide: readable crashing-thread frames/signal, unknown protobuf fields, malformed lengths, incomplete input, input beyond 1 MiB and a secret-bearing raw-memory field that must never reach output. Use independent literal expectations, not a serializer shared with the parser.
- [ ] Run the focused native-trace/JVM tests and confirm the behavior is RED.
- [ ] Implement a bounded reader of only the required protobuf fields, skipping all memory payloads and unknown fields. Bound depth/frame counts, redact text, label truncation/malformed traces, and avoid a new protobuf Gradle plugin or checked-in generated sources.
- [ ] Recover relevant app-owned exit records on startup off the UI thread. Gate API 30 exit metadata and API 31 native traces correctly, save a deduplication cursor only after capture succeeds, and distinguish current recovery build information from unknown crashed-build information. Keep `off` behavior independent.
- [ ] Run GREEN parser/collector tests and actual Waydroid crash/reopen checks; explicitly report a null/unavailable OS trace instead of fabricating a native stack. Defer the commit.

### Task 7: Isolated Waydroid acceptance, review and delivery

**Files:** Add `src/debug/java/io/github/tinywind/norea/LogTestWriterService.kt` and its debug-only manifest entry for a non-exported secondary-process producer. Complete `AndroidAppLoggingDeviceTest.kt`. Create `.tmp/local-logs-20261102/` harnesses and `docs/test-support/local-runtime-crash-logs.md`.

**Interfaces:** The debug service invokes the real `AppLog`/file pipeline in a secondary process; it has no release/main-source entry point. Instrumentation targets only the isolated QA application. No implementation-specific crash or filesystem command is added to shipping IPC.

- [ ] Use the QA harness to package `io.github.tinywind.norea.qalogs20261102.debug` with `pnpm exec tauri android build --apk --debug --target x86_64 --config .tmp/local-logs-20261102/qa.tauri.json` and assemble its matching instrumentation APK. Use the shipping source/bootstrap with no QA source transforms, and restore the Gradle ID with a narrow patch before any commit.
- [ ] Inspect APK package, ABI and launch activity with aapt. Install QA and test APKs with `adb -s 192.168.240.112:5555`, then run `am instrument -w` on the QA test package. Do not use an unfiltered connected-device task while Y700 is attached. If Waydroid is frozen, open its UI and reconnect that transport; do not restart or reset user environments implicitly.
- [ ] Drive the real log-level setting through all levels, including `off`, and reopen the app to verify the native mirror. Generate over 12 MiB of bounded real runtime messages and twelve controlled reports; inspect actual UTF-8 bytes, ten-file limits, independent categories, oldest-first deletion and unchanged unrelated sentinels. Exercise concurrent main/debug-service producers and rotation during a primary failure.
- [ ] Verify selected SAF output, actual grant revocation/public Downloads fallback and the explicitly labeled provider-denial/private-temp case. Verify known synthetic credentials and native memory sentinels are absent. Capture destination/error provenance, APK hashes and all relevant commands/exit codes under `.tmp/`.
- [ ] Test real JS throws/rejections, `am crash` Java termination, a Rust startup panic using a clearly owned QA restore-marker fixture, and a controlled native signal using the QA UID. Restart for OS recovery; remove only owned QA fixtures. Verify bootstrap/store ordering and that logging does not turn fatal errors into apparent successful execution.
- [ ] Run full frontend/type checks, all Android JVM tests and the complete Android native executable on Waydroid. Compare native failure names with the baseline; document every failure. Run `git diff --check`, inspect all affected source/test files and request one fresh read-only whole-change review.
- [ ] Write the factual verification report, including Windows-not-device-tested, OS trace limits, inaccessible-volume retention limits, and injected versus actual permission failures. Do not claim full native-suite success if the known environment failures remain.
- [ ] After review fixes and repeat verification, create coherent native/backend and frontend commits using explicit path lists, include the approved design/plan and verification docs in the appropriate commits, and push `0.2` with hooks enabled. Use Node 24 on PATH for both commit and push. Stop on any non-fast-forward rejection. Verify the remote tip and clean working tree before reporting completion.

## Plan self-review and execution gate

Each spec section maps to Tasks 1-7: ownership/rotation to 1-2, native runtime/levels to 3-4, early browser capture to 5, recovered native evidence to 6, and actual platform verification/delivery to 7. The five Review Focus conditions have explicit owning tests above. No production test endpoint, new Tauri plugin, unbounded queue, raw tombstone publication or default-file-log duplication is planned.

The user approved this plan and selected inline execution on 2026-11-02, including the required builds, tests, independent final review, commits and push. Keep execution evidence and the plan ledger under `.tmp/local-logs-20261102/`.
