import { expect, it } from "vitest";
import type { CheckCandidate } from "../../db/queries/novel-freshness";
import { checkIntervalSeconds, isCheckDue, selectDueChecks, SOURCE_CHECKS_PER_HOUR } from "./check-cadence";

const HOUR = 3600;
const DAY = 24 * HOUR;
const novel = (novelId: number, extra: Partial<CheckCandidate> = {}): CheckCandidate => ({
  novelId, pluginId: "s", status: null, lastReadAt: 100, lastCheckedAt: 0, consecutiveFailures: 0,
  totalChapters: 10, unreadChapters: 4, hasGoal: false, ...extra,
});

it("checks reading novels every interval, unstarted ones every 3 days and finished ones weekly", () => {
  expect(checkIntervalSeconds(novel(1), 12)).toBe(12 * HOUR);
  expect(checkIntervalSeconds(novel(1, { lastReadAt: null }), 12)).toBe(3 * DAY);
  expect(checkIntervalSeconds(novel(1, { lastReadAt: null, hasGoal: true }), 12)).toBe(12 * HOUR);
  expect(checkIntervalSeconds(novel(1, { unreadChapters: 0 }), 12)).toBe(7 * DAY);
  expect(checkIntervalSeconds(novel(1, { lastReadAt: null, status: "Completed" }), 12)).toBe(7 * DAY);
});

it("backs off after 3 failures in a row: 1 day, then 3, then 7", () => {
  expect([3, 4, 5, 9].map((consecutiveFailures) => checkIntervalSeconds(novel(1, { consecutiveFailures }), 12)))
    .toEqual([DAY, 3 * DAY, 7 * DAY, 7 * DAY]);
});

it("is due when never checked or once its interval passed", () => {
  expect(isCheckDue(novel(1, { lastCheckedAt: null }), 12, 10)).toBe(true);
  expect(isCheckDue(novel(1, { lastCheckedAt: 1000 }), 12, 1000 + 12 * HOUR - 1)).toBe(false);
  expect(isCheckDue(novel(1, { lastCheckedAt: 1000 }), 12, 1000 + 12 * HOUR)).toBe(true);
});

it("checks novels being read first and keeps each source within its hourly budget", () => {
  const now = 30 * DAY;
  const candidates = [
    novel(1, { lastReadAt: null, lastCheckedAt: 5 }),
    novel(2, { lastReadAt: 900 }),
    novel(3, { lastReadAt: 950, pluginId: "t" }),
    novel(4, { lastReadAt: null, lastCheckedAt: 1 }),
    novel(5, { lastCheckedAt: now }),
  ];
  expect(selectDueChecks(candidates, { intervalHours: 12, nowSeconds: now, recentChecksBySource: new Map() }))
    .toEqual([3, 2, 4, 1]);
  expect(selectDueChecks(candidates, {
    intervalHours: 12, nowSeconds: now, recentChecksBySource: new Map([["s", SOURCE_CHECKS_PER_HOUR - 1]]),
  })).toEqual([3, 2]);
});
