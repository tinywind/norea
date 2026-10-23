# Content folder recovery

Use a disposable app profile and a separate content-server state directory when
checking recovery. Export the app profile before clearing its database. Keep
server SQLite files outside a synchronized content folder.

## Current layout

Select the parent of `contents/` in the app:

```text
<storage root>/contents/<pluginId>/<novelId>/novel.json
<storage root>/contents/<pluginId>/<novelId>/cover.jpg
<storage root>/contents/<pluginId>/<novelId>/<chapterNumber>/content.html
<storage root>/contents/<pluginId>/<novelId>/<chapterNumber>/manifest.json
<storage root>/contents/<pluginId>/<novelId>/<chapterNumber>/media.zip
```

The source plugin supplies `novelId`. `novel.json` must contain matching
`identity.pluginId` and `identity.novelId`, the source-relative `identity.novelPath`,
work details, and a `chapters` map of canonical chapter numbers to exact titles.
A chapter number is a canonical nonnegative number, such as `1` or `2.5`.
Different sources can use the same work ID.

Text-only chapters need only their body. A PDF chapter uses `content.pdf`.
For chapters with media, every asset declared in `manifest.json` must exist in
`media.zip`. A saved `complete` flag does not establish completeness.

An explicitly requested offline conversion should preserve the original tree,
resolve work IDs using the relevant plugin, and retain exact titles in
`novel.json` before removing titles from directory names. Preserve `contents/.nomedia`
to avoid starting an Android media scan. Keep duplicate copies and old package
files in the saved original tree outside the active `contents/` directory.
Runtime recovery accepts only the current format.

## Verification

1. Inventory work identities, optional metadata, chapter titles, stored chapter
   numbers, and ZIP asset names before recovery. Preserve the inventory outside
   the content folder. Include works without downloaded chapters and chapters
   with missing assets.
2. Start the content server with fresh SQLite state and the actual `contents/`
   directory mounted into its storage root. Run a full folder scan. Compare
   every `works.entry.metadata` document and every chapter's identity, title,
   directory, and `complete` value with the inventory. Require zero skipped or
   failed items for a fully converted directory.
3. In Waydroid, start with an empty app database and select the same storage root
   through the Android folder picker. Let background recovery finish. Check
   actual SQLite rows through the debug WebView or a stopped database snapshot;
   library card counts alone do not verify recovery.
4. Compare `novel.plugin_id`, `source_novel_id`, `path`, work details, every
   chapter number and title, and `work_metadata_directory_cache.directory`.
   All metadata-only catalog entries must remain present. Complete stored
   chapters have `is_downloaded=1` and `media_repair_needed=0`. Incomplete stored
   chapters have `is_downloaded=0` and `media_repair_needed=1`. Catalog-only
   chapters have neither flag set.
5. Cold-start the app again and repeat the comparison. Open a recovered text
   chapter and a chapter with media while source plugins and a content server
   are unavailable. Recheck metadata file hashes to detect unintended writes.

Useful app counts:

```sql
SELECT COUNT(*) AS works FROM novel;
SELECT COUNT(*) AS catalog_chapters,
       SUM(is_downloaded) AS complete_chapters,
       SUM(media_repair_needed) AS incomplete_chapters
FROM chapter;
SELECT COUNT(*) AS stored_chapters FROM work_metadata_directory_cache;
```

Server folder collision checks must use an indexed case-insensitive directory
lookup. A table scan for each imported chapter makes large fresh recoveries
progressively slower. The server's current bootstrap includes this index;
server state from a different bootstrap must be recreated according to its
README.
