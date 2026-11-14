# CLAUDE.md - agent guide for this repo

Read this before touching code or docs. Keep changes narrow, current, and tied
to the user's request.

## Language Policy

- Every committed file in this repo is written in English.
- The only place Korean or other non-English UI text may appear is under
  `strings/languages/<locale>/`.
- User-facing chat summaries may be Korean.
- Translate upstream reference comments or strings to English when importing
  them into this repo.

## Project Shape

Norea is a Tauri 2 light-novel reader for Windows and Android.
It uses a Rust host plus a React/TypeScript UI. The project is inspired by
upstream `lnreader/lnreader`, but it is not a compatibility port. Upstream is
reference material for behavior and edge cases only.

Pinned upstream reference:

```text
https://github.com/lnreader/lnreader/tree/639a2538
```

## Living Documentation

- `README.md` - public overview, current status, and common commands.
- `CLAUDE.md` - repo rules for agents and contributors.
- `docs/development.md` - local setup, development, test, and build commands.
  Read this before development, test, or build work.
- `.claude/local/CLAUDE.md` - optional machine-local private instructions.
  Read it when present, and keep `.claude/local/` untracked.
- `docs/release-compatibility.md` - app data and backup compatibility policy.
- `docs/plugins/contract.md` - plugin runtime compatibility reference.

Do not recreate removed planning snapshots unless the user explicitly asks for
an archive or roadmap document.

## Current Scope

Targets:

- Windows desktop.
- Android sideload APK.

Out of scope unless the user changes direction:

- Linux, macOS, and iOS builds.
- Upstream backup zip round-trip compatibility.
- Upstream MMKV/settings shape compatibility.
- Strict pixel parity with upstream React Native UI.
- TTS, volume-button page turn, Google Drive backup, and tracker integrations.
- In-app auto-update.

Release notes:

- Android APKs are built by GitHub Actions and kept as short-lived workflow
  artifacts for tester download.
- Do not track keystores, signing properties, passwords, or generated APKs.
- Repository secrets, not files in the worktree, provide release signing inputs.

Compatibility notes:

- Database schema changes must increment the schema version and include ordered
  migrations that preserve existing app data, including development builds.
- Keep registered migration SQL immutable. Append upgrades and test existing
  databases as well as fresh initialization. Never reset a database automatically
  because its version or checksum differs.
- Current development supports only the current settings, metadata, backup,
  content-server API, and chapter package formats. Earlier versions of those
  external formats do not require fallback readers, endpoint aliases, or translation.
- Further compatibility requirements must be decided explicitly before they
  introduce implementation work.
- Data, backup, migration, import/export, or local-file changes must follow
  `docs/release-compatibility.md`.

## Repo Layout

```text
norea/
  README.md
  CLAUDE.md
  docs/
    development.md
    release-compatibility.md
    plugins/contract.md
  src/
  src-tauri/
  assets/
  strings/
```

`assets/` and `strings/` started from upstream-compatible MIT material. They
are acceptable to keep, but they are not binding.

## Tech Stack

| Layer | Choice |
| --- | --- |
| Native shell | Tauri 2 |
| Frontend | React 19 |
| UI | Mantine |
| Routing | TanStack Router |
| State | Zustand and TanStack Query |
| Database | Rust-owned SQLite (`sqlx`) with Drizzle schema definitions in `src/db/schema.ts` |
| HTTP | `tauri-plugin-http`, Rust-side fetch commands, and scraper WebView |
| Package manager | pnpm |
| Node | 24 LTS |

## Host I/O and Database Invariant

All SQLite access and local or Android file I/O are owned by the Rust host behind
typed, domain-scoped Tauri commands.

- Rust owns `AppDatabase` (`src-tauri/src/db/mod.rs`) with a serialized
  single-connection `writer` pool and a read-only `reader` pool, and runs
  `sqlx::migrate::Migrator` over `database::schema_migrations()` at startup.
- Frontend code accesses persistence exclusively through `src/db/ipc.ts` and
  `src/db/queries/*` wrappers over domain-scoped Rust commands in
  `src-tauri/src/db/*` and `src-tauri/src/backup.rs`.
- Mixed file and SQLite mutations must coordinate atomic rollback and journal
  recovery in Rust (`src-tauri/src/db/tx.rs`) and return `DbMutationEnvelope<T>`
  side-effect metadata for frontend cache updates.
