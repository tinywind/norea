# Sharing user changes across devices

Settings > Data > Shared user changes exchanges library and reading edits with the
configured content server. It has its own manual action and per-server automatic
toggle. Automatic sharing is off by default. Opening settings reads local status
only. Content metadata/chapter files and portable backups remain separate flows.

## Scope and identities

| Shared field | Unit stored and merged |
| --- | --- |
| Library registration or removal | One work |
| Category name, order, or deletion | One stable category |
| Inclusion or removal from a category | One work/category pair |
| Progress, read/unread, and history time | One atomic chapter reading tuple |
| Bookmark or bookmark removal | One chapter bookmark |
| Resume chapter, document anchor, or explicit clear | One work resume |
| Chapter composition, including exclusions and provenance | One complete composition document |

Admitted, unblocked devices share one server workspace. Device names label edit
authors; they are not separate accounts or snapshots. The server retains a
workspace UUID, epoch, per-entity records, and increasing revisions.

Works use plugin IDs and provider-owned work IDs. Local integers, titles, display
numbers, and storage directories are not portable identities. Chapters use an
exact source path scoped to their work; synthetic composed chapters also carry
the composition entry ID. Local imports use content-hash identities.

Recovered source chapters may use an opaque
`norea-stored:<content-sha256>:<encoded-folder-path>` reference. The receiver
rechecks the exact work, physical storage key, nonempty body, and declared media
before applying it. Missing, inaccessible, different, or ambiguous data remains
pending. Raw numeric folder placeholders are never treated as portable identity.

## Delta storage and merge cost

The app does **not** upload the accumulated personal-state snapshot on each edit.
A local SQLite outbox stores one latest intent per changed entity. Never-attempted
edits may coalesce; once an operation is sent, its UUID and bytes remain immutable
until the exact receipt is acknowledged.

The server stores the current value of each entity in `user_state_records`, writes
an ordered revision row to `user_state_changes`, and stores idempotent operation
receipts in `user_state_operations`. A normal merge is a primary-key lookup plus
one SQL upsert for each submitted operation. Category membership columns are
materialized and indexed, so deleting a category touches only memberships in that
category instead of scanning every personal-state record.

A device uploads all pending local operations that fit within the 30 MiB client
request budget. There is no item-count batch limit on bulk-capable servers: one
change and ten thousand changes use the same message shape, and the client splits
only when the encoded byte budget or the server's response budget requires it. It
downloads revision rows after its saved cursor up to the 32 MiB response budget.
Older servers without the bulk capability retain the legacy 200-item fallback.
The first connection or an interrupted catch-up may read existing history once;
later runs process only changes since the cursor. Category deletion is
intentionally proportional to the affected included memberships because each one
must receive an explicit negative revision.

## Content-independent user state

The durable shared record is the user data. It is stored by portable entity
identity even when this device has no matching novel or chapter row. Missing local
content never blocks cursor advancement, never makes synchronization incomplete,
and never deletes the saved state. Local novel/chapter columns are only a
projection used by existing reader/library queries.

When a matching local work or chapter exists, the received record is projected
into those convenience columns. If it does not exist, the record simply remains
stored. A later metadata mutation may project that exact record without requiring
another server download. Projection failures are not shown as a synchronization
backlog and are never allowed to discard the durable shared value.

## Merge rules

Each explicit edit carries the base revision it observed. Independent fields merge
independently. A different edit to the same field at an unseen revision becomes a
conflict and retains both local and shared values for a deliberate choice.
Wall-clock timestamps never choose between competing manual commands.

Zero progress, unread, bookmark removal, library removal, membership removal,
category deletion, and resume clearing are real values. They are not inferred from
absence and cannot be silently replaced by maximum-progress or boolean-union rules.
Repeated commands that leave the visible SQL row unchanged still record intent.

On first delta connection, meaningful existing positive local state can fill
absent server fields as soft seeds. Seeds never replace an existing record or
tombstone. Historical removals that occurred before the journal existed cannot be
inferred.

Categories have stable IDs. Exact-name creation may alias a new local ID to an
existing shared category. Renaming into another active name creates a conflict.
Deleting a category writes false membership revisions for known included works;
a stale offline inclusion cannot resurrect the deleted category.

