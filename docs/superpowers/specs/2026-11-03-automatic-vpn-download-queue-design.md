# Automatic VPN download queue

Status: conversational design and written specification approved on 2026-11-03.

## Goal and confirmed requirements

The user wants downloads to carry out the requested work with little setup and
as few interruptions as possible. The Y700 investigation covers delayed queue
registration, ordinary download concurrency and the VPN download workflow.

Confirmed on 2026-11-03:

- A download request must appear immediately, including its preparation state.
  Users must not start the same request again on a per-work VPN preview.
- Remove per-work VPN selection and editable worker/range assignments.
  The app chooses profiles and contiguous chapter ranges.
- Tasks opens one launch modal. Its defaults must support starting without
  changing settings; concurrency and challenge policies are optional adjustments.
- Support a configurable global VPN worker limit from 1 through 10.
- Launch includes currently queued source chapter downloads and new requests
  arriving while that VPN run is active.
- Let an ordinary in-flight chapter settle before handing over its remaining
  work. Do not download a chapter twice or discard its queued intent.
- While a VPN run is active, the Tasks body shows a VPN-oriented queue.
- Diagnose on Y700 without clearing app data, library entries or downloaded files.
- Verify the changes and deliver a scoped commit and push. The unfinished
  logging feature and the separate library-query fix remain separate work.

## Current evidence

Y700 is a TB322FC running Android API 36. The installed package is
`io.github.tinywind.norea`, version 0.2.0 / code 2000. Its WebView does not expose
an app DevTools socket, and its package flags do not include `DEBUGGABLE`.

The inspected Tasks screen uses single-VPN automatic recovery and shows pending
per-work previews with another start action. It also shows an extraction timeout
and range-failure notices. Logcat contains repeated OpenVPN connection timeouts.
Those connection failures are distinct from accepting a download into the queue.

Code confirms two different concurrency rules:

- Ordinary background work reserves one executor from the foreground setting.
  The default of three therefore allows two background tasks. The actual Y700
  saved ordinary-concurrency value has not yet been read.
- VPN slots are fixed to two across Kotlin workers/services/activities, Rust
  validation/storage, TypeScript contracts, scheduler dispatch and settings.

New persistent batches enter the VPN interceptor when VPN mode is enabled.
It awaits runtime initialization and chapter catalogs before publishing drafts,
then waits for manual per-work start. Restored ordinary batches use
`persist: false` and bypass that interceptor. Library multi-work requests also
await queued work/chapter reads before admission. These are confirmed code paths;
the dominant wait for the user's newly added work still requires device timing.

Evidence: `.tmp/y700-download-debug-20261103/`.

## Default workflow

An ordinary download request remains an ordinary request until the user launches
VPN downloading. Tasks shows the accepted request even while storage publication
or catalog loading is pending. It distinguishes preparing from durably queued.

The VPN launch modal summarizes the current eligible works and chapter count.
It offers Start as the primary action. Optional settings reuse the last accepted
worker count, or the existing source-concurrency setting on first use, bounded
to 1 through 10. Default challenge handling selects another eligible profile.
An explicit user-selected pause policy remains available under optional settings.
Changing or dismissing the modal does not start connections or mutate the run.

Starting includes pending ordinary source chapter downloads and existing VPN
drafts. New source-download requests join the active run automatically. A run
does not adopt unrelated updates, imports, content-server sync or maintenance.
Media-repair operations remain on their existing separate path.

## Queue admission and ownership handover

Keep the existing scheduler, backend queue and canonical SQLite transaction path.
Do not replace them with a second queue database or browser persistence.

1. Publish request identity, work title and selected count before awaiting catalog
   reads. Duplicate clicks coalesce with already accepted chapter ownership.
2. Persist pending VPN ownership in the existing queue payload contract, using a
   batch-routing marker distinct from an enrolled plan/range. Update its canonical
   TypeScript and Rust definitions together. Ordinary leasing/removal must exclude
   both pending and enrolled VPN-owned jobs.
