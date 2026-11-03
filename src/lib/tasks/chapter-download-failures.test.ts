import { beforeEach, expect, it, vi } from "vitest";

const queries = vi.hoisted(() => ({
  record: vi.fn(),
  clear: vi.fn(async () => 0),
  list: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("../../db/queries/chapter-download-failure", () => ({
  recordChapterDownloadFailure: queries.record,
  clearChapterDownloadFailures: queries.clear,
  listChapterDownloadFailures: queries.list,
}));

import {
  forgetChapterDownloadFailures,
  getChapterDownloadFailureSnapshot,
  recordFailedChapterDownloadAttempt,
  refreshChapterDownloadFailures,
  subscribeChapterDownloadFailures,
} from "./chapter-download-failures";

const job = { id: 7, pluginId: "source", chapterPath: "/7", title: "Seven", retryAt: 99 };

beforeEach(() => { vi.clearAllMocks(); });

it("records the classified failure with the transient budget and without the old wait", async () => {
  queries.record.mockImplementation(async (input) => ({ ...input, attempts: 1, nextRetryAt: 30_100 }));
  const stored = await recordFailedChapterDownloadAttempt(job, new Error("Failed to fetch"), 100);
  const input = queries.record.mock.calls[0]![0];
  expect(input).toMatchObject({ chapterId: 7, pluginId: "source", failureClass: "transient", messageSummary: "Failed to fetch", now: 100 });
  expect(JSON.parse(input.jobJson)).toEqual({ id: 7, pluginId: "source", chapterPath: "/7", title: "Seven" });
  expect([1, 2, 3, 4].map(input.retryDelayMs)).toEqual([30_000, 120_000, 600_000, null]);
  expect(stored).toMatchObject({ nextRetryAt: 30_100 });
});

it("gives content failures no automatic attempt and records the challenged host", async () => {
  queries.record.mockImplementation(async (input) => input);
  await recordFailedChapterDownloadAttempt(job, new Error("External resource at cdn.example requires Cloudflare verification (HTTP 403)."));
  await recordFailedChapterDownloadAttempt(job, new Error("Failed to fetch novel data: (404)"));
  expect(queries.record.mock.calls.map(([input]) => [input.failureClass, input.challengeUrl, input.retryDelayMs(1)]))
    .toEqual([["challenge", "https://cdn.example/", null], ["content", undefined, null]]);
});

it("publishes refreshed failures and skips clearing chapters that have none", async () => {
  const listener = vi.fn();
  const unsubscribe = subscribeChapterDownloadFailures(listener);
  queries.list.mockResolvedValueOnce([{ chapterId: 7 }]);
  await refreshChapterDownloadFailures();
  expect(getChapterDownloadFailureSnapshot()).toEqual([{ chapterId: 7 }]);
  expect(listener).toHaveBeenCalled();
  await forgetChapterDownloadFailures([8]);
  expect(queries.clear).not.toHaveBeenCalled();
  queries.clear.mockResolvedValueOnce(1);
  await forgetChapterDownloadFailures([7]);
  expect(queries.clear).toHaveBeenCalledWith([7]);
  expect(getChapterDownloadFailureSnapshot()).toEqual([]);
  unsubscribe();
});
