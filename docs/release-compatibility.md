# Release Compatibility Policy

Norea guarantees compatibility for its own app data only inside the active
release line.

## Data Compatibility Scope

- Stable releases (`1.0.0` and later) guarantee compatibility only within the
  same major version. For example, `1.x.y` data must remain usable by later
  `1.x.y` releases, but `2.0.0` may introduce incompatible data changes.
- Pre-release development releases (`0.x.y`) guarantee compatibility only within
  the same minor version. For example, `0.1.x` data must remain usable by later
  `0.1.x` releases, but `0.2.0` may introduce incompatible data changes.
- Patch releases must not intentionally break compatibility inside their
  supported release line.

This policy covers Norea-owned local data, including SQLite schema/data,
settings, reading progress, library records, local novel records, downloaded
chapter content, chapter media cache metadata, and Norea backup format.

Retiring an operating-system target does not change these data formats. Backups
created on a retired target remain readable on supported targets inside the same
release-line compatibility scope.

## Schema Versioning

- Filesystem metadata development uses one fresh SQLite bootstrap at version 1,
  matching the metadata document, content-server API, and chapter package
  version. `src-tauri/src/schema.sql` contains the current app tables and
  columns. Runtime initialization installs the current synchronization and
  metadata triggers.
- Before the SQL plugin opens the database, startup compares the applied
  migration versions and SQLx SHA-384 checksums with the migrations bundled in
  the app. An exact matching prefix preserves existing data and applies only
  the remaining migrations. Matching complete histories reopen unchanged.
- Any checksum mismatch, removed version, downgrade, gap in applied history,
  or unsuccessful migration resets the entire SQLite database. An existing
  database with application tables but no migration history is also reset.
  Ordinary database access errors propagate without triggering a reset.
- Reset deletes `norea.db` and its WAL, shared-memory, and rollback-journal
  files before the SQL plugin creates the current schema. It does not delete
  chapter files, covers, `novel.json`, or other app files. DB-backed library
  membership, reading state, and preferences are lost; work metadata can be
  rebuilt from `novel.json`. This also handles incompatible databases restored
  by Android backup after reinstalling the app.
- Source plugins continue to use their independent API version 0.2.
- During pre-release schema churn, Norea does not keep one migration file for
  every schema edit.
- Before a release boundary, the current SQLite schema may replace prior
  development migration history. Local development databases can be reset when
  that happens.
- Schema version or migration files are created only at release boundaries.
- Compatibility obligations apply between released schema versions inside the
  active release line, not to discarded pre-release development history.

## Boundaries

- Compatibility across different stable major versions is not guaranteed.
- Compatibility across different `0.x` minor versions is not guaranteed.
- Upstream app data formats remain out of scope unless a feature explicitly
  adds an importer for them.
- Source plugin runtime compatibility is documented separately in
  [docs/plugins/contract.md](./plugins/contract.md).

## Change Checklist

When a change touches storage, backup, import/export, schema version files,
local files, or release packaging:

1. Identify the current release line that the change belongs to.
2. If the change is inside the compatibility scope, keep existing data readable
   through migrations or backward-compatible readers.
3. If the change requires incompatible data, align it with the next allowed
   release boundary: next major for stable releases, next minor for `0.x`
   releases.
4. Update release notes or migration guidance for user-visible compatibility
   boundaries.
5. Add or update the smallest relevant tests for migrations, backup round trips,
   import/export, or reader behavior when the data shape changes.
