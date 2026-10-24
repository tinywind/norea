---
name: verify-drizzle-sqlite-migration
description: Verify SQLite Drizzle schema, bootstrap SQL, and migrations preserve Norea app data and migration safety.
---

# Verify Drizzle SQLite Migration

Use when Drizzle schema, runtime bootstrap SQL, SQLite migrations, `tauri-plugin-sql` DB client code, backup DB gather/apply logic, or library/plugin persistence changes.

## Migration Policy

- Every app schema change increments the schema version, including development builds.
- Keep the version 1 baseline and every registered migration immutable.
- Append ordered migrations that preserve installed app data.
- Version/checksum mismatches and failed upgrades must preserve the database and
  return an error. Do not reset existing databases automatically.
- Follow `docs/release-compatibility.md` for the supported baseline and verification.

## Checks

- Review edited schema, bootstrap SQL, and release schema version files first.
- Treat the repo as SQLite + Drizzle, not Flyway/PostgreSQL.
- Use local naming consistency and existing domain names; do not import naming rules from another repo.
- Check SQLite-safe DDL: constraints, defaults, nullable changes, foreign keys, indexes, and strictly increasing migration versions.
- Confirm migrations preserve library, categories, installed plugins, chapters, read progress, history, downloads, and backup/restore round trips from the supported installed schema versions.
- Keep bootstrap SQL and release migrations free of mock/sample/demo rows.
- Require populated upgrade, fresh initialization, reopen, failure rollback, and mismatch-preservation tests for schema changes.
- When schema changes need SQL generation, recommend `pnpm db:generate`, `pnpm tsc`, and focused tests only when the command gate allows.
- If plugin persistence changes, check Browse/search/install restart behavior against `README.md`, `docs/plugins/contract.md`, and current plugin manager/cache code.
