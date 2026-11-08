import type { QueryClient } from "@tanstack/react-query";
import { hasStoredChapterContent, listLibraryDownloadChapters, listUnqueuedChapterDownloads, type ChapterListRow, type LibraryDownloadChapter } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import type { TranslationKey } from "../../i18n";
import { isChapterDownloadQueued, type ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import { submitChapterDownloadRequest } from "../../lib/tasks/chapter-download-requests";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";
import { goalReadingChapterId } from "../../lib/download-goals/goal-targets";
import { readServerNovelSource } from "../../lib/content-sync/novel-source";
import { useReaderStore } from "../../store/reader";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type DownloadOnceSelection = { kind: "next"; count: number } | { kind: "remaining" } | { kind: "all" };

/** Selects the requested reading-order range before excluding stored or already queued chapters. */
export function selectDownloadChaptersOnce(
  chapters: readonly LibraryDownloadChapter[],
  selection: DownloadOnceSelection,
  rememberedChapterId: number | undefined,
): LibraryDownloadChapter[] {
  const current = goalReadingChapterId(chapters, rememberedChapterId);
  const currentIndex = current === undefined ? -1 : chapters.findIndex(chapter => chapter.id === current);
  const after = chapters.slice(currentIndex + 1);
  const targets = selection.kind === "all" ? chapters
    : selection.kind === "remaining" ? after : after.slice(0, Math.max(0, Math.floor(selection.count)));
  return targets.filter(chapter => !hasStoredChapterContent(chapter) && !chapter.isDownloadQueued && !isChapterDownloadQueued(chapter.id));
}

export interface DownloadOnceOutcome {
  queued: number;
  skippedLocal: number;
}

/**
 * Queues the chosen range of each source novel once, skipping stored and queued
 * chapters, one request per novel at user priority. Missing novels and local-only
 * novels without a remembered content server are left alone; local-only ones are counted as skipped.
 */
export async function queueChapterDownloadsOnce(
  novelIds: readonly number[],
  t: Translate,
  queryClient: QueryClient,
  selection: DownloadOnceSelection = { kind: "all" },
): Promise<DownloadOnceOutcome> {
  let queued = 0;
  let skippedLocal = 0;
  for (const novelId of new Set(novelIds)) {
    const novel = await getNovelById(novelId);
    if (!novel) continue;
    if (novel.isLocal && !await readServerNovelSource(novel.id)) {
      skippedLocal += 1;
      continue;
    }
    // The paged source query excludes local rows, including works restored from a content server.
    const chapters = selection.kind === "all" && !novel.isLocal
      ? (await listChaptersToDownloadOnce(novel.id)).filter(chapter => !isChapterDownloadQueued(chapter.id))
      : selectDownloadChaptersOnce(await listLibraryDownloadChapters(novel.id), selection,
          useReaderStore.getState().lastReadChapterByNovel[novel.id]);
    if (chapters.length === 0) continue;
    const jobs: ChapterDownloadJob[] = chapters.map((chapter) => ({
      id: chapter.id,
      pluginId: novel.pluginId,
      chapterPath: chapter.path,
      chapterName: chapter.name,
      chapterNumber: chapter.chapterNumber ?? undefined,
      contentType: chapter.contentType,
      novelId: novel.id,
      novelName: novel.name,
      novelPath: novel.path,
      priority: "user",
      title: t("tasks.task.downloadChapter", { name: chapter.name }),
    }));
    const title = t("tasks.task.downloadChapterBatch", { count: jobs.length });
    const request = submitChapterDownloadRequest({
      key: JSON.stringify(["download-once", novel.id, jobs.map((job) => job.id)]),
      title,
      novelIds: [novel.id],
      total: jobs.length,
      prepare: async () => ({ jobs, materializeAllTasks: true, title, total: jobs.length }),
    });
    void request.promise.finally(() => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["novel", "library"] }),
      queryClient.invalidateQueries({ queryKey: ["novel", "detail", novel.id, "chapters"], exact: true }),
    ])).catch(() => undefined);
    await request.materialized;
    queued += jobs.length;
  }
  return { queued, skippedLocal };
}

export function downloadOnceNotice(t: Translate, { queued, skippedLocal }: DownloadOnceOutcome): { color: "ok" | "warn"; message: string } {
  if (queued === 0) {
    return {
      color: "warn",
      message: skippedLocal > 0
        ? t("library.downloadOnce.nothingSkippedLocal", { skipped: skippedLocal })
        : t("library.downloadOnce.nothing"),
    };
  }
  return {
    color: "ok",
    message: skippedLocal > 0
      ? t("library.downloadOnce.doneSkippedLocal", { count: queued, skipped: skippedLocal })
      : t("library.downloadOnce.done", { count: queued }),
  };
}

/** Every chapter of a source novel with no stored body and no persisted download, in reading order. */
async function listChaptersToDownloadOnce(novelId: number): Promise<ChapterListRow[]> {
  const chapters: ChapterListRow[] = [];
  for (let afterChapterId = 0; ;) {
    const page = await listUnqueuedChapterDownloads(novelId, afterChapterId);
    chapters.push(...page);
    if (page.length < MAX_ROUTE_QUERY_ROWS) break;
    afterChapterId = page.at(-1)!.id;
  }
  return chapters.sort((left, right) => left.position - right.position || left.id - right.id);
}
