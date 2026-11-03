# Development Data Policy

Norea preserves app database data across schema upgrades, including development
builds. Every schema change requires a higher version and an ordered migration.
The current version 1 schema is the baseline for this policy; discarded older
development schemas are not reconstructed automatically.

Settings, work metadata, chapter packages, backups, and content-server APIs
support only their current formats. Earlier external formats do not require
fallback readers, endpoint aliases, or settings translation. Further compatibility
requirements must be decided explicitly before implementation.

## App Database Upgrades

- `src/db/schema.ts` defines the current app tables and columns. The registered
  SQL migrations in `src-tauri/src/database.rs` must produce that schema for
  fresh installations and upgrades.
- `src-tauri/src/schema.sql` is the immutable version 1 baseline. Append later
  migration SQL and register each upgrade with a strictly increasing version.
  Do not rewrite an applied migration or its checksum, even before a release.
- The SQL plugin applies pending migrations in order. Reopening an up-to-date
  database does not rerun them. Upgrades must retain library membership,
  categories, installed plugins, chapters, reading progress, history, downloads,
  and work metadata caches unless the user explicitly authorizes a specific loss.
- Unknown versions, mismatched checksums, invalid migration history, and failed
  upgrades stop database opening without deleting the database or its sidecars.
  Transactional upgrades must roll back their changes when an operation fails.
  An unsupported database requires explicit recovery; startup must not erase it.
- Test fresh initialization, upgrades from supported installed versions, unchanged
  reopen, failed-upgrade rollback, and preservation on version/checksum errors.
  Include populated records and relationships affected by the change.
- Reopening the current schema retains pending metadata edits. Startup restores
  indexed work paths and publishes those edits transactionally before content
  sync can proceed. Failed publication leaves pending edits available for retry.
- Current `novel.json` documents and completed chapter folders can rebuild work
  caches after an explicitly requested reset. Invalid or obsolete files are not
  converted or used to guess work identity.
- Runtime initialization restores caches from current files when needed. Schema
  changes belong in versioned migrations, not opportunistic runtime DDL.

## Other Formats

- Database migration 3 adds durable VPN download batch/IP problem records and
  batch identity on existing plans. It preserves queue payloads, checkpoints,
  generations and O/X verdicts. One unambiguous owned-job batch is retained;
  plans without that evidence receive separate legacy identities. Automatic
  exclusions preserve the saved file and do not change the user's verdict.
  Explicit, revision-checked reallow keeps the recorded cause and cannot clear a
  newer failure. Full device snapshots include this table under the existing
  exact-schema policy. A restored or reloaded coordinator also reads the native
  worker generation floor; an older snapshot cannot reuse a surviving worker's
  generation. Ordinary queue cleanup cannot remove VPN-owned jobs.
  Plan JSON may retain `consumedReallowRevisions` per range, keyed by profile ID.
  Missing maps mean no reallow has been consumed; existing plans and queue rows
  remain intact. These revisions cannot regress during ordinary updates and reset
  only after full chapter settlement or an explicit profile-pass restart. Native
  scraper timeouts and the recognized browser tunnel-navigation failure consume a
  range attempt without creating a batch/IP exclusion. TLS certificate failures
  remain explicit stops.
  A range's `profileId` and `profileHash` are a nullable pair that records the
  profile it leased last. New plans start with both null; a worker leases any
  eligible idle profile when it takes the range, so unfinished ranges may share a
  recorded profile and an existing plan's assignment is only a preference.
  Existing plans keep their checkpoints, attempts and queue rows unchanged.
  These fields do not change the SQL schema, backup tables or source plugin format.
  New plans split their selection into contiguous chunks of at most 50 selected
  chapters instead of one range per worker; a chunk is an ordinary range row, so
  plan JSON keeps its shape and existing plans keep their ranges unchanged.
