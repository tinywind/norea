import type { ChapterContentStorageIdentity } from "../../lib/chapter-content/storage-platform";
import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface ChapterCleanupSelection {
  reading: "read" | "all";
  categories: { mode: "all" } | { mode: "selected"; ids: readonly number[] };
  /**
   * Automatic removal of finished chapters: only downloaded, finished, unbookmarked source
   * chapters of an installed source, behind the most recently opened chapter with at least
   * `keepLast` finished chapters between them and it, in novels no "entire novel" goal keeps.
   */
  finished?: { keepLast: number };
}

export interface ChapterCleanupCandidate {
  identity: ChapterContentStorageIdentity;
  novelPath: string;
  chapterPath: string;
  novelName: string;
  chapterName: string;
  serverSource: string | null;
  storageAmbiguous: boolean;
  localServerFingerprint: string | null;
  /** The chapter is not finished; a cleanup removes it only when the user includes unread chapters. */
  unread: boolean;
}

export async function reconcileCleanedChapter(
  candidate: ChapterCleanupCandidate,
  snapshot: { contentBytes: number; mediaBytes: number; mediaComplete: boolean },
): Promise<number> {
  return invokeDbMutation<number>("db_chapter_reconcile_cleaned", {
    input: { candidate, snapshot },
  });
}

export async function listChapterCleanupCandidates(
  selection: ChapterCleanupSelection,
  options: {
    afterId?: number;
    limit?: number;
    chapterId?: number;
    readMode?: DatabaseReadMode;
  } = {},
): Promise<ChapterCleanupCandidate[]> {
  if (selection.categories.mode === "selected") {
    const validIds = selection.categories.ids.filter(Number.isInteger);
    if (validIds.length === 0) return [];
  }
  const normalizedSelection = {
    reading: selection.reading,
    categories:
      selection.categories.mode === "selected"
        ? {
            mode: "selected" as const,
            ids: [...new Set(selection.categories.ids.filter(Number.isInteger))],
          }
        : { mode: "all" as const },
    ...(selection.finished
      ? { finished: { keepLast: Math.max(1, Math.floor(selection.finished.keepLast)) } }
      : {}),
  };
  return invokeDbQuery<ChapterCleanupCandidate[]>(
    "db_chapter_list_cleanup_candidates",
    {
      input: {
        selection: normalizedSelection,
        ...(options.afterId !== undefined ? { afterId: options.afterId } : {}),
        limit: Math.max(1, Math.min(100, options.limit ?? 100)),
        ...(options.chapterId !== undefined ? { chapterId: options.chapterId } : {}),
      },
      readMode: options.readMode ?? "committed",
    },
  );
}
