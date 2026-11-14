import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  countRecentChecksBySource,
  getLatestLibraryCheckAt,
  getNovelFreshness,
  listCheckCandidates,
  recordNovelCheck,
  recordNovelCoverFetched,
} from "./novel-freshness";

beforeEach(() => {
  invokeMock.mockReset();
});

it("records success and failure checks and queries novel freshness", async () => {
  invokeMock
    .mockResolvedValueOnce({ value: null, effects: {} })
    .mockResolvedValueOnce({ value: null, effects: {} })
    .mockResolvedValueOnce({
      novelId: 1,
      lastCheckedAt: 40,
      lastSuccessAt: 40,
      consecutiveFailures: 0,
      lastNewChapterAt: 30,
      coverFetchedAt: null,
    });

  await recordNovelCheck(1, { ok: false }, 20);
  await recordNovelCheck(1, { ok: true, newChapters: 3 }, 30);
  const freshness = await getNovelFreshness(1, "committed");

  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_novel_freshness_record_check",
    {
      novelId: 1,
      ok: false,
      newChapters: 0,
      nowSeconds: 20,
    },
  );
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_novel_freshness_record_check",
    {
      novelId: 1,
      ok: true,
      newChapters: 3,
      nowSeconds: 30,
    },
  );
  expect(invokeMock).toHaveBeenNthCalledWith(3, "db_novel_freshness_get", {
    novelId: 1,
    mode: "committed",
  });
  expect(freshness).toEqual({
    novelId: 1,
    lastCheckedAt: 40,
    lastSuccessAt: 40,
    consecutiveFailures: 0,
    lastNewChapterAt: 30,
    coverFetchedAt: null,
  });
});

it("records cover fetch timestamps, lists candidates, maps source counts, and queries latest check time", async () => {
  invokeMock
    .mockResolvedValueOnce({ value: null, effects: {} })
    .mockResolvedValueOnce([
      {
        novelId: 1,
        pluginId: "source",
        status: "Ongoing",
        lastReadAt: 50,
        lastCheckedAt: 900,
        consecutiveFailures: 1,
        totalChapters: 2,
        unreadChapters: 1,
        hasGoal: true,
      },
    ])
    .mockResolvedValueOnce([
      { pluginId: "source", count: 2 },
      { pluginId: "other", count: 1 },
    ])
    .mockResolvedValueOnce(900);

  await recordNovelCoverFetched(1, 55);
  const candidates = await listCheckCandidates(40);
  const recent = await countRecentChecksBySource(500);
  const latest = await getLatestLibraryCheckAt("committed");

  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_novel_freshness_record_cover_fetched",
    { novelId: 1, nowSeconds: 55 },
  );
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_novel_freshness_list_candidates",
    { activeSince: 40, mode: "queued" },
  );
  expect(candidates).toHaveLength(1);
  expect(recent).toEqual(
    new Map([
      ["source", 2],
      ["other", 1],
    ]),
  );
  expect(latest).toBe(900);
});
