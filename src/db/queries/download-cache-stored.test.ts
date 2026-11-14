import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  deleteDownloadCacheChapter,
  deleteDownloadCacheNovel,
  listDownloadCacheChapters,
  listDownloadCacheNovels,
  listNonLocalDownloadCacheDeleteChapters,
} from "./download-cache";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

it("counts a chapter whose text is stored without its media like the library does", async () => {
  mockedInvoke.mockResolvedValueOnce([
    {
      novelId: 1,
      novelName: "One",
      novelCover: null,
      novelPath: "/one",
      pluginId: "source",
      sourceNovelId: null,
      pluginName: null,
      inLibrary: false,
      chaptersDownloaded: 2,
      totalChapters: 4,
      unreadDownloaded: 1,
      readDownloaded: 1,
      mediaRepairNeededChapters: 1,
      totalBytes: 185,
      lastDownloadedAt: 100,
    },
    {
      novelId: 3,
      novelName: "Three",
      novelCover: null,
      novelPath: "/three",
      pluginId: "source",
      sourceNovelId: null,
      pluginName: null,
      inLibrary: false,
      chaptersDownloaded: 1,
      totalChapters: 1,
      unreadDownloaded: 1,
      readDownloaded: 0,
      mediaRepairNeededChapters: 1,
      totalBytes: 20,
      lastDownloadedAt: 100,
    },
  ]);

  const novels = await listDownloadCacheNovels();
  expect(mockedInvoke).toHaveBeenCalledWith("db_download_cache_list_novels");
  expect(novels.map((novel) => novel.novelId).sort()).toEqual([1, 3]);
  expect(novels.find((novel) => novel.novelId === 1)).toMatchObject({
    chaptersDownloaded: 2,
    totalChapters: 4,
    unreadDownloaded: 1,
    readDownloaded: 1,
    mediaRepairNeededChapters: 1,
    totalBytes: 185,
  });
  expect(novels.find((novel) => novel.novelId === 3)).toMatchObject({
    chaptersDownloaded: 1,
    mediaRepairNeededChapters: 1,
  });
});

it("lists the partial chapter among a work's stored chapters with its missing media", async () => {
  mockedInvoke.mockResolvedValueOnce([
    {
      id: 1,
      novelId: 1,
      name: "Complete",
      position: 1,
      unread: true,
      progress: 0,
      readAt: null,
      downloadedAt: 100,
      contentBytes: 100,
      mediaBytes: 50,
      mediaRepairNeeded: false,
      totalBytes: 150,
    },
    {
      id: 2,
      novelId: 1,
      name: "Text without images",
      position: 2,
      unread: false,
      progress: 0,
      readAt: null,
      downloadedAt: 100,
      contentBytes: 30,
      mediaBytes: 5,
      mediaRepairNeeded: true,
      totalBytes: 35,
    },
  ]);
  mockedInvoke.mockResolvedValueOnce([]);

  const chapters = await listDownloadCacheChapters(1);
  expect(chapters.map((chapter) => chapter.id)).toEqual([1, 2]);
  expect(chapters[1]).toMatchObject({
    mediaRepairNeeded: true,
    totalBytes: 35,
    unread: false,
  });
  expect(await listDownloadCacheChapters(2)).toEqual([]);
});

it("includes partial chapters in the deletion scope so the stored count drops to zero", async () => {
  mockedInvoke.mockResolvedValueOnce([
    {
      contentBytes: 100,
      id: 1,
      isDownloaded: true,
      path: "/1",
      pluginId: "source",
      sourceContentType: "html",
    },
    {
      contentBytes: 30,
      id: 2,
      isDownloaded: false,
      path: "/2",
      pluginId: "source",
      sourceContentType: "html",
    },
    {
      contentBytes: 0,
      id: 4,
      isDownloaded: false,
      path: "/4",
      pluginId: "source",
      sourceContentType: "html",
    },
  ]);
  mockedInvoke.mockResolvedValueOnce({
    value: { rowsAffected: 1 },
    effects: {},
  });
  mockedInvoke.mockResolvedValueOnce({
    value: { rowsAffected: 2 },
    effects: {},
  });
  mockedInvoke.mockResolvedValueOnce([]);

  expect(
    (await listNonLocalDownloadCacheDeleteChapters({ novelIds: [1] })).map(
      (chapter) => chapter.id,
    ),
  ).toEqual([1, 2, 4]);

  await expect(deleteDownloadCacheChapter(6)).resolves.toEqual({
    rowsAffected: 1,
  });
  await expect(deleteDownloadCacheNovel(1)).resolves.toEqual({
    rowsAffected: 2,
  });
  expect(await listDownloadCacheNovels()).toEqual([]);
});
