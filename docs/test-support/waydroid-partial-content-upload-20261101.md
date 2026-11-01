# Waydroid toast and incomplete content upload verification

Date: 2026-11-01

## Environment

- Local Waydroid, Android 13, x86_64.
- Isolated application: `io.github.tinywind.norea.qa20261101`.
- Isolated storage: `Documents/NoreaQA20261101`.
- Local content server with separate data under `.tmp/toast-partial-upload/`
  and port 18103. Production data and server configuration were untouched.
- APK built with `pnpm exec tauri android build --apk --target x86_64 --debug`.
  The temporary application ID override was reverted after building.

## Results

- TypeScript checking passed. All 2,024 frontend tests passed across 169 files.
- All 23 content-sync native tests passed inside Waydroid using the
  cross-compiled Android test executable. Regression cases failed before their
  corresponding fixes and passed afterward.
- The installed app's rescan and sync action uploaded three chapters with the
  default `prefer-complete` policy: a partial HTML body with a partial ZIP,
  a published body with missing media and no ZIP, and a complete chapter.
- The server stored completeness as `false`, `false`, and `true`, respectively.
  Every uploaded body, manifest and ZIP matched its original fixture bytes.
  The local incomplete chapters retained `is_downloaded=0` and
  `media_repair_needed=1`.
- A direct Android snapshot request rejected a partial body without its media
  inventory. The original partial body remained intact. This prevents a missing
  manifest from making an uninspected body appear complete on the server.
- Changed incomplete local copies did not replace incomplete or complete server
  copies under `prefer-complete`. Server entries and revisions stayed unchanged.
- The settings Saved toast remained visible through the five-second timer and
  disappeared after the closing transition, observed between 5.2 and 5.3 seconds.
  Queue restoration and source-access notifications also have regression checks
  for the five-second timeout.
- A saved upload cursor now triggers one discovery pass for previously excluded
  incomplete chapters. Later syncs resume incremental discovery; existing
  deletion exclusions remain intact. A regression test covers both passes.

The server already accepts safe incomplete inventories and calculates their
completeness. No server source, database schema, package format, or plugin
contract change was required. Invalid manifests and unsafe or malformed archives
remain errors. Complete-only download validation remains in place.
