# Filesystem metadata v1

## Contract

`contents/<source>/<work>/novel.json` is the authoritative, portable description
of a work, including its saved chapter catalog. Recovery caches the catalog in
SQLite and matches completed chapter files by their source chapter numbers.
The app database retains queryable metadata as a rebuildable cache. Files win
when cache and disk differ. Reading progress, bookmarks, library membership,
and other device preferences stay local and are not sent to the content server.
Both applications support only the current database schema v1, metadata schema v1,
and API/package version 1. No upgrade migrations or previous-format readers are
retained. A schema checksum mismatch recreates the app database while leaving
files on disk. The server requires a fresh state volume for an incompatible
schema. The independent source-plugin API remains 0.2.

The work identity uses the plugin ID and its source path without the base URL,
for example `/novel/123456`. Absolute HTTP URLs, protocol-relative URLs, and
`norea-folder:` work identities are invalid. Existing folders without valid
`novel.json` are skipped by the content server; no title or work URL is guessed.
Chapter folders named `<number>-<title>` are discovered from completed
`content.html` or `content.pdf` files. A nonempty final body remains readable
even when a media manifest is incomplete or malformed, or a partial artifact
remains. Server package completeness is checked separately. A matching cached
chapter keeps its exact
source path, ID, source title, and reading state. Without a cached match, the
chapter receives a local `norea-folder:<number>` path; source refresh can resolve
that chapter path by an unambiguous chapter number. Work metadata refresh does
not delete source chapters that have not been downloaded.

SQLite also stores rebuildable metadata fingerprints and chapter directory
mappings. Normal startup loads these mappings without rereading all work files.
An uninitialized cache, explicit rescan, or failed-write recovery reads the
authoritative files. Changes made outside the app require a rescan; writes check
the previous file fingerprint to avoid overwriting external edits.

Readers require only `identity.pluginId`, `identity.novelPath`, and `novel.name`.
`schemaVersion` defaults to 1 when absent; an explicit unsupported version is
rejected. Other missing values default to null, with `isLocal` defaulting to false
and `chapters` defaulting to an empty map.
Unknown fields are ignored and omitted on write and transfer. Present supported
fields must have valid types, and cover filenames must stay within the work folder.
The normalized document written by the app and server is:

```typescript
interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: {
    name: string;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: string | null;
    genres: string | null;
    rating: number | null;
    isLocal: boolean;
  };
  cover: { fileName: string; contentType: string | null } | null;
  chapters: Record<string, string>;
}
```

`rating` preserves the plugin rating on a zero-to-five scale; it is null when
absent. `status` preserves source text. `totalPages` controls chapter pagination
and is not work metadata. Chapter directories are safe child names and are never
interpreted as source URLs. Numeric database IDs stay in the local cache.
`cover.fileName` is a safe work-local `cover.<extension>` filename. Cover bytes
live beside `novel.json`. The app does not generate or read `cover.json`.
Source cover URLs remain in the app DB cache for source browsing and downloading
missing covers; they are not written to this document or sent to the server.
Local cover data URLs are also cache-only.
Media `manifest.json` remains a separate chapter-media inventory.
Text-only chapters do not require that media inventory.
Backup validates stored media entries against the archive's filenames and uses
the archive's uncompressed sizes for byte limits. It does not trust or require
the download checkpoint's `complete` property or cached per-image byte counts.
Remote-only media entries remain ineligible for complete offline backup.

Metadata is written atomically through a temporary sibling file and rename.
Identical metadata and cover bytes do not trigger file writes.
The metadata document has no update timestamp. `chapters` maps canonical numeric
source chapter keys to exact titles, including fractional chapter numbers. The
app writes this map only after source metadata fetches. The first fetch retrieves
the full source list; incremental fetches merge titles without dropping earlier
entries. Downloads, deletions, and reading changes never regenerate this map.
Restoring a backup creates the complete cached catalog, then marks only discovered
completed chapter files as downloaded. Completed folders missing from the catalog
are still recovered. Source chapter URLs are not stored in this map; a source
refresh resolves them after recovery before incremental updates can resume.
Cache writes must not silently overwrite newer files during startup/rebuild.
Invalid local metadata is skipped with a path-only warning during scans; valid
works still load. Storage access errors and duplicate valid work identities
remain errors. Updates require matching plugin ID and work path. Scans never rewrite source
documents; publication writes only the normalized current fields.
Invalid metadata is never converted into an empty work. Identity,
directory traversal, and size limits are
validated at both import boundaries. Renaming a title retains the existing work
directory when its identity already exists.

