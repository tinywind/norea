# Batch-wide VPN profile recovery

## Confirmed requirements

The user requested these additions on 2026-11-02:

- A profile that encounters a problem is excluded from its download batch,
  including every other worker in that batch. Other batches are unaffected.
- Preserve the failure reason and expose it for later user review. Automatic
  exclusion must not silently overwrite the user's O/X verdict.
- Settings -> Data -> VPN provides a profile-management modal covering O/X
  verdicts and profiles with runtime problems. Users can change their decisions.
- CAPTCHA/Cloudflare replacement cancels the old execution and authentication
  wait, settles its resources, disconnects, then connects another profile.
- The user explicitly chose retrying the same chapter on the replacement VPN.
  Do not skip the chapter or count the cancelled execution as downloaded.
- When acceptable profiles are occupied, wait for a worker to finish and release
  one instead of declaring the pool exhausted or taking its active connection.

## Current gaps

- `vpn-download-coordinator.ts` stores attempts per range. It does not share
  batch-wide exclusions or preserve structured profile failure reasons.
- Connection failures can rotate within a range, but ordinary chapter failures
  stop it. No common failure classification drives pool exclusion.
- Recovery selection filters occupied profiles before testing exhaustion. This
  can stop a range whose remaining acceptable profiles are merely busy.
- `SavedVpnProfilesSettings.tsx` lists retained files inline. X-only records and
  runtime failures are not a unified management surface.
- `cancelSourceAccessWait` cancels the blocked task and tries subsequent work.
  VPN recovery must share its cancellation/reset guarantees while retaining the
  same chapter payload, as confirmed by the user.

## Recovery state

Persist a batch identity shared by all of its plans. A batch exclusion records
the saved profile ID/hash and IP, cause, timestamp and originating range/worker.
Persist the latest problem information for profile management after the batch
finishes. Do not retain raw request headers, cookies, credentials or unredacted
challenge URLs in that history.

Reserve and select profiles against the shared exclusion state. Persist a new
exclusion before releasing the failed lease, then recheck eligibility after any
await that can allow a competing worker or user action to change it. A stale
completion must not exclude a newer profile generation. A stale UI action must
not clear a failure recorded after the dialog's snapshot.

The proposed identity rule excludes the IP within the batch and records the
exact failed file hash. Replacing the retained file for the same IP must not
silently evade the batch exclusion. Explicit user reallow is required.

### Failure classification

Proposed automatic exclusion causes are CAPTCHA, Cloudflare, tunnel connection
failure, unexpected tunnel loss and a confirmed VPN/source transport failure.
Preserve the existing stop-versus-replace policy for each challenge kind; the
automatic replacement sequence applies when that policy is next-profile.

Whole-device offline state, explicit pause/cancel, local storage/SQLite errors,
missing content and plugin parse errors do not by themselves prove a bad VPN.
Keep their existing pause/failure handling instead of banning every profile for
the same unrelated problem. This classification and the IP identity rule are
review points before implementation.

## Replacement sequence

1. Capture and persist the exact owner's failure and batch exclusion.
2. Invalidate its old execution and authentication revision. Reuse the existing
   force-stop cancellation/reset behavior without advancing the chapter.
3. Await task/source-request settlement, browser close and native tunnel/lease
   cleanup. Keep sibling ranges and manual sessions untouched.
4. Select an eligible idle profile or enter profile-availability wait.
5. Connect/configure a new generation and retry the same frozen chapter payload.
   Checkpoint and successful counts advance only after content/assets settle.

Do not call a generic force-stop action that drains the next chapter on the old
route. Preserve the shared per-chapter dedupe ownership and write protections.

## Waiting and exhaustion

- An eligible idle profile can be reserved immediately.
- If eligible profiles exist but are leased, show a profile-wait state and wake
  the range after actual lease cleanup. A sibling completing a chapter while
  remaining connected does not make its profile idle.
- The waiting range releases its obsolete connection/slot and retains its fixed
  chapter range/checkpoint. It never takes another range's chapters or profile.
- If every remaining profile is excluded, X-marked or unavailable, pause with a
  specific reason. Waiting cannot repair a pool containing only excluded profiles.
- User reallow or a newly available approved profile can wake an eligible waiter.
  Do not restart an exhausted failure pass automatically without that change.

## Settings modal

Keep retention capacity inline as a persistent setting. Add one management
button opening a single modal, with no nested modal chain.

Rows combine saved files, verdict-only O/X records and recorded runtime problems.
Show user verdict separately from batch exclusion, plus file availability,
failure cause/time and affected batch/range. Offer O, X and clear-verdict actions,
and an explicit reallow action for an excluded batch. X retains its existing
global file-removal behavior; automatic exclusion keeps the file for review.
O requires an exact validated profile file. A verdict-only row without that file
must explain that the profile needs to be obtained again rather than inventing
an approved file from its IP. Historical causes remain visible after a decision.

## Persistence and compatibility

Append an ordered database migration after version 2. Do not modify registered
migration SQL or reset existing databases. Backfill batch membership from stored
job ownership where unambiguous; keep unrelated or ambiguous plans separate.
Preserve frozen jobs, checkpoints, attempted profiles and user pauses.

Reuse canonical TypeScript/Rust contracts for batch state, problems and actions.
Include the new database-owned records in normal device snapshots. Preserve the
existing interrupted-restore fence, worker settlement and native file validation.
No plugin API, source HTTP bypass, live-lease clearing or cookie copying is needed.

## Verification and delivery

- One worker's exclusion prevents reuse by another plan in the same batch, but
  does not alter another batch's O verdict or eligibility.
- Concurrent failures/exclusions and stale reallow actions cannot reopen a newly
  failed profile. Restart preserves exclusions and recorded causes.
- Replacement after CAPTCHA/Cloudflare/tunnel failure settles the old owner,
  retries the same chapter once on the new owner and leaves siblings running.
- Occupied-only pools wait; lease release wakes them; all-excluded pools pause.
- The management modal covers retained O entries, X-only entries, runtime causes,
  exact-file approval, revocation and explicit batch reallow.
- Populated database upgrades, full-device backups and ordinary native rollback
  preserve the new records and the existing data-preservation guarantees.
- Run focused/full tests and latest-source x86_64 Waydroid acceptance. The QA APK
  built before these requirements is only a baseline and cannot prove them.
- Finish the whole-feature review, coherent commits and push after acceptance.
  Do not commit a planning document separately from the user's completion gate.