- Database migration 4 adds `chapter_download_failure`, one row per chapter with
  the last terminal download failure: its class, a redacted message summary, the
  challenged URL for challenges, the attempt count, the next automatic attempt
  time, and the failed job's queue JSON. It changes no existing table; queue
  rows, plans, chapters and reading state upgrade unchanged. A row is removed with
  its chapter row through the foreign key, and when its chapter later downloads,
  the user cancels it, or the user retries it, which starts a fresh budget.
  An ordinary queue row may carry an optional `retryAt` in its job JSON while a
  fresh automatic attempt waits for its backoff; restored rows keep that wait.
  Rows without it start at once, as before, and the SQL schema is unchanged. The attempt count is the persisted retry
  budget, so restarts cannot reset it. Full device snapshots include the table
  under the exact-schema policy; restore keeps the rows but clears every
  scheduled retry time, so a restored snapshot never starts automatic downloads.
  Portable file backups exclude the table, and their restore drops it with the
  replaced chapter rows.
- Database migration 5 adds `novel_download_goal`, one row per novel with its
  persistent download goal: keep N chapters ahead (with `count`), all remaining
  chapters, or the entire novel. It changes no existing table; queue rows,
  failures, chapters and reading state upgrade unchanged. A row is removed with
  its novel through the foreign key and when the novel leaves the library; the
  novel's downloads stay. Ordinary queue rows submitted by a goal carry an
  optional `goal: true` in their job JSON so restored goal work still waits for
  the automatic-download budgets; rows without it are explicit work, as before.
  A goal job may also carry `serverLane: true` when the content server listed a
  complete copy; it is only a routing hint that is checked again at transfer
  time, so restored rows with a stale hint still fall back to the source.
  A device restore sets the `download-goals-held-after-restore`
  localStorage entry, so restored goals queue nothing until the user resumes them
  from Needs attention. Full device snapshots include the table
  under the exact-schema policy. Goals are user intent, so portable file backups
  carry them in the manifest.
  The default keep-ahead count for active library novels and the mobile-data
  choice live in the `download-goal-settings` localStorage entry, which both
  backup kinds carry with the other settings.
- Database migration 6 rebuilds `novel_download_goal` to allow the kind `none`,
  the user's explicit opt-out, which also stops the default keep-ahead for that
  novel. Every existing goal row is copied unchanged inside the migration
  transaction before the old table is dropped and the new one renamed. Removing
  the row ("Use default") returns the novel to the default. The portable manifest
  accepts `none` with a null `count`; an earlier build rejects an archive that
  holds it instead of misreading it.
  The same migration adds `chapter_download_goal_exclusion`, one row per chapter
  the user deleted or cancelled while a goal covered it, removed with its chapter
  through the foreign key. Full device snapshots include it under the exact-schema
  policy; portable backups exclude it, and their restore drops it with the
  replaced chapter rows.
- Database migration 7 adds `chapter.found_by_check` (0 or 1, default 0) with an
  index for the Updates list, and `novel_freshness`, one row per novel with the
  last check time, last success, consecutive failures, the time new chapters
  were last found and the time its cover was last fetched. Every existing chapter
  gets 0 with no backfill, because the found time cannot tell a recently
  imported old chapter from a release; the first check after the upgrade starts
  the list. A check for new chapters sets the flag only on chapters it inserts
  into a novel that already had chapters. Freshness rows are removed with their
  novel through the foreign key. Full device snapshots include both under the
  exact-schema policy. The flag follows chapter rows in portable backups
  (manifest format 4); freshness is device state, so portable backups exclude it
  and their restore drops it with the replaced novel rows.
  Updates lists only flagged unread chapters, with every unread chapter under
  "Earlier unread chapters". Its nav badge counts flagged chapters found after
  the `updates-seen` localStorage time, which is device state: device snapshots
  carry it with the other settings and portable backups leave it out.
  The automatic check interval is an additive `checkIntervalHours` field (0, 6,
  12 or 24; default 12) in the `norea-library-settings` entry, which both backup
  kinds carry; a missing or unknown value reads as 12.
