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
  markChaptersDownloaded: (chapterIds: Iterable<number>) => void;
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
  chapterIds: ReadonlySet<number>,
): LibraryUpdateEntry[] {
  let updated: LibraryUpdateEntry[] | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!chapterIds.has(row.chapterId) || row.isDownloaded) continue;
    updated ??= [...rows];
    updated[index] = { ...row, isDownloaded: true };
  }
  return updated ?? rows;
}

function markChaptersDownloadedState(
  state: UpdatesState,
  chapterIds: ReadonlySet<number>,
) {
  const updates = markRowsDownloaded(state.updates, chapterIds);
  const lastCheckUpdates = state.lastCheckResult
    ? markRowsDownloaded(state.lastCheckResult.updates, chapterIds)
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
    set((state) => markChaptersDownloadedState(state, new Set([chapterId]))),
  markChaptersDownloaded: (chapterIds) =>
    set((state) =>
      markChaptersDownloadedState(state, new Set(chapterIds)),
    ),
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