3. At VPN launch, fence new ordinary chapter starts for the transfer cohort.
   Await each in-flight chapter/content publication and its ordinary queue
   settlement before transferring that chapter. Ready queued work need not wait
   for an unrelated in-flight chapter or manual session. Leave unrelated source
   browsing and metadata work usable.
4. Claim only the remaining queued jobs, matching their existing identity and
   ownership. Publish their VPN plans and job ownership atomically. Do not delete
   ordinary jobs first and reconstruct them later without rollback protection.
5. Release an ordinary scheduler handle only after its owner has transferred.
   Late ordinary completion or cancellation must not remove the new owner's row.
6. On failure, retain each request under its last committed owner. Reopen ordinary
   dispatch for work that was not transferred; retain VPN-owned work for retry.
   Never fall back from an established VPN run to an ordinary route silently.

Every accepted request has one owner. Preparation, cancellation, enrollment,
restart and device restore must respect the same owner. Batch progress includes
preparing requests, not only already allocated native workers.

Catalog presentation may use the existing committed reader. Selection ownership,
final eligibility and write preconditions remain on the serialized writer.
Device timings determine which waits need changing; visible preparation alone
must not be presented as removing an unmeasured storage bottleneck.

## Automatic scheduling and recovery

A run shares its global worker budget and batch exclusion identity across works.
The app partitions selected chapters into ordered, non-overlapping contiguous
ranges. Selection gaps remain gaps; only requested chapters are acquired.
After enrollment, keep range membership and checkpoints stable during recovery.

Assign approved retained profiles automatically. Worker leases reserve the exact
profile/IP and generation. Exclude profiles reserved by another worker or the
foreground VPN; never take a busy connection. A worker processes its range in
order and releases its slot/profile after browser and tunnel cleanup completes.
Other waiting works can then proceed without a per-work start action.

The effective active count cannot exceed the requested global limit, ten native
slots, the eligible profile supply or the unfinished work. Create workers lazily.
Capacity changes affect new dispatch and chapter boundaries, not an in-flight
chapter or an open manual-verification session.

Recovery rules:

- Offline work waits for network recovery without excluding every profile.
- Recoverable tunnel/transport failures clean up the old generation, select
  another eligible idle profile and retry the same unfinished chapter.
- CAPTCHA/Cloudflare uses automatic replacement by default and preserves an
  explicitly selected pause policy. Authentication waits must settle before
  replacing the old route.
- An occupied-only pool waits for actual lease release rather than reporting
  exhaustion. Release and relevant eligibility changes wake it automatically.
- One failed pass through all eligible candidates pauses only the affected range
  with a reason. Healthy ranges continue. Do not loop endlessly over known failures.
- Local storage, SQLite and plugin/content errors are not evidence of a bad VPN.
  Preserve the request and report the actionable cause without rotating the
  entire profile pool for the same unrelated failure.
- Explicit pause/cancel is final until the user resumes or starts new work.
  Automatic recovery must not defeat that intent.

Reuse batch-wide exclusions and O/X verdict separation. Runtime failures do not
rewrite the user's approval or remove retained files. Preserve generation checks,
per-chapter deduplication and exact source-fetch routing for bodies and assets.

## Native worker contract

Extend the same isolated Android worker architecture to slots 0 through 9.
Register the required service/activity classes and distinct process identities;
do not route ten workers through two shared WebViews or shared proxy overrides.

Update Kotlin capability reporting, identity/queue parsing, worker arrays,
service/activity dispatch and lifecycle cleanup together with Rust slots,
identity validation, proxy allocation, TypeScript types and scheduler dispatch.
Keep range identity and monotonically increasing safe generations in every
request. Slots outside 0 through 9 remain invalid. Retain bounded IPC payloads,
private profile handling and existing manual-browser lifecycle guarantees.

No third-party plugin, new platform or source HTTP bypass is required.

## Tasks interface

Keep the existing Mantine components and app tokens. The launch modal has one
level and no per-work profile controls. Defaults and the current target count
must be readable without opening optional settings.