- Database migration 8 allows several plugin repositories. It drops the
  single-repository index and adds `repository.priority` (1 is first, default 1)
  and `repository.enabled` (0 or 1, default 1), so the existing repository stays
  the first enabled entry with its URL, name and time. It adds
  `installed_plugin.repository_url`, the publishing repository updates come
  from. An existing install is bound to the existing repository only when its
  `source_url` equals a plugin `url` in that repository's cached index; an id
  match alone is not enough, and invalid cached indexes bind nothing. Every other
  install, including local files, keeps a null publisher: it is never updated
  automatically and Extensions offers "Choose publisher" when a repository lists
  it. Removing a repository keeps the publisher URL of its plugins, so adding it
  again restores their updates. Full device snapshots include the columns under
  the exact-schema policy; portable backups carry them in manifest format 5.
  Automatic extension updates are an additive `autoUpdateExtensions` flag in the
  `browse-plugin-settings` entry, which both backup kinds carry; a missing or
  non-boolean value reads as off.
- The reader option "Download next chapter in advance" is retired; download
  goals replace it (RD4). Stored `autoDownloadNextChapter` values stay in the
  `reader-settings` entry and are read once at startup. Off for all novels, it
  turns the default keep-ahead off unless `download-goal-settings` already saved
  one; a source or novel override that differs from the default becomes that
  library novel's own goal (`none`, or keep one ahead). The additive
  `legacyReadAheadMigrated` flag in `download-goal-settings` records that this
  ran, so later changes to either setting are never overwritten. A restored
  backup without the flag repeats the step at the next start.
- Automatically tested VPN Gate servers live in `plugin-vpn/automatic-profiles/`
  beside the approved `saved-profiles/` vault, with their own index and private
  files. They never write or change an O/X verdict; an entry leaves the pool when
  its IP receives any verdict, after repeated worker tunnel failures, or beyond the
  retention capacity, which the pool applies separately from approved files. The
  pool is rediscoverable device-local data: device snapshots and portable backups
  exclude it, restore leaves it in place, and an unreadable index starts an empty
  pool instead of disabling approved profiles. The "Use tested servers
  automatically" choice is part of the VPN download settings in localStorage.
  "Approve all working" under Network > Advanced is the user's explicit verdict:
  it publishes each pool entry without a recent failure into `saved-profiles/`
  with an O row and the same bytes and hash, so running worker leases continue,
  and the entries then leave the pool. It adds no new file or table format.

- Work metadata version 1 stores a `chapters` map from source chapter numbers
  to titles. Source metadata fetches merge this catalog; downloads, download deletions,
  and reading changes do not edit it. Local works publish their chapter titles
  after local imports, edits, deletions, and reordering. There is no update timestamp. Recovery
  restores the catalog into SQLite and marks only discovered completed files
  as downloaded. After inspecting chapter files, recovery rereads the work document
  before applying it so an earlier snapshot cannot hide newer details or titles.
  A completed scan clears download flags and byte counts for cached chapter paths
  absent from that work, preserving metadata and reading state. Downloads changed
  after the scan began retain their newer state.
  Once a work is indexed, a different external document has unknown freshness
  and cannot replace its cached details or chapter catalog during recovery or
  sync rescanning. Newly discovered works still recover from their files.
  A successful source refresh can republish the retained details and chapter
  catalog over a conflicting file. Cover-only writes and uploads reject that
  conflict instead of accepting it as a new baseline.
- Chapter completeness is derived from `manifest.json` and the actual
  `media.zip` inventory. Every declared asset must be present; cached completion
  and per-asset status flags do not override the files. Folder recovery and
  portable file backup restore retain incomplete chapter rows with media repair
  required and the downloaded flag cleared. Inspection does not rewrite the original files.
  Content-server uploads include stored incomplete chapters and persist their
  actual completeness in the catalog, as do folder scans. Upload snapshots copy
  a partial HTML body as `content.html` without changing the original file.
  Partial bodies require a valid media manifest so missing assets remain tracked.
  The first sync after enabling incomplete uploads rediscovers stored chapters
  once, preserving the saved deletion exclusions and later incremental cursors.
  Incomplete copies remain visible in catalogs and can be downloaded. Completeness
  is displayed as status, and installed missing assets retain media repair state.
  Upload conflicts follow the
  app's selected policy, checked again when the server publishes the files.
