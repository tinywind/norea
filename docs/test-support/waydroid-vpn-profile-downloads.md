# VPN profile download verification

## Two-worker feasibility probe

Date: 2026-11-02. Device: local Waydroid, Android 13, x86_64.
The probe used a separate `io.github.tinywind.norea.vpnprobe` package. Existing
Norea installations and the attached physical device were not changed.

Two controlled OpenVPN servers ran in isolated Docker containers. The app's
existing OpenVPN engine, userspace network stack and local proxy code connected
to both servers concurrently. Separate Android service processes used different
WebView data directories and proxy overrides. The controlled source observed
exit peers `172.29.81.2` and `172.29.81.3` for the same source address.

| Check | Result |
| --- | --- |
| Shared-process negative control | A's navigation reached B's proxy, failing the route assertion. |
| Separate service processes | Navigation, redirects, JavaScript fetch and images used the owning tunnel. |
| Cookie isolation | A sent `identity=A`; B sent `identity=B` on the same source. |
| Concurrent transfer | Both two-second fetch requests started within one millisecond of each other. |
| Background and screen off | With a foreground execution service and partial wake lock, downloads continued while the activity was hidden and the screen was off. |
| A disconnected | A stopped at five settled rounds. B reached twelve rounds during the acceptance interval and later completed twenty. No direct fallback from A reached the source. |
| Process recreation | B's new process retained B's cookie identity. |
| Manual browser | The B-process activity attached the service's existing WebView; its manual navigation and fetch still used B's tunnel and cookies. |
| Resource sample | B used 43,963 KiB PSS and 86,352 KiB RSS during background execution. This sample excludes the host and other worker. |

The first background run omitted the foreground execution service. Android
classified the app and its workers as cached and killed them. The successful
repeat used the foreground-service and wake-lock ownership required by the
existing download runtime.

This probe supports an initial Android cap of two workers on API 28 or later,
with WebView proxy override and multi-profile support. It does not establish
Windows isolation, higher worker counts, long-term battery consumption,
Android 15+ service quota behavior, or compatibility with a live external
Cloudflare challenge. Product integration and end-to-end acceptance remain
separate checks.

Probe sources, raw request logs, RED/GREEN assertions and APK build outputs are
temporary files under `.tmp/vpn-profile-workers/`. Native probe entrypoints are
temporary and must not be included in delivery commits.

## Production notification bridge checks

Date: 2026-11-02. Device: the same local Waydroid Android 13 x86_64 instance.
The integrated application was built for x86_64 only and installed as
`io.github.tinywind.norea.qavpn20261102.debug`, preserving existing app data.
The APK contains only `lib/x86_64/libapp_lib.so`. Its SHA-256 is
`dad4fac1c9efba4ae786a842bb47cc00acde4384d45d6a9a057083e6dc2a9d40`.

The QA build exposes the real notification model and action parser to the
WebView debugger through a temporary Vite transform. Controlled range snapshots
from that model entered the shipping Android JSON bridge, NotificationManager,
PendingIntent and private action registry. The app remained at its initial media
storage gate; this check did not create real download plans or open a worker
browser. The temporary Gradle application ID was restored after packaging.
The shipping Vite and Tauri configurations were not changed.

| Check | Observed result |
| --- | --- |
| Two paused ranges from one source | Both native cards used ID 1203 and different length-prefixed plan/range tags. |
| Resolve range A | Only A's card disappeared; B's card remained. |
| Tap B | The queue delivered B's exact plan, source, range, profile, generation 7 and checkpoint 0. A repeated drain was empty. |
| Cold B action | After Home and `am kill`, PID 41129 was absent and B's notification remained. Tapping it started PID 41786; the restored private queue delivered the same owner fields once. |
| Ordinary source coexistence | `(source/qa-same-source,1201)` remained separate from the valid B range card. |
| Invalid native JSON | A verification action with string generation `"7"` was rejected without removing valid B or the ordinary source card. |
| Untrusted extra action fields | Injected URL and command fields were absent from B's delivered canonical action. |
| Exhausted range | Its card delivered only `{"type":"openTasks"}`. |
| Cleanup | An empty snapshot removed all QA cards. Existing app notifications were left unchanged. |

