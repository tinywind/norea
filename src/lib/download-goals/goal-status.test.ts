import { expect, it } from "vitest";
import type { ChapterListRow } from "../../db/queries/chapter";
import { describeDownloadGoalProgress, formatDownloadEta } from "./goal-status";

const chapter = (id: number, extra: Partial<ChapterListRow> = {}) =>
  ({ id, isDownloaded: false, contentBytes: 0, mediaRepairNeeded: false, readAt: null, ...extra }) as ChapterListRow;
const order = [
  chapter(1, { isDownloaded: true, contentBytes: 5 }), chapter(2, { contentBytes: 3, mediaRepairNeeded: true }),
  chapter(3), chapter(4), chapter(5),
];

it("reports progress over the goal's chapters while work is queued", () => {
  const statuses = new Map([[3, { kind: "running" as const }]]);
  expect(describeDownloadGoalProgress({ kind: "entire" }, order, 1, statuses)).toEqual({ kind: "downloading", done: 2, total: 5 });
  expect(describeDownloadGoalProgress({ kind: "keep_ahead", count: 2 }, order, 2, new Map()))
    .toEqual({ kind: "waiting", remaining: 2 });
});

it("says what is on the device once the goal is met or when there is none", () => {
  expect(describeDownloadGoalProgress({ kind: "keep_ahead", count: 1 }, order, undefined, new Map()))
    .toEqual({ kind: "satisfied", onDevice: 2, missingImages: 1 });
  expect(describeDownloadGoalProgress(null, order, 1, new Map())).toEqual({ kind: "none", onDevice: 2, missingImages: 1 });
});

it("rounds estimates to minutes and says a few hours past two hours", () => {
  expect(formatDownloadEta(25 * 60_000 + 10_000)).toEqual({ key: "downloadGoals.eta.minutes", minutes: 25 });
  expect(formatDownloadEta(20_000)).toEqual({ key: "downloadGoals.eta.lessThanMinute", minutes: 0 });
  expect(formatDownloadEta(3 * 60 * 60_000)).toEqual({ key: "downloadGoals.eta.hours", minutes: 0 });
});
