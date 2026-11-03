import type { StoredChapterDownloadFailure } from "../../db/queries/chapter-download-failure";
import type { DownloadFailureClass } from "./download-failure";

export interface VpnFailureRange {
  planId: string;
  rangeId: string;
}

export interface ChapterDownloadFailureGroup {
  key: string;
  pluginId: string;
  failureClass: DownloadFailureClass;
  action: "retry" | "repair" | "verify";
  chapterIds: number[];
  /** Chapters owned by VPN ranges; retrying them resumes their range instead of queueing a direct download. */
  vpnRanges: VpnFailureRange[];
  challengeUrl: string | null;
  /** The challenged host; empty for other classes. */
  challengeHost: string;
  latestSummary: string;
}

export interface ChapterDownloadFailureAttention {
  /** Failures waiting for an automatic attempt; information, not attention. */
  retrying: number;
  groups: ChapterDownloadFailureGroup[];
}

function vpnRange(jobJson: string): VpnFailureRange | null {
  try {
    const job = JSON.parse(jobJson) as { vpnPlanId?: unknown; vpnRangeId?: unknown };
    return typeof job.vpnPlanId === "string" && typeof job.vpnRangeId === "string"
      ? { planId: job.vpnPlanId, rangeId: job.vpnRangeId } : null;
  } catch {
    return null;
  }
}

function challengeHost(url: string | null): string {
  if (!url) return "";
  try { return new URL(url).hostname; } catch { return ""; }
}

/** Groups persisted failures by source and class, with one action each, as the Needs attention list. */
export function chapterDownloadFailureAttention(
  rows: readonly StoredChapterDownloadFailure[],
): ChapterDownloadFailureAttention {
  const groups = new Map<string, ChapterDownloadFailureGroup & { updatedAt: number }>();
  let retrying = 0;
  for (const row of rows) {
    if (row.nextRetryAt !== null) {
      retrying += 1;
      continue;
    }
    const host = row.failureClass === "challenge" ? challengeHost(row.challengeUrl) : "";
    const key = JSON.stringify([row.pluginId, row.failureClass, host]);
    let group = groups.get(key);
    if (!group) {
      group = {
        key, pluginId: row.pluginId, failureClass: row.failureClass,
        action: row.failureClass === "challenge" ? "verify" : row.failureClass === "media-incomplete" ? "repair" : "retry",
        chapterIds: [], vpnRanges: [], challengeUrl: row.challengeUrl, challengeHost: host, latestSummary: row.messageSummary, updatedAt: row.updatedAt,
      };
      groups.set(key, group);
    }
    group.chapterIds.push(row.chapterId);
    const range = vpnRange(row.jobJson);
    if (range && !group.vpnRanges.some((item) => item.planId === range.planId && item.rangeId === range.rangeId)) {
      group.vpnRanges.push(range);
    }
    if (row.updatedAt >= group.updatedAt) {
      group.updatedAt = row.updatedAt;
      group.latestSummary = row.messageSummary;
      group.challengeUrl = row.challengeUrl ?? group.challengeUrl;
    }
  }
  return {
    retrying,
    groups: [...groups.values()].map(({ updatedAt: _updatedAt, ...group }) => group),
  };
}
