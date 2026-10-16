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
  to titles. Source metadata fetches merge this catalog; downloads, deletions,
  and reading changes do not edit it. There is no update timestamp. Recovery
  restores the catalog into SQLite and marks only discovered completed files
  as downloaded.
- Backups preserve unknown chapter creation times as `null`, including chapters
  recovered from metadata or storage. Restoring does not invent those timestamps.
- Content sync shares work metadata and chapter content. Library membership,
  reading progress, bookmarks, and selected reading positions remain local.
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

## Storage Changes

1. Update the current format and its callers together.
2. Remove obsolete format branches and their tests instead of extending them.
3. Test fresh initialization, reopening the exact current schema, rejection or
   reset of other schemas, and the affected current-format behavior.
4. State any data reset consequences in release notes. Do not reset deployed
   databases or device data as part of a code change without authorization.
