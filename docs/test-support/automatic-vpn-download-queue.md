# Automatic VPN download queue verification

## Status

The feature-only candidate passed frontend, TypeScript and focused native checks.
One independent review and its behavioral fix pass are complete. The final signed
x86_64 APK passed the Waydroid UI and queue smoke checks below on Android 13.

Real relay downloads succeeded. Three simultaneously connected worker tunnels and
ten simultaneously connected worker tunnels were not demonstrated. Y700 timing and
hardware acceptance are deferred at the user's request.

## Workflow

1. Request chapter downloads from a work or the library. Tasks shows preparation
   immediately, including requests waiting for a catalog or persistent queue write.
2. In Tasks, choose **Download with VPN**. Start without changing the defaults, or
   expand optional settings to choose 1 through 10 simultaneous connections and
   independent CAPTCHA/Cloudflare policies.
3. Start includes queued chapter downloads and requests added during the run. An
   ordinary chapter already running finishes publication before ownership changes.
   Other ready work transfers independently.
4. The VPN queue groups work and its assigned ranges. Profile and range assignments
   are read-only. Run, work and range controls identify their own pause, resume and
   cancellation targets. Global Tasks controls also affect VPN runs and preparation.

The default challenge policy tries another eligible profile for the same unfinished
chapter. Explicit pause policies remain available. A healthy connection is retained
through its frozen range; cleanup releases its slot and profile to waiting work.
Missing profiles wait automatically. Busy profiles and known failures are distinct.

## Preservation boundaries

- Pending intent uses the canonical job's `vpnBatchId`; enrolled intent retains
  `vpnPlanId` and `vpnRangeId`. No registered schema migration was changed.
- Pending work pause uses `vpnWorkPaused` in the existing queue JSON. Enrolled
  work pause and independent range pause retain separate reasons.
- Ordinary adoption compares the stored JSON and update timestamp atomically. A
  completed or explicitly cancelled chapter cannot be recreated by a late transfer.
- Pending and enrolled VPN rows cannot be leased or overwritten as ordinary work.
  Backup restoration preserves both ownership forms.
- Interrupted runs require Resume. A run pause does not overwrite independent
  range holds, and run Resume does not release a work-level hold.
- Cancellation waits for owned queue publication, task settlement and browser/tunnel
  cleanup. Cleanup failures remain visible and can be retried.
- A request still preparing when other work finishes remains part of the active
  run. Cancelling the run aborts those producers before ordinary fallback is possible.

## Automated evidence

Evidence is recorded under `.tmp/y700-download-debug-20261103/` and is not committed.

| Check | Observed result |
| --- | --- |
| Final feature-only frontend suite | 207 files, 2,707 tests passed |
| Final feature-only TypeScript check | Exit 0 |
| Waydroid native queue tests | 7 passed, including pending work-pause roundtrip |
| Waydroid native VPN worker tests | 15 passed, including ten isolated blocked proxy routes |
| Waydroid device-backup tests | 21 passed, including pending ownership restoration |
| Focused Android JVM policy and manifest tests | 22 passed |

These native tests execute the real queue, proxy, generation, cleanup and backup
logic. They do not establish ten working VPN tunnels. The clean candidate excludes
the unfinished library and logging changes in the development checkout.

## Local browser review

The temporary UI harness renders the real Mantine components with controlled test
snapshots and an isolated query cache. It does not provide a native VPN backend.
Lightpanda inspected the initial UI. The headed browser then checked:

- Korean launch dialog at 390 CSS pixels and a 375-pixel layout at 125% root scale.
- No horizontal document/dialog overflow or controls outside the horizontal viewport.
- Optional count 10 updates the displayed target without persisting settings.
- Escape closes the dialog, returns focus to the launch button and leaves settings
  unchanged. The dialog close control has an accessible localized name.
- English work/range presentation at 1280 CSS pixels.

These checks do not establish the Y700's current scale, native browser behavior,
multi-process memory use or real simultaneous VPN throughput.

## Waydroid acceptance

- The installed application ID and public signing certificate match the existing
  installation. Its exact APK digest matches the final feature build. An earlier
  replacement command returned 1, but inspection after the host reboot confirmed
  that the replacement had taken effect. The installation was not repeated.
- No uninstall or app-data reset was used. The original library work, 1/1 cached
  chapters and 18% stored reading progress survived the update and cold restarts.
  The cached chapter reopened with the reader's Offline label and its bookmark
  intact. A later reader scroll smoke advanced that test work to 20%.
- At 540x960, the launch modal starts at three with next-profile policies and no
  optional edits. Counts 1, 3 and 10 were accepted. Dismissing an unsubmitted count
  ten retained three; the saved count was restored to three after acceptance.
- A direct chapter request joined an already active run and waited visibly for an
  available saved profile. Work Pause survived cold restart. Run Resume retained
  that work hold; only work Resume cleared it.
- A tested public relay saved while occupied by foreground VPN remained unavailable
  to the waiter. Switching foreground relays released it, automatically started
  worker slot 0 and completed the waiting chapter through that saved relay.
- Three additional public-domain works were requested while the run was paused.
  Resuming the configured three-worker run completed all three. The captures show
  active and connecting lifetimes, but do not prove three overlapping live tunnels.
- A configured ten-worker run accepted new pending work with only three saved
  profiles. Cancel all during connection settled the run. Cold restart did not
  resurrect it or offer Resume for the cancelled work.
- The final application launch succeeded and the crash buffer contained no entries.

## Remaining hardware and network checks

1. Measure the originally delayed Y700 work, separating admission, persistence,
   catalog read, plan publication and connection times. The preparation indicator
   does not by itself prove a reduction in storage latency.
2. Measure ordinary concurrency three and simultaneous live VPN counts 3 and 10
   with enough approved profiles and sustained work. Record actual slot 9 traffic
   separately from the tested scheduler route and native component declarations.
3. Exercise physical offline/online recovery, challenge replacement and manual
   challenge clearing. Automated recovery regressions passed; those network cases
   were not repeated end to end on the final Waydroid APK.
4. Verify Y700 scaling, memory use and throughput when the device is available.

Deferred review observations are launch work/chapter counts, nameless fallback
localization, a baseline catalog diagnostic, the work progress accessible label
and pre-existing Kotlin capability-map typing debt. They are outside the completed
behavioral fix pass.
