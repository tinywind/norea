# Development Data Policy

Norea is in early development and supports only its current data formats.
Backward compatibility with earlier development builds is out of scope,
including builds with the same version number.

This policy covers SQLite, settings, library and reading state, local work
metadata, chapter packages, backups, and content-server storage and APIs.
Do not add migration histories, old format readers, endpoint aliases, or
settings translation to preserve discarded development formats. Future release
compatibility requirements must be decided explicitly before implementation.

## Current App Database

- `src/db/schema.ts` defines the app tables and columns. The single version 1
  bootstrap in `src-tauri/src/schema.sql` creates all current tables, indexes,
  and triggers, including the content journal and work metadata caches.
- Before the SQL plugin opens the database, startup requires exactly one
  successful version 1 entry with the bootstrap's SQLx SHA-384 checksum.
  Reopening that schema preserves its data. Every other history resets the
  database; matching prefixes do not upgrade.
- Reopening the current schema retains pending metadata edits. Startup restores
  indexed work paths and publishes those edits transactionally before content
  sync can proceed. Failed publication leaves pending edits available for retry.
- Reset removes `norea.db` and its WAL, shared-memory, and rollback-journal
  files before creating the current schema. It does not delete chapter files,
  covers, `novel.json`, or other app files. Database access errors propagate
  without deleting an unreadable database.
- A reset loses DB-backed library membership, reading state, and caches.
  Current `novel.json` documents and completed chapter folders can rebuild the
  work cache. Invalid or obsolete files are not converted or used to guess work
  identity.
- Runtime initialization rebuilds cached data from current files when needed.
  It does not add missing columns, replace tables, or translate old cached
  snapshots. Schema edits belong in the bootstrap and change its checksum.

## Other Formats

- Work metadata version 1 stores a `chapters` map from source chapter numbers
  to titles. Source metadata fetches merge this catalog; downloads, download deletions,
  and reading changes do not edit it. Local works publish their chapter titles
  after local imports, edits, deletions, and reordering. There is no update timestamp. Recovery
  restores the catalog into SQLite and marks only discovered completed files
  as downloaded. After inspecting chapter files, recovery rereads the work document
  before applying it so an earlier snapshot cannot hide newer details or titles.
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
are rejected. The database bootstrap checksum changes with the new cache column.
Runtime recovery does not import or convert earlier title-based folders or
metadata without the plugin-owned ID. It leaves those original files untouched.
Explicitly requested offline conversions follow the preservation and validation
checks in [Content folder recovery](./test-support/storage-folder-recovery.md).
Use current plugins, app, and server together; earlier development backups are
unsupported.

## Storage Changes

1. Update the current format and its callers together.
2. Remove obsolete format branches and their tests instead of extending them.
3. Test fresh initialization, reopening the exact current schema, rejection or
   reset of other schemas, and the affected current-format behavior.
4. State any data reset consequences in release notes. Do not reset deployed
   databases or device data as part of a code change without authorization.
