import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChapterById, type ChapterRow } from "../db/queries/chapter";
import { readStoredChapterContentMirror } from "./chapter-content-storage";
import {
  getNextChapterPreparationPlan,
  readerChapterQueryOptions,
} from "./reader-chapter";
import { chapterDetailQueryKey } from "./reader-query-invalidation";

vi.mock("../db/queries/chapter", () => ({ getChapterById: vi.fn() }));
vi.mock("./chapter-content-storage", () => ({
  readStoredChapterContentMirror: vi.fn(),
}));

const chapter: ChapterRow = {
  id: 2,
  novelId: 1,
  path: "/chapter/2",
  name: "Chapter 2",
  chapterNumber: "2",
  position: 2,
  page: "1",
  bookmark: false,
  unread: true,
  progress: 0,
  isDownloaded: true,
  sourceContentType: "html",
  contentType: "html",
  contentBytes: 20,
  mediaBytes: 0,
  mediaRepairNeeded: false,
  releaseTime: null,
  readAt: null,
  createdAt: null,
  foundAt: 1,
  updatedAt: 1,
};

let queryClient: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  vi.mocked(getChapterById).mockResolvedValue(chapter);
  vi.mocked(readStoredChapterContentMirror).mockResolvedValue("<p>Next</p>");
});

afterEach(() => queryClient.clear());

describe("reader chapter preloading", () => {
  it("reuses the prefetched local chapter when it becomes current", async () => {
    await queryClient.prefetchQuery(readerChapterQueryOptions(chapter.id));
    const result = await queryClient.fetchQuery(readerChapterQueryOptions(chapter.id));

    expect(result).toEqual({ ...chapter, content: "<p>Next</p>" });
    expect(readStoredChapterContentMirror).toHaveBeenCalledExactlyOnceWith(chapter.id);
    expect(getChapterById).toHaveBeenCalledTimes(2);
    expect(result?.progress).toBe(0);
    expect(result?.unread).toBe(true);
  });

  it("reloads content and reconciled metadata after invalidation", async () => {
    await queryClient.prefetchQuery(readerChapterQueryOptions(chapter.id));
    await queryClient.invalidateQueries({
      exact: true,
      queryKey: chapterDetailQueryKey(chapter.id),
    });
    vi.mocked(readStoredChapterContentMirror).mockResolvedValue("<p>Repaired</p>");
    vi.mocked(getChapterById)
      .mockResolvedValueOnce(chapter)
      .mockResolvedValueOnce({ ...chapter, contentBytes: 30 });

    const result = await queryClient.fetchQuery(readerChapterQueryOptions(chapter.id));

    expect(result?.content).toBe("<p>Repaired</p>");
    expect(result?.contentBytes).toBe(30);
    expect(readStoredChapterContentMirror).toHaveBeenCalledTimes(2);
  });

  it("returns a missing chapter without reading storage", async () => {
    vi.mocked(getChapterById).mockResolvedValue(null);

    await expect(
      queryClient.fetchQuery(readerChapterQueryOptions(chapter.id)),
    ).resolves.toBeNull();
    expect(readStoredChapterContentMirror).not.toHaveBeenCalled();
  });
});

describe("next chapter preparation planning", () => {
  it("prepares a stored next chapter without downloading it", () => {
    expect(
      getNextChapterPreparationPlan({
        currentChapterReady: true,
        nextChapter: { id: 3, isDownloaded: true },
        autoDownloadNextChapter: false,
      }),
    ).toEqual({ chapterId: 3, download: false });
  });

  it("downloads and then prepares an unstored next chapter when enabled", () => {
    expect(
      getNextChapterPreparationPlan({
        currentChapterReady: true,
        nextChapter: { id: 3, isDownloaded: false },
        autoDownloadNextChapter: true,
      }),
    ).toEqual({ chapterId: 3, download: true });
  });

  it("does not download an unstored next chapter when disabled", () => {
    expect(
      getNextChapterPreparationPlan({
        currentChapterReady: true,
        nextChapter: { id: 3, isDownloaded: false },
        autoDownloadNextChapter: false,
      }),
    ).toBeNull();
  });

  it("waits until the current chapter is ready", () => {
    expect(
      getNextChapterPreparationPlan({
        currentChapterReady: false,
        nextChapter: { id: 3, isDownloaded: true },
        autoDownloadNextChapter: true,
      }),
    ).toBeNull();
  });
});
