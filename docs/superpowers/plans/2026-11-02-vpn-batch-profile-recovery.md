# Batch-wide VPN profile recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. The user explicitly requested design refinement, implementation and tests without further approval prompts. Keep delivery commits until the complete feature is accepted.

**Goal:** Prevent reuse of a failed profile anywhere in its batch, preserve its cause, and finish the requested management and waiting behavior.

**Architecture:** Persist a batch identity on existing plans and a batch/IP problem record separate from user O/X verdicts. The coordinator excludes pending/persisted failures before releasing their old lease, and reloads the same state before allocating after restart. Existing generation-scoped task/browser/tunnel cleanup remains authoritative.

**Tech stack:** Existing SQLite/Drizzle, TypeScript coordinator/runtime, Mantine, Rust/Tauri and Android worker services.

**Spec:** `docs/superpowers/specs/2026-11-02-vpn-batch-profile-recovery-design.md`

## Global constraints

- Retry the same chapter after replacement; do not advance its checkpoint on cancellation.
- User O/X verdicts are independent of automatic batch exclusion. Other batches are unaffected.
- Append migration 3; keep registered migration 2 immutable and preserve existing app data.
- Retain completed worker/restore safety changes and plugin-owned HTTP routing.
- Keep temporary artifacts under `.tmp/vpn-profile-workers/`; use only the isolated x86_64 QA package on Waydroid.

## Task 1: Shared exclusion and cause persistence

**Files:** `src/lib/tasks/vpn-download-types.ts`, `vpn-download-coordinator.ts` and tests; `src/db/queries/vpn-download-plans.ts` and tests; `src/db/schema.ts` and tests; new `src/db/queries/vpn-download-profile-issues.ts`; migration `0003_vpn_download_profile_issues.sql`; `src-tauri/src/database.rs`; runtime wiring and its existing fixtures.

**Interfaces:** `VpnDownloadPlan.batchId`; canonical `VpnDownloadProfileIssue` with batch/profile/IP/owner/generation/cause/time/excluded/revision; runtime `loadProfileIssues(batchId)` and `recordProfileIssue(input)`; SQLite query functions with those contracts.

- [x] Add a coordinator regression: A fails on profile a, then B fails on b in the same batch. Their replacements must be c/d, never a/b. Another batch may still use a. Verify recorded causes and unchanged checkpoints.
- [x] Run it against current code and observe reused a instead of d.
- [x] Add a durable batch ID and batch/IP issue table. Validate exact current plan/range generation before recording; keep problem rows after plan deletion for management history. Do not store raw credentials, headers or challenge URLs.
- [x] Exclude in memory immediately and persist before releasing a failed lease. Reload issues before new/restored plan allocation. Recheck after awaited profile discovery. Do not clear exclusions just because per-range attempt history resets.
- [x] Cover connection failure, restart, pending persistence, stale ownership, cross-plan/cross-batch separation and ordinary offline/user cancellation controls.
- [x] Verify focused/full frontend, schema upgrade/reopen and relevant native migration/backup checks on Waydroid. No new full-suite failures; ten existing native environment failures remain documented.

## Task 2: Occupied-profile waiting and explicit reallow

**Files:** coordinator, runtime, profile-issue queries and their tests; range state labels/locales.

**Interfaces:** typed occupied-only wait, explicit revision-checked reallow and profile-change wakeup.

- [x] Reproduce occupied-only false exhaustion; keep the failed chapter frozen while another worker owns every healthy candidate.
- [x] Separate healthy/busy from excluded/unavailable candidates. Wake only after actual lease settlement; respect the global cap and user pauses.
- [x] Implement explicit CAS reallow without deleting history or allowing stale actions to clear a newer failure. An ordinary new pass must not silently override a batch exclusion.
- [x] Verify held cleanup, simultaneous exclusions/releases, restart and same-chapter continuation.

## Task 3: Profile management modal

**Files:** `SavedVpnProfilesSettings.tsx`, a focused modal component if needed, profile issue/verdict queries, locale JSON and tests.

**Interfaces:** one management surface combining retained files, verdict-only rows and issue history; exact-file O, X/clear and explicit batch reallow actions.

- [x] Keep capacity inline; open the requested single management modal.
- [x] Show user verdict separately from problem/batch eligibility, including cause/time and file availability.
- [x] Test O/X-only/problem rows, missing exact files, stale reallow and failed async actions.
- [x] Verify locale parity and the real modal in the latest-source QA APK.

## Task 4: Production-path acceptance and delivery

- [x] Rebuild x86_64 QA from the real entry, preserving the shipping application ID after packaging.
- [x] Exercise real VPN downloads, controlled challenge replacement, same-chapter retry, unaffected sibling, shared exclusion, occupied-profile reuse, restart and native full-vault restore on Waydroid. Record background/protected-provider/restore scope limits rather than claiming broader acceptance.
- [x] Record actual evidence and limits and perform one whole-branch review.
- [x] Fix confirmed defects with regression tests. Delivery uses separate native, frontend and documentation commits and the user's explicit push authorization.

## Delivery evidence

See `docs/test-support/waydroid-vpn-profile-downloads.md`, section Production
download and recovery acceptance. The final frontend run passed 203 files /
2,582 tests and TypeScript checking. Android JVM passed 162 tests; Waydroid
native reported 328 passed and ten unchanged environment failures. The real
APK also reproduced and verified fixes for cold Chromium initialization and
the last-candidate waiter transition. No second whole-branch review or expanded
release-target build was performed.

## Review focus

1. Two plans in one batch must not accidentally form independent exclusion pools.
2. A late failure or reallow action must not change a newer owner's eligibility.
3. Failed persistence must not release a profile for reuse while forgetting the failure.
4. A healthy occupied pool must wait without stealing fixed chapters or closing another worker's manual session.
5. Database upgrades and backup restoration must preserve exclusions without rewriting old migrations or source credentials.
