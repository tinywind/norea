import { beforeEach, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../lib/observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));

import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { HISTORY_PAGE_SIZE, listReadingHistoryPage } from "./history-search";

beforeEach(() => {
  invokeMock.mockReset();
});

it("forwards default pagination, search, progress, and readMode to db_chapter_list_reading_history_page", async () => {
  invokeMock.mockResolvedValueOnce({ entries: [], nextCursor: null });

  await expect(listReadingHistoryPage()).resolves.toEqual({
    entries: [],
    nextCursor: null,
  });
  expect(invokeMock).toHaveBeenCalledWith(
    "db_chapter_list_reading_history_page",
    {
      input: {
        cursor: null,
        limit: HISTORY_PAGE_SIZE,
        progress: "all",
        search: "",
      },
      readMode: "queued",
    },
  );
});

it("clamps oversized page limits and forwards cursor, progress filter, and committed readMode", async () => {
  const cursor = { chapterId: 31, position: 9, readAt: 500 };
  invokeMock.mockResolvedValueOnce({ entries: [], nextCursor: null });

  await listReadingHistoryPage({
    cursor,
    limit: MAX_ROUTE_QUERY_ROWS + 50,
    progress: "finished",
    readMode: "committed",
    search: " dragon ",
  });

  expect(invokeMock).toHaveBeenCalledWith(
    "db_chapter_list_reading_history_page",
    {
      input: {
        cursor,
        limit: MAX_ROUTE_QUERY_ROWS,
        progress: "finished",
        search: " dragon ",
      },
      readMode: "committed",
    },
  );
});