- Media repair keeps the stored chapter body and uses its manifest as the asset
  inventory. It validates ZIP entries individually, reuses intact entries from
  current or interrupted-publication archives, and downloads only missing or
  corrupt assets. A stale per-asset status does not force a new download.
  The original archive remains available until its replacement is validated;
  completed assets from a failed repair are reused on retry. Individual asset
  failures do not stop acquisition of the remaining assets. Before reporting an
  incomplete download, the host archives every validated stored asset in
  `media.zip`, even when the result is an empty ZIP. Missing assets remain in
  the manifest and keep `complete` false; a partial ZIP is not a completed
  chapter. A retry reuses its intact entries and requests only missing or
  damaged assets. Existing damaged archives and recovery copies are preserved
  when there is no validated stored replacement. A malformed
  manifest without a valid recovery copy fails without replacing the archive.
  A damaged archive that cannot be safely decoded is also preserved on failure.
- Library storage percentages and missing-chapter download batches count chapters
  with a stored body, including chapters that still need media repair. Native
  storage inspection recognizes `.chapter-content.partial` and preserves its
  body size and media repair state when reopening a work. Missing
  assets do not reduce the stored-chapter count or cause ordinary batch downloads
  to select the chapter again. Whole-work discovery includes nonempty partial
  bodies after published HTML and PDF candidates. Reconciliation stores the
  inspected body and archive sizes together with completeness and repair state,
  so partial-only folders are not mistaken for missing chapters. These persisted
  counts and repair flags remain available after restart without another scan.
  Package completeness and media repair flags continue to
  use the full manifest and validated asset inventory.
- Source refreshes, server metadata installation, and storage recovery preserve
  known optional metadata when incoming fields are missing, null, or blank.
  Nonempty source and server updates and a rating of zero still apply. Explicit
  local edits can clear fields through their separate editing path. Server installation writes
  the preserved fields to the work document as well as the database. A source
  refresh repairs missing work details in that document even when the source
  returns the same metadata already cached in SQLite. Recovery does not rewrite
  original metadata files merely to fill missing fields from the database.
- Overlapping source refreshes use the newest request for each work. An earlier
  response is checked again inside the database queue and cannot publish after
  a later request. Superseded callers receive the newer request's result.
  Metadata publication notifies visible detail and chapter queries, including
  background refreshes. Database failures restore transaction-owned file writes
  without automatically rebuilding metadata from unrelated external files.
- Backups preserve unknown chapter creation times as `null`, including chapters
  recovered from metadata or storage. Restoring does not invent those timestamps.
- Content sync shares work metadata and chapter content. Library membership
  and reading state remain local during ordinary content sync. Settings -> Data
  -> Device backup separately saves and restores a complete database and settings
  snapshot, identified by device name. Restore replaces personal state rather
  than merging it, so unread flags, removed bookmarks, and deleted history in the
  selected snapshot also replace the current values. The app no longer exposes
  private-key reading-history send, import, or merge controls.
- Explicit app deletions store per-server work and chapter upload exclusions in
  the existing content sync cache. They survive restart and local rescans without
  changing the database schema. Whole-device work deletion removes its reader
  state and source association; a source refresh started before deletion cannot
  recreate that work. Partial deletion retries retain completed targets.
  Server work deletion bypasses the full synchronization queue. Active metadata
  and chapter transfers recheck the deletion before publishing results or starting
  another upload; unrelated works continue. A pending deletion is reconciled even
  when its upload rejection arrives first. Late server responses cannot reinstall
  explicitly deleted works. Deletion exclusions are saved separately from the
  active sync checkpoint so its cursor and completed baselines are retained.
- Work sync reads the pending server change pages and applies only the latest
  record for each work. It advances the saved cursor after processing those
  records; failed processing retains completed baselines for a safe retry.
- Portable local file backups use manifest format 5, which lifts the
  one-repository limit of format 4 and adds `priority` and `enabled` per
  repository and the nullable `repositoryUrl` publisher per installed plugin.
  Restore rejects a repository URL listed twice and a priority below 1 before it
  replaces any row (format 4 added the per-chapter `foundByCheck` flag, format 3
  `downloadGoals`). Format 4 and earlier archives are rejected without conversion. They exclude device authentication keys. Their restore behavior below is separate from full device
  snapshots stored on the content server.
