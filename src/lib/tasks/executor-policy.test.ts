import { expect, it } from "vitest";
import {
  canUsePoolExecutorForImmediateInteraction,
  shouldUseImmediateExecutor,
  usesSearchExecutor,
} from "./executor-policy";
import type { TaskKind, TaskPriority } from "./task-types";

it.each<[TaskKind, TaskPriority, boolean, boolean, boolean, boolean]>([
  ["source.globalSearch", "user", false, true, false, false],
  ["source.openSite", "user", false, false, true, false],
  ["source.openNovel", "user", false, false, true, true],
  ["source.openNovel", "user", true, false, true, false],
  ["source.openNovel", "background", false, false, false, false],
])(
  "routes %s at %s priority with foreground requirement %s",
  (kind, priority, foreground, search, immediate, pool) => {
    const task = { record: { kind, priority }, spec: { requiresForegroundExecutor: foreground } };
    expect(usesSearchExecutor(task)).toBe(search);
    expect(shouldUseImmediateExecutor(task)).toBe(immediate);
    expect(canUsePoolExecutorForImmediateInteraction(task)).toBe(pool);
  },
);
