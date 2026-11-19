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
