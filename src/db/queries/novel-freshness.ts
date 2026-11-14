import type { DatabaseReadMode } from "../client";
import { invokeDbMutation, invokeDbQuery } from "../ipc";

export interface NovelFreshness {
  novelId: number;
  /** Unix seconds of the last check for new chapters, successful or not. */
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastNewChapterAt: number | null;
  coverFetchedAt: number | null;
}

export async function getNovelFreshness(
  novelId: number,
  readMode: DatabaseReadMode = "queued",
): Promise<NovelFreshness | null> {
  return invokeDbQuery<NovelFreshness | null>("db_novel_freshness_get", {
    novelId,
    mode: readMode,
  });
}

/**
 * Records a finished check for new chapters: a success resets the failure count and notes
 * when chapters were found; a failure counts toward the check backoff. Missing novels are skipped.
 */
export async function recordNovelCheck(
  novelId: number,
  outcome: { ok: true; newChapters: number } | { ok: false },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  await invokeDbMutation("db_novel_freshness_record_check", {
    novelId,
    ok: outcome.ok,
    newChapters: outcome.ok ? outcome.newChapters : 0,
    nowSeconds,
  });
}

/** Notes when the novel's cover was last fetched, or the baseline for a cover stored before tracking. */
export async function recordNovelCoverFetched(
  novelId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  await invokeDbMutation("db_novel_freshness_record_cover_fetched", {
    novelId,
    nowSeconds,
  });
}

/** A library source novel with what the check cadence needs. */
export interface CheckCandidate {
  novelId: number;
  pluginId: string;
  /** The source's status text, such as "Completed". */
  status: string | null;
  lastReadAt: number | null;
  lastCheckedAt: number | null;
  consecutiveFailures: number;
  totalChapters: number;
  unreadChapters: number;
  /** The current global automatic policy covers this active, unpaused library novel. */
  hasGoal: boolean;
}

export async function listCheckCandidates(
  activeSince: number | null = null,
): Promise<CheckCandidate[]> {
  return invokeDbQuery<CheckCandidate[]>("db_novel_freshness_list_candidates", {
    activeSince,
    mode: "queued",
  });
}

/** Checks each source started since `sinceSeconds`, for the per-source hourly budget. */
export async function countRecentChecksBySource(
  sinceSeconds: number,
): Promise<Map<string, number>> {
  const rows = await invokeDbQuery<Array<{ pluginId: string; count: number }>>(
    "db_novel_freshness_count_recent_by_source",
    {
      sinceSeconds,
      mode: "queued",
    },
  );
  return new Map(rows.map((row) => [row.pluginId, row.count]));
}

/** When any library novel was last checked for new chapters, for "Last checked" on Updates. */
export async function getLatestLibraryCheckAt(
  readMode: DatabaseReadMode = "queued",
): Promise<number | null> {
  return invokeDbQuery<number | null>(
    "db_novel_freshness_get_latest_library_check_at",
    { mode: readMode },
  );
}
