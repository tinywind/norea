---
name: verify-norea-data-access-conventions
description: Verify Norea DB, repository cache, and plugin data access conventions.
---

# Verify Norea Data Access Conventions

Use after changing DB access, plugin fetches, scraper runtime, repository cache, backup/import/export, or download queue persistence.

## Rules

- App DB access must stay on the Rust-owned SQLite path: `AppDatabase` (`src-tauri/src/db/mod.rs`) owns the serialized `writer` pool and read-only `reader` pool, all SQL executes in domain-scoped Rust commands (`src-tauri/src/db/*`, `src-tauri/src/backup.rs`), and frontend callers go through `src/db/ipc.ts` and `src/db/queries/*`.
- Flag any reintroduction of `tauri-plugin-sql`, `@tauri-apps/plugin-sql`, raw SQL strings in production TypeScript/JavaScript (outside `src/db/schema.ts`), or generic SQL/transaction pass-through Tauri commands.
- Local and Android file I/O must use `@tauri-apps/plugin-dialog`, the `norea-media` protocol, and typed Rust commands (`AndroidNativeIo.kt` JNI helpers on Android); flag `<input type="file">` pickers or direct Android `@JavascriptInterface` file I/O bridges.
- Do not introduce a second ORM, browser storage replacement, or direct DB path without an explicit tech-stack change.
- Plugin-owned site fetch changes should also run `verify-plugin-fetch-contract`; this skill only flags obvious data-access helpers that bypass the sanctioned scraper bridge.
- Repository/plugin index/list queries must define deterministic ordering at the query/helper boundary.
- Conflict helpers should be named by behavior: `upsert*` for update-on-conflict and `insertIfAbsent*` for do-nothing-on-conflict unless a stronger local name exists.
- Do not add thin wrappers that only forward to lower-level query/fetch/update calls without domain meaning.
