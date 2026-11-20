import { afterEach, expect, it, vi } from "vitest";

vi.mock("./scheduler", () => ({
  taskScheduler: { getSnapshot: () => ({ records: [] }), subscribe: () => () => undefined },
  taskWorkQueueKey: (subject?: { novelId?: number }) =>
    subject?.novelId === undefined ? null : `novel:${subject.novelId}`,
}));

import type { TaskRecord } from "./task-types";
import { resetWorkProgressForTests, updateWorkProgress, workProgress } from "./work-progress";

const chapter = (id: number, status: TaskRecord["status"], novelId = 9) =>
  ({ id: `t${id}`, kind: "chapter.download", status, subject: { novelId } }) as unknown as TaskRecord;
const queued = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => chapter(from + index, "queued"));
const observe = (records: TaskRecord[]) => {
  updateWorkProgress({ records });
  return workProgress("novel:9", records);
};

afterEach(resetWorkProgressForTests);

it("keeps counting finished chapters after they leave the snapshot", () => {
  expect(observe(queued(459))).toEqual({ done: 0, total: 459 });
  expect(observe(queued(446, 14))).toEqual({ done: 13, total: 459 });
  expect(observe([...queued(445, 15), chapter(900, "running")])).toEqual({ done: 13, total: 459 });
  expect(observe(queued(460, 15))).toEqual({ done: 13, total: 473 });
});

it("forgets a work once nothing of it is active, even if the page never rendered it", () => {
  observe(queued(10));
  updateWorkProgress({ records: [] });
  expect(observe(queued(5, 20))).toEqual({ done: 0, total: 5 });
});

it("counts failures as not done", () => {
  expect(observe([chapter(1, "failed"), chapter(2, "succeeded")])).toEqual({ done: 1, total: 2 });
});

it("ignores non-download source tasks for the same novel", () => {
  const refresh = { id: "refresh", kind: "source.refreshNovel", status: "running", subject: { novelId: 9 } } as unknown as TaskRecord;
  const check = { id: "check", kind: "source.checkLibraryUpdates", status: "queued", subject: { novelId: 9 } } as unknown as TaskRecord;
  updateWorkProgress({ records: [chapter(1, "queued"), refresh, check] });
  expect(workProgress("novel:9", [chapter(1, "queued")])).toEqual({ done: 0, total: 1 });
});

it("preserves completed chapter count when the final chapter fails after earlier chapters leave the snapshot", () => {
  expect(observe(queued(3))).toEqual({ done: 0, total: 3 });
  expect(observe([chapter(3, "running")])).toEqual({ done: 2, total: 3 });
  expect(observe([chapter(3, "failed")])).toEqual({ done: 2, total: 3 });

  // Retrying that failed chapter keeps the original total instead of inflating it to 4.
  expect(observe([chapter(3, "queued")])).toEqual({ done: 2, total: 3 });
  expect(observe([chapter(3, "succeeded")])).toEqual({ done: 3, total: 3 });
  updateWorkProgress({ records: [] });
  expect(observe(queued(2, 10))).toEqual({ done: 0, total: 2 });
});

it("reduces total instead of counting cancelled chapters as completed", () => {
  expect(observe(queued(3))).toEqual({ done: 0, total: 3 });
  expect(observe([chapter(1, "failed"), chapter(2, "cancelled"), chapter(3, "cancelled")])).toEqual({ done: 0, total: 1 });
  expect(observe([chapter(1, "failed")])).toEqual({ done: 0, total: 1 });
});

it("deduplicates retries for the same chapterId instead of inflating work total", () => {
  const chTask = (
    taskId: string,
    chapterId: number,
    status: TaskRecord["status"],
    createdAt: number,
  ) =>
    ({
      id: taskId,
      kind: "chapter.download",
      status,
      createdAt,
      subject: { novelId: 9, chapterId },
    }) as unknown as TaskRecord;

  expect(
    observe([
      chTask("t1", 1, "queued", 10),
      chTask("t2", 2, "queued", 11),
      chTask("t3", 3, "queued", 12),
      chTask("t4", 4, "queued", 13),
    ]),
  ).toEqual({ done: 0, total: 4 });

  // Chapters 1 and 4 finish and leave snapshot; 2 and 3 remain failed.
  expect(
    observe([chTask("t2", 2, "failed", 11), chTask("t3", 3, "failed", 12)]),
  ).toEqual({ done: 2, total: 4 });

  // Retrying chapter 2 while t2 is still present must keep total at 4 (not 5).
  expect(
    observe([
      chTask("t2", 2, "failed", 11),
      chTask("t3", 3, "failed", 12),
      chTask("t5", 2, "running", 20),
    ]),
  ).toEqual({ done: 2, total: 4 });

  // Retry fails too -> still 2 / 4.
  expect(
    observe([
      chTask("t2", 2, "failed", 11),
      chTask("t3", 3, "failed", 12),
      chTask("t5", 2, "failed", 20),
    ]),
  ).toEqual({ done: 2, total: 4 });

  // Cancelling a retry while chapter 2 still has a failed record must not drop total.
  expect(
    observe([
      chTask("t2", 2, "failed", 11),
      chTask("t3", 3, "failed", 12),
      chTask("t6", 2, "cancelled", 25),
    ]),
  ).toEqual({ done: 2, total: 4 });

  // Later retry succeeds -> newest status for chapter 2 is succeeded -> 3 / 4.
  expect(
    observe([
      chTask("t2", 2, "failed", 11),
      chTask("t3", 3, "failed", 12),
      chTask("t7", 2, "succeeded", 30),
    ]),
  ).toEqual({ done: 3, total: 4 });
});
