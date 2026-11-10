# Development Guide

This guide is for contributors who want to run, test, or change Norea locally.
The public README stays user-focused; this document keeps the practical developer
workflow in one place.

## Source of Truth

- `package.json` defines package scripts, dependencies, and the pinned package
  manager version.
- GitHub workflows define supported build tooling and release artifact jobs.
- `CLAUDE.md` defines repository rules for agents and contributors.
- `docs/release-compatibility.md` defines app data and backup compatibility
  policy.
- `docs/plugins/contract.md` defines the source plugin compatibility contract.
- This guide contains the fixture-plugin smoke path and content-folder recovery
  checks used for manual integration testing.

## Build and Test Environment

Use the same major versions as CI when possible.

| Tool | Version / target | Used for |
| --- | --- | --- |
| Node.js | 24 LTS | Frontend build, tests, and Tauri CLI |
| pnpm | 10.27.0 | Package manager, pinned by `packageManager` |
| Rust | stable | Tauri host and native plugins |
| Java | JDK 17, preferably Temurin through SDKMAN locally | Android Gradle builds |
| Android Gradle Plugin | 8.13.2 | Android project build plugin |
| Kotlin Gradle Plugin | 2.0.21 | Kotlin build plugin compatible with current Tauri Android scripts |
| Android SDK platform | `android-36` | Android APK builds |
| Android build tools | `36.0.0` | APK signing and build tools |
| Android NDK | `29.0.14206865` | Rust Android targets |
| Android Rust targets | `aarch64-linux-android`, `x86_64-linux-android` | Device APK and emulator/WSA APK |
| Windows Rust targets | `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` | Windows x64 and ARM64 release bundles |

## Local Development

Install dependencies on any development host:

```bash
pnpm install
```

Start the native desktop app on Windows:

```bash
pnpm tauri dev
```

`pnpm install` configures the local Git hooks path to `.githooks`. If hooks are
missing in an existing checkout, run this once:

```bash
pnpm hooks:install
```

## Automated Checks

Use the smallest relevant check for the change.

```bash
pnpm tsc
pnpm test
```

Run `pnpm tauri build --debug` on Windows when the change touches native
desktop integration.

Keep `src/db/schema.ts` aligned with the result of the registered SQLite
migrations in `src-tauri/src/database.rs`. The existing `schema.sql` is the
immutable version 1 baseline. For each schema change, append SQL with a higher
version, register it in `schema_migrations()`, and preserve existing rows and
relationships. Do not edit applied migration SQL or reset a database on mismatch.
Test fresh initialization, upgrades from supported installed versions, reopening,
and rollback after a failed upgrade. Version/checksum errors preserve the database
and require diagnosis before retrying.

The work home requests `committed` reads for its detail and chapter-list queries
through a read-only SQLite pool mapped to the same `norea.db` file. WAL allows
these queries to read committed data while a metadata transaction publishes its
files. All writes and transactional reads
remain on the serialized single-connection writer. Do not use the reader for
mutation preconditions that must wait for earlier queued writes.

Rust-side checks:

The Windows dependency workflow also runs for Rust source changes. Its x64 job
executes the native unit tests; its ARM64 job verifies cross-compilation.

```bash
cd src-tauri
cargo check
cargo test --lib
```

Android APK build:

```bash
pnpm exec tauri android build --apk --target aarch64
```

Build only the target needed for the current device or emulator. Use
`--target x86_64` for x86_64 emulators or WSA. Use aggregate package scripts
only when intentionally producing every release APK they cover.

Set `NOREA_TRACING_BUILD=true` for a tracing APK: the same signed release made
debuggable, so `adb shell run-as` and WebView DevTools inspection work on a
device. It installs over a release build with `adb install -r` and keeps app
data.

Local Android builds need Java, Android SDK packages, and Rust Android targets
available in the same shell. SDKMAN is the preferred local JDK path. Install
the Android command line tools under `$ANDROID_HOME/cmdline-tools/latest` before
running `sdkmanager`. If the exact Temurin patch below is no longer listed,
choose the current Temurin 17 entry from `sdk list java`.

