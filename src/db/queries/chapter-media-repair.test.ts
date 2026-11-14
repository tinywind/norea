import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import {
  markChapterMediaRepairPending,
  saveChapterContentMetadata,
  saveChapterPartialContentMetadata,
} from "./chapter";

beforeEach(() => {
  invokeMock.mockReset();
});

it("sends partial repair flag separately from final content metadata", async () => {
  const html =
    '<img src="norea-media://reader-asset/good.png"><img src="https://cdn.example/missing.png">';
  invokeMock
    .mockResolvedValueOnce({ value: { rowsAffected: 1 }, effects: {} })
    .mockResolvedValueOnce({ value: { rowsAffected: 1 }, effects: {} });

  await saveChapterPartialContentMetadata(1, html, "html");
  expect(invokeMock).toHaveBeenNthCalledWith(
    1,
    "db_chapter_save_partial_content_metadata",
    {
      input: {
        chapterId: 1,
        contentBytes: new TextEncoder().encode(html).byteLength,
        contentType: "html",
        mediaRepairNeeded: true,
      },
    },
  );

  const repairedHtml =
    '<img src="norea-media://reader-asset/good.png"><img src="norea-media://reader-asset/fixed.png">';
  await saveChapterContentMetadata(1, repairedHtml, "html", { mediaBytes: 456 });
  expect(invokeMock).toHaveBeenNthCalledWith(
    2,
    "db_chapter_save_content_metadata",
    {
      input: {
        chapterId: 1,
        contentBytes: new TextEncoder().encode(repairedHtml).byteLength,
        contentType: "html",
        mediaBytes: 456,
        mediaRepairNeeded: false,
      },
    },
  );
});

it("marks repair pending via db_chapter_mark_media_repair_pending", async () => {
  invokeMock
    .mockResolvedValueOnce({ value: { rowsAffected: 1 }, effects: {} })
    .mockResolvedValueOnce({ value: { rowsAffected: 0 }, effects: {} });

  await expect(markChapterMediaRepairPending(1)).resolves.toEqual({
    rowsAffected: 1,
  });
  expect(invokeMock).toHaveBeenCalledWith(
    "db_chapter_mark_media_repair_pending",
    { chapterId: 1 },
  );
  await expect(markChapterMediaRepairPending(99)).resolves.toEqual({
    rowsAffected: 0,
  });
});
