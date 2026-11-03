import { useContentSyncStore } from "../../store/content-sync";
import type { ChapterDownloadJob } from "../tasks/chapter-download";
import { fetchServerChapters } from "./chapters";
import { withContentServerLookup } from "./client";
import { registerContentDevice } from "./device";
import { readServerNovelSource } from "./novel-source";
import { contentWorkId } from "./works";

/** A whole work's chapter listing pages 100 at a time, so it gets more time than one chapter lookup. */
const SERVER_LANE_LISTING_TIMEOUT_SECONDS = 30;

const chapterNumberKey = (value: string | null | undefined): number | null =>
  value != null && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;

/**
 * Marks the jobs whose chapter the user's content server lists as complete, so they
 * run on the server lane first. The listing is app-owned traffic to the user's server.
 * Any listing failure leaves the jobs unchanged, which keeps today's per-chapter lookup.
 */
export async function planServerLaneJobs(
  novel: { id: number; pluginId: string; path: string },
  jobs: readonly ChapterDownloadJob[],
  signal: AbortSignal,
): Promise<ChapterDownloadJob[]> {
  const settings = useContentSyncStore.getState();
  let complete: { paths: Set<string>; numbers: Set<number> };
  try {
    const stored = await readServerNovelSource(novel.id);
    const serverUrl = stored?.serverUrl ?? settings.serverUrl;
    if (!serverUrl || jobs.length === 0) return [...jobs];
    const workId = stored?.workId ?? await contentWorkId({ pluginId: novel.pluginId, novelPath: novel.path });
    const chapters = await withContentServerLookup(async (deadline) => {
      const token = await registerContentDevice(serverUrl, settings.deviceName, deadline);
      return fetchServerChapters({ serverUrl, workId }, token, deadline);
    }, SERVER_LANE_LISTING_TIMEOUT_SECONDS, signal);
    const counts = new Map<number, number>();
    for (const chapter of chapters) {
      const number = chapterNumberKey(chapter.chapterNumber);
      if (number !== null) counts.set(number, (counts.get(number) ?? 0) + 1);
    }
    complete = {
      paths: new Set(chapters.filter((chapter) => chapter.complete).map((chapter) => chapter.chapterPath)),
      // An ambiguous chapter number cannot identify a copy, so only unique numbers count.
      numbers: new Set(chapters.flatMap((chapter) => {
        const number = chapterNumberKey(chapter.chapterNumber);
        return chapter.complete && number !== null && counts.get(number) === 1 ? [number] : [];
      })),
    };
  } catch (error) {
    signal.throwIfAborted();
    console.warn("[content-sync] could not list server chapters for the server lane:", error);
    return [...jobs];
  }
  return jobs.map((job) => {
    const number = chapterNumberKey(job.chapterNumber);
    return complete.paths.has(job.chapterPath) || (number !== null && complete.numbers.has(number))
      ? { ...job, serverLane: true }
      : job;
  });
}
