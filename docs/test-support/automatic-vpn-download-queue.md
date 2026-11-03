# Automatic VPN download queue verification

## Status

The feature-only candidate passed frontend, TypeScript and focused native checks.
One independent review and its behavioral fix pass are complete. The final signed
x86_64 APK passed the Waydroid UI and queue smoke checks below on Android 13.

Real relay downloads succeeded. The delivered ARM64 build was then tested on Y700
with the user's existing workload. Seven simultaneously connected worker tunnels
and 131 nonempty saved chapter files were observed. Ten connected tunnels and
uninterrupted recovery remain unverified because extraction failures stopped many
ranges. Y700 acceptance is incomplete.

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

## Y700 acceptance on November 3, 2026

The installed build comes from commit `f3a8d1f`, Android CI run `41574401749`.
The device is TB322FC, ARM64, Android SDK 36, with a 1904x3040 physical display.
Evidence is under `.tmp/y700-download-debug-20261103/y700-acceptance/`.

| Check | Observed result |
| --- | --- |
| Signed update | Matching signer, ARM64-only APK, app ID, ten worker component pairs and JNI getter verified before `adb install -r`; installed bytes match the CI checksum |
| Existing data | The library retained 121 works. The old app restored 13 queued works and 1,804 tasks before update; the new ordinary queue initially showed 1,800. The four-task difference is not fully reconciled |
| Actual connections | Seven connected tunnels in the first capture after the user stopped interacting. A separate 150-second sample observed at most four, then three and one. Worker processes for slots 0 through 9 existed, which does not prove ten connected tunnels |
| Stored chapters | New range checkpoints reached 131 across three works. Read-only file inspection found 2, 123 and 6 recent, nonempty `content.html` files in those work folders, matching each work's new checkpoint count |
| Global pause | Connections reached zero and cleanup settled. All 135 displayed range identities, selected counts and checkpoints remained unchanged, including 20 previously cancelled ranges and their explicit-pause markers |
| Global resume | Connections returned to two, then seven. Checkpoints had not advanced beyond the pre-pause total at the last observation, so post-resume chapter publication was not established |
| Final state | The run was left active, with five connected and two connecting. The main process and exact installed CI APK were unchanged. No Cancel all, manual force-stop, uninstall or data reset was used |

The 135 ranges include historical completed and cancelled plans. They are not a
count of new requests. The full accessibility tree includes offscreen work and
range nodes; conservation checks use those nodes rather than only visible cards.
The run added 104 ranges containing 1,796 selected chapters. At the controlled
pause, 131 were checkpointed and 1,665 remained. Four ordinary failed task rows
also remained visible with `Plugin VPN is unavailable`; they were not retried or
cleared. These observations do not resolve the earlier four-task count difference.

The following failures prevent full acceptance:

- Multiple ranges stopped with `webview_extract: timeout after 35000ms` while
  other ranges continued saving. A controlled Resume reproduced extraction
  failures and Chromium `ChildProcessConnection.start failed, trying again`
  messages. Their underlying cause is not established.
- `[object Object]` appeared again after controlled Resume, hiding the rejected
  value's details. `describeError()` stringifies non-Error objects; the original
  rejection payload was not captured, so its cause remains unknown.
- Slot 9's process was observed, but neither its buffered log nor a bounded live
  capture established a successful source request from that slot.

The initial launch included roughly 90 seconds of preparation and an error pause.
The user was also operating the device during that interval, so it is excluded
from exclusive timing measurements. The old APK exited before replacement with
a destroyed-mutex message in the crash buffer and EXIT_SELF/status 0 in Android
exit information; that event is not attributed to the delivered build.

## Y700 recovery follow-up on November 3, 2026

The follow-up candidate is commit `f9d9d13` from ARM64-only CI run `41597382971`.
Its source excludes the separate library and logging work. It is installed only
for this test; the additional fixes have not been merged or pushed to `0.2`.

- The feature-only suite and normal commit/push hooks passed 208 files and 2,733
  tests, with TypeScript exit 0. The frontend build passed with existing chunk-size
  and dynamic-import warnings.
- The formatter preserves serialized native error messages. Exact native scraper
  timeouts now use bounded range-local attempts without asserting a bad-IP verdict.
  Four independently reviewed defects were reproduced with failing tests and
  corrected: pause-policy reconnect loops, sibling assignment deadlock, reused
  reallow allowances after restore, and a timeout/Pause persistence race.
- The GitHub artifact digest, APK checksum, existing signer, ARM64-only libraries,
  ten worker component pairs, retained JNI getter and native build identity passed.
  The content-hashed recovery asset matches the CI build and its embedded asset
  name. The APK was installed with `adb install -r`; installed bytes match the
  verified checksum. No uninstall, app-data reset or manual force-stop was used.