The first UI taps hit Android's auto-group summary rather than an individual
card. The final checks explicitly expanded the matching group before selecting
its card and asserted the delivered queue contents. `run-as` could not read the
QA preferences on this Waydroid image; normal notification taps and cold process
recreation verified the queue without changing device privileges.

Automated checks passed: 201 frontend files / 2,473 tests, TypeScript checking,
and 161 Android JVM tests across 20 suites. The final Gradle run executed all
108 tasks with `--rerun-tasks`, including Kotlin compilation. The six new app
toast tests initially failed before the range subscription was implemented.
They cover sibling preservation, stale actions, individual dismissal, exhaustion
navigation, plan identity and silent automatic replacement. The existing orange
five-second toast presentation is unchanged.

Raw evidence is under `.tmp/vpn-profile-workers/`: `notifications-ui-red.log`,
`notifications-ui-fixture-green.log`, `notifications-integration-frontend-full.log`,
`notifications-integration-tsc.log`, `notifications-native-parent-fresh.log`,
`notifications-qa-build-4.log`, `notifications-device-after-a.txt`,
`notifications-device-cold-kill.txt`, `notifications-device-cold-action.json`
and `notifications-device-assertions.json`. Native implementation boundaries and
RED/GREEN details are in `notifications-native-report.md` in that directory.

Actual worker-browser opening from a range card, successful protected chapter
settlement, full backup/restore and the complete VPN download acceptance matrix
remain unverified by this notification-only device check.

## Active profile journal durability ordering

The active-selection checkpoint now syncs its parent directory after publishing
the checkpoint and before changing the retained selector. A Waydroid `strace`
regression observed no parent `fsync` between those operations before the fix.
After the fix, the successful parent `fsync` appeared at trace line 242, before
the next selector publication at line 244. All five active-profile tests passed
on Waydroid. This proves syscall ordering and file-backed restart behavior, not
persistence under an actual power loss.

Evidence: `active-journal-{red,green}.trace`,
`active-journal-barrier-{red,green}.log` and `active-journal-native-green.log`
under `.tmp/vpn-profile-workers/`.

The full native test executable still reports 318 passed / 10 failed. Eight
tests use host-only fixture paths and fail with `PermissionDenied`; two hit
Tauri's unimplemented Android mock context. Exact test names and causes are
listed in `.tmp/vpn-profile-workers/quarantine-restart-report.md`; the fresh run
is `notifications-native-rust-full.log`. These failures were not suppressed.

## Notification and journal affected files