```bash
source "$HOME/.sdkman/bin/sdkman-init.sh"
sdk install java 17.0.19-tem
sdk use java 17.0.19-tem

export JAVA_HOME="$HOME/.sdkman/candidates/java/current"
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
export ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | sdkmanager --licenses
sdkmanager --install \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;36.0.0" \
  "ndk;29.0.14206865"
rustup target add aarch64-linux-android x86_64-linux-android
```

If multiple side-by-side NDK versions are installed, keep `NDK_HOME` and
`ANDROID_NDK_HOME` explicit so local builds use the intended version instead of
whatever Tauri discovers first.

## Release Artifact Workflows

The public README keeps download guidance user-focused. These are the workflow
artifact names and release-upload behavior used by maintainers.

| Workflow | Artifact names |
| --- | --- |
| Windows Release Bundles | `norea-windows-x64-nsis`, `norea-windows-x64-msi`, `norea-windows-arm64-nsis`, `norea-windows-arm64-msi`, plus matching checksum artifacts |
| Android Release APKs | `norea-arm64.apk`, `norea-x86_64.apk`, the tracing `norea-arm64-tracing.apk` and `norea-x86_64-tracing.apk`, and `norea-android-checksums` |

Pushes to `0.2` create workflow artifacts retained for 30 days and refresh the
`dev-0.2` prerelease. Version tags matching `v*` upload collected bundles to the
matching GitHub Release.

The Android release and Java/Kotlin analysis jobs run
`node scripts/prepare-gradle-cache.mjs` before invoking the Gradle wrapper.
Windows release jobs run `node scripts/prepare-windows-tools.mjs` before bundling.
These scripts download from the upstream GitHub release asset API and verify
pinned SHA-256 checksums before populating the tools' normal caches. This avoids
browser-download redirect failures while retaining the same Gradle, WiX, and NSIS
versions and all release formats. `GH_TOKEN` is scoped to each preparation step;
local runs can use an authenticated GitHub CLI. When updating either build tool,
update its verified checksum together with the pinned version.

Advanced CodeQL jobs prepare a verified language-specific CLI archive with
`node scripts/prepare-codeql.mjs` before initialization. The script pins CLI
2.27.4 and official asset hashes, and passes the local archive through the
action's `tools` input. Update those pins when intentionally updating the CLI.
Android plugin dependencies prefer Maven Central in `buildSrc` plugin
management, and the rustls Maven archive uses its canonical upstream raw host.

## Manual Smoke Test

Use this path when checking that the app still works end to end:

1. Start the Windows desktop app with `pnpm tauri dev`.
2. Open Browse -> Extensions.
3. Set the repository URL to the sample catalog from the README.
4. Refresh the repository from its row menu and install one source plugin.
5. Browse or search that source and open a novel detail page.
6. Add the novel to the library.
7. Open a chapter in the reader and confirm paged or scrolling mode works.
8. Download at least one chapter and reopen it from the library.
9. Change reader theme or font settings and confirm they persist after reopening
   the reader.
10. Export a local backup and import it into a clean test profile when the change
    touches library, progress, category, repository, or downloaded chapter data.
11. On an installed Windows or Android build, open TXT, MD, PDF, and EPUB
    files from the system file browser while Norea is stopped and while it is
    already running; confirm all files share the `local` work and each file opens
    its imported chapter, including when another chapter is already open.

For protected sources, open the in-app site browser first so the app can use the
same browser session for later source actions.

## Local Source Plugin Testing

