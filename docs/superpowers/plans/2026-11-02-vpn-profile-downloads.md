# Saved VPN Profiles and Contiguous Download Ranges

> Where this document differs, `docs/superpowers/specs/2026-11-03-ui-ux-page-structure-design.md` §2.2.5 (System B: VPN as a per-source route) governs. New plans split work into 50-chapter chunks (V3) and may lease tested servers (V4).

> This document began as a planning-only request. The user subsequently authorized implementation, Waydroid verification, commits and push. Implementation and acceptance results are recorded in `docs/test-support/waydroid-vpn-profile-downloads.md`; the proposed defaults and original-code descriptions below preserve the planning context rather than describe the final checkout.

**Goal:** Retain user-approved VPN Gate profile files and support challenge recovery, with a proposed parallel mode that assigns contiguous chapter ranges to isolated VPN/browser workers.

**Architecture:** A native profile vault owns bounded private profile files. Persisted download ranges own ordered chapter identities and checkpoints. Each parallel worker owns one tunnel, proxy route and source browser session; the scheduler preserves per-range order and isolates challenges and recovery.

**Spec:** The behavior contract below distinguishes confirmed requirements from proposed defaults and platform feasibility gates.

**Tech stack:** Existing React/Mantine, Zustand, Tauri/Rust, SQLite/Drizzle, OpenVPN engine and Android WebView. No replacement scraper, bare HTTP source path or new third-party plugin is assumed.

## Confirmed requirements

- Settings -> Data controls how many recently O-marked profile files are retained; 10 and 20 are examples, not the simultaneous connection count.
- O stores a usable profile file; X removes it from the retained pool.
- Tasks exposes automatic VPN use and separate stop/next-profile policies for CAPTCHA and Cloudflare blocks.
- Switching disconnects the affected VPN, connects its replacement and resumes unfinished work after actual source verification.
- Exhausting one pass through usable profiles stops the affected work and raises a notification; no endless wraparound.
- Consider parallel downloads from one source with a configurable contiguous range per VPN. Do not distribute chapters one at a time in round-robin order.
- In parallel mode, an exhausted blocked range stops while other ranges continue. This was explicitly confirmed.

## Current code and constraints

| Existing surface | Relevant behavior |
| --- | --- |
| src/db/queries/vpn-gate-server-verdict.ts:25 | O/X is stored by server IP with an update timestamp; it does not save profile bytes |
| src/routes/settings.tsx:494 | Both the current-profile control and Finder call the same verdict mutation |
| src-tauri/src/plugin_vpn/finder.rs:225 | Finder profile bytes live in an in-memory cache; the selected candidate may disappear after refresh/restart |
| src-tauri/src/plugin_vpn/state.rs:186 | Only plugin-vpn/profile.ovpn is persisted as the active profile |
| src/lib/plugin-vpn.ts:242 | A profile switch preserves blocked routing and prevents the old profile's recovery from winning |
| src-tauri/src/plugin_vpn/proxy.rs:79 | One proxy router selects one direct, blocked or tunnel route |
| src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidVpnProxy.kt:26 | ProxyController configures the shared WebView proxy |
| src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidScraperBridge.kt:819 | Browser profiles are keyed only by source ID, so two workers for the same source would share a session |
| src/lib/tasks/source-access-gate.ts:7 | Blocks have a source/site scope, origin task and revision; parallel workers are not distinguished |
| src/lib/tasks/scheduler.ts:755 | Challenges suspend matching work and later allow one verification request |
| src/lib/tasks/scheduler.ts:907 | Source access can be confirmed before later media/storage work finishes |
| src-tauri/src/download_queue.rs:33 | Native jobs preserve batch identity in JSON, but restoration creates new runtime batch handles |
| src-tauri/src/device_backup.rs:21 | Device backups include one active profile file, not a retained profile pool |

Android's current [ProxyController documentation](https://developer.android.com/reference/androidx/webkit/ProxyController) says its proxy override applies to all app WebViews. Separate WebView profiles isolate browser state but do not establish separate proxy routes. The AndroidX [class reference](https://developer.android.com/reference/androidx/classes) describes the override as process-specific. Separate Android worker processes are therefore the candidate design, not a proven working implementation.

