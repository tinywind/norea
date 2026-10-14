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

All works are synchronization targets; library membership does not select the
sync scope. Opening any work refreshes that work from the connected server in
the background, independently of the scheduled sync mode. Saved information is
shown immediately. This request retrieves only the selected work's metadata,
cover, and chapter summaries, without waiting for the full catalog or downloading chapter bodies.
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
rows before contacting the server. Known completed folders are skipped; only
uncached folders are checked for final body filenames and sizes,
without reading bodies or finalizing media archives. Deletions during this scan
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

Registered devices can delete and restore server chapters. Server deletion
preserves local files. Removing a local download does not delete the server copy
or automatically download it again. When the work is on the server or already
linked to it, **Manage server data** opens a separate server chapter list from
the work page. It has its own selection, pages of 100 chapters, and deletion
confirmation naming the work and server. Only selected server chapter IDs are
deleted; local files, work metadata, and covers remain. Automatic sync respects
deletions. To replace content, delete it on the server, then choose **Rescan local
files and sync**. The app does not offer whole-work deletion from the server.
Whole-work deletion in the server console removes the server folder, metadata,
cover, and chapter index. It keeps device copies intact and blocks automatic
metadata reuploads until an explicit rescan restores the work.
Local deletion runs directly and cancels only the selected chapter downloads.
It does not enter the task queue or wait for network requests or unrelated jobs.
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
numeric database IDs remain device-local. Downloaded chapters use the existing
readable directory rules; synchronization does not rename existing folders.

Each work folder stores an authoritative `novel.json` and its cover image.
No cover sidecar or source cover URL is generated or transferred. Readers require
only the plugin ID, source path, and work name; optional fields may be absent and
unknown fields are ignored. The document stores work information, including source rating,
without chapter lists or update timestamps. Work paths exclude the source base URL
and retain identity query parameters. Chapter folders supply downloaded chapter
numbers and titles. Source and server chapter lists are cached separately.
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
rescan. Pending local edits and failed transfers remain eligible for retry.
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

The first sync establishes a baseline. Later syncs read recorded changes and
check only affected complete chapters. The server's change-wait endpoint returns
cursor hints; the app then fetches the corresponding deltas. Before making a
snapshot, the app checks whether the server already has a complete chapter.
Existing copies skip local file copying and upload, including after an app-side
edit. The server retains one copy and ignores competing uploads. Missing or
wrong-sized server files can be repaired by the next completed upload.

Chapter deltas contain identities and deletion state, without package file
inventories. The app retains cursors and tombstones instead of a full remote
catalog snapshot. Browsing retrieves summaries in pages; a selected download
fetches its package manifest separately.

The current development schema has one v1 bootstrap. A version or checksum
mismatch recreates the app database, without importing previous records. Current
files remain available for an explicit rescan. Server schema mismatch requires
a fresh state volume; no migration or format conversion runs. Sync cursors and
device keys remain outside portable backups. No account, session, or personal-state
endpoint is called.

Local content installation is serialized per work. Network transfers use private
staging directories and do not hold a work lock. Upload fingerprinting and transfer
use one snapshot. Android copies snapshots on a separate, bounded worker so that
the foreground storage queue can process metadata, downloads, and deletion.
Conflicting changes during copying discard the snapshot and leave the upload pending.
Backup restoration waits for active work operations and holds exclusive storage
access until files and settings are ready. If file
restoration fails after the database was replaced, restored downloads are marked
as needing repair and are excluded from upload.

## Current limits

Automatic per-work download policies are not implemented. Downloads restart after
interruption; the app does not resume partial chapter files or legacy ZIP transfers.
Local imports and completed downloads enter the local change record and follow
the selected sync mode.

Edits made directly to downloaded files outside Norea are not database changes.
Use Rescan local files and sync after those edits. This explicit scan checks all
complete local chapters and can take time for large libraries. Android uses a
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
