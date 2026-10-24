---
name: verify-drizzle-schema-contract
description: Verify app-owned SQLite tables, columns, release schema files, raw SQL, and persistence contracts match `src/db/schema.ts`.
---

# Verify Drizzle Schema Contract

Use after changing `src/db/schema.ts`, runtime schema bootstrap SQL, release schema version files, `src/db/client.ts`, `src/db/queries/*`, app-owned cache tables, backup snapshot/apply code, or TypeScript/Rust code that reads or writes app-owned SQLite data.

This skill is not a general DB-style review. It must prove whether persisted
app-owned SQLite structure matches the canonical schema in `src/db/schema.ts`.

## Current Repo Facts

- `drizzle.config.ts` points at `src/db/schema.ts`; Drizzle stays in the project for schema definitions and deliberate migration SQL generation.
- The runtime DB handle is `src/db/client.ts`, backed by `@tauri-apps/plugin-sql` and `Database.load("sqlite:norea.db")`.
- Current runtime queries use `db.select(...)` and `db.execute(...)` with SQL strings, not Drizzle query builders.
- The version 1 `src-tauri/src/schema.sql` baseline is immutable. Every later schema change requires a higher version and appended upgrade SQL, including development builds.
- Tauri registers the ordered migration list from `schema_migrations()` in `src-tauri/src/database.rs` through `src-tauri/src/lib.rs`. Generated `drizzle/` output alone does not register a runtime migration.
- Fresh initialization and upgrades must both produce the current canonical Drizzle schema while retaining existing data.

## Checks

- Build the canonical table/column/index map from `src/db/schema.ts` first. Do not infer the canonical structure from raw SQL, tests, backup models, route props, or generated migration files.
- Every app-owned persisted table or column mentioned in changed raw SQL must exist in the canonical map. Flag new table/column names that appear only in SQL strings, backup models, tests, Rust structs, or migrations.
- Schema edits must append an ordered migration and increment its version without modifying applied SQL.
- Registered schema migrations must match the canonical schema intent. Flag release schema or migration DDL that diverges from `src/db/schema.ts` unless the change is an explicit SQLite backfill/compatibility step.
- Ordinary app-owned DB reads/writes should go through `src/db/queries/*` helpers. New direct `getDb()` usage outside that layer needs a clear reason, such as backup snapshot/apply, library update-check orchestration, or plugin-to-library orchestration.
- Raw SQL is normal in this repo, but it is not a source of truth. Verify table names, column names, aliases, boolean 0/1 coercions, conflict targets, ordering, and null handling against the canonical map.
- Query result interfaces may be view models for joins, aggregates, aliases, and UI-specific rows. Flag interfaces that restate direct table rows or inserts instead of using schema-exported `$inferSelect` / `$inferInsert` types.
- Plugin-owned fetch/site data stays outside this rule except persisted app-owned cache tables such as `installed_plugin` and `repository_index_cache`.
- Backup format models are serialized artifact contracts, not a second live DB schema. Snapshot/apply code must visibly map each persisted field to and from canonical schema columns.
- Flag unreferenced app-owned persistence models only after confirming no references outside the defining file.

## Review Sequence

1. Read `src/db/schema.ts` and write down the relevant canonical tables, columns, indexes, and exported row/insert types.
2. Review changed raw SQL and classify every table/column reference as canonical, alias/view-model-only, or invalid.
3. Review changed runtime schema bootstrap SQL, release schema version files, and `src-tauri/src/lib.rs` registration against the canonical schema map.
4. Review backup, cache, plugin import, and update-check code only where it persists app-owned SQLite rows.
5. Report whether the schema contract holds. Use this exact wording in the summary: `Schema contract holds`, `Schema contract violated`, or `Schema contract not applicable`.
6. Recommend migration SQL generation, `pnpm tsc`, or focused tests only when the command gate allows those commands.