- Do not reintroduce `tauri-plugin-sql`, `@tauri-apps/plugin-sql`, SQL strings in
  production TypeScript/JavaScript (outside `src/db/schema.ts` Drizzle table
  declarations), or generic SQL/transaction pass-through Tauri commands.
- Local and Android file selection, reading, writing, media serving, and APK
  installation must go through `@tauri-apps/plugin-dialog`, the `norea-media`
  custom protocol, and Rust commands backed on Android by JNI helpers in
  `AndroidNativeIo.kt`. Do not add `<input type="file">` pickers or direct
  Android `@JavascriptInterface` file I/O bridges (`__NoreaAndroidScraper` and
  non-file runtime/service/window/permission bridges remain scoped to platform
  control only).

## Plugin Fetch Invariant

Plugin-owned site traffic must preserve browser-like session behavior.

- App and repository fetches may use ordinary app-side HTTP helpers.
- Plugin-owned source browsing, search, novel parsing, library update checks,
  and chapter downloads must go through the plugin fetch path in `src/lib/http.ts`
  and `src-tauri/src/scraper.rs`.
- The scraper WebView owns browser session state. When a protected site needs
  manual challenge clearing, use the site browser overlay instead of replacing
  plugin traffic with raw app-origin fetches.
- Do not switch plugin-owned site fetches to bare `fetch`, `reqwest`, copied
  cookies, or unrelated HTTP helpers without updating the plugin contract and
  tests.

## Coding Standards

- Keep changes surgical. Do not refactor adjacent code unless required.
- Match the existing style before introducing a new pattern.
- Use self-documenting code. Add comments only for public API docs, intent that
  is hard to infer, justified lint disables, or actionable TODOs.
- Do not add mock data, partial features, speculative options, or unused
  abstractions.
- Keep visible UI strings in the existing i18n files.
- Do not write generated artifacts, screenshots, logs, or temporary outputs into
  the repo. Use the project-root `.tmp/` directory and clean it up when done.

## Verification

Do not run build, compile, test, or git-mutating commands unless the user
explicitly requests them in the current message.

When verification is allowed, choose the smallest relevant loop:

When the user asks for one platform, device, or target ABI, do not use
aggregate `package.json` build scripts. Run the Tauri CLI for the requested
target only, such as `pnpm exec tauri android build --apk --target aarch64`.
Use aggregate package scripts only when the user explicitly asks for every
release target that script produces.

| Change | Check |
| --- | --- |
| TypeScript or React | `pnpm tsc`, `pnpm test` |
| Rust host | `cargo check`, `cargo test --lib` from `src-tauri` |
| Windows desktop native integration | `pnpm tauri build --debug` |
| Android APK/release workflow | Targeted `pnpm exec tauri android build --apk --target <target>` plus device smoke when behavior is Android-only |
| Data, backup, migration, or local-file behavior | Relevant unit tests plus compatibility review against `docs/release-compatibility.md` |
| Docs only | Link/reference scan and `git diff --check` when requested |

## Git Workflow

- Work on `0.2` unless the user asks for another branch.
- Do not bypass hooks.
- Commit subject format: `<type>(<module>): <imperative summary>`.
- Types: `feat | fix | chore | docs | style | refactor | test`.
- Keep one coherent purpose per commit.
- Do not add `Co-Authored-By`, `Generated`, or AI-tool trailers.
- Do not push unless the user explicitly asks in the current message.
- If a push is rejected as non-fast-forward, stop and ask.

## Ask vs. Do

Ask before:

- Adding a third-party Tauri plugin or changing the stack.
- Renaming top-level paths or route structure.
- Using paid certificates, OAuth secrets, or other credentials.
- Running destructive filesystem or git operations.

Do without extra ceremony:

- Keep docs aligned with the current repo.
- Fix broken references caused by your own edits.
- Remove imports, variables, and files orphaned by your change.

## References

- Upstream repo: <https://github.com/lnreader/lnreader/tree/639a2538>
- Trigger issue for the rewrite: <https://github.com/lnreader/lnreader/issues/1835>
- Plugin catalog: <https://github.com/lnreader/lnreader-plugins>
- Tauri 2 docs: <https://v2.tauri.app/>
- This repo: <https://github.com/tinywind/norea>
