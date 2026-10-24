---
name: verify-norea-release-compatibility
description: Verify Norea release-line compatibility for database, backup, storage, import/export, release packaging, schema versioning, plugin contract, and compatibility-impacting changes.
---

# Verify Norea Release Compatibility

Use this skill when checking whether a Norea change is complete and safe to
merge or release.

## Required References

- Read `CLAUDE.md` before judging repository rules.
- Read `docs/release-compatibility.md` when the change touches data, backups,
  storage, local files, import/export, schema version files, migrations, or
  release behavior.
- Read `docs/plugins/contract.md` when the change touches source plugin runtime
  behavior.

## Compatibility Rule

Follow the current scope in `docs/release-compatibility.md`.

- App database changes increment the version and preserve existing data through
  ordered migrations, including development builds.
- Applied migration SQL is immutable. Unsupported history, checksum mismatches,
  and upgrade failures must preserve the database instead of resetting it.
- Settings, metadata, backups, and content-server APIs currently support their
  current formats. Do not infer additional format compatibility from semver alone.

## Verification Checklist

For data or release-affecting changes:

1. Identify whether the change is inside the current compatibility scope.
2. Check that ordered database migrations and schema versions,
   backup format handling, local file handling, and reader/import paths
   preserve data inside that scope.
3. Require explicit authorization for data loss and populated upgrade,
   rollback, reopen, and mismatch-preservation coverage for schema changes.
4. Check that README, `CLAUDE.md`, release notes, or developer docs reference
   the compatibility impact when users or agents need to know it.
5. Prefer the smallest relevant automated check, then add manual smoke steps
   only when automation cannot cover the behavior.