- Before the update, the four retained ordinary failures were retried through
  their public controls and joined four additional durable ranges. After update,
  all 139 range identities, 3,913 historical selections, 1,195 checkpoints, 901
  unfinished selections and 20 cancelled ranges with explicit-pause markers
  remained. The library still contains 121 works. These four retries do not
  reconcile the earlier 1,804-to-1,800 count difference.
- All 62,366 inventoried content and metadata paths remained present with unchanged
  sizes and modification times before resuming. This includes 55,193 HTML bodies.
  The inventory is not a full-content hash comparison.

The first controlled six-minute measurement did not pass acceptance. Across 24
captures, at most seven tunnels were connected and 17 ranges changed profiles 37
times automatically, but checkpoints stayed at 1,195. No `[object Object]` was
visible. Native page-start/page-finish events continued without extraction results;
the capture recorded 29 extraction timeouts and one
`net::ERR_TUNNEL_CONNECTION_FAILED`. No Chromium child-start failure appeared in
this window.

Before the later controlled pause, checkpoints reached 1,197. Read-only inspection
found exactly two new, nonempty HTML bodies for source work `63712`, chapters 776
and 777. All prior inventoried paths remain. These publications occurred after the
six-minute window and do not turn that window into a throughput pass.

The observed tunnel-navigation error had stopped its range instead of trying the
next route. An additional regression reproduced that break, and the feature-only
suite now passes 2,736 tests with TypeScript exit 0. Only that exact native tunnel
error joins the bounded recovery path; certificate errors remain explicit stops.
The temporary CI branch also contains a metadata-only native diagnostic for the
next hardware run. It records readiness, visibility and bridge types, without page
text, cookies, credentials, full URLs or request bodies. Further native behavior
changes require that evidence.

Follow-up evidence is under `.tmp/y700-download-debug-20261103/y700-fixes/`.

## Handoff after testing was stopped

The user stopped further debugging and requested committing and pushing the
current changes across the Norea projects. Hardware acceptance remains incomplete.
The installed Y700 APK is still the temporary diagnostic build from `0c019ef`,
with checksum `7add9684dccc125505bb6d1b13555da13731b221d41e9cf37376658b17365739`.
The installed Newtoki Novel source is the local metadata-only probe
`1.0.20-y700-probe.1`; its base URL and disabled paid-unlock setting were retained.
Remove both temporary probes before final product delivery.

The plugin probe's three-minute sample advanced checkpoints from 1,721 to 1,727.
All eight extraction requests in its log succeeded within 35 seconds. Its empty
shadow-root snapshots were transient loading states, so they do not establish a
plugin defect. No behavioral change was made to the private plugin checkout.

Read-only profile inspection found 19 saved profiles. The original run's batch
excluded 16: 14 connection failures, one tunnel loss and one CAPTCHA requirement.
Another profile was reserved for foreground use, leaving two profiles available
outside those restrictions. The user approved reallowing only the 14 original
connection-failure records. Twelve reallows were confirmed before cancellation;
the other two were not completed. Device-wide O/X, CAPTCHA/tunnel-loss exclusions,
explicit holds and cancellations were not changed by that operation. Its action
journal is in the private plugin checkout at
`.tmp/y700-capture-20261103/approved-reallow-actions.json`.

The last completed queue observation before reallowing showed 139 ranges, 3,913
historical selections, 1,765 checkpoints, 42 completed ranges and 331 unfinished
selections. Later progress and added files have not been reconciled independently.

## Remaining hardware and network checks

1. Measure the originally delayed Y700 work, separating admission, persistence,
   catalog read, plan publication and connection times. The preparation indicator
   does not by itself prove a reduction in storage latency.
2. Measure ordinary concurrency three, sustained VPN throughput and ten overlapping
   live tunnels with enough usable profiles. Seven live tunnels were observed on
   Y700. Successful slot 9 traffic still needs separate evidence.
3. Exercise physical offline/online recovery, challenge replacement and manual
   challenge clearing. Automated recovery regressions passed; those network cases
   were not repeated end to end on the final Waydroid APK.
4. Verify calibrated Y700 scaling and memory use under sustained load. A process
   RSS observation includes shared pages and is insufficient for memory acceptance.

Physical offline testing was not attempted because the current Y700 control path
is wireless ADB over the device's network connection. Reconcile the original
workload and diagnose the extraction and error-detail failures before declaring
the hardware run complete.

Deferred review observations are launch work/chapter counts, nameless fallback
localization, a baseline catalog diagnostic, the work progress accessible label
and pre-existing Kotlin capability-map typing debt. They are outside the completed
behavioral fix pass.
