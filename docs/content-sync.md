# Content server integration

The optional [Norea Content Server](https://github.com/tinywind/norea-content-server)
stores complete chapter packages for your devices. Configure it under Settings >
Data > Content server. Reading positions, read flags, bookmarks, and library
membership stay local. Reading continues when the server is unavailable.

## Using the server

1. Start the server using its README.
2. Save the server URL and a device name in Norea.
3. Run Sync now. The device registers automatically and uploads complete local
   chapters. No account or password is required.
4. Select Download to this device for a server chapter. Downloads open the local
   novel page after verified installation.
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

The previous automatic-sync switch migrates to When changes occur when enabled,
or Manual only when disabled.

Registered devices can delete and restore server chapters. Server deletion
preserves local files. Removing a local download does not delete the server copy
or automatically download it again. A server tombstone prevents a stale local
upload from restoring deleted content.

## Device access

Each server URL has its own random 32-byte device key, persisted in this app's
local storage before registration. The key survives app restarts and stays outside
portable backups. Restoring a backup does not replace or remove device keys.
The app does not derive keys from hardware identifiers.

The server accepts new devices automatically. Its administrator can block or
unblock a device in the server console. The app keeps the same key after rejection
and shows a blocked-device message; it never creates another key to bypass a
block. Ask the administrator to unblock the device before retrying.

The app checks `/api/v1/capabilities` before registration or content transfer. It
requires API version 2, package version 1, `authentication: "device-key"`, and
`personalStateSync: false`. Registration uses `/api/v1/devices/register`;
subsequent requests carry the key in the authorization header. Change waiting
uses only `catalogAfter` and `waitSeconds` and receives a `catalogCursor`.

## Storage and compatibility

Plugin ID, novel path, and chapter path identify content across devices. Existing
numeric database IDs remain device-local. Downloaded chapters use the existing
readable directory rules; synchronization does not rename existing folders.

Only complete bodies and media are packaged. Native code transfers ZIP files and
verifies their inventory, sizes and SHA-256 before installation. Interrupted
replacement preserves a target-named backup that storage access can recover.

The app records local content changes in SQLite alongside the affected data.
Sync uses durable catalog cursors, fingerprints, and pending uploads so failed
requests can be retried after a restart. These records are scoped to the server;
timestamps are not used to decide which changes to skip.

The first sync establishes a baseline. Later syncs read recorded changes and
check only affected complete chapters. The server's change-wait endpoint returns
cursor hints; the app then fetches the corresponding deltas. Existing
fingerprints remain valid when upgrading to device access.

Sync metadata uses additive SQLite tables and is excluded from portable backups.
Existing release migrations, reader data, and downloaded folder names are
unchanged. Legacy account caches, personal-state journal rows, and position-cache
rows remain stored but are no longer read or written by synchronization. Their
old triggers are retired without deleting the data. No account, session, or
personal-state endpoint is called.

Backup restoration and content synchronization share a storage-operation queue.
Sync waits until restored files and reading settings are ready. If file
restoration fails after the database was replaced, restored downloads are marked
as needing repair and are excluded from upload.

## Current limits

Cover transfer and automatic per-work download policies are not implemented.
Downloads restart after interruption; the server supports Range but the app does
not yet resume partial ZIPs. Local imports and completed downloads enter the
local change record and follow the selected sync mode.

Edits made directly to downloaded files outside Norea are not database changes.
Use Rescan local files and sync after those edits. This explicit scan hashes all
complete local chapters and can take time for large libraries. Android uses a
cache snapshot to read SAF files, so staging also needs free device storage.
HTML reference conversion reads the chapter body into memory; ZIP and media
transfer use streaming. Source-plugin traffic continues through the existing
scraper path, independently of content-server traffic.

## Local Android testing

Run the server on the development machine and map its port with
`adb -s <serial> reverse tcp:8080 tcp:8080`. Configure `http://127.0.0.1:8080`
in the app. Use a separate debug app and an owned test storage folder. Do not clear
or uninstall the user's existing app to work around installation or migration
errors. See [development.md](development.md) for the targeted Android build.
