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
  backup restore retain incomplete chapter rows with media repair required and
  the downloaded flag cleared. Inspection does not rewrite the original files.
  Content-server uploads and folder scans persist this result in the catalog;
  incomplete copies are unavailable for download. Upload conflicts follow the
  app's selected policy, checked again when the server publishes the files.
- Media repair keeps the stored chapter body and uses its manifest as the asset
  inventory. It validates ZIP entries individually, reuses intact entries from
  current or interrupted-publication archives, and downloads only missing or
  corrupt assets. A stale per-asset status does not force a new download.
  The original archive remains available until its replacement is validated;
  completed assets from a failed repair are reused on retry. A malformed
  manifest without a valid recovery copy fails without replacing the archive.
  A damaged archive that cannot be safely decoded is also preserved on failure.
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
- Content sync shares work metadata and chapter content. Library membership,
  reading progress, bookmarks, and selected reading positions remain local.
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
- Backup restore preserves every existing storage file, including `novel.json`,
  covers, chapter bodies, `media.zip`, and chapter `manifest.json`. This applies
  to works omitted from the backup as well. Restore inspects current files
  before replacing database rows and never deletes or rewrites originals.
- Existing `novel.json` documents supply restored work metadata and chapter
  titles. Backup library membership, categories, progress, and bookmarks remain
  authoritative for personal state. Works found only in storage remain cached
  outside the restored library. A downloaded flag is restored only when a
  completed chapter file is discovered; backed-up byte counts are discarded.
  Current size cache entries are retained only for the same inspected directory
  and body type. Other sizes remain available for the normal storage backfill.
- The native restore transaction replaces database rows and installs the
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