## Server and synchronization

The work ID is SHA-256 of `JSON.stringify([pluginId, novelPath])`, matching the
current chapter file identity. Chapter transfers use original files with
packageVersion 1 and layout `chapter-files`. Work metadata and cover transfer independently of chapter
downloads so catalog-only works display their covers in the app.

- `PUT /api/v1/works/:id`: device-authenticated JSON upsert of NovelMetadataV1.
- `GET /api/v1/works?after=0&limit=100`: `{items, cursor, hasMore}` incremental
  work catalog. Items are `{id, sequence, metadata, hasCover}`.
- `GET /api/v1/works/:id`: one work catalog item.
- `PUT /api/v1/works/:id/cover`: device-authenticated raw image bytes; the
  work's metadata supplies the filename. Maximum cover size is 10 MiB.
- `GET /api/v1/works/:id/cover`: image bytes, using the normal read policy.
- `GET /api/v1/admin/works?search=&offset=0&limit=50`: console-authenticated
  `{items, total}`; `chapterCount` counts catalog entries and `downloadedChapters`
  counts available server copies. Summary metadata omits the chapter map;
  the Metadata action fetches the full work document on demand.
- `GET /api/v1/admin/works/:id/cover`: console-authenticated image bytes.
- `GET /api/v1/admin/works/:id/chapters?search=&offset=0&limit=50`:
  console-authenticated saved chapter catalog with available server entries
  containing only `id` and `fileBytes`. Inspect fetches the full chapter details.
  Chapters without stored bodies have a null entry and cannot be deleted or read.

Metadata and covers are stored in readable work folders. SQLite indexes these
files and keeps durable change cursors; the files can rebuild the work catalog.
Metadata-only works are valid. Covers update the work change cursor as well.
The sync client records local metadata/cover fingerprints and its remote work
cursor. It never sends personal reading state. Conflict handling preserves
pending local edits instead of overwriting them with an earlier remote snapshot.
Chapter catalog pages update the package index without rewriting work files.
Full work metadata comes from the work catalog. A work must be installed before
its chapter packages; a package cannot reconstruct missing work metadata.

Folder scanning requires the essential fields in novel.json and does not consult
an app database. A cover descriptor is optional: readers discover nonempty
`cover.jpg`, `cover.png`, and other supported image files directly in the work
folder. An existing declared image takes priority; otherwise filename order
selects a cover. The saved catalog supplies chapter titles; chapter folders
determine file availability. Uploading a smaller catalog preserves previously
known titles. Deleting a chapter copy leaves the work catalog unchanged.
It registers the work and cover even when no complete chapter is present. It
scans completed chapter folders independently of the work document. Invalid or
missing metadata is not replaced by database guesses. Existing user folders
remain read-only scan inputs.

## Console

Content opens as a responsive work-cover grid with a grid/list toggle, search,
chapter counts, and Metadata and Delete actions. A work opens its chapter list
with file availability for each catalog chapter. Available copies have Inspect
and Delete actions; missing copies show Not backed up. Metadata is shown as readable fields plus its full JSON;
missing covers have a stable placeholder. Image requests use console auth without
putting session tokens in URLs. Existing console styles and accessibility apply.

## Verification

Test file-only import, cover round trips, metadata-only works, DB cache rebuild,
file precedence, chapter identity fidelity, invalid metadata, unsafe paths,
interrupted writes, work/cover change cursors, and local reading-state isolation.
Run app TypeScript tests/typecheck and relevant Rust checks, server tests/build,
and console browser checks at desktop and mobile widths. All real existing Norea
content is a read-only test input; writable fixtures live under project `.tmp`.