The active queue has a compact run summary followed by work groups. Each work
shows completed/total chapters and range rows with current chapter, progress and
state. Distinguish preparing, waiting for handover, waiting for a profile,
connecting, running, waiting for network, paused and completed. Read-only route
identity may be shown for diagnosis; it is not an assignment control.

Pause/resume/cancel operate on the indicated run/work/range. A single range
failure must not display as failure of the whole run. Ordinary non-VPN tasks
remain in a separate section; do not duplicate VPN chapters in the old flat list.
Use responsive app units, keyboard/focus semantics and English/Korean locale keys.

## Persistence and existing data

Reuse `chapter_download_queue`, `vpn_download_plan` and current issue records.
Pending routing is an addition to the canonical internal job payload, not a new
database column. Update queue leasing, cleanup and device-backup handling so a
pending VPN job cannot become an ordinary restored download accidentally.

Existing untagged ordinary jobs remain ordinary until explicitly adopted.
Existing enrolled VPN plans retain their ranges, checkpoints, profile attempts,
batch issues and user pauses. Restarts show interrupted work as resumable;
they do not clear completion state or require profile/range configuration again.
Do not alter registered migrations. Any discovered need for a schema change
requires an appended preserving migration and an explicit design revision.

## Y700 diagnosis and acceptance

Use a diagnostic build with the shipping application ID only after checking its
signer against the installed package. Use existing configured signing material
only with execution approval. A mismatch blocks installation; do not uninstall,
clear app data, bypass signing or substitute a different application database.

Before updating, settle active chapter publication and account for pending
in-memory previews in the old app. Do not assume those previews are durable.
Preserve their requests before any process-restarting update; otherwise stop
and report that blocker. Keep temporary build instrumentation under `.tmp/`
and exclude the unfinished logging feature from the diagnostic candidate.

Measure click/admission, backend persistence, catalog reads, plan publication,
worker allocation and native connection separately. Record counts and durations,
not credentials, cookies, profile bytes or private source URLs. Reproduce the
user's newly added work and compare its path with restored ordinary jobs.

Required checks before delivery:

- A large request appears as preparing before a held DB/catalog wait resolves.
  One start action suffices; repeated requests cannot duplicate ownership.
- Ordinary background downloads can use their configured count, including three,
  while interactive source work retains its existing independent execution path.
- Launch transfers queued work at chapter boundaries. Concurrent completion,
  cancellation, persistence failure and restart cannot lose or double-run jobs.
- Global limits of 1, 3 and 10 work across multiple plans, including connecting
  and closing leases. Slot 9 works; slot 10 is rejected across contracts.
- Available profiles are assigned without per-work inputs. Busy profiles wake
  waiters on release; all-excluded profiles stop only the affected range.
- Recoverable replacement retries the same chapter and preserves successful
  checkpoints. Offline recovery and explicit pause/cancel remain distinct.
- Modal cancellation has no execution side effects. Default launch requires no
  settings edits. No profile/range selectors remain on the execution surface.
- Populated queue/restart/device-backup checks preserve pending/enrolled routing,
  existing library state, files, metadata and read progress.
- Run focused/full frontend and relevant native/JVM checks, then Y700 acceptance.
  Report the actual device concurrency achieved and any profile/network limit;
  mocks alone cannot establish ten working device connections.

## Review and delivery

Review this written specification before creating the implementation plan.
Execution approval must cover the requested builds/tests, data-preserving Y700
update and final scoped Git operations. Do not commit a planning document alone
while the user's implementation and acceptance gate remains open.

Likely change surfaces are the chapter-download queue/runtime/coordinator,
`src/db/queries/vpn-download-plans.ts`, native `download_queue.rs` and VPN workers,
Android worker contracts/manifest, Tasks/VPN components, queue/device-backup
tests and locale files. Keep the staged library-query fix and logging work out
of these commits. Stage explicit paths or hunks and inspect the final diff.
