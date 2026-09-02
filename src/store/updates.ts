import { create } from "zustand";
import type {
  LibraryUpdateEntry,
  LibraryUpdatesCursor,
  LibraryUpdatesPage,
} from "../db/queries/chapter";
import type { UpdateCheckResult } from "../lib/updates/check-library-updates";

interface UpdatesState {
  hasLoaded: boolean;
  hasMoreUpdates: boolean;
  lastCheckResult: UpdateCheckResult | null;
  nextUpdateCursor: LibraryUpdatesCursor | null;
  updates: LibraryUpdateEntry[];
  appendPage: (page: LibraryUpdatesPage) => void;
  applyCheckResult: (result: UpdateCheckResult) => void;
  markChapterDownloaded: (chapterId: number) => void;
  mergeFirstPage: (page: LibraryUpdatesPage) => void;
  replaceWindow: (page: LibraryUpdatesPage) => void;
}

function mergeRows(
  priorityRows: readonly LibraryUpdateEntry[],
  existingRows: readonly LibraryUpdateEntry[],
): LibraryUpdateEntry[] {
  const seen = new Set<number>();
  const merged: LibraryUpdateEntry[] = [];

  for (const row of [...priorityRows, ...existingRows]) {
    if (seen.has(row.chapterId)) continue;
    seen.add(row.chapterId);
    merged.push(row);
  }

  return merged;
}

function appendRows(
  existingRows: readonly LibraryUpdateEntry[],
  nextRows: readonly LibraryUpdateEntry[],
): LibraryUpdateEntry[] {
  const seen = new Set(existingRows.map((row) => row.chapterId));
  const appended = nextRows.filter((row) => !seen.has(row.chapterId));
  return [...existingRows, ...appended];
}

function markRowsDownloaded(
  rows: LibraryUpdateEntry[],
  chapterId: number,
): LibraryUpdateEntry[] {
  const index = rows.findIndex((row) => row.chapterId === chapterId);
  if (index < 0 || rows[index]?.isDownloaded) return rows;

  const updated = [...rows];
  updated[index] = { ...updated[index]!, isDownloaded: true };
  return updated;
}

function getNextCursor(
  rows: readonly LibraryUpdateEntry[],
  hasMore: boolean,
): LibraryUpdatesCursor | null {
  if (!hasMore) return null;
  const last = rows.at(-1);
  if (!last) return null;
  return {
    chapterId: last.chapterId,
    foundAt: last.foundAt,
    position: last.position,
  };
}

export const useUpdatesStore = create<UpdatesState>((set) => ({
  hasLoaded: false,
  hasMoreUpdates: false,
  lastCheckResult: null,
  nextUpdateCursor: null,
  updates: [],
  appendPage: (page) =>
    set((state) => {
      const updates = appendRows(state.updates, page.updates);
      return {
        hasLoaded: true,
        hasMoreUpdates: page.hasMore,
        nextUpdateCursor: getNextCursor(updates, page.hasMore),
        updates,
      };
    }),
  applyCheckResult: (result) =>
    set({
      hasLoaded: true,
      hasMoreUpdates: result.hasMoreUpdates,
      lastCheckResult: result,
      nextUpdateCursor: result.nextUpdateCursor,
      updates: result.updates,
    }),
  markChapterDownloaded: (chapterId) =>
    set((state) => {
      const updates = markRowsDownloaded(state.updates, chapterId);
      const lastCheckUpdates = state.lastCheckResult
        ? markRowsDownloaded(state.lastCheckResult.updates, chapterId)
        : null;
      if (
        updates === state.updates &&
        (!state.lastCheckResult ||
          lastCheckUpdates === state.lastCheckResult.updates)
      ) {
        return state;
      }
      return {
        lastCheckResult: state.lastCheckResult
          ? { ...state.lastCheckResult, updates: lastCheckUpdates! }
          : null,
        updates,
      };
    }),
  mergeFirstPage: (page) =>
    set((state) => {
      const hasMoreUpdates = page.hasMore || state.hasMoreUpdates;
      const updates = mergeRows(page.updates, state.updates);
      return {
        hasLoaded: true,
        hasMoreUpdates,
        nextUpdateCursor: getNextCursor(updates, hasMoreUpdates),
        updates,
      };
    }),
  replaceWindow: (page) =>
    set({
      hasLoaded: true,
      hasMoreUpdates: page.hasMore,
      nextUpdateCursor: page.nextCursor,
      updates: page.updates,
    }),
}));
