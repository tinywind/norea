---
name: verify-norea-instruction-hygiene
description: Verify repo-local agent instruction files stay concise and point to current repo docs instead of stale planning snapshots.
---

# Verify Norea Instruction Hygiene

Use after editing `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, nested instruction files, or `.claude/skills/**/SKILL.md`.

## Checks

- Inspect only project-local instruction files.
- Keep `CLAUDE.md` (and its root symlinks `AGENTS.md` and `GEMINI.md`) as a shared agent entry point, not a replacement for `README.md` or implementation docs.
- Do not duplicate long product plans, route inventories, old milestone acceptance tables, package script catalogs, or stale status snapshots.
- Use `README.md` for public status, supported tooling, and project map.
- Use `docs/plugins/contract.md` for plugin runtime compatibility.
- Do not reference removed planning snapshots unless the user explicitly asks to restore or archive them.
- Keep skill catalogs out of `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`; point to `.claude/skills/` instead.
- Allow stable policy in instruction files: language policy, source-of-truth order, surgical changes, host I/O and database invariant, plugin fetch invariant, command/git restrictions, and communication policy.

## Output

Report duplicated or stale instruction content, file path, line range, and shorter replacement direction.
