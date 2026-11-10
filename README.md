# Norea

Norea is a local-first reader for light novels, webtoons, manga, and local files on
Windows and Android. Your library and downloaded content stay usable without a
server; optional sync services add cross-device content and user-state sharing.

Norea is inspired by lnreader/lnreader, but uses its own data model, plugin
contract, storage layout, and backup formats.

## Screenshots

<p align="center">
  <img src="docs/screenshots/library-xl-dark.png" alt="Dark library list with reading progress and unread counts" width="100%">
</p>

<p align="center">
  <img src="docs/screenshots/browse-search-sm.png" alt="Installed source search results" width="34%">
  <img src="docs/screenshots/reader-xs.png" alt="Reader view on a narrow window" width="25%">
  <img src="docs/screenshots/reader-settings-xs.png" alt="Reader settings panel over the reading view" width="25%">
</p>

## Features

- Browse and search installed source plugins.
- Organize works with a library, categories, filters, sorting, and selection tools.
- Read text, Markdown, HTML, EPUB, PDF, webtoon, manga, and locally imported files.
- Download chapters and media for offline reading, including incomplete-media repair.
- Track progress, unread state, history, bookmarks, resume positions, and compositions.
- Check sources for updates and continue recent reading from History.
- Use source-specific VPN routing on Windows and Android when configured.
- Recover downloaded content from filesystem metadata without contacting source sites.
- Share work metadata and chapter files through the optional Norea Content Server.
- Share library edits, categories, reading state, bookmarks, resumes, and
  compositions between admitted devices through explicit user-state sync.
- Export and restore portable local backups without bundling downloaded chapter bodies.

## Supported builds

Tester builds are published from the 0.2 branch in the
[dev-0.2 prerelease](https://github.com/tinywind/norea/releases/tag/dev-0.2).

| Platform | Package |
| --- | --- |
| Windows x64 | NSIS or MSI |
| Windows ARM64 | NSIS or MSI |
| Android ARM64 | norea-arm64.apk |
| Android x86_64 | norea-x86_64.apk |
| Android diagnostics | tracing APK |

Tracing APKs are debuggable and install over the matching release build without
clearing app data when the signing key matches.

Norea does not publish Linux, macOS, or iOS builds. Android background behavior
varies by firmware, and protected source sites may require the in-app site browser
before automated access succeeds. Updates are installed manually from Settings -> About.

## First run

1. Install and open Norea.
2. Open Browse -> Extensions and add a plugin repository.
3. Install one or more sources.
4. Search a source, open a work, and add it to the library.
5. Open or download chapters as needed.

The sample plugin repository is maintained at
[tinywind/norea-plugins](https://github.com/tinywind/norea-plugins). Add this URL:

    https://raw.githubusercontent.com/tinywind/norea-plugins/dist/0.2/.dist/plugins.json

Only install and use sources you are allowed to access.

## Content storage and recovery

Downloaded content is stored as readable work/chapter files. Work metadata and
covers are stored beside content and can rebuild local indexes after app-data loss.
SQLite is a browsing and state index, not the sole copy of downloaded content.

The current filesystem contract is documented in
[docs/filesystem-metadata-v1.md](docs/filesystem-metadata-v1.md).

## Optional content server

The [Norea Content Server](https://github.com/tinywind/norea-content-server)
keeps a secondary copy of work metadata, covers, and chapter files. Norea remains
usable when that server is unavailable.

Content sync and user-state sync are separate:

- **Content sync** shares work metadata, covers, and downloaded chapter files.
- **Shared user changes** merges library membership, categories, reading state,
  bookmarks, resume positions, and chapter compositions.

Devices register with per-server device keys. No account password is required in
the app. Content sync can run manually, periodically, or when changes occur.
User-state sharing is explicitly enabled per server.

See [content synchronization](docs/content-sync.md) and
[user-state synchronization](docs/user-state.md) for the current contracts.

### Quick Docker server

    docker volume create norea-content-data
    docker run -d --name norea-content-server --restart unless-stopped \
      -p 0.0.0.0:8080:8787 \
      -v norea-content-data:/data \
      tinywind0/norea-content-server:0.2

The administration console is at http://localhost:8080/admin/. First startup
creates the console credential inside the data volume:

    docker exec norea-content-server cat /data/admin-password.hash

Expose the server only on a network you trust or place it behind appropriate
access controls. Server deployment and security details live in the server repository.

## Backup

Portable backups include library state, progress, categories, source settings,
installed sources, and download metadata. Downloaded chapter bodies and cached
media remain in the content folder and are re-indexed after restore.

Device credentials, VPN secrets, and server authentication keys are not portable
backup data. Restoring a backup does not automatically publish the restored
snapshot into shared user state.

## Documentation

- [Content sync](docs/content-sync.md)
- [Shared user changes](docs/user-state.md)
- [Filesystem metadata](docs/filesystem-metadata-v1.md)
- [Plugin contract](docs/plugins/contract.md)
- [Shared site browser](docs/shared-site-browser.md)
- [Release and data compatibility](docs/release-compatibility.md)
- [Development guide](docs/development.md)

Historical implementation plans and one-off device verification reports are kept
in Git history rather than the current documentation tree.

## License

MIT. Third-party notices are in [public/THIRD_PARTY_NOTICES.md](public/THIRD_PARTY_NOTICES.md).
