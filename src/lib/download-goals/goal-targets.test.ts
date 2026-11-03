import { expect, it } from "vitest";
import {
  ACTIVE_NOVEL_WINDOW_SECONDS, effectiveDownloadGoal, goalReadingChapterId, goalTargetChapters, resolveGoalTargets, type GoalChapter,
} from "./goal-targets";

const chapter = (id: number, extra: Partial<GoalChapter> = {}): GoalChapter =>
  ({ id, isDownloaded: false, contentBytes: 0, mediaRepairNeeded: false, readAt: null, ...extra });
const ids = (chapters: readonly GoalChapter[]) => chapters.map((row) => row.id);
const order = [1, 2, 3, 4, 5, 6].map((id) => chapter(id));

it("covers the chapters after the reading position, or every chapter for the entire novel", () => {
  expect(ids(goalTargetChapters({ kind: "keep_ahead", count: 3 }, order, 2))).toEqual([3, 4, 5]);
  expect(ids(goalTargetChapters({ kind: "keep_ahead", count: 3 }, order, 5))).toEqual([6]);
  expect(ids(goalTargetChapters({ kind: "all_remaining" }, order, 4))).toEqual([5, 6]);
  expect(ids(goalTargetChapters({ kind: "entire" }, order, 4))).toEqual([1, 2, 3, 4, 5, 6]);
  expect(ids(goalTargetChapters({ kind: "keep_ahead", count: 2 }, order, undefined))).toEqual([1, 2]);
});

it("uses the remembered position, else the latest read chapter", () => {
  const read = [chapter(1, { readAt: 50 }), chapter(2, { readAt: 90 }), chapter(3, { readAt: 70 })];
  expect(goalReadingChapterId(read, 3)).toBe(3);
  expect(goalReadingChapterId(read, 99)).toBe(2);
  expect(goalReadingChapterId([chapter(1)], undefined)).toBeUndefined();
});

it("counts stored chapters, reports missing images separately and requests only unowned, unexcluded gaps", () => {
  const chapters = [
    chapter(1), chapter(2, { isDownloaded: true, contentBytes: 10 }), chapter(3, { contentBytes: 8, mediaRepairNeeded: true }),
    chapter(4), chapter(5), chapter(6),
  ];
  const targets = resolveGoalTargets({ kind: "all_remaining" }, chapters, 1, (row) => row.id === 4, (row) => row.id === 5);
  expect(ids(targets.targets)).toEqual([2, 3, 4, 5, 6]);
  expect(targets.stored).toBe(2);
  expect(ids(targets.missingMedia)).toEqual([3]);
  expect(targets.inFlight).toBe(1);
  expect(targets.excluded).toBe(1);
  expect(ids(targets.pending)).toEqual([6]);
});

it("applies the default keep-ahead only to active library source novels without their own goal", () => {
  const now = 10 * ACTIVE_NOVEL_WINDOW_SECONDS;
  const active = { inLibrary: true, isLocal: false, lastReadAt: now - ACTIVE_NOVEL_WINDOW_SECONDS };
  expect(effectiveDownloadGoal(null, active, 3, now)).toEqual({ goal: { kind: "keep_ahead", count: 3 }, isDefault: true });
  expect(effectiveDownloadGoal({ kind: "entire" }, { ...active, inLibrary: false }, 3, now))
    .toEqual({ goal: { kind: "entire" }, isDefault: false });
  for (const novel of [{ ...active, lastReadAt: now - ACTIVE_NOVEL_WINDOW_SECONDS - 1 }, { ...active, inLibrary: false },
    { ...active, isLocal: true }, { ...active, lastReadAt: null }]) {
    expect(effectiveDownloadGoal(null, novel, 3, now)).toEqual({ goal: null, isDefault: false });
  }
  expect(effectiveDownloadGoal(null, active, 0, now)).toEqual({ goal: null, isDefault: false });
});