Merely increasing the existing scraper executor count or changing the global proxy before each request cannot provide concurrent independent VPN routes. Host-based proxy rules also cannot distinguish workers downloading from the same site.

## Behavior contract

### 1. Retained profiles

Proposed defaults: retain 20 profiles, integer setting 1..100; automatic VPN download mode initially off. The retention limit and simultaneous worker limit are separate.

- Follow the existing IP-level O/X identity: retain one exact approved profile per server IP. Approving a newer profile for that IP replaces its saved bytes and moves it to the most-recent approval position. This is a proposal, not a new TCP/UDP-level verdict system.
- A Finder-row O captures that row's exact native candidate bytes. A current-profile O captures the actual active profile under the native operation lock. Validate IP, profile hash and VPN Gate provenance; do not substitute another protocol or refreshed candidate silently.
- Save only complete validated inline profiles using the existing 1 MiB profile limit and private-file publication rules. Return metadata to the UI, not credentials or profile contents.
- X, or clearing the approval, immediately revokes future allocation and removes the retained file. File cleanup failure must leave a non-allocatable entry and a visible error, never an apparently usable stale profile.
- Retention removes the oldest saved approval. Automatic use does not promote recency. Connection failure or a challenge does not change the user's O/X verdict.
- Existing O rows do not imply that their historical bytes still exist. Preserve those verdicts, distinguish missing files from retained profiles, and require an available exact candidate/current profile before saving.
- Serialize O/X, capacity changes and profile leases. Recheck verdict, retained entry and hash before assignment/connection. Crash recovery excludes uncommitted/orphaned files and any file without a current O verdict.
- Never delete the user's externally imported .ovpn original. Manually imported profiles currently have no O/X identity; extending them is outside the initial vault scope.

### 2. Modes and settings

Use one Tasks mode selector: Off, Single VPN with recovery, Parallel VPN ranges. CAPTCHA and Cloudflare each select Pause or Next profile. Default both to Pause; the user explicitly enables replacement.

Settings -> Data contains retention capacity, saved/maximum count and a compact list of saved server IP, protocol and approval time. Tasks contains mode, simultaneous-worker count, the two challenge policies and per-work range assignment.

Start feasibility verification with two simultaneous workers. Set the shipping maximum only after measuring background stability, memory and connection isolation; retaining 20 files does not promise 20 live tunnels.

The configured connection timeout should reuse the existing bounded VPN connection behavior. Do not add unrelated random timing, fingerprint changes, CAPTCHA solving or hidden retries.

### 3. Range allocation

Example: for chapters 1..300 and three workers, suggest A=1..100, B=101..200, C=201..300. Users may edit start/end boundaries and choose an eligible saved profile before starting.

- Partition each work independently in its canonical chapter-list order. Display chapter titles/numbers, but persist exact chapter IDs and boundaries; decimal chapter labels, extras and duplicate display numbers are not array indexes.
- Auto-split the selected ordered span into balanced contiguous intervals. Reject overlaps, reversed/empty ranges and unassigned requested chapters before starting.
- Each worker processes at most one chapter at a time: finish or settle chapter N before starting the next eligible chapter in that same interval. Keep that chapter's page and source-owned assets on the same worker route.
- Already-downloaded or unselected chapters may be skipped within their original interval; filtering must not renumber or redistribute the remaining chapters across VPNs.
- Do not rotate a shared global chapter queue, rebalance on speed changes, or steal individual chapters from another worker.
- A finished worker stays finished. Any later range reassignment is explicit and moves a contiguous unstarted interval; it never changes a running chapter's owner.
- Freeze range membership at start. Metadata refresh, newly discovered chapters, queue restoration or reordering cannot silently change an accepted range.
- The existing chapter write guard remains authoritative: normal download, repair, cleanup and parallel workers cannot publish competing copies.

### 4. Worker isolation and profile leases

A download worker owns its VPN tunnel, loopback proxy, browser storage/cookies, executor identity and cancellation generation. Browser identity includes the source and VPN profile; browser work for the same source on another VPN is a different session.

