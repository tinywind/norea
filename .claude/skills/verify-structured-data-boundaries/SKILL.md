---
name: verify-structured-data-boundaries
description: Verify stable Norea app data uses named types while plugin/raw external data stays at explicit opaque boundaries.
---

# Verify Structured Data Boundaries

Use after editing app data models, plugin runtime payloads, IPC DTOs, backup manifests, repository metadata, or parser boundaries.

## Rules

- Stable app data must use named TypeScript, Rust, or domain types instead of `any`, broad `Record<string, unknown>`, `serde_json::Value`, or ad hoc maps.
- Persisted SQLite rows should trace to `src/db/schema.ts`; IPC inputs/outputs (`DbMutationEnvelope<T>`, domain filter/cursor/mutation DTOs), backup manifests, repository metadata, reader settings, and library/category/chapter data must use named, validated contracts rather than generic SQL or untyped JSON pass-through payloads.
- Plugin-owned dynamic data may remain opaque only at explicit boundaries: plugin settings, plugin contract payloads, raw HTML, repository source JSON before validation, and external site response passthrough.
- Do not widen opaque boundaries into app-owned state. Normalize or validate before storing in SQLite, passing through IPC, or rendering.
- Plugin-owned fetch boundary changes should also run `verify-plugin-fetch-contract`.
