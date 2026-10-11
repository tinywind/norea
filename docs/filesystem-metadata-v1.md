# Filesystem metadata v1

## Contract

`contents/<source>/<work>/novel.json` is the authoritative, portable description
of a work. Chapter lists remain in the app database; completed chapter files
can rebuild downloaded chapter entries.
The app database retains queryable metadata as a rebuildable cache. Files win
when cache and disk differ. Reading progress, bookmarks, library membership,
and other device preferences stay local and are not sent to the content server.
No old-database migration or automatic rewriting of existing user folders is
part of this change. Both applications use a single database schema v1 baseline,
metadata schema v1, and API/package version 1. Existing databases must be retained
separately when preparing a fresh development database. The independent
source-plugin API remains 0.2.

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

```typescript
interface NovelMetadataV1 {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: {
    name: string;
    cover: string | null;
    author: string | null;
    artist: string | null;
    summary: string | null;
    status: string | null;
    genres: string | null;
    rating: number | null;
    isLocal: boolean;
  };
  cover: { fileName: string; contentType: string | null; sourceUrl: string } | null;
}
```

`rating` preserves the plugin rating on a zero-to-five scale; it is null when
absent. `status` preserves source text. `totalPages` controls chapter pagination
and is not work metadata. Chapter directories are safe child names and are never
interpreted as source URLs. Numeric database IDs stay in the local cache.
`cover.fileName` is a safe work-local `cover.<extension>` filename. Cover bytes
and the existing `cover.json` sidecar live beside `novel.json`.
Media `manifest.json` remains a separate chapter-media inventory.
Text-only chapters do not require that media inventory.

Metadata is written atomically through a temporary sibling file and rename.
Identical metadata, cover bytes, and cover sidecars do not trigger file writes.
The metadata document has no timestamp or chapter list.
Cache writes must not silently overwrite newer files during startup/rebuild.
Invalid local metadata is skipped with a path-only warning during scans; valid
works still load. Storage access errors and duplicate valid work identities
remain errors. Fresh validated metadata from a source or server can replace an
obsolete document when its stored plugin ID and work path match exactly. This
replaces only work metadata; existing chapter bodies and media remain untouched.
Invalid metadata is never converted into an empty work. Identity,
directory traversal, and size limits are
validated at both import boundaries. Renaming a title retains the existing work
directory when its identity already exists.

## Server and synchronization

The work ID is SHA-256 of `JSON.stringify([pluginId, novelPath])`, matching the
existing chapter package work identity. Existing complete chapter ZIPs keep
packageVersion 1. Work metadata and cover transfer independently of chapter
downloads so catalog-only works display their covers in the app.

- `PUT /api/v1/works/:id`: device-authenticated JSON upsert of NovelMetadataV1.
- `GET /api/v1/works?after=0&limit=100`: `{items, cursor, hasMore}` incremental
  work catalog. Items are `{id, sequence, metadata, hasCover}`.
- `GET /api/v1/works/:id`: one work catalog item.
- `PUT /api/v1/works/:id/cover`: device-authenticated raw image bytes; the
  work's metadata supplies the filename. Maximum cover size is 10 MiB.
- `GET /api/v1/works/:id/cover`: image bytes, using the normal read policy.
- `GET /api/v1/admin/works?search=&offset=0&limit=50`: console-authenticated
  `{items, total}`; each item also has `chapterCount` and `downloadedChapters`.
- `GET /api/v1/admin/works/:id/cover`: console-authenticated image bytes.

Metadata and covers are stored in readable work folders. SQLite indexes these
files and keeps durable change cursors; the files can rebuild the work catalog.
Metadata-only works are valid. Covers update the work change cursor as well.
The sync client records local metadata/cover fingerprints and its remote work
cursor. It never sends personal reading state. Conflict handling preserves
pending local edits instead of overwriting them with an earlier remote snapshot.
Chapter catalog pages update the package index without rewriting work files.
Full work metadata comes from the work catalog. A work must be installed before
its chapter packages; a package cannot reconstruct missing work metadata.

Folder scanning requires novel.json and does not consult an app database.
It registers the work and cover even when no complete chapter is present. It
scans completed chapter folders independently of the work document. Invalid or
missing metadata is not replaced by database guesses. Existing user folders
remain read-only scan inputs.

## Console

Content opens as a responsive work-cover grid with a grid/list toggle, search,
chapter counts, and a Metadata action. A work opens its existing chapter and
revision controls. Metadata is shown as readable fields plus its full JSON;
missing covers have a stable placeholder. Image requests use console auth without
putting session tokens in URLs. Existing console styles and accessibility apply.

## Verification

Test file-only import, cover round trips, metadata-only works, DB cache rebuild,
file precedence, chapter identity fidelity, invalid metadata, unsafe paths,
interrupted writes, work/cover change cursors, and local reading-state isolation.
Run app TypeScript tests/typecheck and relevant Rust checks, server tests/build,
and console browser checks at desktop and mobile widths. All real existing Norea
content is a read-only test input; writable fixtures live under project `.tmp`.
