import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  CONTINUE_READING_LIMIT,
  getContinueReadingTarget,
  listContinueReading,
  type ContinueReadingEntry,
} from "./continue-reading";

beforeEach(() => {
  invokeMock.mockReset();
});

it("clamps continue-reading limit to [1, CONTINUE_READING_LIMIT] and invokes db_chapter_list_continue_reading", async () => {
  invokeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

  await listContinueReading(50);
  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_chapter_list_continue_reading",
    { limit: CONTINUE_READING_LIMIT },
  );

  await listContinueReading(0);
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_chapter_list_continue_reading",
    { limit: 1 },
  );
});

it("resumes an unfinished chapter and opens the next chapter of a finished one", () => {
  const base: ContinueReadingEntry = {
    chapterId: 11,
    chapterName: "One",
    chapterNumber: "1",
    nextChapterId: 12,
    nextChapterName: "Two",
    nextChapterNumber: "2",
    nextChapterPosition: 3,
    novelCover: null,
    novelId: 1,
    novelIsLocal: false,
    novelName: "N",
    novelPath: "/1",
    pluginId: "s",
    novelSourceNovelId: "1",
    position: 2,
    progress: 40,
    readAt: 1,
  };

  expect(getContinueReadingTarget(base)).toEqual({
    chapterId: 11,
    chapterName: "One",
    chapterNumber: "1",
    next: false,
    position: 2,
  });
  expect(getContinueReadingTarget({ ...base, progress: 100 })).toEqual({
    chapterId: 12,
    chapterName: "Two",
    chapterNumber: "2",
    next: true,
    position: 3,
  });
  expect(
    getContinueReadingTarget({ ...base, nextChapterId: null, progress: 100 }),
  ).toEqual({
    chapterId: 11,
    chapterName: "One",
    chapterNumber: "1",
    next: false,
    position: 2,
  });
});
