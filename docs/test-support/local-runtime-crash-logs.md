# Local runtime and crash logs

## Behavior

Runtime logs follow the existing `trace`, `debug`, `info`, `warn`, `error` and
`off` setting. Crash capture remains enabled at `off`. Each category retains
at most ten files of at most 1,048,576 bytes, including the active runtime file.

Logs prefer `logs/` beneath the selected media root. If it is unavailable,
Android uses app-owned files in `Download/Norea/logs/`, then private cache.
Windows uses Downloads/Norea/logs, then its application-specific OS temporary
folder. Android document providers and MediaStore receive `.log.txt` names;
ordinary filesystem files use `.log`.

The native level mirror does not change the frontend settings format. Android
reads it on a worker before draining early queued records. Application setup
does no main-thread file I/O. FileObserver notifications update other app-owned
processes, and the runtime worker rechecks the mirror before writing each record.

Java uncaught exceptions preserve causes and suppressed exceptions and chain
the previous fatal handler. Rust panic capture runs before fallible startup.
Early browser `error` and `unhandledrejection` listeners are installed before
the restore check and import no persisted store. The restore guard remains
before SQL preload.

Crash capture flushes a private staging report independently of the runtime
queue, then waits up to 1,500 ms for public publication. A blocked provider
leaves the staging report for a later start. Authentication headers, cookies,
password/token fields, bearer credentials, URL queries/user information and
private-key/profile blocks are redacted before file output.

## Verification environment

Verification uses only Waydroid at `192.168.240.112:5555` (Android API 33,
x86_64). The QA package is `io.github.tinywind.norea.qalogs20261102.debug`;
the Java/JNI namespace is unchanged. The physical Y700 is not used.

Build tools: Node 24, pnpm 10.27.0, Temurin 17, Android SDK/build tools 36 and
NDK 29.0.14206865. The QA build targets only x86_64. Temporary harnesses and
command output live under `.tmp/local-logs-20261102/`.

## Automated checks

`acceptance-frontend.log` reports 204 files and 2,589 tests passed.
`acceptance-types.log` reports `pnpm tsc` exit 0.
`process-and-crash-tests-build.log` reports the complete Android JVM suite
and QA app/instrumentation assembly exit 0.
`redaction-boundary-rust-green.log` reports all 13 logging-native tests passed.

Final device acceptance, artifact hashes and independent review results will
be recorded here before delivery. This section does not claim completion.

Confirmed regression evidence includes:

- Behavioral RED/GREEN for byte limits, independent retention, restart append,
  oldest-first pruning, concurrent writers and fallback after partial writes.
- Actual raw-folder and granted SAF output; actual persisted-grant revocation
  falls back to MediaStore Downloads.
- A clearly injected provider denial produces a real private-cache file. This
  is not an actual OS revocation of the app's MediaStore ownership.
- StrictMode `penaltyDeath` reproduced main-thread Application file access;
  the corrected installation passes all four destination tests under that policy.
- JNI's own logging caused recursive forwarding during actual app startup.
  A whole-dispatch thread-local guard fixes the native regression, and an
  existing frontend log command reaches an actual public Downloads file.
- JSON headers, bare bearer credentials and non-HTTP page URL regression tests
  pass in Kotlin and Rust. A bounded large-plain-text case also catches
  quadratic Java URL-pattern scanning.

## Native suite baseline failures

`acceptance-native-full.log` reports 345 passed and ten existing fixture/mock
failures (exit 101). Their names match the baseline in
`y700-startup-restore-guard.md`; the full native suite is not green.

- `chapter_media::paths::tests::chapter_identity_lookup_matches_complete_directory_names`
- `chapter_media::work_metadata::tests::discovers_cover_files_without_a_descriptor_or_sidecar`
- `chapter_media::work_metadata::tests::discovers_final_bodies_despite_incomplete_media_or_partial_artifacts`
- `chapter_media::work_metadata::tests::lists_work_candidates_without_inspecting_chapter_folders`
- `chapter_media::work_metadata::tests::metadata_only_work_roundtrip_and_interrupted_publication`
- `chapter_media::work_metadata::tests::prefers_the_declared_cover_and_discovers_an_existing_file_if_it_is_missing`
- `chapter_media::work_metadata::tests::registers_exact_chapter_directories_for_native_media_writes`
- `chapter_media::work_metadata::tests::rejects_escape_and_non_metadata_files`
- `download_cache::tests::delete_work_run_clears_bulk_novel_cache_end_to_end`
- `plugin_vpn::state::tests::saved_profile_engine_reads_hold_the_operation_lock_until_connection_settles`

The eight chapter-media cases encounter host-fixture `PermissionDenied` on
Android. The last two reach Tauri's unimplemented Android mock runtime.

## Coverage limits

Windows code and the portable file-store logic are included, but no Windows
binary or Windows device has been verified in this task. Portable Rust
file-store/process tests run as an Android-native executable on Waydroid.

Android API 30 supplies previous-exit metadata. API 31 and later may also
supply a native tombstone. Only signal, abort reason and the crashing thread's
module/function/build-ID/relative-PC fields are rendered. Reports exclude raw
memory, registers and opaque payloads and label unavailable or truncated OS
evidence. Java/ANR recovery uses OS metadata without claiming an OS stack.

SIGKILL, power loss, failures before capture installation and Windows native
access violations do not guarantee a report. Inaccessible old volumes can
retain files beyond the ordinary total budget until access returns. Public
output also depends on OS permissions; private cache is the last resort.
