# Sharing user changes across devices

Settings > Data > Shared user changes exchanges manual library edits with the
configured content server. It has its own manual action and automatic toggle.
Automatic sharing is off by default for each server. Opening settings reads
local status only. Ordinary content sync continues to share work metadata and
chapter bodies; portable file backups remain an explicit recovery operation.

## Scope and identities

| Shared field | Unit of conflict |
| --- | --- |
| Library registration or removal | One work |
| Category name, saved order, or deletion | One stable category |
| Inclusion or removal from a category | One work/category pair |
| Progress, read/unread, and history time | One atomic chapter reading tuple |
| Bookmark or bookmark removal | One chapter bookmark |
| Resume chapter, document anchor, or explicit clear | One work resume |
| Chapter composition, including exclusions and source provenance | One complete composition document |

Admitted, unblocked devices share the server's user-state workspace. Device
names label authors, not separate accounts or snapshots. The server generates
and retains a workspace UUID and epoch. Existing private reading-state profiles
are not inferred, imported, or reassigned.

Works use plugin IDs and provider-owned work IDs. ASCII case folding follows
SQLite's identity lookup. Local integer IDs, titles, display numbers, and storage
directories are not portable identities. Chapters use an exact source path
scoped to their work; synthetic composed chapters also carry the composition
entry ID. Imported local files use content-hash chapter paths in the local-files
work.

Missing source IDs remain pending locally until legitimate metadata supplies
them. Numeric recovery placeholders are not published. Missing works or chapters
and ambiguous file ownership remain visible as deferred applications instead
of being matched by title or number.

## Merge rules

The server assigns increasing revisions. Each explicit edit has an observed base
revision and a fresh operation UUID. Independent fields merge independently.
A differing edit to the same field at an unseen revision becomes a conflict,
retaining local and shared values for a deliberate choice. Wall-clock timestamps
never choose between manual edits.

Zero progress, unread, bookmark removal, library removal, category removal, and
resume clears are actual values. No maximum-progress or boolean accumulation
rule overrides them. Repeated commands that change no SQL row still record intent.

On first connection, meaningful existing positive state can fill absent server
fields as soft seeds. Seeds never overwrite an existing record or deletion.
Historical removals and renames from before the journal existed cannot be inferred.

New categories receive random stable IDs. Existing categories initially receive
an exact-name-derived legacy ID. A new category with an already active exact name
can alias its ID to the shared category. Renaming an existing category into another
active name creates a resolvable conflict. Deleting a category emits false
memberships for all known included works in the same transaction. A stale offline
inclusion cannot resurrect it. Choosing local inclusion against a deleted category
explicitly restores that category before inclusion.

Composition conflicts show both complete arrangements. A chosen shared document
owns user labels, display numbers, inclusion, order, primary sources, and retained
entry/file identities. Later source snapshots can refresh exact source facts and
append unedited newly discovered chapters owned by the target work. They cannot
restore an excluded origin or import an older manual addition from another source.
Ambiguous physical keys defer application while retaining original files.
Different entry UUIDs are accepted only for the same original provider path,
physical key, and proven primary source. Synthetic entries and prepared native
copies retain strict identity checks.

## Durability and privacy

Migration 11 appends the intent journal, attempted operations, per-workspace
acknowledgements and cursors, received records, stable category mappings,
private-reading markers, and portable-restore fence. Earlier migrations remain
unchanged.

A manual edit and its journal entry commit together. Never-attempted changes may
coalesce; attempted payloads remain immutable until the exact receipt arrives.
An edit made while a request is outstanding survives its older acknowledgement.
A descendant advances from its own acknowledged ancestor, without silently
rebasing onto an unrelated newer record.

Operation IDs are idempotent across the server workspace, including replay by
another admitted device after recovery. Identical payloads return the original
receipt and author. Reusing an ID with different content fails. Receipts, changes,
and tombstones have no arbitrary expiry.

Each read page and its cursor commit atomically. The frozen upper revision is
durable so an interrupted read resumes the same bounded sequence. Applying records
to the local cache is separate and can be deferred. Wrong namespaces, changed
epochs, and cursors ahead of the server fail without resetting pending work.

