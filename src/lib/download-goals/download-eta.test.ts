import { beforeEach, expect, it } from "vitest";
import type { TaskRecord } from "../tasks/task-types";
import {
  averageChapterDurationMs,
  estimateNovelDownloadMs,
  novelDownloadRoute,
  recordChapterDownloadDuration,
  resetDownloadEtaForTests,
  SERVER_LANE_ETA_KEY,
} from "./download-eta";

const record = (extra: Partial<TaskRecord>): TaskRecord => ({
  id: "task", lane: "source", kind: "chapter.download", priority: "background", title: "Chapter",
  source: { id: "source", name: "Source" }, subject: { novelId: 1 }, status: "queued", createdAt: 0,
  canCancel: true, canRetry: false, ...extra,
});
const finished = (duration: number, extra: Partial<TaskRecord> = {}) => recordChapterDownloadDuration({
  task: record({ status: "succeeded", startedAt: 1_000, finishedAt: 1_000 + duration, ...extra }), previousStatus: "running",
});

beforeEach(() => { resetDownloadEtaForTests(); });

it("keeps a rolling average per source and for the server lane", () => {
  finished(2_000);
  finished(4_000);
  finished(500, { chapterDownloadPhase: "server-download" });
  recordChapterDownloadDuration({ task: record({ status: "succeeded", startedAt: 0, finishedAt: 9 }), previousStatus: "queued" });
  expect(averageChapterDurationMs("source")).toBe(3_000);
  expect(averageChapterDurationMs(SERVER_LANE_ETA_KEY)).toBe(500);
  for (let index = 0; index < 25; index += 1) finished(1_000);
  expect(averageChapterDurationMs("source")).toBe(1_000);
});

it("estimates from the novel's last place in its source order and names the running route", () => {
  const records = [
    record({ id: "a", status: "running", chapterDownloadPhase: "source-download" }),
    record({ id: "b", queueIndex: 1 }),
    record({ id: "c", queueIndex: 2, subject: { novelId: 2 } }),
    record({ id: "d", queueIndex: 3 }),
  ];
  expect(estimateNovelDownloadMs(1, records, 1_000)).toBeNull();
  finished(2_000);
  expect(estimateNovelDownloadMs(1, records, 1_000)).toBe(4 * 3_000);
  expect(estimateNovelDownloadMs(3, records, 1_000)).toBeNull();
  expect(novelDownloadRoute(1, records)).toBe("source");
  expect(novelDownloadRoute(1, [record({ status: "running", chapterDownloadPhase: "server-download" })])).toBe("server");
  expect(novelDownloadRoute(1, [record({ status: "running", vpnWorker: { rangeId: "r", slot: 0, generation: 1 } })])).toBe("vpn");
  expect(novelDownloadRoute(2, records)).toBeNull();
});
