import { chapterDownloadFailureTable } from "../schema";
import { getDb, runDatabaseTransaction } from "../client";

export type StoredChapterDownloadFailure = typeof chapterDownloadFailureTable.$inferSelect;

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

const columns = `chapter_id AS chapterId,plugin_id AS pluginId,failure_class AS failureClass,
  message_summary AS messageSummary,challenge_url AS challengeUrl,attempts,next_retry_at AS nextRetryAt,
  job_json AS jobJson,updated_at AS updatedAt`;

/**
 * Records one more failed attempt for a chapter and schedules its next automatic
 * attempt from the persisted count, so a restart cannot reset the budget.
 * Returns null when the chapter row no longer exists.
 */
export async function recordChapterDownloadFailure(
  input: ChapterDownloadFailureInput,
): Promise<StoredChapterDownloadFailure | null> {
  return runDatabaseTransaction(async (db) => {
    const [previous] = await db.select<{ attempts: number }[]>(
      "SELECT attempts FROM chapter_download_failure WHERE chapter_id=$1", [input.chapterId]);
    const attempts = (previous?.attempts ?? 0) + 1;
    const delay = input.retryDelayMs(attempts);
    const nextRetryAt = delay === null ? null : input.now + delay;
    const result = await db.execute(`INSERT INTO chapter_download_failure
      (chapter_id,plugin_id,failure_class,message_summary,challenge_url,attempts,next_retry_at,job_json,updated_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE EXISTS(SELECT 1 FROM chapter WHERE id=$1)
      ON CONFLICT(chapter_id) DO UPDATE SET plugin_id=excluded.plugin_id,failure_class=excluded.failure_class,
        message_summary=excluded.message_summary,challenge_url=excluded.challenge_url,attempts=excluded.attempts,
        next_retry_at=excluded.next_retry_at,job_json=excluded.job_json,updated_at=excluded.updated_at`,
    [input.chapterId, input.pluginId, input.failureClass, input.messageSummary, input.challengeUrl ?? null,
      attempts, nextRetryAt, input.jobJson, input.now]);
    if (result.rowsAffected !== 1) return null;
    return {
      chapterId: input.chapterId, pluginId: input.pluginId, failureClass: input.failureClass,
      messageSummary: input.messageSummary, challengeUrl: input.challengeUrl ?? null, attempts, nextRetryAt,
      jobJson: input.jobJson, updatedAt: input.now,
    };
  });
}

/** Returns how many failure rows were removed. */
export async function clearChapterDownloadFailures(chapterIds: readonly number[]): Promise<number> {
  const ids = [...new Set(chapterIds)].filter(Number.isSafeInteger);
  if (ids.length === 0) return 0;
  const db = await getDb();
  let removed = 0;
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500);
    const result = await db.execute(
      `DELETE FROM chapter_download_failure WHERE chapter_id IN (${chunk.map((_, offset) => `$${offset + 1}`).join(",")})`,
      chunk);
    removed += result.rowsAffected;
  }
  return removed;
}

export async function getChapterDownloadFailure(chapterId: number): Promise<StoredChapterDownloadFailure | undefined> {
  const db = await getDb();
  const [row] = await db.select<StoredChapterDownloadFailure[]>(
    `SELECT ${columns} FROM chapter_download_failure WHERE chapter_id=$1`, [chapterId]);
  return row;
}

/** Removes deadlines left by an earlier automatic retry policy without deleting failures. */
export async function clearScheduledChapterDownloadRetries(): Promise<number> {
  const db = await getDb();
  const result = await db.execute("UPDATE chapter_download_failure SET next_retry_at=NULL WHERE next_retry_at IS NOT NULL");
  return result.rowsAffected;
}

export async function listChapterDownloadFailures(): Promise<StoredChapterDownloadFailure[]> {
  const db = await getDb();
  return db.select<StoredChapterDownloadFailure[]>(
    `SELECT ${columns} FROM chapter_download_failure ORDER BY plugin_id,failure_class,updated_at,chapter_id`);
}
