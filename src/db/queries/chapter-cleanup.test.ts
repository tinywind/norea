import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  listChapterCleanupCandidates,
  reconcileCleanedChapter,
  type ChapterCleanupCandidate,
} from "./chapter-cleanup";

beforeEach(() => {
  invokeMock.mockReset();
});

it("deduplicates selected categories, clamps limits, and defaults to committed readMode", async () => {
  invokeMock.mockResolvedValueOnce([]);

  await listChapterCleanupCandidates(
    {
      reading: "read",
      categories: { mode: "selected", ids: [10, 11, 10] },
      finished: { keepLast: 0 },
    },
    { afterId: 2, limit: 500 },
  );

  expect(invokeMock).toHaveBeenCalledWith(
    "db_chapter_list_cleanup_candidates",
    {
      input: {
        selection: {
          reading: "read",
          categories: { mode: "selected", ids: [10, 11] },
          finished: { keepLast: 1 },
        },
        afterId: 2,
        limit: 100,
      },
      readMode: "committed",
    },
  );
});

it("short-circuits an empty selected category list without invoking IPC", async () => {
  await expect(
    listChapterCleanupCandidates({
      reading: "all",
      categories: { mode: "selected", ids: [] },
    }),
  ).resolves.toEqual([]);
  expect(invokeMock).not.toHaveBeenCalled();
});

it("forwards queued per-ID rechecks and reconcileCleanedChapter mutations", async () => {
  const candidate: ChapterCleanupCandidate = {
    identity: {
      novel: {
        id: 1,
        pluginId: "test",
        sourceNovelId: "one",
        path: "/one",
        name: "One",
      },
      chapter: {
        id: 1,
        name: "Read partial",
        position: 1,
        chapterNumber: "1",
        contentType: "html",
      },
    },
    novelPath: "/one",
    chapterPath: "/1",
    novelName: "One",
    chapterName: "Read partial",
    serverSource: null,
    storageAmbiguous: false,
    localServerFingerprint: null,
    unread: false,
  };
  invokeMock
    .mockResolvedValueOnce([candidate])
    .mockResolvedValueOnce({ value: 1, effects: {} });

  await expect(
    listChapterCleanupCandidates(
      { reading: "read", categories: { mode: "all" } },
      { chapterId: 1, readMode: "queued" },
    ),
  ).resolves.toEqual([candidate]);
  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_chapter_list_cleanup_candidates",
    {
      input: {
        selection: { reading: "read", categories: { mode: "all" } },
        limit: 100,
        chapterId: 1,
      },
      readMode: "queued",
    },
  );

  await expect(
    reconcileCleanedChapter(candidate, {
      contentBytes: 0,
      mediaBytes: 7,
      mediaComplete: false,
    }),
  ).resolves.toBe(1);
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_chapter_reconcile_cleaned",
    {
      input: {
        candidate,
        snapshot: { contentBytes: 0, mediaBytes: 7, mediaComplete: false },
      },
    },
  );
});
