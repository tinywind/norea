# Content server integration

The optional [Norea Content Server](https://github.com/tinywind/norea-content-server)
stores complete chapter files for your devices. Configure it under Settings >
Data > Content server. Reading positions, read flags, bookmarks, and library
membership stay local. Reading continues when the server is unavailable.

## Using the server

1. Start the server using its README.
2. Save the server URL and a device name in Norea.
3. Open Browse > Content server to search titles or filter by source. Results
   load one page at a time, without waiting for a full sync. The device registers
   automatically; no account or password is required.
4. Open a work to view its cover and available chapters. Use the usual library
   and download buttons. Downloads use the server's files without contacting
   the original site or requiring its plugin.
5. Choose a sync mode. Sync now remains available in every mode.

| Mode | When synchronization runs |
| --- | --- |
| Manual only | When you request it, including explicit server actions |
| Periodically | On startup or return to the app, then at the selected interval (1–1440 minutes; default 15) |
| When changes occur | On startup or return, after local content changes settle for 1.5 seconds, and when the server reports new catalog changes |

Automatic sync runs while the app is visible. It resumes on foreground or network
recovery; it does not require the app to remain connected for reading. Android
suspension stops the foreground scheduler. Changing to Manual only stops scheduled
work and cancels the server change wait; a transfer already started may finish.
Reading, bookmarking, and library changes do not trigger content sync.

The server acts as an optional shadow backup. Automatic lookups, transfers, and
refreshes run in the background without blocking navigation or adding error
banners to normal pages. Saved work details and local reading stay usable when
the server is slow or unavailable. Explicit server actions still report failures
that prevent completion. Sync does not refresh plugin repositories.
A work becomes visible after its metadata and cover are installed.
Sync preserves existing library membership; add a server work to the library
from its detail page. Sync now uploads complete local chapters and updates the
remote catalog independently of browsing or selected chapter downloads.

Settings > Data > Content server includes **Upload conflicts**:

- **Prefer complete chapters** (default) replaces an incomplete server chapter
  with a complete app chapter. Equal completeness keeps the server copy.
- **Keep server data** preserves an existing server copy.
- **Replace with app data** replaces the server chapter with the uploaded copy.

Changing this setting makes the next sync recheck local chapters, including
chapters previously skipped. A sync already running uses its selected policy.
The server applies the policy again when publishing the upload, so concurrent
uploads or deletions cannot silently replace a newer copy.

Upload and folder indexing record completeness from the media inventory: every
asset declared in `manifest.json` must exist in `media.zip`. Cached completion,
status, and byte counts do not establish completeness. Safe extra ZIP entries
are allowed. A body-only chapter without a media manifest has no declared assets.
Valid incomplete chapters remain indexed but are excluded from server downloads;
invalid manifests and unsafe archives are rejected. App folder scans use the
same rule and mark incomplete chapters as needing media repair.

All works are synchronization targets; library membership does not select the
sync scope. Opening any work refreshes that work from the connected server in
the background, independently of the scheduled sync mode. Saved information is
shown immediately. This request retrieves only the selected work's metadata,
cover, and chapter summaries without downloading chapter bodies. Metadata transfers
to the same server run sequentially, so this lookup may wait for an active work
metadata sync. Navigation cancellation also cancels a waiting lookup. Chapter file
transfers and local source refreshes do not hold this metadata queue.
Locally known chapters remain available when absent from the server response.

For a work opened from the server catalog, an installed source plugin also
refreshes its current metadata and chapter list when the original novel path is
known. It uses the normal source task and scraper path. Missing source metadata
does not clear stored fields, and chapters removed from the site remain stored.
Source refresh starts independently of the server request, with automatic refresh
behind user tasks in the source queue. A late server response cannot replace a
completed source refresh. Unchanged server metadata and covers are not reinstalled.
A failed server or site request leaves the saved work usable. A work must have
original source identity metadata; folder names cannot establish work identity.

Before a chapter download, Norea checks the cached download state in SQLite and
skips completed chapters. For pending chapters, each download batch lists the
work's chapter folders once and restores missing download flags and chapter
rows before contacting the server. Each discovered folder is checked for its
body and declared ZIP assets without finalizing or rewriting media. Deletions during this scan
cannot restore stale download flags. Detailed content recovery remains part of
opening stored content and explicit storage rescans.
For an unfinished chapter, Norea asks the server for that chapter. Matching files
install into the existing local chapter; otherwise an available source plugin
handles the download. The server lookup timeout defaults to 3 seconds
and can be set from 1 to 120 seconds. This deadline includes device registration
and metadata lookup, and also applies to work-home server refreshes. Chapter file
transfers have their own timeout. Server-only chapters report unavailable-server
errors instead of sending their folder identities to a source plugin.
After a server failure, source-capable chapters skip server attempts for 30 seconds;
a missing chapter does not trigger this delay. A failed chapter transfer also falls
back to the source plugin. Cancelling a transfer releases the download task without
publishing late results. Native HTTP may finish in its private staging directory,
which is removed after the request ends.

Chapter rows show the current step below the title: checking download status,
checking the content server, downloading from the content server, or downloading
from the original site. The label changes when a server attempt falls back to
the source. Queued rows show the known pending step; an unstarted download has
no selected source yet.

Registered devices can delete and restore server chapters. Deletion confirmations
name the selected scope and server. Additional options start unchecked. Server
chapter deletion can also remove matching device downloads; local chapter deletion
can also remove matching server chapters, including incomplete copies. These
operations preserve work information and reading progress. Removing library
membership can also delete device downloads or the whole server work. Settings
maintenance uses the same choices for the entire library or all downloads.

When the work is on the server or already linked to it, **Manage server data**
opens a separate server chapter list with its own selection and pages of 100
chapters. Explicit app deletions persist per-server upload exclusions keyed by
plugin-owned work and chapter identities. Normal sync and local rescans do not
undo those choices after restart. An explicit server chapter restore clears that
chapter's exclusion. Deletions originating outside this app retain the existing
sync policy: completed local chapters can fill missing server copies. To replace
existing complete chapters, select **Replace with app data** under Upload
conflicts, then choose **Sync now**.
**Delete work from server** is available on each work in Browse -> Content server
and in the work's **Manage server data** page. After confirmation, it removes
the whole server work folder, metadata, cover, and chapter index, using the
registered device key. Its optional device action removes the matching work's
database records, files, library membership, and reading state. Keeping device
data still leaves the explicitly deleted server work excluded during rescans.
Whole-work deletions originating in the server console can be restored by an
explicit local rescan when this app has no explicit exclusion for that work.

Deletion waits for active content synchronization, with a 30-second admission
timeout. A timed-out request cannot execute later. Results distinguish successful
and failed targets; retries skip successful actions. Local deletion cancels only
the selected chapter downloads and does not enter the task queue.
An in-progress local write for a selected chapter settles before its files are
removed; cancelled downloads cannot write files afterward. Pending batch entries
and late download-queue inserts are discarded for those chapters. A new download
for the same chapter waits for that deletion before accessing its local files.

## Device access

Each server URL has its own random 32-byte device key, persisted in this app's
local storage before registration. The key survives app restarts and stays outside
portable backups. Restoring a backup does not replace or remove device keys.
The app does not derive keys from hardware identifiers.

The server accepts new devices automatically. Its administrator can block or
unblock a device in the server console. The app keeps the same key after rejection
and shows a blocked-device message; it never creates another key to bypass a
block. Ask the administrator to unblock the device before retrying.

The app checks `/api/v1/capabilities` before device registration. It
requires API version 1, package version 1, `authentication: "device-key"`, and
`personalStateSync: false`. Registration uses `/api/v1/devices/register`;
successful registration is reused during the app session. A changed device name
or key requires registration again. HTTP 401 clears only this in-memory result so
the next request registers the same saved key. Subsequent requests carry the key
in the authorization header. Change waiting
uses `catalogAfter`, `workAfter`, and `waitSeconds` and receives chapter and work
cursor hints.

## Storage and compatibility

Plugin ID, novel path, and chapter path identify content across devices. Existing
numeric database IDs remain device-local. The plugin supplies a stable, unique
`novelId`. Both app and server store files under
`contents/<pluginId>/<novelId>/<chapterNumber>/`, without work or chapter titles
in directory names. Invalid IDs and collisions are rejected. This development
format does not convert earlier title-based directories.

Each work folder stores an authoritative `novel.json` and its cover image.
No cover sidecar or source cover URL is generated or transferred. Readers require
only the plugin ID, source path, and work name; optional fields may be absent and
unknown fields are ignored. The document stores work information, including source rating,
with a chapter-number-to-title catalog and no update timestamp. Work paths
exclude the source base URL and retain identity query parameters. Numeric chapter
folders supply downloaded chapter availability; the catalog supplies titles. Source and server chapter lists are cached separately.
SQLite keeps a queryable metadata cache and local
reading state. Normal startup reuses this cache and restores directory mappings
without reading every metadata file or rewriting chapter rows. The first cache
initialization, explicit local rescan, and recovery rebuild it from the files.
Metadata changes check the saved file fingerprint before writing back to the work
folder. The [v1 file contract](filesystem-metadata-v1.md) defines
the fields and validation rules. Existing folders are not automatically rewritten
from an older database during startup.

Work metadata and covers transfer separately from chapter files. Sync records a
work cursor, per-work fingerprints, and local metadata/cover change revisions.
Normal sync reads only changed work files; external edits require an explicit
rescan. Every successful source refresh advances the upload revision, even when
the metadata is unchanged. A revision is acknowledged only after both metadata and
cover upload succeed. Remote installations record their exact committed revision;
local refreshes that complete during transfer stay pending. Server lookups cannot
replace a pending local revision. Pending local edits and failed transfers remain
eligible for retry.
Saved metadata supports offline browsing without refetching the
source site. Reading progress and library membership stay on each device.

Only complete chapters outside the download queue can start an upload. This also
applies to manual sync and local rescans. Pending queue writes, persisted queue
entries, active downloads, and media repairs defer the affected chapter. Queue
checks use chapter-ID maps and SQLite primary-key lookups, without scanning the
task list for every chapter. Queue changes invalidate an upload being prepared,
and completion and queue state are checked again before native transfer starts.
Deferred chapters stay pending; other completed chapters continue syncing. When
changes mode is enabled, queue settlement schedules another sync. Transfers use
a private snapshot of completed files and never hold download locks during HTTP.

Native code sends the original `content.html`
or `content.pdf`, with `manifest.json` and `media.zip` when present, in one multipart
request. It streams the saved bytes without creating an extra ZIP, rewriting HTML
or media references, or extracting and recompressing media.

Uploads use `POST /api/v1/chapter-files`. The `metadata` part contains the
`PackageManifest`, with `layout: "chapter-files"`, the body path, and each file's
path, size, and filesystem modification time (`modifiedAt`, Unix milliseconds).
Each file has its own multipart part, named after its filename.
The server publishes a revision only after every listed file arrives
and passes validation. Catalog entries for this layout expose their total stored
size as `fileBytes`.

Downloads request each original file through
`GET /api/v1/chapters/:id/files?revision=<revision>&path=<filename>`.
Native code checks every file's name, size, and completed transfer in a private
staging directory before installing the complete set. Interrupted replacement
preserves a target-named backup that storage access can recover.

Media repair preserves the saved body and validates existing ZIP entries before
requesting missing or corrupt assets. Server copies supply individual assets
through `GET /api/v1/chapters/:id/media`, with the revision, filename, and original
source URL identifying the requested entry. The server checks the entry's size
and CRC before returning it. Repair can use server assets without an installed
source plugin; source-site fallback still requires the plugin fetch path.

Only the current original-file format is supported. There is no outer ZIP
transfer, older manifest decoder, or media-reference conversion.

Chapter transfers do not compute or compare SHA-256 file checksums. A same-size
change with an unchanged modification time cannot be detected by a file rescan.
Identity and authentication hashes are independent of file transfer validation.

Use current app and server builds together. Older protocols are unsupported.

The app records local content changes in SQLite alongside the affected data.
Sync uses durable catalog cursors, fingerprints, and pending uploads so failed
requests can be retried after a restart. These records are scoped to the server.
Journal sequence numbers select changes; file names, sizes, and modification
times identify unchanged chapter snapshots without rereading their contents.

The first sync establishes a baseline. Later syncs read recorded local changes
and server chapter deletions, then check affected complete chapters. Deleted
chapter deltas do not include a chapter number, so the app rechecks completed
chapters in the same work to match source paths and recovered folder identities.
Those checks become durable local upload candidates before the deletion signal
is consumed. Existing siblings skip snapshot creation and upload; failed or queued
candidates remain pending. Explicit app deletion exclusions suppress these uploads;
whole-work exclusions also suppress metadata restoration during local rescans.
The server's change-wait endpoint returns
cursor hints; the app then fetches the corresponding deltas. Before making a
snapshot, the app checks whether the server already has a complete chapter.
The selected conflict policy determines whether an existing copy skips local
file copying or receives an upload. The server retains one copy and records its
verified completeness. Missing or wrong-sized server files can be repaired by
the next completed upload.

Chapter deltas contain identities, completeness, and deletion state, without package file
inventories. The app retains cursors and pending deletion signals instead of a full
remote catalog snapshot. Browsing retrieves summaries in pages; a selected download
fetches its package manifest separately.

A sync request arriving during an active pass queues another pass. Waiting requests
coalesce and preserve upload and rescan requests, so a metadata refresh after the
active work phase is processed before the requesting caller completes.

The app database uses an immutable v1 baseline. Later schema changes increment
the version and migrate existing records, including sync exclusions and cursors.
Version/checksum errors preserve the database and stop opening it. An incompatible
server schema still requires a fresh state volume; server format conversion is
outside this app migration policy. Sync cursors and device keys remain outside
portable backups. No account, session, or personal-state endpoint is called.

Local content installation is serialized per work. Network transfers use private
staging directories and do not hold a work lock. Upload fingerprinting and transfer
use one snapshot. Android copies snapshots on a separate, bounded worker so that
the foreground storage queue can process metadata, downloads, and deletion.
Conflicting changes during copying discard the snapshot and leave the upload pending.
Backup restoration waits for active work operations and holds exclusive storage
access while inspecting original files and restoring database state. It never
deletes or rewrites work metadata, covers, or chapter files, including files for
works omitted from the backup. Inspection failure leaves the database unchanged;
failure during the native restore transaction rolls it back. Only discovered
completed chapter files are marked downloaded and eligible for upload.

## Current limits

Automatic per-work download policies are not implemented. Downloads restart after
interruption; the app does not resume partial chapter files or legacy ZIP transfers.
Local imports and completed downloads enter the local change record and follow
the selected sync mode.

Edits made directly to downloaded files outside Norea are not database changes.
Use Rescan local files and sync after those edits. This explicit scan checks all
local chapter folders and can take time for large libraries. Android uses a
cache snapshot to read SAF files, so staging also needs free device storage.
Transfers stream the saved body and media without conversion.
The legacy ZIP decoder still reads HTML into memory when converting old package
references. Source-plugin traffic continues through the existing
scraper path, independently of content-server traffic.

## Local Android testing

Run the server on the development machine and map its port with
`adb -s <serial> reverse tcp:8080 tcp:8080`. Configure `http://127.0.0.1:8080`
in the app. Use a separate debug app and an owned test storage folder. Do not clear
or uninstall the user's existing app to work around installation or migration
errors. See [development.md](development.md) for the targeted Android build.