- Automatic backup (RD15) writes the same portable archive to `backups/` in the
  storage folder as `norea-auto-backup-<yyyyMMddHHmmss>.zip`. Each archive is
  written under a temporary name and renamed into place, and only after that
  succeeds are the oldest files with that exact name pattern beyond the kept
  count deleted; other files in the folder are never touched. The schedule
  (`off`, `daily` or `weekly`), the kept count (default 5) and the last
  outcome live in the `auto-backup` localStorage entry. The folder belongs to
  this device, so device snapshots carry the entry with the other settings and
  portable backups leave it out; a missing or unknown value reads as off.
- Portable file backup restore preserves every existing storage file, including
  `novel.json`, covers, chapter bodies, `media.zip`, and chapter `manifest.json`. This applies
  to works omitted from the backup as well. Restore inspects current files
  before replacing database rows and never deletes or rewrites originals.
- During portable file backup restore, existing `novel.json` documents supply
  restored work metadata and chapter titles. Backup library membership,
  categories, progress, and bookmarks remain
  authoritative for personal state. Works found only in storage remain cached
  outside the restored library. A downloaded flag is restored only when a
  completed chapter file is discovered; backed-up byte counts are discarded.
  Current size cache entries are retained only for the same inspected directory
  and body type. Other sizes remain available for the normal storage backfill.
- The native portable restore transaction replaces database rows and installs the
  inspected file cache together, then clears metadata publication triggers.
  Failure rolls back that transaction. Old download jobs are discarded because
  their database IDs no longer identify the restored rows. Content-server
  source associations keyed by replaced novel IDs are also discarded;
  identity-based sync and device caches are retained. Retained work files
  receive a new sync revision so stale backup metadata cannot replace them on
  the content server. No schema change or device database reset is required.
- Upstream app data formats remain out of scope unless the user explicitly
  requests an importer.
- Source plugins use their independent API version 0.2. Their contract is
  documented in [docs/plugins/contract.md](./plugins/contract.md).

## Device-only chapter cleanup

Settings > Data > Clear downloaded chapters previews an explicit cleanup before
confirmation. A chapter must have an eligible managed payload and satisfy the
selected server, reading, and category conditions. Selected categories match
any of those categories; the three conditions apply together. Source downloads
remain eligible. A local-work chapter requires proof of its own successful
server download and a matching current payload fingerprint. A work-level server
association alone does not qualify it. Existing local chapters without this
proof remain excluded, and replacing their files invalidates the proof.

The four server conditions check whether a chapter is present, whether server
asset coverage is at least the device coverage, whether the server contains all
valid device content, or ignore server state. Coverage compares matching body
digests and strict manifest declarations before comparing valid asset counts.
Containment compares the body and every valid local asset by identity, digest,
and size. Missing or malformed declarations cannot establish either comparison.
Server evidence is checked again before deletion and reflects the server at that
moment; another device may change the server copy later.

Cleanup removes recognized downloaded bodies, archives, managed loose media,
and payload staging files. It retains chapter `manifest.json`, `novel.json`,
covers, chapter rows and catalog entries, library membership, categories,
reading history, progress, read flags, and bookmarks. Download flags and byte
counts are cache state and are reconciled with remaining files. Cleanup does not
remove server content or create server deletion exclusions. An interrupted task
does not restart automatically; run a new preview to evaluate remaining files.
The proof uses the existing content sync cache and requires no schema migration,
format conversion, or database reset.

Unread chapters and chapters a download goal in effect keeps (its keep-ahead
window, every remaining chapter, or the whole novel) stay out of the confirmed
set unless the user includes each kind after the preview. A chapter marked
unread after the preview is skipped as changed. Deleted chapters become goal
exclusions, so goals do not download them again until the novel's goal is set
again, and the app offers to stop the goals of the affected novels. Downloads >
Storage > Clean up opens the same workflow.

Settings > Downloads & storage > Remove finished chapters automatically (Off by
default; keep the last 5, 10 or 20) runs the same cleanup unattended after
reading progress changes and once a day while the app is visible, catching up
at the next foreground return after 24 hours. It selects only downloaded,
finished, unbookmarked source chapters of an installed plugin that lie behind
the most recently opened chapter with at least the chosen number of finished
chapters between them, never chapters a download goal keeps or novels with an
entire-novel goal. Every condition is checked again immediately before each
deletion. With a content server it uses only the server-contains-local
condition; without one it starts only after the user accepts that removed
chapters exist nowhere else. A run is skipped while another cleanup is queued or
running, and removed chapters become goal exclusions. The setting is stored as
the additive fields `finishedChapterKeep` and `finishedCleanupWithoutServer` of
the `download-goal-settings` entry, which both backup kinds carry; missing or
unknown values read as off. The last run time and result are device-only state
in `finished-chapter-cleanup-state` and are not backed up. No schema change is
required.