| File | Relevant line |
| --- | --- |
| `src/components/TaskNotifications.tsx` | 223 |
| `src/components/TaskNotifications.test.ts` | 169 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/TaskNotificationState.kt` | 26 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidTaskNotificationActions.kt` | 13 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidTaskNotifications.kt` | 34 |
| `src-tauri/gen/android/app/src/test/java/io/github/tinywind/norea/TaskNotificationStateTest.kt` | 148 |
| `src-tauri/gen/android/app/src/test/java/io/github/tinywind/norea/AndroidTaskNotificationRangesTest.kt` | 1 |
| `src-tauri/src/plugin_vpn/state.rs` | 1089 |
| `docs/test-support/waydroid-vpn-profile-downloads.md` | 43 |

## Worker settlement before device restore

Date: 2026-11-02. The latest native test executable ran on the same Waydroid
Android 13 x86_64 instance, not a replacement production APK.

Two new tests exercise the real download-worker manager, saved-profile vault,
private files, SQLite O verdicts and native restore-lock entrypoint. Stateful
engine controls stand in for external OpenVPN processes so tests can hold or
close completion monitors deterministically. They do not prove real VPN egress
or app-browser behavior during archive installation.

Both tests failed before wiring manager shutdown into the restore guard: restore
did not invalidate either worker, and the existing idle-lease check rejected
the operation without attempting their cleanup. After the fix, both workers are
invalidated before cleanup waits; a pending engine completion keeps restore
pending while the vault operation lock remains available. Completing both
monitors releases the leases and permits the guard. A closed monitor instead
returns the cleanup error and retains its session/lease and original files.

Frontend integration tests exercise the real restore function, range runtime
and coordinator with controlled native/storage boundaries. They independently
hold task settlement, Android browser close, native disconnect and final manager
stop. No sync/storage/database restore barrier or settings replacement occurs
until every stage completes. Additional cases cover terminal-but-closing workers,
pending plan publication, delayed profile lookup, failure before installation,
and explicit resume after a rejected restore. Invalid archives do not suspend
workers; a server change during cleanup releases the hold without entering the
database barrier.

| Verification | Result |
| --- | --- |
| New native restore/worker tests on Waydroid | 2/2 passed after behavioral RED. |
| Frontend runtime/coordinator/backup integration | 109/109 passed. |
| Full frontend | 201 files / 2,532 tests passed; TypeScript check passed. |
| Full native executable on Waydroid | 320 passed / 10 known environment failures; none suppressed. |

All 13 archive tests, nine vault-backup tests, 13 worker-manager tests and the
idle-lease guard test passed in the full native run. Its ten failures are the
same eight host-only fixture path permission errors and two Tauri Android mock
context failures documented earlier. This is native lifecycle evidence, not
full APK backup/restore acceptance or process-interruption consistency.

Evidence under `.tmp/vpn-profile-workers/`:
`backup-worker-settlement-{red,green,full,tsc,whitespace}.log`,
`backup-worker-profile-fence-red.log`,
`backup-native-worker-stop-{red,green}.log`,
`backup-worker-settlement-native-full.log` and
`backup-worker-settlement-report.md`.

## Interrupted restore checkpoint

The Android x86_64 native tests now spawn a second copy of the real app test
executable on Waydroid and exit it with code 86 after the native VPN files and
storage root are installed, before SQLite replacement. A new process reads the
old database alongside the new files/root and refuses startup through the same
checkpoint check used by production. The old profile and vault, previous root
record and original content remain available. The initial run reproduced this
mixed state without a durable checkpoint; the updated test passes.

A second process-exit case exits with code 87 after SQLite commit but before
frontend acknowledgement. A fresh process still refuses startup (code 88).
After an exact acknowledgement, its fresh startup check succeeds (code 0).
Incomplete and legacy checkpoints, symlinked recovery paths, escaped publication
names and stale IDs are rejected without deleting the preserved data. All 18
native device-backup tests passed in the focused Waydroid run.

Frontend tests load the module entry referenced by `index.html`. They hold or
reject the native startup check and verify that the application module is not
loaded. The original entry failed all three blocking cases. Backup tests also
hold the native commit response to verify that old settings remain unchanged,
then check installation of the native receipt's settings and exact acknowledgement.
Settings-write failure, failed acknowledgement and a lost native response retain
the recovery archive and reload through the startup check. The focused frontend
run passed 117 tests; the full run passed 202 files / 2,540 tests and the TypeScript
check passed.

The policy is conservative: an interrupted restore blocks startup and requires
manual recovery. These tests cover process termination and persisted refusal,
not automatic rollback, power failure, Windows filesystem behavior or full APK
WebView/VPN restoration. No APK or existing app data was replaced for this test.
The early native startup guard is registered ahead of the SQL plugin because
Tauri initializes plugins before configured WebViews and calls app setup after
creating those WebViews. The separate web entry protects WebView-only reloads.

Evidence under `.tmp/vpn-profile-workers/`:
`backup-interruption-native-{red,green,full}.log`,
`backup-interruption-settings-red.log`,
`backup-interruption-startup-red.log`,
`backup-interruption-frontend-{green,full}.log`,
`backup-interruption-tsc.log` and `backup-interruption-report.md`.

## Unopenable destination vault

A native Waydroid regression reproduced a valid full backup being rejected
because the destination's index could not be parsed during initialization.
Restore now prepares the existing quarantine recovery under the operation lock,
after stopping workers and checking the interruption fence. The test runs the
actual native guard and full staged bundle installation, verifies that the old
malformed index and private bytes remain in quarantine, and revalidates/exports
the restored vault. It passed after the fix. The whole native executable then
reported 326 passed / the same ten environment failures. This is native recovery
evidence; the latest APK's browser/download/restore acceptance is still separate.
Logs: `.tmp/vpn-profile-workers/backup-unopenable-vault-red.log` and
`backup-unopenable-vault-native-full.log`.

## Production download and recovery acceptance

Date: 2026-11-02. The production entry was built for x86_64 only and installed
in the isolated `io.github.tinywind.norea.qavpn20261102.debug` package on
Waydroid Android 13. The final APK SHA-256 is
`79cd807e9c11201fc99c66feb372a8c940f29562d7c6cf5f2b59388d1a25130b`.
The shipping application ID and manifest were restored after packaging.
No shipping installation, physical device, host routing or Waydroid routing
was changed. QA JavaScript sources and debugger helpers stayed under `.tmp/`.

| Check | Observed result |
| --- | --- |
| Exact-file O and capacity | Four public Finder candidates were approved through normal controls. Capacity 10 persisted. Reducing it to 2 retained two files and kept the other O verdicts as missing-file rows. |
| Real parallel chapters | Fixed ranges 1..3 and 4..6 downloaded six actual HTTPS responses from `httpbin.org`. Every stored body was 1,189 bytes, both checkpoints reached 3/3, and both native workers released their leases. |
| Cold worker bootstrap | The first APK failed with `Must be started before we block!`. Constructing the blank host WebView on the main thread before applying the process proxy fixed the real-device failure. Source browser creation/navigation still follows proxy readiness. |
| Occupied pool | A stayed at checkpoint 0 while B owned the only eligible profile. B completed 4..6 before A acquired that released profile. No fixed chapters were taken from B. |
| CAPTCHA and reallow | Controlled challenge DOM on a real HTTPS page caused a durable CAPTCHA exclusion without advancing chapter 1. The manager's reallow changed only that batch/IP revision and retained its cause. Chapter 1 retried on a newer worker, then the range completed. |
| Shared exhaustion | Both workers encountered controlled CAPTCHA pages in one batch. Both profiles were excluded exactly once, both checkpoints stayed 0, and neither profile was recycled by its sibling. A separate batch could use an IP excluded by an older batch. |
| Waiting-to-exhausted transition | The first device run exposed A remaining in `profile-in-use` after B excluded the last candidate. The matching coordinator regression failed before the fix. Pending exclusions now invalidate same-batch wait snapshots; the rebuilt APK reported `profiles-exhausted` for both ranges. |
| Manual Cloudflare session | Open verification displayed the owning native worker activity. A real tap on the controlled fixture and Android Back returned to that range. After the fixture supplied normal responses, explicit Resume completed on the same generation 11; its recorded Cloudflare cause remained. |
| Populated management modal | At 360x640 CSS pixels the modal displayed retained files, missing-file verdicts, cause/time/batch/range/generation and independent Works/Does not work choices. A real Does not work selection removed the exact saved file while preserving problem records. |
| Native full-vault restore | Through the installed APK's real IPC, a version 2 archive contained both 10,045-byte profile files and their exact hashes. After capacity was reduced to one file, restoration recovered both files, capacity 2 and all seven issue rows. Frontend settings installation preceded exact receipt acknowledgement; the startup fence then cleared. |
| Resume after restore | Reallow preserved history and two fixed ranges completed sequentially on the one eligible profile, using generations 19 and 20 above the surviving native floor 16. Public engine failures during acceptance were excluded and remained separate from successful chapter settlement. |
| Cold restart | A package-only force-stop/relaunch preserved both completed checkpoints, generations 20/19, eight issue records, the X verdict and file removal. The persistent chapter queue was empty and the restore startup fence was clear. |

The public profiles `219.100.37.214` and `219.100.37.212` both produced origin
`219.100.37.246`. This confirms real HTTPS transfer through the VPN, but shared
public NAT cannot prove separate egress. The controlled two-server probe above
remains the independent route/cookie-isolation evidence.

The challenge fixture uses the existing `documentStartScript` acquisition
contract to insert visible challenge markers into an actual HTTPS page. It
tests host detection, cancellation, policy, browser ownership and retry. It
does not prove compatibility with a live third-party CAPTCHA/Cloudflare
provider. An initial base64 fixture returned `text/plain` and did not exercise
challenge handling; that run is excluded from challenge evidence.

The latest production screen-off attempt did not establish chapter progress:
its public VPN connection failed before downloading. Background/screen-off
support is evidenced by the earlier controlled probe, not by this inconclusive
production attempt. The installed-APK restore test used real native IPC with
quiescent workers, not the content-server upload/download UI or an archive
replacement during live source transfer. Shutdown ordering during live restore
is covered separately by the native and production-runtime regression tests.
Power-loss durability, Windows isolation/ACL behavior and Android 15+ service
quotas remain unverified here.

### Final automated checks

- Frontend: 203 test files, 2,582 tests passed, including the new exhausted-waiter
  regression. TypeScript checking and `git diff --check` passed.
- Android JVM: 162 tests across 20 suites passed, with no failures, errors or skips.
- Native executable on Waydroid: 328 passed and the same 10 environment failures.
  Eight host-fixture paths produced `PermissionDenied`; two reached Tauri's
  Android mock `todo!()`. These were neither hidden nor suppressed. This is not
  a claim that the full native suite is green.

The eight fixture-path failures are
`chapter_media::paths::tests::chapter_identity_lookup_matches_complete_directory_names`
and `chapter_media::work_metadata::tests::{discovers_cover_files_without_a_descriptor_or_sidecar,
discovers_final_bodies_despite_incomplete_media_or_partial_artifacts,
lists_work_candidates_without_inspecting_chapter_folders,
metadata_only_work_roundtrip_and_interrupted_publication,
prefers_the_declared_cover_and_discovers_an_existing_file_if_it_is_missing,
registers_exact_chapter_directories_for_native_media_writes,
rejects_escape_and_non_metadata_files}`.
The mock failures are
`download_cache::tests::delete_work_run_clears_bulk_novel_cache_end_to_end` and
`plugin_vpn::state::tests::saved_profile_engine_reads_hold_the_operation_lock_until_connection_settles`.

Evidence under `.tmp/vpn-profile-workers/` includes
`final-qa-download-green.json`, `final-qa-chapter-{1,4}.html`,
`qa-wait-{busy,exhausted,green}.json`, `qa-manager-populated.png`,
`qa-cf-{manual.png,manual-green.json}`, `qa-ex-waiter-red.log`,
`delivery-ex-green.json`, `delivery-backup-{created,restored}.json`,
`delivery-diag-final.json`, `delivery-cold-{state,native}.json`,
`delivery-frontend-full.log`, `delivery-tsc.log`, `delivery-qa-build.log`,
`final-browser-bootstrap-jvm.log` and `final-review-native-full.log`.

### Delivery choices

- Continue the existing `0.2` worktree and keep scratch evidence in `.tmp/`.
  This avoids repeating completed work but provides no additional branch isolation.
- Exclude by batch/IP while retaining the exact failed file identity. A newer
  file for that IP still needs explicit reallow in the affected batch.
- Backfill old plan membership only from one unambiguous owned-job batch.
  Otherwise keep a plan-local legacy identity; uncertain historical membership
  will not share exclusions across plans.
- Keep restore guarantees scoped to process-interruption evidence. Do not infer
  power-loss durability or Windows ACL behavior from these Android checks.
- Report the ten existing native environment failures without broad fixture
  changes. Full native-suite success is not established in this environment.

### Main implementation boundaries

| File | Relevant line |
| --- | --- |
| `src/lib/tasks/vpn-download-coordinator.ts` | 139, 321, 539 |
| `src/lib/tasks/vpn-download-runtime.ts` | 98, 423 |
| `src/db/queries/vpn-download-profile-issues.ts` | 1 |
| `src/components/SavedVpnProfilesSettings.tsx` | 1 |
| `src/components/VpnDownloadRanges.tsx` | 179 |
| `src-tauri/src/plugin_vpn/download_workers.rs` | 1 |
| `src-tauri/src/plugin_vpn/saved_profiles.rs` | 1 |
| `src-tauri/src/migrations/0003_vpn_download_profile_issues.sql` | 1 |
| `src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidVpnDownloadWorkerService.kt` | 132 |
