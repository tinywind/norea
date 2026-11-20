import type { ChapterContentStorageIdentity } from "../../lib/chapter-content/storage-platform";
import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface ChapterCleanupSelection {
  reading: "read" | "all";
  categories: { mode: "all" } | { mode: "selected"; ids: readonly number[] };
  /**
   * Automatic removal of finished chapters: downloaded, finished (`progress >= 100`),
   * unbookmarked source chapters keeping the latest `keepLast` finished chapters by position
   * (`0` selects every finished chapter). When `requireInstalledPlugin` is true (no content
   * server configured), chapters belonging to uninstalled plugins are skipped.
   */
  finished?: { keepLast: number; requireInstalledPlugin?: boolean };
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
  /** Reading progress percentage in `[0, 100]`; chapters below `100` are unfinished. */
  progress: number;
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
      ? {
          finished: {
            keepLast: Math.max(0, Math.floor(selection.finished.keepLast)),
            ...(selection.finished.requireInstalledPlugin !== undefined
              ? { requireInstalledPlugin: selection.finished.requireInstalledPlugin }
              : {}),
          },
        }
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