- Reserve each saved profile for at most one active worker. Profiles used by another worker, or the foreground/default connection, are unavailable as spares.
- Ordinary browsing/metadata uses its existing default route. Replacing one download worker's tunnel must not change that route or disconnect other download workers.
- The user's explicit VPN-off action cancels automatic connection attempts; automatic recovery cannot reconnect behind that action. UI must distinguish the default VPN from active download workers.
- A retained profile removed while in use cannot be reassigned. Stop new chapter dispatch at the owning worker's boundary and show that its profile was removed; do not tear down unrelated workers.
- Preserve manual pauses. Transport recovery holds are distinct from user pause controls and never clear them.
- Cookie/session state is not copied between VPN workers. A source requiring login may need manual authentication in each worker's own browser session.

Candidate Android implementation: separate non-exported worker services/activities in distinct app processes, initialized with unique WebView data directories before any WebView creation. The Rust host manages separate tunnel/proxy instances; bounded Binder messages carry extraction requests/results, not shared UI state. A manual verification action foregrounds the owning process/profile. Prototype this before committing to the architecture.

Windows requires an independent WebView2 environment/proxy isolation check. Do not advertise parallel mode on a platform until its route/session isolation has been demonstrated.

### 5. Challenges and replacement

- Only a structured, source-scoped CAPTCHA/Cloudflare result from an enrolled batch triggers this policy. Generic 403, 404, timeouts, storage errors and metadata-only failures are not automatically reclassified as challenges.
- Existing external-resource scope protections remain intact. Do not turn an arbitrary CDN URL into a trusted source challenge just to enable switching.
- Pause policy retains the chapter/range and opens the existing manual-verification flow on request.
- Next-profile policy pauses the affected worker, settles its current requests, keeps its route blocked, releases its failed tunnel, reserves an unused saved profile and connects that profile. No direct-network fallback.
- Retry the blocked chapter/operation on the new worker route. Tunnel-connected status alone does not clear the source block.
- Track one recovery episode per range. Persist attempted profile IDs and in-flight attempt before connecting. Each eligible spare is tried at most once; another worker's leased profile is not disconnected or stolen.
- A repeated CAPTCHA changing to Cloudflare, a new block revision, or a transient body success before another asset challenge does not reset the attempt budget. Reset only after the blocked operation and canary chapter have settled without another protection challenge.
- If a new challenge kind is configured to Pause, stop that range immediately. Other workers remain untouched.
- No spare, all attempts exhausted, authentication requiring input or invalid profile leaves the range paused with an actionable reason. Preserve failed-profile user verdicts.
- A physical offline event waits for network return without consuming every profile. Manual mode changes, cancellation, native worker death and process restart invalidate stale completion callbacks.
- Restore range checkpoints and attempts after restart, but do not silently start a new recovery lap. An interrupted replacement remains paused until an explicit resume.
- A manual CAPTCHA browser temporarily owns that worker. Automatic replacement cannot switch its IP underneath the user's interaction.

### 6. Tasks UI and notifications

Each range row shows work, chapter interval, assigned VPN, current chapter, progress, connection/recovery status and independent pause/resume/cancel controls. Preview all ranges before starting.

Keep the existing aggregate download and metadata notifications. Verification/exhaustion identity must additionally distinguish worker/range and generation: resolving range A must not remove range B's notice. A tap opens the correct worker session; a stale action cannot reconnect an old profile or open a different range. Successful verification removes only that notice.

During automatic attempts, show progress in Tasks rather than creating a new notification for every VPN switch. Notify when manual action or exhausted candidates stop a range. Existing toast appearance and completion/failure lifetime remain unchanged.

## Approach choice

1. **Recommended candidate:** isolated worker routes and browser sessions, contiguous fixed ranges, per-range replacement from an unleased spare pool. This satisfies real concurrency but needs native platform work and a feasibility gate.
2. **Single tunnel with sequential ranges:** simpler and useful for the original recovery request, but not simultaneous multi-IP downloading. Keep it as a separate selectable mode, not an implementation of parallel mode.
3. **One browser/global proxy with round-robin jobs:** reject; it neither provides independent simultaneous routes nor preserves sequential ownership.

## Implementation sequence

### Task 1: Prove two isolated Android workers