The public sample source catalog is maintained in
[tinywind/norea-plugins](https://github.com/tinywind/norea-plugins). The app
stores a single active repository URL, and the published sample manifest is:

```text
https://raw.githubusercontent.com/tinywind/norea-plugins/dist/0.2/.dist/plugins.json
```

For local plugin development, keep a sibling checkout at `../norea-plugins` and
serve its generated manifest:

```bash
cd ../norea-plugins
npm install
cp .env.template .env
node scripts/generate-plugin-index.js
npm run build:compile
npm run build:manifest:dev
npm run dev
```

Then set the app's repository URL to:

```text
http://localhost:3000/.dist/plugins.min.json
```

When testing from Android or another device, replace `localhost` in `.env` and in
the app with a host address the device can reach, such as the development
machine's LAN IP or `10.0.2.2` for the Android emulator.

## Project Map

| Area | Path |
| --- | --- |
| React app | `src/` |
| Tauri/Rust host | `src-tauri/` |
| Android project shell | `src-tauri/gen/android/` |
| Database queries and schema | `src/db/`, `src-tauri/src/schema.sql`, `drizzle.config.ts` |
| Plugin runtime | `src/lib/plugins/`, `src/lib/http/`, `src-tauri/src/scraper/` |
| Chapter media and storage | `src/lib/chapter-media/`, `src/lib/chapter-content/`, `src-tauri/src/chapter_media/` |
| Task scheduling | `src/lib/tasks/` |
| Runtime viewport and startup gates | `src/lib/runtime/`, `src/components/runtime/` |
| Local import and local novel data | `src/lib/local-import.ts`, `src/db/queries/novel.ts` |
| i18n strings | `strings/languages/` |

The Android project stays under `src-tauri/gen/android/` because Tauri owns
that build location. Its tracked `app/src/main/java/io/github/tinywind/norea/`
sources and `app/src/main/res/raw/` scripts are maintained app code; Gradle's
generated bindings and build outputs remain untracked. `MainActivity` connects
the lifecycle and WebView to the storage, media, update and scraper modules.

The TypeScript scheduler owns app tasks and source access. The Android scraper
queue separately owns WebView navigation/extraction exclusivity and concurrent
fetch requests. Keep cancellation and source identity intact across both.

`src/lib/http.ts` and `src/lib/chapter-media.ts` preserve the public import
surface. Their modules separate app HTTP from source-session HTTP, and media
HTML/manifest/recovery logic from platform storage. Generic request data uses
`HttpInit`; source routing and executor context use `PluginFetchContext` through
`PluginHttpInit`.

## Contribution Rules

- Keep changes narrow and tied to the issue or request.
- Do not commit generated APKs, keystores, signing properties, local logs, or
  temporary build artifacts.
- Write user-facing app text through the existing i18n files.
- Keep documentation and source comments in English.
- Do not add mock data, partial features, or speculative options.
- Update tests or smoke-test notes when behavior changes.

## Fixture Plugin Smoke

Use a sibling `../norea-plugins` checkout and its development fixture rather than
adding fixtures to this repository.

1. Build the fixture plugin and serve its development manifest/content host.
2. Install the fixture through the local repository flow. Android emulators use
   `10.0.2.2`; physical devices use the development machine's LAN address.
3. Download the fixture HTML, text, and PDF chapters and wait for the task queue
   to finish without failures.
4. Verify the SQLite rows have non-zero stored bytes and the expected content
   types. HTML media references must be rewritten to local Norea media URLs.
5. Stop the fixture server and reopen the downloaded chapters. HTML media, text,
   and PDF content must remain readable offline.
6. Delete one chapter, then clear downloaded fixture content. The database and
   local media cache must reflect the deletion.

## Content Folder Recovery

Use a disposable app profile and a separate content-server state directory.
Never test recovery by mutating the user's only content copy.

The active layout is:

```text
<root>/contents/<pluginId>/<novelId>/novel.json
<root>/contents/<pluginId>/<novelId>/cover.<ext>
<root>/contents/<pluginId>/<novelId>/<chapterNumber>/content.html|content.pdf
<root>/contents/<pluginId>/<novelId>/<chapterNumber>/manifest.json
<root>/contents/<pluginId>/<novelId>/<chapterNumber>/media.zip
```

For a recovery check:

1. Inventory work identities, chapter numbers/titles, metadata files, and media
   archives before recovery.
2. Start the content server with fresh SQLite state and scan the real current
   format. A fully converted tree should produce no unexpected skips or failures.
3. In Waydroid or another disposable Android profile, select the same storage
   root with an empty app database and wait for background recovery.
4. Compare recovered work/plugin/source identities, chapter numbers, titles,
   storage directories, downloaded flags, and media-repair flags against the
   inventory. Inspect SQLite directly; card counts are not sufficient evidence.
5. Cold-start and repeat the comparison. Open representative text and media
   chapters with the source and server unavailable.
6. Recheck source metadata hashes to prove recovery did not rewrite unrelated
   files.

Runtime recovery accepts the current storage format only. Offline conversion of
older title-based folders must be an explicit, separately backed-up operation.