## Full Device Backups on the Content Server

The version 1 device-backup transport stores one current snapshot per device name. The app's
device name is the default slot, and all registered, unblocked devices may list
and restore every saved device name. Device registration remains the
authentication mechanism; anonymous catalog access and console sessions do not
authorize device backup requests. There is no separate private reading sync key.

The current archive manifest is version 2. Earlier archive versions are rejected
without conversion. The archive contains `manifest.json`, `norea.db`, the native
`profile.ovpn` when present, and `saved-profiles/index.json` with the retained
private VPN profile files. The vault index preserves capacity, approval sequence,
profile identity and protocol, and the active retained selection. Its manifest
inventory records each retained file's path, size, and SHA-256. Profile bytes stay
inside native file/archive operations and never pass through frontend JSON.
The database snapshot includes every SQLite table, including
repository URLs, complete installed plugin JavaScript, categories, library
membership, read progress, bookmarks, history, and work and chapter metadata.
The manifest carries all localStorage settings and the storage root setting.
This includes server connection settings and device tokens, VPN preferences,
and interface settings. Unlike portable file backups, device snapshots include
device credentials and replace the current device's saved settings.

Export holds the native VPN operation lock across the database snapshot and vault
export, inside the existing frontend database and storage barriers. Restore checks
the whole staged bundle before changing live state. Vault validation reuses the
canonical profile and index checks and requires each retained file to match its
SQL O verdict and approval timestamp. It rejects unmarked profiles, mismatched
identity/protocol/hash, duplicate or undeclared entries, and unsafe paths. A vault
contains at most 100 profiles of at most 1 MiB each, with an index of at most
128 KiB. Staged and installed VPN files use private publication rules; symlinked
managed files and directories are rejected.
An unavailable active retained selection stays unavailable after restore; it
does not recreate a revoked vault entry or bypass the normal connection checks.

Downloaded bodies, covers, chapter images, and other original content files are
excluded. Restore must not delete or overwrite those files. OS folder access
grants and WebView cookies are not portable snapshot data. VPN usernames and
passwords held only in memory are also excluded. A restored storage root can
refer to an unavailable folder or lack OS access on another device; acquiring
that permission remains a separate device operation.

Restoration requires an exact match for the current database schema and ordered
migration history. Validate SQLite integrity and foreign keys before replacing
the live data. Do not migrate an incompatible snapshot, reset the live database,
or continue after a schema, checksum, or integrity failure. Existing app schema
upgrade rules remain unchanged.

The restore operation requires explicit overwrite confirmation, validates the
selected snapshot's SHA-256, replaces database contents in a SQL transaction,
and leaves frontend settings unchanged until that transaction commits. After bundle validation, the
frontend suspends VPN allocation and waits for range tasks, pending plan writes,
worker browsers and tunnel cleanup before taking the sync, storage and database
restore barriers. The allocation hold remains until reload; a failed restore
releases the hold but leaves stopped ranges paused for explicit resume. Cleanup
failure prevents settings and snapshot installation. Native restore also stops
the tunnel manager before taking the VPN operation/vault locks and disconnects
the foreground VPN. It refuses to proceed while worker leases remain. Install the
active profile and retained vault before committing the database, retain the old
managed files until success, and roll them back if settings or database
installation fails. A completed native rollback also restores the previous storage
root. Restored lease state is empty. On success, reload the app so
in-memory state reflects the restored database and settings. Cancel or remove
restored ordinary download and metadata publication jobs before normal startup
can process them; these jobs must not rewrite original content using snapshot
state. VPN range jobs retain their frozen payloads and attempt counts, with queue
leases cleared. Ordinary native queue leasing excludes these jobs. Before any
worker allocation, the range coordinator must pause all unfinished restored plans
and sessions while preserving attempted profile IDs and checkpoints. They require
explicit resume. Restore does not merge history or reconstruct the database from
content files.