**Files to inspect/modify in the prototype:** src-tauri/src/plugin_vpn/state.rs, engine.rs, proxy.rs; src-tauri/gen/android/app/src/main/java/io/github/tinywind/norea/AndroidVpnProxy.kt, AndroidScraperBridge.kt; app/src/main/AndroidManifest.xml. New worker service/activity entrypoints belong alongside the existing Android modules. Keep probe artifacts under .tmp/vpn-profile-workers/.

- [ ] Build an authorized x86_64-only QA APK with two independently routed workers and unique browser storage.
- [ ] Use two controlled VPN exits and a controlled source to log actual egress identity, chapter order and cookie identity. Prove both transfers overlap in wall time; two configured tunnel names alone are insufficient.
- [ ] Verify page navigation, JavaScript fetch, redirects, images, recovery requests and manual CAPTCHA UI use the owning route.
- [ ] Disconnect worker A while B is downloading; A must not fall back directly, B and the foreground route must continue.
- [ ] Repeat with the app hidden, screen off/on and process recreation. Measure memory, UI latency and worker recovery.
- [ ] Record pass/fail and the supported worker cap. If isolation or background WebView operation fails, stop parallel implementation and revise the architecture; do not replace source browsing with bare HTTP.

### Task 2: Retain approved profile files

**Create:** src-tauri/src/plugin_vpn/saved_profiles.rs; src/lib/plugin-vpn-profiles.ts and tests.
**Modify:** src-tauri/src/plugin_vpn.rs, state.rs, finder.rs, src-tauri/src/lib.rs; src/db/queries/vpn-gate-server-verdict.ts; src/routes/settings.tsx and src/components/PluginVpnFinder.tsx.

**Interfaces:** native list/capture/revoke/set-limit/apply operations expose SavedVpnProfile metadata (stable ID, IP, protocol, hash, approval sequence). capture takes an exact Finder candidate ID or expected active-profile hash. The TS verdict service serializes file/DB changes and returns the persisted verdict plus saved-file result.

- [ ] Test O/X/unmarked transitions, duplicate IP, repeated approval, exact TCP/UDP selection, retention 10/20, shrinking limits, unavailable historical profiles and restart.
- [ ] Implement bounded atomic native publication and fail-closed reconciliation with current O verdicts. Serialize allocation against removal and replacement.
- [ ] Test write/delete failure, hash mismatch, invalid profile, revoked in-flight selection and crash windows.
- [ ] Keep file contents private and preserve external imported originals.

### Task 3: Persist and schedule ordered ranges

**Create:** src/lib/tasks/vpn-download-ranges.ts and tests; src/db/queries/vpn-download-plans.ts and tests.
**Modify:** src/lib/tasks/chapter-download.ts, task-types.ts, scheduler.ts, source-executor-leases.ts; src-tauri/src/download_queue.rs; src/db/schema.ts and an appended ordered SQL migration registered in src-tauri/src/database.rs.

**Interfaces:** planVpnDownloadRanges accepts a source/work and ordered selected chapter identities plus editable interval/profile assignments. Persisted plans and ranges own stable IDs, chapter membership/order, checkpoint, pause state, assigned profile and recovery episode. Queue jobs reference a stable range ID independently of temporary runtime batch IDs.

- [ ] Test 1..300 splitting, unequal sizes, extras/decimal labels, holes, fewer chapters than workers, overlaps, uncovered selections and already-downloaded chapters.
- [ ] Enforce one in-flight chapter per range and a bounded total worker count; keep the existing per-chapter write protections.
- [ ] Persist range/job publication transactionally. Queue restoration preserves original range ownership and attempted-profile history.
- [ ] Test refresh/reordering, cancellation, interrupted publication, cleanup/repair overlap and exact-once chapter settlement.
- [ ] Append a schema migration; preserve populated existing databases and queued ordinary downloads. Do not edit registered migration SQL.

### Task 4: Route source sessions and recover individual ranges

**Create:** src/lib/tasks/vpn-download-coordinator.ts and tests.
**Modify:** src/lib/plugin-vpn.ts, plugin-vpn-lifecycle.ts, plugin-vpn-traffic.ts; the native worker/tunnel modules from Task 1; src/lib/tasks/source-access-gate.ts, source-access-coordinator.ts, source-tasks.ts and scheduler.ts; internal plugin fetch/executor context and scraper IPC boundaries.

