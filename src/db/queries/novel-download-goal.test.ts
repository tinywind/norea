import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  excludeChaptersFromDownloadGoals,
  getNovelDownloadGoal,
  listDownloadGoalExcludedChapterIds,
  listDownloadGoalNovels,
  listGoalNovelIdsForDownloadScope,
  listLibraryNovelsWithoutDownloadGoal,
  listNovelDownloadGoals,
  resumeStoppedNovelDownloadGoal,
  setNovelDownloadGoal,
} from "./novel-download-goal";

beforeEach(() => {
  invokeMock.mockReset();
});

it("stores, reads, lists, and clears novel download goals via Rust IPC", async () => {
  invokeMock
    .mockResolvedValueOnce({ value: true, effects: {} })
    .mockResolvedValueOnce({
      novelId: 1,
      goal: { kind: "keep_ahead", count: 3 },
      updatedAt: 10,
    })
    .mockResolvedValueOnce([
      { novelId: 1, goal: { kind: "keep_ahead", count: 3 }, updatedAt: 10 },
    ])
    .mockResolvedValueOnce({ value: true, effects: {} });

  await expect(
    setNovelDownloadGoal(1, { kind: "keep_ahead", count: 3 }, 10),
  ).resolves.toBe(true);
  await expect(getNovelDownloadGoal(1)).resolves.toEqual({
    novelId: 1,
    goal: { kind: "keep_ahead", count: 3 },
    updatedAt: 10,
  });
  await expect(listNovelDownloadGoals()).resolves.toHaveLength(1);
  await expect(setNovelDownloadGoal(1, null, 20)).resolves.toBe(true);

  expect(invokeMock).toHaveBeenNthCalledWith(1, "db_novel_goal_set", {
    novelId: 1,
    goal: { kind: "keep_ahead", count: 3 },
    now: 10,
  });
  expect(invokeMock).toHaveBeenNthCalledWith(4, "db_novel_goal_set", {
    novelId: 1,
    goal: null,
    now: 20,
  });
});

it("short-circuits null activeSince or empty id sets and deduplicates safe integer ids", async () => {
  await expect(listDownloadGoalNovels(null)).resolves.toEqual([]);
  await expect(listDownloadGoalNovels(400, [])).resolves.toEqual([]);
  await expect(listGoalNovelIdsForDownloadScope("novel", [], 400)).resolves.toEqual([]);
  await expect(listGoalNovelIdsForDownloadScope("all", [], null)).resolves.toEqual([]);
  await excludeChaptersFromDownloadGoals([]);
  expect(invokeMock).not.toHaveBeenCalled();

  invokeMock
    .mockResolvedValueOnce([
      {
        id: 3,
        pluginId: "source",
        path: "/active",
        name: "Active",
        lastReadAt: 500,
        goal: null,
      },
    ])
    .mockResolvedValueOnce([2]);

  await expect(
    listDownloadGoalNovels(400, [3, 4, 3, Number.NaN]),
  ).resolves.toHaveLength(1);
  expect(invokeMock).toHaveBeenNthCalledWith(1, "db_novel_goal_list_novels", {
    activeSince: 400,
    novelIds: [3, 4],
    mode: "queued",
  });

  await expect(
    listGoalNovelIdsForDownloadScope("chapter", [10, 20, 20], 400),
  ).resolves.toEqual([2]);
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_novel_goal_list_ids_for_scope",
    {
      scope: "chapter",
      ids: [10, 20],
      activeSince: 400,
      mode: "queued",
    },
  );
});

it("routes exclusions, resumeStoppedNovelDownloadGoal, and novels without goals", async () => {
  invokeMock
    .mockResolvedValueOnce({ value: null, effects: {} })
    .mockResolvedValueOnce([10, 11])
    .mockResolvedValueOnce({ value: true, effects: {} })
    .mockResolvedValueOnce([{ id: 1, pluginId: "source" }]);

  await excludeChaptersFromDownloadGoals([11, 10, 11], 5);
  await expect(listDownloadGoalExcludedChapterIds(1)).resolves.toEqual([10, 11]);
  await expect(resumeStoppedNovelDownloadGoal(1)).resolves.toBe(true);
  await expect(listLibraryNovelsWithoutDownloadGoal()).resolves.toEqual([
    { id: 1, pluginId: "source" },
  ]);

  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_novel_goal_exclude_chapters",
    {
      chapterIds: [11, 10],
      now: 5,
    },
  );
  expect(invokeMock).toHaveBeenNthCalledWith(
    3,
    "db_novel_goal_resume_stopped",
    { novelId: 1 },
  );
});