### Interrupted device restore

Before changing live VPN files or the storage root, native restore publishes and
syncs a private `plugin-vpn/.device-restore/restore.json` checkpoint and its parent
directory. The checkpoint records the target settings, previous storage root and
an operation ID. File publication preserves old managed files in its private
`.device-backup-*` directory. The checkpoint and old files remain after SQLite
commits. The frontend then installs and verifies the settings returned by that
native operation, acknowledges its exact ID, and reloads. Only acknowledgement
removes the old files and checkpoint. A stale or premature acknowledgement is
rejected. A fully rolled-back native error may clear the checkpoint without
changing frontend settings.

If a process exits before acknowledgement, startup refuses to use the stores.
The native startup guard runs before SQL-plugin preload; vault initialization
also checks the checkpoint. The web entry checks it before importing app modules,
including after a WebView-only reload. An unreadable, partial or malformed
checkpoint, or an orphaned `.device-backup-*` directory, also blocks startup.
The app preserves these paths and does not infer whether SQLite committed.
An uncertain native response, failed frontend settings write or failed
acknowledgement keeps the running restore barriers held and reloads into this
check instead of returning to ordinary work.

This protocol intentionally requires manual recovery after an interrupted
restore, even when the database transaction committed. With the app stopped,
preserve the checkpoint, rollback directories, staged archive and SQLite files
(including any WAL/SHM files) together before diagnosis. Treat them as private
credentials-bearing app data. Do not delete a checkpoint to bypass the guard,
reset the database or independently select whichever profile/settings file looks
newest. A recovery must establish one matching database, vault, storage root and
frontend settings snapshot before normal startup is allowed. Automatic recovery
is not implemented. Process-exit tests cover interruption; they do not establish
power-loss guarantees for every filesystem or Windows ACL behavior.

A valid full backup can replace a destination vault that failed initialization.
After validating the complete staged bundle and stopping workers, restore uses
the existing quarantine recovery under the VPN operation lock. The malformed
index and private files remain in the quarantine directory; they are not reset
or deleted. The idle-lease guard and interrupted-restore fence still apply.
Ordinary export does not use this recovery path to invent a healthy snapshot.

The server advertises `deviceBackupVersion: 1` through capabilities. This versions
the opaque archive transport, independently of archive manifest version 2; the
server does not extract or validate the manifest. Its list
includes the device name, update time, byte size, and SHA-256. Uploads require
`X-Backup-Sha256` and are limited to 512 MiB. Downloads pin the chosen SHA-256
so a newer upload to the same device name cannot silently replace the selected
snapshot. See [Content-server integration](./content-sync.md) for the endpoints.
Physical download cache flags and byte counts are reset during a full device
restore because original chapter files are not included. Existing local files
remain untouched and are checked again when their chapters are opened or
downloaded; reading progress and metadata stay restored.


## Plugin-owned storage IDs

The current file and package format requires `identity.novelId`, supplied by the
source plugin. Files live under `contents/<pluginId>/<novelId>/<chapterNumber>/`.
Titles and host-generated hashes are excluded from directory names. The app
caches the plugin-owned work ID in `novel.source_novel_id` and includes it in metadata,
chapter manifests, and backup snapshots. Invalid, changed, or conflicting IDs
are rejected. The version 1 baseline includes this cache column.
Runtime recovery does not import or convert earlier title-based folders or
metadata without the plugin-owned ID. It leaves those original files untouched.
Explicitly requested offline conversions follow the preservation and validation
checks in [Content folder recovery](./test-support/storage-folder-recovery.md).
Use current plugins, app, and server together; earlier development backups are
unsupported.

## Storage Changes

1. Update the current format and its callers together.
2. Remove obsolete format branches and their tests instead of extending them.
3. For database changes, increment the schema version, append an ordered
   migration, and test populated upgrades, fresh initialization, reopening, and
   failure rollback. Keep earlier migration SQL unchanged.
4. Document compatibility consequences. Never reset deployed databases or device
   data as part of a code change without explicit authorization.
