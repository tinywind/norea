import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/download-cache", () => ({
  getDownloadCacheMediaBackfillCandidateContent: vi.fn(),
  listDownloadCacheMediaBackfillCandidates: vi.fn(),
  updateDownloadCacheChapterMediaBytes: vi.fn(),
}));

vi.mock("./chapter-media", () => ({
  getStoredChapterMediaBytes: vi.fn(),
}));

vi.mock("./observability", () => ({
  recordPerformanceObservation: vi.fn(),
  startPerformanceObservation: vi.fn(() => vi.fn()),
}));

vi.mock("./tauri-runtime", () => ({
  isTauriRuntime: vi.fn(),
}));

import {
  getDownloadCacheMediaBackfillCandidateContent,
  listDownloadCacheMediaBackfillCandidates,
  updateDownloadCacheChapterMediaBytes,
} from "../db/queries/download-cache";
import { getStoredChapterMediaBytes } from "./chapter-media";
import { MAX_BACKFILL_PER_RUN } from "./performance-budgets";
import { isTauriRuntime } from "./tauri-runtime";
import { backfillDownloadCacheMediaBytes } from "./download-cache-media";

const mockedIsTauriRuntime = vi.mocked(isTauriRuntime);
const mockedListCandidates = vi.mocked(listDownloadCacheMediaBackfillCandidates);
const mockedGetContent = vi.mocked(getDownloadCacheMediaBackfillCandidateContent);
const mockedGetStoredMediaBytes = vi.mocked(getStoredChapterMediaBytes);
const mockedUpdateMediaBytes = vi.mocked(updateDownloadCacheChapterMediaBytes);

beforeEach(() => {
  vi.clearAllMocks();
  mockedIsTauriRuntime.mockReturnValue(true);
});

describe("download cache media backfill", () => {
  it("uses the capped candidate query and fetches content only for selected rows", async () => {
    mockedListCandidates.mockResolvedValueOnce([
      {
        chapterName: "One",
        chapterNumber: "1",
        id: 7,
        novelId: 3,
        novelName: "Novel",
        novelPath: "/novel",
        pluginId: "source",
        position: 1,
        updatedAt: 100,
      },
    ]);
    mockedGetContent.mockResolvedValueOnce(
      '<img src="norea-media://chapter/7/page.png">',
    );
    mockedGetStoredMediaBytes.mockResolvedValueOnce(12);
    mockedUpdateMediaBytes.mockResolvedValueOnce({ rowsAffected: 1 });

    const result = await backfillDownloadCacheMediaBytes(3);

    expect(mockedListCandidates).toHaveBeenCalledWith(3, MAX_BACKFILL_PER_RUN);
    expect(mockedGetContent).toHaveBeenCalledWith(7);
    expect(mockedGetStoredMediaBytes).toHaveBeenCalledWith(
      '<img src="norea-media://chapter/7/page.png">',
      expect.objectContaining({ chapterId: 7, novelId: 3 }),
    );
    expect(mockedUpdateMediaBytes).toHaveBeenCalledWith(7, 12);
    expect(result).toMatchObject({
      candidateCount: 1,
      processedChapters: 1,
      skipped: false,
      updatedChapters: 1,
    });
  });

  it("returns a skipped result outside Tauri without querying chapter content", async () => {
    mockedIsTauriRuntime.mockReturnValueOnce(false);

    const result = await backfillDownloadCacheMediaBytes();

    expect(mockedListCandidates).not.toHaveBeenCalled();
    expect(mockedGetContent).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      candidateCount: 0,
      processedChapters: 0,
      skipped: true,
      updatedChapters: 0,
    });
  });
});
