# Filesystem metadata v1 implementation plan

> Execution: superpowers:subagent-driven-development; implement and review the
> independent app, server, and console tasks, then integrate and verify together.

**Goal:** Files own complete work metadata and covers; app/server caches and UI
consume the same v1 contract, including works without downloaded chapters.

**Spec:** [Filesystem metadata v1](filesystem-metadata-v1.md).

**Constraints:** English source/docs, Korean user summaries, no original-folder
writes during testing and no automatic DB migration. Container deployment,
S25 installation, verification, and commits/pushes were authorized in the follow-up.

## Tasks

- [x] App persistence: add canonical NovelMetadataV1 validation and atomic
  Windows/Android filesystem IO, write metadata on all work/chapter mutation
  paths, and rebuild query caches from files. Tests must prove file precedence,
  undownloaded works, deletion semantics, malformed-file handling, and recovery.
- [x] Server: add file-backed work repository, cover HTTP endpoints and work
  journal, integrate novel.json-first folder ingestion, and test metadata-only
  import, cover bytes, change cursors, database-free rebuild and invalid paths.
- [x] Console: implement work grid/list, authenticated covers, metadata dialog,
  and drilldown to existing chapter controls. Verify responsive/keyboard behavior.
- [x] App sync: transfer metadata and covers separately from chapter packages,
  persist cursors/fingerprints, preserve device reading state, and test roundtrip.
- [x] Integration: reconcile public docs and version-1 constants, run scoped and
  full relevant tests, inspect rendered console, and report exact evidence and
  any remaining work. Do not replace the user's original data with test fixtures.

## Review focus

File updates must not be hidden by an older database cache. Cover transport must
work when anonymous reading is off. Undownloaded chapter metadata must survive
app restart. Missing or invalid files must not silently delete server copies.
An interrupted write must preserve a valid previous document.

## Verification outcome

The app suite passed 1,236 tests across 109 files, and the Windows native suite
passed 246 tests. Server tests passed 69 cases. TypeScript checks, the Windows
application build, server web build, actual HTTP synchronization, and desktop and
mobile console checks passed. Android Kotlin compilation and the final aarch64 debug APK build also passed.

Read-only original-input verification registered three works and three covers;
14 original files retained their hashes, sizes and modification times. Missing
exact identities and remote-only chapter media remain explicit skip conditions.

Independent review found and corrected multi-work failure recovery, authoritative
chapter directory retention, cover cache invalidation, and synchronization races.
Individual-file interrupted publication is recoverable. Multi-file rollback uses
process-local snapshots and cannot guarantee all-files atomicity after a forced
process termination.

The existing Docker container was updated with its data volume preserved and
original input mounts read-only. S25 verification used the debug app, a backed-up
previous installation, a fresh v1 database, and separate external test folders.
A locally created work, cover, and chapter uploaded to the running server and
downloaded into an empty folder with byte-identical metadata, cover, and chapter
files. The downloaded work remained readable without the server after app restart.
An existing archived work also displayed its cover in the catalog, work screen,
and library after a real chapter download. The original 45,511-file inventory,
sizes, modification times, and original metadata database remained unchanged.

Device testing exposed redundant work-file rewrites during chapter catalog sync.
The package catalog now stays in its own index; full metadata comes from the work
catalog, with package identity import retained for individual downloads. A
regression test covers this separation.
