# Content server integration

The optional [Norea Content Server](https://github.com/tinywind/norea-content-server)
stores complete chapter files for your devices. Configure it under Settings >
Data > Content server. Ordinary content sync handles work metadata and files.
The separate Shared user changes section merges manual library edits, categories,
reading state, bookmarks, resumes, and chapter compositions with stable source
identities. It is off by default for each server. See [Sharing user changes](user-state.md)
for the journal, conflict, privacy, and restore contracts. Reading remains available offline.

## Using the server

1. Start the server using its README.
2. Save the server URL and a device name in Norea.
3. Open Browse > Server to search titles or filter by source. Results
   load one page at a time, without waiting for a full sync. The device registers
   automatically; no account or password is required. Search and source filters
   remain when you return from a work and are kept separately for each server.
4. Open a work to view its cover and available chapters. Use the usual library
   and download buttons. Downloads use the server's files without contacting
   the original site or requiring its plugin.
   To add many works at once, choose Select (overflow menu, or a cover's
   long-press menu), or choose "Add all N works to library" for every work
   matching the current search and source. Select all also includes pages the
   grid has not loaded. The add runs as one background task in Downloads,
   at most three works at a time; works already in the library are skipped,
   chapters are not downloaded, and failed or unreached works can be retried.
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
Sync preserves existing library membership; add server works to the library
from Browse > Server or a work's detail page. Sync now uploads stored local
chapters and updates the remote catalog independently of browsing or selected
chapter downloads.

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
Valid incomplete chapters remain visible in server catalogs and the library,
and can be downloaded. Completeness is shown as status, without restricting
availability. Downloads preserve the body, manifest and available media bytes;
local inspection records missing assets as needing media repair. Invalid
manifests and unsafe archives remain errors.

All works are synchronization targets; library membership does not select the
sync scope. Opening any work refreshes that work from the connected server in
the background, independently of the scheduled sync mode. Saved information is
shown immediately. This request retrieves only the selected work's metadata,
cover, and chapter summaries without downloading chapter bodies. Metadata transfers
to the same server run sequentially, so this lookup may wait for an active work
metadata sync. Navigation cancellation also cancels a waiting lookup. Chapter file
transfers and local source refreshes do not hold this metadata queue.
The work's original source is checked for new chapters on open only when its
last check is older than 6 hours, within that source's hourly check budget; it
is no longer parsed in full on every open. "Refresh all novel info" still runs the
full source refresh.
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
errors instead of sending their folder identities to a source plugin. A recovered
folder chapter of a work whose source plugin is installed is source-capable: when
the server lacks it, the download refreshes that work once per session through the
task's plugin fetch route, including a VPN download worker's route, so matching
source chapter numbers replace folder identities, then downloads from the source.
It fails as a content error only when the source has no matching chapter.
After a server failure, source-capable chapters skip server attempts for 30 seconds;
a missing chapter does not trigger this delay. A failed chapter transfer also falls
back to the source plugin. Cancelling a transfer releases the download task without
publishing late results. Native HTTP may finish in its private staging directory,
which is removed after the request ends.

When a download goal queues chapters and a content server is configured, Norea
first lists that work's server chapters, 100 per page, within a 30 second
deadline. Queued jobs whose chapter the listing shows as complete, by chapter
path or by a unique chapter number, run first on the server lane: app-owned HTTP
to the user's server with up to 3 transfers at once, outside the source's serial
queue and without its cooldown. The lane is a route of the same queued task, so
each chapter keeps one owner. Every transfer repeats the identity check above and
also requires the server copy to be complete at that moment, because the listing
can be stale. When it cannot finish, the same task continues on its source route
exactly like any other download, including the ordinary server lookup. A failed
listing leaves the jobs on that ordinary route. The lane never sends a chapter to
a source plugin, and server-only chapters still fail instead of falling back.

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
**Delete work from server** is available in the work's **Manage server data**
page. After confirmation, it removes
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
portable file backups. Restoring a portable file backup does not replace or
remove device keys. A full device backup includes all saved localStorage
settings, including device keys, and restores the selected snapshot's values.
The app does not derive keys from hardware identifiers.

The server accepts new devices automatically. Its administrator can block or
unblock a device in the server console. The app keeps the same key after rejection
and shows a blocked-device message; it never creates another key to bypass a
block. Ask the administrator to unblock the device before retrying.

The app checks `/api/v1/capabilities` before device registration. It
requires API version 1, package version 1, `authentication: "device-key"`, and
the supported content protocol. Shared user changes additionally require
`userStateVersion: 1`. Legacy full-device archive requests require
`deviceBackupVersion: 1`. These capabilities are separate from the retained
private reading-history protocol; none substitutes for another feature version.
Registration uses `/api/v1/devices/register`;
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
rescan. A check for new chapters advances the upload revision only when it
changed the stored details or chapter list. Other successful source refreshes
(Refresh all novel info, import) advance it even when nothing
changed, which republishes the retained details. A revision is acknowledged only after both metadata and
cover upload succeed. Remote installations record their exact committed revision;
local refreshes that complete during transfer stay pending. Server lookups cannot
replace a pending local revision. Pending local edits and failed transfers remain
eligible for retry.
Saved metadata supports offline browsing without refetching the
source site. Reading progress and library membership stay on each device.

Stored chapters outside the download queue can start an upload, including
chapters with missing media. This also
applies to manual sync and local rescans. Pending queue writes, persisted queue
entries, active downloads, and media repairs defer the affected chapter. Queue
checks use chapter-ID maps and SQLite primary-key lookups, without scanning the
task list for every chapter. Queue changes invalidate an upload being prepared,
and completion and queue state are checked again before native transfer starts.
Deferred chapters stay pending; other completed chapters continue syncing. When
changes mode is enabled, queue settlement schedules another sync. Transfers use
a private snapshot of stored files and never hold download locks during HTTP.

Native code sends the original `content.html`
or `content.pdf`, with `manifest.json` and `media.zip` when present, in one multipart
request. It streams the saved bytes without creating an extra ZIP, rewriting HTML
or media references, or extracting and recompressing media. A leftover `media/`
download or repair workspace is not sent; its loose files are not part of the
stored chapter, so completeness follows `media.zip` and the chapter uploads as
incomplete when assets are missing there.
The upload deadline is 10 minutes, extended for large chapters to allow at least
64 KiB/s. A dropped connection, a client timeout, or HTTP 408, 502, 503 or 504
is retried once; other server responses are final. A failure reports how many
bytes were sent, the elapsed time and the underlying transport cause. Settings
shows a plain summary with the raw failure under Details.

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

### Device-only cleanup

Settings > Data > Clear downloaded chapters previews managed downloads and
requires confirmation. Server, reading status, and category conditions all
apply. The server condition can require an available chapter body, at least the
device's declared-asset coverage, or every valid device asset with matching
content. It can also ignore server state, without making a server request.
Coverage and containment require matching body digests and valid manifests;
coverage also requires the same declared asset set. Equal coverage can describe
different missing assets. Server checks use the work's saved server association,
or the configured server when the work has none. They are point-in-time checks,
not a guarantee that another device will retain the server copy.

Source downloads can be selected. A local-work chapter is eligible only when its
own completed server download has recorded proof matching its current files.
Older local chapters without that proof stay excluded even if their work has a
server association. Cleanup preserves the work and chapter metadata, including
`manifest.json`, and updates download state from remaining files. It does not
remove server copies or create upload exclusions. Interrupted cleanup requires a
new preview and does not resume automatically.

For server-dependent previews, the app requests
`GET /api/v1/chapters/:id/storage-inventory?revision=<revision>`. The response
contains the package identity and revision, a SHA-256 body digest and byte count,
manifest asset keys, and valid uncompressed asset digests and byte counts. A
missing or malformed manifest produces `expectedAssetKeys: null`. The presence
condition adds `presenceOnly=true`; this checks and hashes the body and returns
`expectedAssetKeys: null` with an empty `storedAssets` array without reading the
media inventory. The endpoint uses catalog read authorization and fails for a
stale revision or unavailable body. It transfers inventory data, not the body
or archive. Current app and server versions must both support this endpoint.

Media repair preserves the saved body and validates existing ZIP entries before
requesting missing or corrupt assets. Server copies supply individual assets
through `GET /api/v1/chapters/:id/media`, with the revision, filename, and original
source URL identifying the requested entry. The server checks the entry's size
and CRC before returning it. Repair can use server assets without an installed
source plugin; source-site fallback still requires the plugin fetch path.

Chapter transfers support only the current original-file format. They do not
use an outer ZIP, older manifest decoder, or media-reference conversion. The
full device backup ZIP described below is a separate protocol.

Chapter transfers do not compute or compare SHA-256 file checksums. A same-size
change with an unchanged modification time cannot be detected by a file rescan.
Identity and authentication hashes are independent of file transfer validation.
Full device backups have their own required archive SHA-256 validation.

Use current app and server builds together. Older protocols are unsupported.

The app records local content changes in SQLite alongside the affected data.
Sync uses durable catalog cursors, fingerprints, and pending uploads so failed
requests can be retried after a restart. These records are scoped to the server.
Journal sequence numbers select changes; file names, sizes, and modification
times identify unchanged chapter snapshots without rereading their contents.

The first sync establishes a baseline. Later syncs read recorded local changes
and server chapter deletions, then check affected stored chapters. Deleted
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

The app database uses an immutable v1 baseline plus ordered migrations.
Version/checksum errors preserve the database and stop opening it. The server
keeps an immutable base-schema checksum and upgrades supported additive extension
tables in place; an incompatible base schema is rejected instead of rewritten.
Sync cursors and device keys remain outside portable file backups. Full device
snapshots include the entire database and saved settings, including those values.
Shared content sync does not upload or restore device backups automatically.
Device backup is a separate, explicit operation described below.

Local content installation is serialized per work. Network transfers use private
staging directories and do not hold a work lock. Upload fingerprinting and transfer
use one snapshot. Android copies snapshots on a separate, bounded worker so that
the foreground storage queue can process metadata, downloads, and deletion.
Conflicting changes during copying discard the snapshot and leave the upload pending.
Portable file backup restoration waits for active work operations and holds
exclusive storage access while inspecting original files and restoring database state. It never
deletes or rewrites work metadata, covers, or chapter files, including files for
works omitted from the backup. Inspection failure leaves the database unchanged;
failure during the native restore transaction rolls it back. Only discovered
completed chapter files are marked downloaded and eligible for upload.

## Current limits

Download goals can keep selected works ahead, download all remaining chapters,
or keep an entire work available. Transfers that are interrupted restart the
chapter transfer; partial chapter-file and legacy ZIP resume are not supported.
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


## Legacy full-device archive contract

The normal settings screen now uses [Shared user changes](user-state.md).
The full-device archive endpoints and stored files remain separate recovery
facilities. They save a complete database and settings snapshot under a device
name. Replacing a snapshot or restoring it has the explicit recovery semantics
described below; this protocol is not used for everyday sharing.

The server lists all saved device names, including each backup's update time,
byte size, and SHA-256. Every registered, unblocked device may list and restore
all these backups. A separate private reading sync key is not used. Anonymous
catalog access does not grant backup access, and a console session is not a
device credential for these endpoints.

### Snapshot contents

| Included | Details |
| --- | --- |
| Complete SQLite database | Repository URLs, complete installed plugin JavaScript, categories, library membership, progress, bookmarks, history, and all work and chapter metadata |
| Saved app settings | All localStorage values, including server connection settings, device tokens, VPN preferences, and interface settings |
| Native VPN profile | The imported `profile.ovpn`, when present |
| Storage location | The storage root setting, without copying the folder's files or OS access grants |

The current format-2 ZIP contains `manifest.json`, `norea.db`, optional
`profile.ovpn`, and the retained VPN vault when present. See the current archive
contract in [Development data policy](release-compatibility.md).
Installed plugin source code is part of the database snapshot. Downloaded
chapter bodies, cover files, chapter images, and other media files remain in
their original folders and are excluded from this archive. Restore does not
delete or overwrite those original files.

WebView cookies and VPN usernames/passwords held only in memory are excluded.
Operating-system folder permissions cannot be transferred with the saved folder
setting. After restoring another device's snapshot, the user may need to grant
folder access again or select a folder available on the current device.

### Restore behavior

Restore replaces the local database and saved settings with the chosen
snapshot, including its library membership, read/unread flags, removed
bookmarks, and history. It does not require matching books to exist locally,
and it does not merge progress or preserve the current device's credentials
over the saved values. Original content files stay in place even when they are
absent from the restored database.

The app pins the selected backup's SHA-256 while downloading and verifies the
archive before replacement. The database must have the exact current schema
and ordered migration history, pass SQLite integrity checks, and satisfy
foreign-key checks. An incompatible or invalid snapshot is rejected without
resetting the current database.

Database replacement runs in a SQL transaction, with settings rollback if
installation fails. A successful restore reloads the app to apply the restored
database and settings together. Pending download and metadata publication jobs
from the snapshot are cancelled or removed so startup cannot use them to
rewrite original files.

Settings -> Backup uses portable format 6 with an optional stable category ID.
It excludes device authentication keys and inspects existing content files when
rebuilding download state. Portable restoration atomically pauses user-state
sharing and never converts restored values into new sharing seeds. Full device backup instead restores the entire
database and saved settings. These are separate formats and restoration paths;
see [Development data policy](release-compatibility.md).

Physical download cache flags and byte counts are reset during a full device
restore because original chapter files are not included. Existing local files
remain untouched and are checked again when their chapters are opened or
downloaded; reading progress and metadata stay restored.

If a preserved work is absent from the restored database, opening it from the
server catalog rebuilds its local index from the existing files without
replacing those files with the server response.

### Device backup API

The server advertises `deviceBackupVersion: 1` in `/api/v1/capabilities`.
All requests require the bearer credential of a registered, unblocked device.
URL-encode the device name in the path.

| Endpoint | Contract |
| --- | --- |
| `GET /api/v1/device-backups` | Returns `{items: [{deviceName, updatedAt, size, sha256}]}` for the server's saved device names |
| `PUT /api/v1/device-backups/:name` | Uploads the binary ZIP to the named slot; requires `X-Backup-Sha256` with the archive's SHA-256; maximum 512 MiB |
| `GET /api/v1/device-backups/:name?sha256=<selected-sha256>` | Downloads the selected archive only while the named slot still has the requested SHA-256 |

If another upload changes the named slot after listing, the pinned download
fails instead of silently restoring a different snapshot. Refresh the device
list and select the intended current backup again.
