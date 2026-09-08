---
name: verify-frontend-quality
description: Verify Norea frontend comments, reusable TypeScript contracts, null/number boundaries, and obvious plugin fetch misuse.
---

# Verify Frontend Quality

Use after modifying `src/**/*.{ts,tsx}`.

## Checks

1. Remove low-signal comments.
   - Fail section dividers or comments that restate filenames or component names.
   - Allow public API JSDoc, justified lint disables, TODOs with real follow-up, and short intent comments.
2. Detect obvious frontend contract drift.
   - Fail only local exported types that clearly duplicate central app contracts in the reviewed frontend file.
   - Leave broader canonical type ownership to `verify-canonical-types`.
   - Why: Reusing canonical string value definitions keeps equivalent code consistent across models and sessions; string literal unions are not inherently type-unsafe.
   - When converting a union to a string enum, use PascalCase member names and preserve every existing string value exactly, including casing, spelling, whitespace, and punctuation. Apply the same value preservation when using const-backed definitions allowed by local conventions.
   - String values follow established app, plugin, IPC, database, URL, or serialized contracts. Changing values is a separate behavioral or data-migration change; do not introduce a blanket union ban through this check.
3. Keep null at real boundaries.
   - Report exported reusable contracts that carry `| null` without a boundary reason.
   - Allow null from DB, plugin, browser, or Tauri APIs when the boundary requires it.
   - Allow UI props and state to mirror explicit app empty states such as no selected category, no cover image, missing active plugin, absent route result, or optional reader/browser handles.
4. Keep numeric business values numeric.
   - Report exported reusable `number | string` fields for counts, sizes, rates, progress, chapter indexes, or expiry hours.
   - Allow strings at form input, parser, or raw plugin HTML boundaries.
5. Preserve plugin-owned fetch routing at the smoke-check level.
   - Report clear frontend call sites that fetch plugin-owned source pages through ordinary app HTTP or window fetch.
   - Leave full fetch-boundary review to `verify-plugin-fetch-contract`.

## Output

Report concrete findings only. Avoid duplicating deeper plugin-runtime or IPC verifiers.
