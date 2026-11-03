import type { CheckCandidate } from "../../db/queries/novel-freshness";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** Automatic checks per source per hour; catch-up beyond it is spread over the following hours. */
export const SOURCE_CHECKS_PER_HOUR = 30;

/** Failed checks in a row after which a novel's checks back off and show as paused. */
export const CHECK_BACKOFF_FAILURES = 3;

/** A novel opened after this long without a check is checked in the background. */
export const STALE_ON_OPEN_SECONDS = 6 * HOUR;

const isReading = (novel: CheckCandidate) =>
  novel.hasGoal || (novel.lastReadAt !== null && novel.unreadChapters > 0);
const isFinished = (novel: CheckCandidate) =>
  /complete/i.test(novel.status ?? "") || (novel.totalChapters > 0 && novel.unreadChapters === 0);

/**
 * How often a novel is checked (spec F2): the interval while it is being read or has a goal,
 * 3 days in the library but not started, 7 days once finished or fully read, and 1, 3 then 7 days
 * after 3 or more failures in a row.
 */
export function checkIntervalSeconds(novel: CheckCandidate, intervalHours: number): number {
  if (novel.consecutiveFailures >= CHECK_BACKOFF_FAILURES) {
    return novel.consecutiveFailures === CHECK_BACKOFF_FAILURES ? DAY : novel.consecutiveFailures === 4 ? 3 * DAY : 7 * DAY;
  }
  if (isReading(novel)) return intervalHours * HOUR;
  if (isFinished(novel)) return 7 * DAY;
  return novel.lastReadAt === null ? 3 * DAY : intervalHours * HOUR;
}

export function isCheckDue(novel: CheckCandidate, intervalHours: number, nowSeconds: number): boolean {
  return novel.lastCheckedAt === null || nowSeconds - novel.lastCheckedAt >= checkIntervalSeconds(novel, intervalHours);
}

/**
 * The due novels to check now: those being read first (most recently read first), then the
 * longest unchecked, within each source's remaining hourly budget.
 */
export function selectDueChecks(
  candidates: readonly CheckCandidate[],
  options: { intervalHours: number; nowSeconds: number; recentChecksBySource: ReadonlyMap<string, number> },
): number[] {
  const due = candidates.filter((novel) => isCheckDue(novel, options.intervalHours, options.nowSeconds));
  due.sort((left, right) => {
    const reading = Number(isReading(right)) - Number(isReading(left));
    if (reading !== 0) return reading;
    if (isReading(left)) return (right.lastReadAt ?? 0) - (left.lastReadAt ?? 0);
    return (left.lastCheckedAt ?? 0) - (right.lastCheckedAt ?? 0);
  });
  const used = new Map(options.recentChecksBySource);
  const selected: number[] = [];
  for (const novel of due) {
    const count = used.get(novel.pluginId) ?? 0;
    if (count >= SOURCE_CHECKS_PER_HOUR) continue;
    used.set(novel.pluginId, count + 1);
    selected.push(novel.novelId);
  }
  return selected;
}
