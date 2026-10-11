# Filesystem metadata v1

## Contract

`contents/<source>/<work>/novel.json` is the authoritative, portable description
of a work and its complete known chapter list, including undownloaded chapters.
The app database retains queryable metadata as a rebuildable cache. Files win
when cache and disk differ. Reading progress, bookmarks, library membership,
and other device preferences stay local and are not sent to the content server.
No old-database migration or automatic rewriting of existing user folders is
part of this change. Both applications use a single database schema v1 baseline,
metadata schema v1, and API/package version 1. Existing databases must be retained
separately when preparing a fresh development database. The independent
source-plugin API remains 0.2.

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
    isLocal: boolean;
  };
  chapters: {
    path: string;
    name: string;
    chapterNumber: string | null;
    position: number;
    page: string;
    contentType: 'html' | 'text' | 'markdown' | 'pdf' | 'epub';
    releaseTime: string | null;
    directory: string;
  }[];
  cover: { fileName: string; contentType: string | null; sourceUrl: string } | null;
  updatedAt: number;
}
```

Chapter directories are single safe child names, not absolute paths or paths
inferred back into source URLs. Source paths are preserved verbatim. Numeric
database IDs are local cache details and do not occur in this document.
`cover.fileName` is a safe work-local `cover.<extension>` filename. Cover bytes
and the existing `cover.json` sidecar live beside `novel.json`.
Media `manifest.json` remains a separate chapter-media inventory.
Text-only chapters do not require that media inventory.

Metadata is written atomically through a temporary sibling file and rename.
Cache writes must not silently overwrite newer files during startup/rebuild.
Malformed metadata is reported, never converted into an empty work. Identity,
directory traversal, duplicate chapter paths/directories, and size limits are
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
Full work metadata comes from the work catalog; an individual chapter download
can still import its package identity when full metadata is unavailable.

Folder scanning prefers novel.json and requires no app database when it exists.
It registers the work and cover even when no complete chapter is present. It
uses exact chapter paths and directories from the file. Invalid present metadata
is not replaced by database guesses. Optional legacy DB-assisted scanning may
remain for existing folders, without writing into those folders.

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