Composition conflicts retain both complete arrangements. Applying one keeps the
existing file-ownership and rollback checks. User order, labels, exclusions,
primary source decisions, and physical storage identities remain explicit.

## Automatic timing

Automatic sharing is intentionally split by change type:

| Trigger | Schedule |
| --- | --- |
| Enable sharing, return to foreground, or regain network | Immediately |
| Library, bookmark, category, membership, composition, or other command | 1.5 seconds after the latest command |
| Reading progress or resume-position writes | 20 seconds after the latest reading write |
| Open or move to another chapter | Immediately after the queued local reader writes finish |
| App moves to the background or is being hidden | Persist the latest progress/anchor and immediately make a best-effort delta pass |
| No local changes while visible and online | Poll revisions every 60 seconds |

Repeated reading changes reset the 20-second timer, so staying on a page no longer
causes a request every 1.5 seconds. If the background flush runs before the final
reader write commits, that commit schedules one more hidden-safe immediate pass.
No periodic polling continues while hidden.

Only one network run is active at a time. New requests coalesce behind it. Failures
retain the durable outbox and retry after approximately 2, 4, 8, 16, 32, then at
most 60 seconds. Manual synchronization uses the same delta drain even when
automatic sharing is disabled.

## Durability and privacy

Migration 11 contains the intent journal, attempted operations, per-workspace
acknowledgements/cursors, received records, category mappings, private-reading
markers, and portable-restore fence. A user mutation and its intent commit in the
same local transaction. An edit made while a request is outstanding survives the
older acknowledgement.

Each read page and cursor commit atomically. A frozen upper revision lets an
interrupted read resume the same bounded sequence. Wrong namespaces, changed
epochs, and cursors ahead of the server fail without clearing pending work.

Only documented values and stable references enter the protocol. It excludes
book bodies and images, credentials, VPN profiles, localStorage, storage roots,
plugin code, queues, cache flags, statistics, and viewport-only page indices.
Incognito reading does not publish progress, history, or resume state. Applying a
shared resume does not echo a local edit or start provider downloads.

## Upgrade from the temporary current-snapshot protocol

The server still advertises `userStateCurrentVersion: 2` temporarily for deployed
older apps, but advertises `userStateVersion: 1` for the normal delta protocol.
At the first upgraded server start, existing current-snapshot rows are copied once
into indexed delta records inside the database migration transaction. Existing
content, credentials, current rows, prior receipts, and workspace identity remain
intact.

The compatibility current endpoint remains available during rollout. Values it
receives are bridged into the same delta tables, and explicit negative delta values
are not resurrected by a stale positive snapshot. New apps do not call that
endpoint.

An app database that previously created only a current-snapshot workspace seeds
its durable delta outbox once, records a namespace-scoped completion marker, and
then uses only record-level intents. This conversion does not repeat on every sync.

## Wire contract

Requests use the existing registered-device bearer credential.

| Endpoint | Contract |
| --- | --- |
| GET `/api/v1/user-state` | Version, workspace UUID, epoch, and head revision |
| POST `/api/v1/user-state/read` | Read ordered records after a cursor through a frozen revision |
| POST `/api/v1/user-state/merge` | Apply immutable operations and return exactly one receipt per operation |

An operation contains `operationId`, `entity`, `baseRevision`, `value`, and optional
`seed: true`. A record contains entity/value, revision, operation ID, server time,
and authenticated author ID/name. Receipt statuses are `applied`, `unchanged`,
`seed-skipped`, `conflict`, and `aliased`.

Bulk-capable servers bound pages and merge batches by bytes, not by item count.
Server requests and responses are limited to 32 MiB and the client targets 30 MiB;
composition documents retain their 16 MiB limit. If response receipts exceed the
budget, the transaction rolls back and the client retries the same immutable
operations in smaller halves. Legacy servers remain compatible through a 200-item
fallback.

## Portable backup restoration

Portable backups do not carry the sharing ledger or device credentials. Before a
restore replaces local values, the app aborts active sharing and waits for it to
settle. The restore writes a durable sharing fence in the same transaction.

Settings then requires **Reconnect to the existing shared state**. Pending
operations, received records, and cursors remain stored. Reconnecting resumes the
existing delta workspace; it does not convert the restored snapshot into a new
bulk upload. Values intentionally edited after the restore enter the outbox in the
normal way. The original backup file remains the recovery copy.
