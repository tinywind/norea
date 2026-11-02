# Y700 restore-guard startup regression

Date: 2026-11-02. Device: Lenovo TB322FC (Y700), Android 16 / SDK 36,
`arm64-v8a`. Package: `io.github.tinywind.norea`, version 0.2.0 / code 2000.

## Reproduction and cause

The installed release APK aborted during the early `device-restore-guard`
plugin setup, before SQL preload. Repeated failures occurred within one or two
seconds of startup. The original diagnostic did not identify the rejected path.

A locally built, release-signed diagnostic APK was installed with `adb install
-r`. It identified the rejected ancestor as `/data/user/0`. Android can expose
that system path as an alias inside an application's isolated filesystem
namespace, even though the ADB shell sees a directory. The guard applied
`symlink_metadata().is_dir()` to every ancestor of the raw app data path and
rejected the platform alias before checking any restore checkpoint.

## Repair boundary

`plugin_vpn::state::managed_profile_path` resolves only the OS-provided app
data root on Android, before appending `plugin-vpn/profile.ovpn`. Both the
early restore commands and VPN initialization use this resolver. Other
platforms retain their previous path construction.

The managed VPN directory, vault, profile and restore checkpoint are not
canonicalized. Existing linked-managed-path rejection, interrupted-restore
blocking and exact receipt acknowledgement remain in place. No SQLite schema,
backup format, stored file contents or automatic recovery policy changed.
Rejected-parent errors now include the actual path.

## Automated verification

Rust tests were compiled for `aarch64-linux-android` and executed on the Y700
from a dedicated `/data/local/tmp/norea-startup-tests-20261102` directory, not
from the installed app's private data directory.

| Check | Result |
| --- | --- |
| Rejected-path diagnostic regression, before change | 1 expected failure |
| Rejected-path diagnostic regression, after change | 1 passed |
| Platform-root regressions, raw root | 2 expected failures; linked-managed-path control passed |
| Platform-root regressions, normalized root | 3 passed |
| Backup, vault-backup and platform-root cases in the full native run | 30 passed |
| Full native baseline, before root normalization | 329 passed / 10 failed |
| Full native after root normalization | 332 passed / the same 10 failed |
| Frontend suite | 203 files / 2,582 tests passed |
| TypeScript | Passed |

The alias regression also verifies that ordinary startup does not create a VPN
directory. The acknowledgement regression retains old publication files after
a stale receipt, removes them only after exact acknowledgement and preserves
unrelated original content. The linked-managed-directory control retains the
link and external original file while rejecting startup.

### Unchanged native environment failures

The first eight cases use host fixture paths unavailable to the Android test
process and fail with `PermissionDenied`. The last two reach Tauri's
unimplemented Android mock context. None was skipped or suppressed; the full
native command still exits 101.

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

## Signed APK and physical startup

The final APK was built locally with the existing release certificate, not a
replacement testing key. The user authorized one temporary remote branch to
encrypt the repository signing inputs for a one-time local recipient. Only the
encrypted artifact was downloaded through `gh`. The temporary branch and
artifact were deleted and their absence verified; remote `0.2` remained at
`8c107ceb0aed73bef67cb02a36733b6dc2d98d54`. Local private signing inputs and the
one-time recipient private key were removed after both builds completed.

The build used `pnpm exec tauri android build --apk --split-per-abi --target
aarch64` with a local frontend-output configuration. It did not build another
ABI or change the shipping package ID. APK verification confirmed:

- Package `io.github.tinywind.norea`, version 0.2.0 / code 2000.
- Only `arm64-v8a` native libraries.
- Certificate SHA-256 `d6792257d0d2aba0f7c75941d3c7ab971172752dc677a4951fc52ebb7d16c89f`, identical to the previously installed APK.
- Final APK SHA-256 `050975ccb66dd86f5366282be8ca3b9f234bde08cc577b5da34d647ef66a4012`.

`adb install -r` succeeded at 20:51:26 device time. The installed APK's own
SHA-256 matched the local verified file. Three force-stop/cold-start cycles
kept the app running and visible without a native abort, Java fatal exception
or restore-guard initialization error. The last process remained unchanged
during a further 30-second log observation window. Korean settings and the
existing media folder became visible, and tapping Library opened existing
work cards while background folder recovery continued.

The app retained UID 10309, its 2026-10-12 first-install time, app-data path and
CE data inode 2372849 through the diagnostic and fixed updates. No app data
clear, uninstall, storage-folder selection, checkpoint deletion or database
reset was performed. These checks establish in-place package-data identity and
visible existing state, not an exhaustive private-database or content-file hash
audit. The non-debuggable release does not permit `run-as` reads of private
files. The complete background storage scan was not awaited or claimed as a
separate integrity test.

Both release builds completed with Rust dead-code and Kotlin/R8 metadata
warnings. No toolchain change or warning suppression was added. A separate
read-only review found no actionable defect in the three Rust changes.
Windows compilation, Windows ACL behavior and power-loss recovery were not
tested. The APK was built from local changes on the base commit above, before
the source repair was committed or pushed to `0.2`.

## Local evidence

Evidence is under `.tmp/y700-startup-crash-20261102/`:

- `diagnostic-red-exact.log`, `diagnostic-green.log`
- `diagnostic-build-result.json`, `diagnostic-device-result.json`
- `platform-root-red.log`, `platform-root-green.log`
- `native-baseline-full.log`, `native-final-full.log`, `native-suite-comparison.json`
- `frontend-tests.log`, `typecheck.log`
- `fixed-build-result.json`, `fixed-signature.txt`, `fixed-apk-manifest.txt`
- `fixed-install.log`, `fixed-device-result.json`, `cold-2-device-result.json`, `cold-3-device-result.json`
- `sustained-device-result.json`, `sustained-startup.log`, `library-ui.xml`, `library-screen.png`
- `signing-recovery-cleanup-verified.json`, `signing-local-cleanup.json`

Signing inputs are private credentials, not test evidence. They must not be
included in a report, committed or published with the APK.
