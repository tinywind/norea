---
name: verify-canonical-types
description: Verify Norea TypeScript code reuses canonical schema, plugin, backup, and IPC types instead of duplicating contracts.
---

# Verify Canonical Types

Use after editing TypeScript that touches DB rows, plugin metadata/results, download/backup payloads, or Tauri IPC-facing data.

## Rules

- `src/db/schema.ts` exports are canonical for direct persisted DB row and insert shapes. Prefer `$inferSelect` and `$inferInsert` for direct table rows and insert payloads.
- Joined, aggregated, aliased, and UI-specific query view rows are allowed across Rust `sqlx` row structs / IPC DTOs and TypeScript query modules, provided their persisted columns still map back to `src/db/schema.ts`.
- Backup format types in `src/lib/backup/format.ts` are canonical for backup artifacts; do not restate those manifest records elsewhere.
- Do not create local interfaces that restate direct persisted entities such as Novel, Chapter, Repository, InstalledPlugin, or repository cache rows unless they are UI-only view models or raw SQL alias rows.
- Plugin-facing types should come from the existing plugin contract/runtime modules.
- IPC payload/result types should be centralized near the command wrapper boundary and imported by UI code.
- Local form/search/filter state is allowed when it is UI-only or transforms intentionally into canonical persistence, plugin, or IPC types.
- Raw status strings are allowed only for UI sentinels; persisted or contract-backed statuses should use existing constants, unions, or enums.