**Interfaces:** a worker lease binds rangeId, profileId and generation; all internal source requests carry that trusted execution identity. Existing source plugin APIs stay unchanged. Challenge scopes extend source/site identity with the worker when present. acquire/release and connection attempts are serialized per worker/profile.

- [ ] Test two lanes on one source with independent cookies, requests, challenge revisions and manual browsers.
- [ ] Implement the recovery sequence and one-pass budget; do not scan truncated task presentation snapshots to find active ranges.
- [ ] Test simultaneous challenges, no spare, leased spares, changed challenge kinds, body success followed by asset challenge, connection failure, offline transitions, X during replacement and stale completions.
- [ ] Preserve user pauses and other workers; suspend ordinary reconnect logic for a worker while replacement owns it.
- [ ] Keep manual-browsing/default VPN behavior intact and ensure all explicit-off/cancel paths invalidate pending reconnects.

### Task 5: Add the two UI surfaces and range-specific actions

**Create:** src/components/VpnDownloadSettings.tsx, src/components/VpnDownloadRanges.tsx and focused tests.
**Modify:** src/routes/settings.tsx, src/routes/tasks.tsx, src/store/plugin-vpn.ts, src/lib/tasks/source-access-notifications.ts, android-notifications.ts and native action validation; strings/languages/en/app.json and strings/languages/ko/app.json.

- [ ] Implement retention settings and accurate saved/unavailable counts.
- [ ] Implement mode/policy selection, supported parallel-count selection, automatic contiguous suggestions, editable assignments and explicit start confirmation.
- [ ] Test range A pause/exhaustion while B continues, invalid/overlapping ranges, disabled unavailable profiles and setting changes during an active run.
- [ ] Route notification actions to the matching source/range/profile generation and remove only resolved notices.
- [ ] Keep per-progress rendering bounded; test large plans without materializing every chapter as a visible UI row.

### Task 6: Backup, verification and delivery

**Modify:** src-tauri/src/device_backup.rs, native profile export/restore, src/lib/content-sync/device-backup.ts and related tests, docs/release-compatibility.md and docs/plugins/contract.md. Add docs/test-support/waydroid-vpn-profile-downloads.md when device verification is actually performed.

- [ ] Extend full-device backup to include the retained vault with validated manifest entries and bounded sizes; increment the current device-backup format for its changed contract. Restore profiles/settings/DB coherently, roll back failures and restore range sessions paused without live leases.
- [ ] Keep portable metadata backups and source cookies outside this profile-vault archive; never persist session-only VPN passwords.
- [ ] Run relevant TypeScript, Rust and Android tests, then full required checks after implementation authorization. Include migration and backup preservation coverage.
- [ ] Build only the requested target: pnpm exec tauri android build --apk --debug --target x86_64 for Waydroid.
- [ ] Test single recovery and parallel ranges using controlled challenge fixtures plus authorized real VPNs. Verify egress, strict per-range ordering, uninterrupted sibling ranges, one-pass exhaustion, matching manual WebView, background operation, restart and payload correctness.
- [ ] Run relevant project IPC, source-fetch, storage/migration, notification, localization, architecture and UI checks.
- [ ] Commit native/storage and UI changes coherently on 0.2 and push only when explicitly authorized. A successful probe is not completion of the product feature.

## Review focus

1. Global proxy or cookie sharing that makes two apparent workers use the same route/session: Task 1 and Task 4 prove isolation.
2. Queue restoration or metadata refresh silently changing chapter ownership: Task 3 fixes persistent membership and tests recovery.
3. Another worker losing its active VPN because a blocked range takes its profile: Task 4 tests exclusive leases.
4. Body-only verification or new revisions resetting a failing asset's rotation budget: Task 4 tests canary settlement and persisted attempts.
5. Notification/manual-browser actions targeting the wrong profile after a switch or restart: Task 5 validates range and generation.

## Planning status

Only this plan was written. No implementation, build, tests, commits, VPN connections or device mutations were performed in this planning turn. Parallel mode remains contingent on the two-worker isolation probe. The user confirmed one-pass exhaustion and continuing unaffected ranges; capacity 20, IP-level retention, worker cap and the process architecture are proposed implementation choices.
