# Release and data compatibility

This document defines the current compatibility policy for Norea 0.2. It is a
contract for maintainers, not a history of how individual features were built.

## App database

The SQLite schema is persistent user data.

- src-tauri/src/schema.sql is the immutable version-1 baseline.
- Later changes are appended as ordered SQL migrations and registered with a
  strictly increasing version.
- Applied migration SQL and checksums are never rewritten.
- Unknown versions, checksum mismatches, invalid migration history, and failed
  migrations stop database opening without deleting the database or sidecars.
- Migrations preserve library membership, categories, plugins, chapters,
  reading state, downloads, queues, and sync state unless an explicitly approved
  migration says otherwise.
- Runtime startup may rebuild caches from authoritative files, but schema changes
  never use opportunistic runtime DDL.

The current migration set extends through 0012_content_sync_journal_triggers.sql.

## Filesystem metadata

Work metadata uses filesystem schema version 1. The authoritative work document is
contents/<pluginId>/<novelId>/novel.json and the current contract is defined in
[filesystem-metadata-v1.md](filesystem-metadata-v1.md).

Unsupported explicit metadata versions are rejected. Recovery does not guess
portable identities from titles or local database IDs.

## Chapter content

Current chapter storage uses the original chapter body plus optional manifest.json
and media.zip. Content-server packageVersion 1 and chapter-files layout are the
supported transfer format.

Incomplete media is represented explicitly. Existing readable body content is not
discarded merely because media is incomplete.

## Portable backup

The portable app backup format is version 6.

A portable backup contains app/library state and download metadata but not the
downloaded chapter bodies themselves. Restore rechecks the selected content folder
so download flags match files that actually exist.

Device credentials, server authentication keys, VPN secrets, and storage-folder
permissions are not portable backup state.

Older portable manifest versions that the current parser does not support are
rejected instead of being silently reinterpreted.

## Full device backup

The native full-device archive format is version 2. It is distinct from the
portable backup format and from content-server chapter storage.

Restore validates the archive, database migration history, and expected files
before replacing live state. Interrupted restore keeps recovery material rather
than treating a partial replacement as complete.

## Update metadata

Application update metadata uses schema version 1. Unsupported update metadata is
rejected before download/install actions.

Tracing Android APKs use the same application package and signing identity as the
matching release APK so they can replace it without clearing data.

## Content server compatibility

Use current Norea 0.2 app and server builds together.

The app probes server capabilities before using optional protocol features.
Capabilities gate behavior such as:

- chapter-file transfer;
- work metadata and cover synchronization;
- work migration and migration lineage;
- chapter-number reconciliation;
- user-state bulk synchronization and opaque identities;
- full-device backup operations.

A client must not invent fallback semantics for a capability the server does not
advertise. Unsupported optional operations remain unavailable while ordinary
local reading stays usable.

## Content sync state

Content sync cursors, upload fingerprints, deletion exclusions, migration state,
and downloaded-server evidence are durable cache state. They survive restart and
are scoped to the configured server.

The sync engine may perform an explicit reconciliation when a newer client needs
to discover durable local files that predate the local change journal. Once that
checkpoint is recorded, ordinary synchronization returns to incremental discovery.

Local deletion and server deletion are separate. Server deletion records prevent
ordinary rescans from silently republishing removed content.

## Shared user state

Shared user changes use the migration-11 local journal and the server user-state
delta protocol.

- Local edits are stored durably before upload.
- Sent operation bytes and operation IDs remain stable until acknowledged.
- Server receipts are idempotent.
- Cursors advance only after durable local application/acknowledgement.
- Missing content does not erase shared user-state records.
- Opaque identities are retained only when the server advertises support.

The detailed merge contract is in [user-state.md](user-state.md).

## Work migration and chapter composition

Pending work migrations, migration receipts, chapter-number mappings, and chapter
composition documents are durable state. Restart and retry reuse the recorded
operation identity rather than creating a new semantic operation.

Composition and migration state use portable source identities; local row IDs are
never cross-device identities. Source and target must be different remote works:
they may use different plugins or distinct provider-owned work IDs under the
same plugin. Self-migration is rejected before any source work is retired.

Work merges save their storage plan and metadata baseline before moving chapter
folders. The merge transaction also commits the storage journal. On restart,
uncommitted moves return to their source paths; committed moves finish cleanup.
Unexpected source files or metadata changes stop recovery without overwriting
them. Providers without folder-move support retain the copy-and-delete path.

## Plugin-owned storage IDs

Source plugins own stable novel IDs used as storage directory names. IDs must be
portable safe child names and must not be silently changed for an existing work.

The host does not derive a replacement ID from the title or source URL when the
plugin-owned ID is missing or invalid.

## Settings and localStorage

Persisted settings use their current documented shapes. New fields should be
additive and default safely when absent.

When a setting migration is required, perform it once and record completion in
the same settings domain. Do not keep permanent compatibility readers for
discarded development-only shapes unless explicitly required.

## Development rules

When changing a persistent format:

1. identify the authoritative current schema;
2. decide whether the change is additive, migrated, or intentionally incompatible;
3. add regression coverage for populated existing data;
4. verify restart/reopen behavior;
5. preserve data on failure;
6. update this document only with the current rule, not an implementation diary.

Historical migration rationale remains available in Git history.
