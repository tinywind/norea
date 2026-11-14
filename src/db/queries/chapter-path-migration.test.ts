import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import { upsertSourceChapters } from "./chapter";

beforeEach(() => {
  invokeMock.mockReset();
});

it("passes normalized chapter identity fields for path migration to db_chapter_upsert_source", async () => {
  invokeMock.mockResolvedValueOnce({
    value: { rowsAffected: 2, chunks: 1 },
    effects: {},
  });

  await expect(
    upsertSourceChapters([
      {
        novelId: 1,
        path: "/a/1-new",
        name: "One",
        position: 1,
        chapterNumber: "1",
      },
      {
        novelId: 1,
        path: "/a/2",
        name: "Two",
        position: 2,
        chapterNumber: "2",
      },
    ]),
  ).resolves.toEqual({ rowsAffected: 2, chunks: 1 });

  expect(invokeMock).toHaveBeenCalledWith("db_chapter_upsert_source", {
    inputs: [
      {
        novelId: 1,
        path: "/a/1-new",
        name: "One",
        position: 1,
        chapterNumber: "1",
        page: "1",
        releaseTime: null,
        contentType: "html",
      },
      {
        novelId: 1,
        path: "/a/2",
        name: "Two",
        position: 2,
        chapterNumber: "2",
        page: "1",
        releaseTime: null,
        contentType: "html",
      },
    ],
  });
});
