import {
  clearChapterDownloadFailures,
  listChapterDownloadFailures,
  recordChapterDownloadFailure,
  type StoredChapterDownloadFailure,
} from "../../db/queries/chapter-download-failure";
import type { ChapterDownloadJob } from "./chapter-download";
import { automaticRetryDelayMs, classifyDownloadFailure } from "./download-failure";

let snapshot: readonly StoredChapterDownloadFailure[] = [];
let loaded = false;
let refreshing: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(rows: readonly StoredChapterDownloadFailure[]): void {
  snapshot = rows;
  loaded = true;
  for (const listener of listeners) listener();
}

/** The persisted failures last read from the database, for Needs attention and row status. */
export function getChapterDownloadFailureSnapshot(): readonly StoredChapterDownloadFailure[] {
  return snapshot;
}

export function subscribeChapterDownloadFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Rereads persisted failures; overlapping calls are serialized so the newest read wins. */
export function refreshChapterDownloadFailures(): Promise<void> {
  refreshing = refreshing.catch(() => undefined).then(async () => publish(await listChapterDownloadFailures()));
  return refreshing;
}

/** Records one failed attempt and returns its stored row without scheduling another attempt. */
export async function recordFailedChapterDownloadAttempt(
  job: ChapterDownloadJob,
  error: unknown,
  now = Date.now(),
): Promise<StoredChapterDownloadFailure | null> {
  const failure = classifyDownloadFailure(error);
  const { retryAt: _retryAt, ...storedJob } = job;
  const stored = await recordChapterDownloadFailure({
    chapterId: job.id,
    pluginId: job.pluginId,
    failureClass: failure.failureClass,
    messageSummary: failure.summary,
    ...(failure.challengeUrl ? { challengeUrl: failure.challengeUrl } : {}),
    jobJson: JSON.stringify(storedJob),
    now,
    retryDelayMs: (attempts) => automaticRetryDelayMs(failure, attempts),
  });
  void refreshChapterDownloadFailures().catch((refreshError: unknown) => {
    console.warn("[chapter-download] failed to read download failures:", refreshError);
  });
  return stored;
}

/** Clears failures after a success, an explicit cancel or a manual retry. */
export async function forgetChapterDownloadFailures(chapterIds: readonly number[]): Promise<void> {
  if (loaded && !snapshot.some((row) => chapterIds.includes(row.chapterId))) return;
  if (await clearChapterDownloadFailures(chapterIds) > 0 || !loaded) await refreshChapterDownloadFailures();
}