Only documented field values and stable references enter this protocol.
SQLite snapshots, localStorage, credentials, VPN profiles and passwords, storage
roots, plugin code, download queues, cache flags, statistics, and viewport page
indices are excluded.

Incognito reading does not publish progress, history, or resume events.
Private markers also prevent later initial scans and history-only actions from
publishing previously private values. Applying a shared resume neither echoes
a local edit nor starts provider downloads or finished-file cleanup.

## Portable backup restoration

Portable format 6 includes an optional category stable ID. Native restoration
reconnects that exact ID to the newly created local category inside its existing
transaction. Missing IDs never reconnect categories by reused integers or a guessed
name. Portable files do not carry the sharing ledger or device credentials.

Before restoration starts, the app aborts active sharing and waits for settlement.
This serializes sharing and restore in the application; it does not hold a SQLite
transaction during a network request. Native restoration then sets a durable
sharing fence in the same transaction as the restored data. Failure rolls the
fence back with the restoration.

Pending changes, attempted payloads, received records, and cursors are retained.
Settings explains that sharing is paused. **Reconnect to existing shared state**
resumes existing shared records and pending changes, including direct edits made
after restoration. Current restored values can change to those shared values.

The snapshot is never automatically converted into new seeds. The restored marker
remains after reconnection and also applies when connecting to a different server
workspace. To share a restored value deliberately, edit that field normally after
restoration. The selected backup file remains the recovery copy of the snapshot.

Old full-device archive endpoints and stored archives remain available under their
separate recovery contract. The normal sharing screen does not replace the
database, clear localStorage, or reload the app.

## Wire contract

The server advertises userStateVersion: 1 in /api/v1/capabilities, separately
from legacy reading-state and device-backup versions. Requests use the existing
registered-device bearer credential.

| Endpoint | Contract |
| --- | --- |
| GET /api/v1/user-state | Version, workspace UUID, epoch, current head revision |
| POST /api/v1/user-state/read | Workspace/epoch, after, frozen through and limit; returns ordered records and next cursor |
| POST /api/v1/user-state/merge | Workspace/epoch and immutable operations; exactly one receipt per submitted operation |

An operation contains operationId, entity, baseRevision, value, and optional
seed: true. A record contains entity/value, revision, server timestamp,
operation ID, and authenticated author ID/name. Receipt statuses are applied,
unchanged, seed-skipped, conflict, and aliased. Aliases identify the submitted
and canonical category IDs explicitly. Library addedAt, reading readAt, and
resume openedAt are Unix seconds; anchor savedAt, composition updatedAt, and
server record updatedAt are milliseconds.

A batch/page has at most 200 operations/records. Requests and responses are
bounded to 32 MiB on the server; the client uses a 30 MiB request budget.
Composition documents retain their 16 MiB limit. If conflict records make a
response too large, the server rolls the transaction back with HTTP 413.
The client retries exact immutable halves until receipts fit, preserving IDs.

Before acknowledgement the client verifies schemas, byte counts, workspace,
epoch, requested page bounds, revision ordering, operation completeness, exact
acknowledged values, category alias provenance, and supplied chapter ownership.
It checks the selected server after asynchronous work. Changing the address aborts
the previous run, including an away-and-back switch.

Automatic sharing debounces manual changes and checks for other-device edits
once per minute while visible and online. Failures retain the outbox and back off
to at most one retry per minute. Manual synchronization uses the same drain with
automatic sharing disabled. It contacts only the configured content server.

## Regression coverage

Real SQLite tests cover colliding local IDs, explicit negative/no-op edits,
rollback, seeds, aliases, deletion, incognito protection, lost acknowledgements,
new edits during requests, frozen cursors, source migration, deferred application,
and composition refresh. Transport tests cover response validation, cancellation,
response-budget splitting, and restore serialization. Server tests use real HTTP
and SQLite, including persistent restart and upgrades from the previous schema.
Native restore SQL tests run against exact production source and registered
migrations in an isolated harness. Published-image and actual-device verification
are recorded separately after release.
