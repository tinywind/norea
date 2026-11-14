import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  clearChapterDownloadFailures,
  clearScheduledChapterDownloadRetries,
  getChapterDownloadFailure,
  listChapterDownloadFailures,
  recordChapterDownloadFailure,
  type ChapterDownloadFailureInput,
  type StoredChapterDownloadFailure,
} from "./chapter-download-failure";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

function failure(
  chapterId: number,
  extra: Partial<ChapterDownloadFailureInput> = {},
): ChapterDownloadFailureInput {
  return {
    chapterId,
    pluginId: "source",
    failureClass: "transient",
    messageSummary: "Timed out",
    jobJson: JSON.stringify({ id: chapterId }),
    now: 1_000,
    retryDelayMs: (attempts) => (attempts <= 3 ? attempts * 10 : null),
    ...extra,
  };
}

it("forwards precomputed retry budgets to db_download_failure_record", async () => {
  const stored: StoredChapterDownloadFailure = {
    chapterId: 1,
    pluginId: "source",
    failureClass: "transient",
    messageSummary: "Timed out",
    challengeUrl: null,
    attempts: 1,
    nextRetryAt: 1_010,
    jobJson: '{"id":1}',
    updatedAt: 1_000,
  };
  mockedInvoke.mockResolvedValueOnce({ value: stored, effects: {} });

  await expect(recordChapterDownloadFailure(failure(1))).resolves.toEqual(
    stored,
  );
  expect(mockedInvoke).toHaveBeenCalledWith("db_download_failure_record", {
    input: expect.objectContaining({
      chapterId: 1,
      pluginId: "source",
      failureClass: "transient",
      messageSummary: "Timed out",
      challengeUrl: null,
      now: 1_000,
      fallbackRetryDelayMs: null,
      retryDelaysMs: expect.arrayContaining([10, 20, 30, null]),
    }),
  });
});

it("clears scheduled retries and failure rows via Rust commands", async () => {
  await expect(clearChapterDownloadFailures([])).resolves.toBe(0);
  expect(mockedInvoke).not.toHaveBeenCalled();

  mockedInvoke.mockResolvedValueOnce({ value: 2, effects: {} });
  mockedInvoke.mockResolvedValueOnce({ value: 1, effects: {} });

  await expect(clearChapterDownloadFailures([1, 1, 2])).resolves.toBe(2);
  await expect(clearScheduledChapterDownloadRetries()).resolves.toBe(1);

  expect(mockedInvoke).toHaveBeenNthCalledWith(1, "db_download_failure_clear", {
    chapterIds: [1, 2],
  });
  expect(mockedInvoke).toHaveBeenNthCalledWith(
    2,
    "db_download_failure_clear_scheduled_retries",
  );
});

it("reads single and listed chapter failures and maps null to undefined", async () => {
  const row: StoredChapterDownloadFailure = {
    chapterId: 2,
    pluginId: "source",
    failureClass: "challenge",
    messageSummary: "Verify",
    challengeUrl: "https://cdn.example/",
    attempts: 2,
    nextRetryAt: null,
    jobJson: '{"id":2}',
    updatedAt: 2_000,
  };
  mockedInvoke.mockResolvedValueOnce(row);
  mockedInvoke.mockResolvedValueOnce(null);
  mockedInvoke.mockResolvedValueOnce([row]);

  await expect(getChapterDownloadFailure(2)).resolves.toEqual(row);
  await expect(getChapterDownloadFailure(99)).resolves.toBeUndefined();
  await expect(listChapterDownloadFailures()).resolves.toEqual([row]);
});
