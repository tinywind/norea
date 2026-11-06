import type { QueryClient } from "@tanstack/react-query";
import { listUnqueuedChapterDownloads, type ChapterListRow } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import type { TranslationKey } from "../../i18n";
import { isChapterDownloadQueued, type ChapterDownloadJob } from "../../lib/tasks/chapter-download";
import { submitChapterDownloadRequest } from "../../lib/tasks/chapter-download-requests";
import { MAX_ROUTE_QUERY_ROWS } from "../../lib/performance-budgets";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export interface DownloadOnceOutcome {
  queued: number;
  skippedLocal: number;
}

/**
 * Queues every chapter of each source novel that has no stored body and is not
 * queued yet, one request per novel at user priority. Local and missing
 * novels are left alone; local ones are counted as skipped.
 */
export async function queueChapterDownloadsOnce(
  novelIds: readonly number[],
  t: Translate,
  queryClient: QueryClient,
): Promise<DownloadOnceOutcome> {
  let queued = 0;
  let skippedLocal = 0;
  for (const novelId of novelIds) {
    const novel = await getNovelById(novelId);
    if (!novel) continue;
    if (novel.isLocal) {
      skippedLocal += 1;
      continue;
    }
    const chapters = (await listChaptersToDownloadOnce(novel.id))
      .filter((chapter) => !isChapterDownloadQueued(chapter.id));
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
    void request.promise.finally(() => queryClient.invalidateQueries({ queryKey: ["novel", "library"] }))
      .catch(() => undefined);
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
