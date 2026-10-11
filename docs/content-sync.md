# Content server integration

The optional [Norea Content Server](https://github.com/tinywind/norea-content-server)
stores complete chapter packages and account-specific reading state. Configure it
under Settings > Data > Content server. Local reading continues when the server
is unavailable or no server is configured.

## Using the server

1. Start the server and provision an account using its README.
2. Save the server URL in Norea. Anonymous catalog access and downloads depend on
   the server's access policy.
3. Sign in to upload complete local chapters and synchronize personal state.
   Choose whether to merge this device's state or use the server's state. Use
   server state when switching to another person's account.
4. Run Sync now. Select Download to this device for a server chapter. Downloads
   open the local novel page after verified installation.
5. Enable automatic sync to synchronize on startup, foreground/network recovery,
   completed chapter downloads, and reader exit. Reader exit synchronizes state
   without scanning chapter files. Incoming state is deferred while reading.

Conflicting personal states remain visible in the settings panel until explicitly
resolved. Server deletion is a separate administrator action and preserves local
files. Removing a local download does not delete the server copy or automatically
download it again. A server tombstone prevents a stale local upload from restoring
deleted content.

## Storage and compatibility

Plugin ID, novel path, and chapter path identify content across devices. Existing
numeric database IDs remain device-local. Downloaded chapters use the existing
readable directory rules; synchronization does not rename existing folders.

Only complete bodies and media are packaged. Native code transfers ZIP files and
verifies their inventory, sizes and SHA-256 before installation. Interrupted
replacement preserves a target-named backup that storage access can recover.

Catalog cursors and account outboxes live in the additive `content_sync_cache`
SQLite table. They are device/server-specific and are excluded from portable
backups. Existing release migrations are unchanged. Server settings are stored
separately, and session tokens remain in memory; restarting the app requires
signing in again.

## Current limits

This is the first implementation, not the complete server design. It synchronizes
library membership, chapter read status, bookmarks, and chapter-level percentage
positions. Exact paragraph/PDF locators, cover transfer, persisted secure device
sessions, automatic per-work download policies, and an in-app account-management
screen are not implemented. Downloads restart after interruption; the server
supports Range but the app does not yet resume partial ZIPs.

Remote personal state needs matching local or shared-package metadata before it
can be applied. Local file imports are uploaded on the next manual, startup, or
foreground content sync; importing does not yet trigger an immediate sync.

Manual content sync hashes local artifacts, which can take time for large
libraries. Android uses a cache snapshot to read SAF files, so staging also needs
free device storage. HTML reference conversion reads the chapter body into memory;
ZIP and media transfer use streaming. Source-plugin traffic continues through the
existing scraper path, independently of content-server traffic.

## Local Android testing

Run the server on the development machine and map its port with
`adb -s <serial> reverse tcp:8080 tcp:8080`. Configure `http://127.0.0.1:8080`
in the app. Use a separate debug app and an owned test storage folder. Do not clear
or uninstall the user's existing app to work around installation or migration
errors. See [development.md](development.md) for the targeted Android build.
