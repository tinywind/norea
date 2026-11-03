import { expect, it, vi } from "vitest";
import type { TaskRecord } from "../lib/tasks/task-types";

vi.mock("../lib/download-goals/goal-service", () => ({ stopDownloadGoals: vi.fn() }));
vi.mock("../lib/tasks/scheduler", () => ({ taskScheduler: { cancel: vi.fn() } }));

import { goalNovelIdsOf } from "./use-cancel-goal-work";

const task = (id: string, novelId: number, extra: Partial<TaskRecord> = {}): TaskRecord => ({
  id, lane: "source", kind: "chapter.download", priority: "background", title: id, source: { id: "s", name: "S" },
  subject: { novelId, chapterId: Number(id) }, status: "queued", createdAt: 0, canCancel: true, canRetry: false,
  automatic: true, ...extra,
});

it("finds the novels whose active goal work a cancel would stop", () => {
  expect(goalNovelIdsOf([
    task("1", 7), task("2", 7, { status: "running" }), task("3", 3),
    task("4", 9, { automatic: false }), task("5", 10, { status: "succeeded", canCancel: false }),
    task("6", 11, { kind: "library.checkUpdates" }),
  ])).toEqual([3, 7]);
});
