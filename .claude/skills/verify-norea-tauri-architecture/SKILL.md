---
name: verify-norea-tauri-architecture
description: Verify Norea architecture boundaries across React UI, Tauri Rust runtime, SQLite/Drizzle persistence, plugin fetches, and Android scope.
---

# Verify Norea Tauri Architecture

Use after changing `src/**`, `src-tauri/src/**`, plugin scraping, persistence, backup, download queue, reader runtime, or Android foreground-service work.

## Rules

- Keep UI in `src/**` and native/IPC/runtime/SQLite/file-I/O work in `src-tauri/src/**`.
- Plugin-owned site fetches must use the scraper WebView cookie/context path.
- App/repository fetches and plugin-owned site fetches must remain separate.
- Persistence must stay on Rust-owned SQLite (`AppDatabase` `writer`/`reader` `sqlx` pools in `src-tauri/src/db/mod.rs`) exposed through typed, domain-scoped Tauri commands (`src-tauri/src/db/*`, `src-tauri/src/backup.rs`) and `src/db/ipc.ts` / `src/db/queries/*`, with canonical schema definitions in `src/db/schema.ts` and immutable migrations in `src-tauri/src/database.rs`. Flag `tauri-plugin-sql`, `@tauri-apps/plugin-sql`, SQL strings in production JS/TS (outside `src/db/schema.ts`), or generic SQL pass-through IPC commands.
- Local and Android file selection, reads, writes, media serving (`norea-media`), and APK installation must route through Rust commands (`AndroidNativeIo.kt` JNI on Android) and `@tauri-apps/plugin-dialog`; flag `<input type="file">` or direct Android `@JavascriptInterface` file I/O bridges.
- Avoid hidden per-item DB/network loops in update, search, download, backup, and plugin flows; use batching, maps, bounded concurrency, or cancellation where appropriate.
- Android foreground-service rules apply only to custom Android service work or device-validation changes; desktop queue behavior remains in-app.
