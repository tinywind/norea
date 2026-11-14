import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { MAX_BACKFILL_PER_RUN } from "../../lib/performance-budgets";
import {
  deleteAllDownloadCache,
  deleteDownloadCacheChapter,
  deleteDownloadCacheNovel,
  listDownloadCacheChapters,
  listDownloadCacheMediaBackfillCandidates,
  listDownloadCacheNovels,
  listNonLocalDownloadCacheDeleteChapters,
  listNonLocalOrdinaryQueuedDownloadChapterIds,
  updateDownloadCacheChapterMediaBytes,
} from "./download-cache";

const mockedInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("download-cache IPC queries and mutations", () => {
  it("lists download cache novels and chapters through Rust commands", async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    mockedInvoke.mockResolvedValueOnce([]);

    await expect(listDownloadCacheNovels()).resolves.toEqual([]);
    await expect(listDownloadCacheChapters(7)).resolves.toEqual([]);

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      1,
      "db_download_cache_list_novels",
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "db_download_cache_list_chapters",
      { novelId: 7 },
    );
  });

  it("normalizes delete candidate and ordinary queued ID filters before invoking Rust", async () => {
    await expect(
      listNonLocalDownloadCacheDeleteChapters({ chapterIds: [] }),
    ).resolves.toEqual([]);
    await expect(
      listNonLocalOrdinaryQueuedDownloadChapterIds({ novelIds: [-1, 0] }),
    ).resolves.toEqual([]);
    expect(mockedInvoke).not.toHaveBeenCalled();

    const candidate = {
      contentBytes: 512,
      id: 7,
      isDownloaded: true,
      path: "/chapter/7",
      pluginId: "source-a",
      sourceContentType: "html" as const,
    };
    mockedInvoke.mockResolvedValueOnce([candidate]);
    mockedInvoke.mockResolvedValueOnce([7, 9]);

    await expect(
      listNonLocalDownloadCacheDeleteChapters({ chapterIds: [9, 7, 7] }),
    ).resolves.toEqual([candidate]);
    await expect(
      listNonLocalOrdinaryQueuedDownloadChapterIds({ novelIds: [5, 3, 5] }),
    ).resolves.toEqual([7, 9]);

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      1,
      "db_download_cache_list_delete_candidates",
      { filter: { chapterIds: [7, 9] } },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "db_download_cache_list_ordinary_queued_ids",
      { filter: { novelIds: [3, 5] } },
    );
  });

  it("delegates chapter, novel, and global download cache deletion mutations", async () => {
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 1 },
      effects: {},
    });
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 2 },
      effects: {},
    });
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 3 },
      effects: {},
    });

    await expect(deleteDownloadCacheChapter(7)).resolves.toEqual({
      rowsAffected: 1,
    });
    await expect(deleteDownloadCacheNovel(7)).resolves.toEqual({
      rowsAffected: 2,
    });
    await expect(deleteAllDownloadCache()).resolves.toEqual({
      rowsAffected: 3,
    });

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      1,
      "db_download_cache_delete_chapter",
      { chapterId: 7 },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "db_download_cache_delete_novel",
      { novelId: 7 },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      3,
      "db_download_cache_delete_all",
    );
  });

  it("clamps media byte backfill limits and rounds updated media byte counts", async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    mockedInvoke.mockResolvedValueOnce([]);
    mockedInvoke.mockResolvedValueOnce({
      value: { rowsAffected: 1 },
      effects: {},
    });

    await listDownloadCacheMediaBackfillCandidates(7);
    await listDownloadCacheMediaBackfillCandidates();
    const result = await updateDownloadCacheChapterMediaBytes(7, 42.4);

    expect(mockedInvoke).toHaveBeenNthCalledWith(
      1,
      "db_download_cache_list_media_backfill_candidates",
      { novelId: 7, limit: MAX_BACKFILL_PER_RUN },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      2,
      "db_download_cache_list_media_backfill_candidates",
      { novelId: null, limit: MAX_BACKFILL_PER_RUN },
    );
    expect(mockedInvoke).toHaveBeenNthCalledWith(
      3,
      "db_download_cache_update_media_bytes",
      { chapterId: 7, mediaBytes: 42 },
    );
    expect(result).toEqual({ rowsAffected: 1 });
  });
});
