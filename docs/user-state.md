# Sharing current user state across devices

Settings > Backup and sync shares current library state with the configured
content server. Automatic sharing remains opt-in per server. Opening settings
reads a small local summary and does not enumerate chapter diagnostics or send
data. Content metadata, chapter bodies, and explicit backup restoration retain
their separate workflows.

## Current values and additive merge

The app reads SQLite in bulk and exchanges one JSON snapshot. It does not replay
library/category transitions, deletion events, or a chapter operation journal.

| Current value | Receiver behavior |
| --- | --- |
| Library works | Add received works to the library without removing unrelated works |
| Manual categories | Reuse an exact trimmed name or add the category |
| Category membership | Add the received work/category relation |
| Public chapter reading tuple | Prefer the newer read time; equal/absent times use greater progress and retain read completion |
| Bookmarks | Add received bookmarks |
| Resume location | Prefer the newer opened time and document anchor |
| Chapter composition | Apply the newer complete composition using the existing file ownership and rollback checks |

Absence from a snapshot does not delete receiver data. Category names identify
additive categories: the canonical ID is `name-` plus the SHA-256 of the exact
trimmed UTF-8 name. A renamed category does not force another device to rename or
delete its existing category. Library and category removals, cleared bookmarks,
and historical transitions are not sent as commands.

Composition contains separate source snapshots, physical storage keys, and user
order/display numbers. Sharing never treats a displayed number as a chapter
identity or renames a downloaded chapter folder merely to change its order.
The whole composition retains explicit user exclusions within that current
document.

## Stable identities and privacy

Works use a plugin ID and provider-owned work ID. Chapters use their exact source
path within that work; synthetic composed chapters also require the composition
entry ID. Local integer IDs, titles, and coincident chapter numbers are not
portable identities. Local file chapters use their content hash identities.

Private-reading markers prevent incognito progress, history, and resume positions
from entering a later bulk export. Only documented public fields are exported.
The payload excludes credentials, VPN profiles, localStorage, storage locations,
plugin code, download queues, cache flags, and device viewport page indices.
Existing private server reading profiles are not imported into the shared
workspace.

A receiver retains unmatched current values in one cached snapshot until exact
work/chapter metadata is available. A metadata update retries its affected work.
Settings shows overall progress, last success, and errors; it never renders one
paragraph per deferred chapter. No source-provider request or download is started
by this merge.

## Wire contract and durability

The server advertises `userStateVersion: 2` and
`userStateCurrentVersion: 2`. The existing registered-device credential
authorizes both endpoints:

| Endpoint | Contract |
| --- | --- |
| GET /api/v1/user-state/current | Current workspace, epoch, and snapshot |
| POST /api/v1/user-state/current | Merge the submitted snapshot and return current shared values |

A snapshot is
`{version:2,workspaceId,epoch,items:[{entity,value}]}`.
It has no operation IDs, base revisions, per-item receipts, or event history.
A repeated exchange after a lost response is an additive merge. Requests and
responses are limited to 32 MiB and 100,000 items; the app reserves a 30 MiB
upload budget. A composition retains its 16 MiB limit. The app rejects oversized
state clearly rather than silently falling back to thousands of small requests.

The server imports supported positive values from existing V1 current records.
V1 tables, receipts, and app journals remain intact for preservation; they are
not used by the new exchange. Old event read/merge endpoints require an app
upgrade. Existing SQL migrations and their checksums remain unchanged.

Scalar values use bulk SQL in one transaction. Composition changes retain their
existing guarded file publication transactions; chapter values apply after their
composition is established. The app rechecks its selected server after
asynchronous work. Changing the server cancels the old run, including switching
away and back. Concurrent sync requests coalesce.

Automatic sharing debounces local changes and runs while visible and online.
It retries failures with backoff and retains the current SQLite data throughout.
Manual sharing uses the same exchange.

## Backup restoration

Restoration aborts and awaits active sharing before replacing local state.
The existing durable restore fence is preserved. Explicit reconnection resumes
current-state merging; restored public values can then be exported and merged
with the shared current values. Unrelated receiver data remain intact.
Portable backups do not carry device credentials or the old sharing journal.

## Completed work migrations

A completed source-to-target migration is resolved by exact saved identities
when a server work is opened or added. An existing destination is refreshed and
relinked rather than reporting the retired source as an add failure. Its current
composition and downloaded bodies are retained.

A legacy completed move whose source was accidentally restored can be reported
through the server migration reconciliation capability. The app supplies its
unchanged original request and a separately persisted request against current
source/target snapshots. Exact chapter paths select current storage numbers;
old plugin numbers and user display order are never substituted for those keys.
The server verifies every stored body/asset decision before retiring the source
and records the active relation. A lost response reuses the saved request.
Explicitly revoked moves are not automatically retired again.
