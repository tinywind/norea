import { clampRouteQueryLimit } from "../../lib/performance-budgets";
import type { DatabaseReadMode } from "../client";
import { invokeDbQuery } from "../ipc";
import type { RecentlyReadEntry } from "./chapter";

export const HISTORY_PAGE_SIZE = 50;

export type HistoryProgressFilter = "all" | "inProgress" | "finished";

export interface HistoryCursor {
  chapterId: number;
  position: number;
  readAt: number;
}

export interface HistoryPage {
  entries: RecentlyReadEntry[];
  nextCursor: HistoryCursor | null;
}

/**
 * One page of reading history: the latest read chapter of every novel,
 * newest first. A search matches the novel name, that chapter's name or its
 * number anywhere in the history, not only among recent entries.
 */
export async function listReadingHistoryPage({
  cursor = null,
  limit = HISTORY_PAGE_SIZE,
  progress = "all",
  readMode = "queued",
  search = "",
}: {
  cursor?: HistoryCursor | null;
  limit?: number;
  progress?: HistoryProgressFilter;
  readMode?: DatabaseReadMode;
  search?: string;
} = {}): Promise<HistoryPage> {
  const pageSize = clampRouteQueryLimit(limit, HISTORY_PAGE_SIZE);
  return invokeDbQuery<HistoryPage>("db_chapter_list_reading_history_page", {
    input: {
      cursor,
      limit: pageSize,
      progress,
      search,
    },
    readMode,
  });
}
