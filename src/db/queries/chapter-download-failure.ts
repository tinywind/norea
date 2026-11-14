import { chapterDownloadFailureTable } from "../schema";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export type StoredChapterDownloadFailure =
  typeof chapterDownloadFailureTable.$inferSelect;

export interface ChapterDownloadFailureInput {
  chapterId: number;
  pluginId: string;
  failureClass: StoredChapterDownloadFailure["failureClass"];
  messageSummary: string;
  challengeUrl?: string;
  jobJson: string;
  now: number;
  /** Returns the wait before the next automatic attempt after `attempts` recorded failures, or null. */
  retryDelayMs: (attempts: number) => number | null;
}

const PRECOMPUTED_RETRY_BUDGET = 32;

/**
 * Records one more failed attempt for a chapter and schedules its next automatic
 * attempt from the persisted count, so a restart cannot reset the budget.
 * Returns null when the chapter row no longer exists.
 */
export async function recordChapterDownloadFailure(
  input: ChapterDownloadFailureInput,
): Promise<StoredChapterDownloadFailure | null> {
  const retryDelaysMs = Array.from(
    { length: PRECOMPUTED_RETRY_BUDGET },
    (_, index) => input.retryDelayMs(index + 1),
  );
  const fallbackRetryDelayMs = input.retryDelayMs(PRECOMPUTED_RETRY_BUDGET + 1);
  return invokeDbMutation<StoredChapterDownloadFailure | null>(
    "db_download_failure_record",
    {
      input: {
        chapterId: input.chapterId,
        pluginId: input.pluginId,
        failureClass: input.failureClass,
        messageSummary: input.messageSummary,
        challengeUrl: input.challengeUrl ?? null,
        jobJson: input.jobJson,
        now: input.now,
        retryDelaysMs,
        fallbackRetryDelayMs,
      },
    },
  );
}

/** Returns how many failure rows were removed. */
export async function clearChapterDownloadFailures(
  chapterIds: readonly number[],
): Promise<number> {
  const ids = [...new Set(chapterIds)].filter(Number.isSafeInteger);
  if (ids.length === 0) return 0;
  return invokeDbMutation<number>("db_download_failure_clear", {
    chapterIds: ids,
  });
}

export async function getChapterDownloadFailure(
  chapterId: number,
): Promise<StoredChapterDownloadFailure | undefined> {
  const row = await invokeDbQuery<StoredChapterDownloadFailure | null>(
    "db_download_failure_get",
    { chapterId },
  );
  return row ?? undefined;
}

/** Removes deadlines left by an earlier automatic retry policy without deleting failures. */
export async function clearScheduledChapterDownloadRetries(): Promise<number> {
  return invokeDbMutation<number>(
    "db_download_failure_clear_scheduled_retries",
  );
}

export async function listChapterDownloadFailures(): Promise<
  StoredChapterDownloadFailure[]
> {
  return invokeDbQuery<StoredChapterDownloadFailure[]>(
    "db_download_failure_list",
  );
}
