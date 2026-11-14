---
name: verify-tauri-layer-boundary
description: Verify Norea UI, state, IPC, Rust runtime, SQLite/Drizzle, plugin fetch, reader, and validation responsibilities stay in their layers.
---

# Verify Tauri Layer Boundary

Use after changes crossing UI, state, IPC, Rust runtime, DB, plugin fetch, reader, or validation boundaries.

## Rules

- React routes/components own UI, routing, event binding, and display state.
- Zustand and TanStack Query own client state and async orchestration, not Rust/SQL internals.
- Tauri IPC commands must be domain-scoped and typed: argument validation, permission/context checks, Rust persistence/storage execution, and `DbMutationEnvelope<T>` / DTO response shaping. Never expose generic SQL or transaction pass-through commands.
- Rust runtime modules own all SQLite queries/transactions (`src-tauri/src/db/*`), atomic file-plus-DB rollback (`src-tauri/src/db/tx.rs`), local and Android SAF file I/O (`AndroidNativeIo.kt` JNI), `norea-media` protocol serving, backup zip pack/unpack, scraper fetch, and native operations. TypeScript may own task orchestration and EPUB parsing when plugin/runtime contracts, failure propagation, and Rust-owned DB/file boundaries remain explicit.
- SQLite schema declarations live in `src/db/schema.ts`, while all runtime SQL execution lives in Rust persistence modules (`src-tauri/src/db/*`, `src-tauri/src/backup.rs`, `src-tauri/src/download_*.rs`) behind `src/db/ipc.ts` and `src/db/queries/*`. Production TypeScript must not contain SQL strings outside `src/db/schema.ts` or direct Android JS file I/O bridges.
- Plugin-owned site fetch responsibility should stay behind the sanctioned scraper bridge; run `verify-plugin-fetch-contract` for detailed fetch-path review.
- Reader persistence, progress policy, chapter opening, and adjacent navigation should live in reader runtime/settings code. Route/component ownership of UI event binding, chrome visibility, and rendering mechanics is allowed when it stays local and cohesive.
- Validate once at the right boundary; avoid duplicated UI/IPC/schema validation.
