import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import { countNewLibraryChaptersSince, listLibraryUpdatesPage } from "./chapter";

beforeEach(() => {
  invokeMock.mockReset();
});

it("requests new and backlog scopes with explicit read modes", async () => {
  invokeMock
    .mockResolvedValueOnce([
      {
        chapterId: 6,
        chapterPath: "/6",
        novelId: 1,
        pluginId: "s",
        novelSourceNovelId: null,
        novelPath: "/a",
        chapterName: "Six",
        contentType: "html",
        position: 6,
        sortAt: 250,
        isDownloaded: false,
        novelName: "Library",
        novelCover: null,
        novelIsLocal: false,
      },
      {
        chapterId: 2,
        chapterPath: "/2",
        novelId: 1,
        pluginId: "s",
        novelSourceNovelId: null,
        novelPath: "/a",
        chapterName: "Two",
        contentType: "html",
        position: 2,
        sortAt: 200,
        isDownloaded: false,
        novelName: "Library",
        novelCover: null,
        novelIsLocal: false,
      },
      {
        chapterId: 4,
        chapterPath: "/4",
        novelId: 1,
        pluginId: "s",
        novelSourceNovelId: null,
        novelPath: "/a",
        chapterName: "Four",
        contentType: "html",
        position: 4,
        sortAt: 100,
        isDownloaded: false,
        novelName: "Library",
        novelCover: null,
        novelIsLocal: false,
      },
    ])
    .mockResolvedValueOnce([]);

  const first = await listLibraryUpdatesPage(2);
  expect(first.updates.map((row) => [row.chapterId, row.sortAt])).toEqual([
    [6, 250],
    [2, 200],
  ]);
  expect(first.hasMore).toBe(true);
  expect(first.nextCursor).toEqual({ chapterId: 2, sortAt: 200, position: 2 });

  await listLibraryUpdatesPage(2, first.nextCursor, "backlog", "committed");
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_chapter_list_library_updates",
    {
      input: {
        limit: 3,
        cursor: { chapterId: 2, sortAt: 200, position: 2 },
        scope: "backlog",
      },
      readMode: "committed",
    },
  );
});

it("counts new chapters found since Updates was last opened", async () => {
  invokeMock.mockResolvedValueOnce(2).mockResolvedValueOnce(0);

  await expect(countNewLibraryChaptersSince(0)).resolves.toBe(2);
  expect(invokeMock).toHaveBeenNthCalledWith(1, "db_chapter_count_new_since", {
    seenAt: 0,
    readMode: "queued",
  });

  await expect(countNewLibraryChaptersSince(400, "committed")).resolves.toBe(0);
  expect(invokeMock).toHaveBeenNthCalledWith(2, "db_chapter_count_new_since", {
    seenAt: 400,
    readMode: "committed",
  });
});
