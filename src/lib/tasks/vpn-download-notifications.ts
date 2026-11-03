import type { TranslationKey } from "../../i18n";
import { parseTaskNotificationAction, type TaskNotificationAction } from "./native-notification-actions";
import type { TaskNotificationTranslate } from "./task-notification-model";
import type { VpnDownloadPlan, VpnDownloadRangeState, VpnDownloadRunSnapshot } from "./vpn-download-types";

export interface VpnDownloadNotification {
  id: string;
  planId: string;
  rangeId: string;
  title: string;
  body: string;
  actionLabel: string;
  action: TaskNotificationAction;
}

const MANUAL_PAUSE_KEYS: Readonly<Record<string, TranslationKey>> = {
  "profiles-exhausted": "vpnDownload.reason.exhausted",
  "profile-unavailable": "vpnDownload.reason.unavailable",
  interrupted: "vpnDownload.reason.interrupted",
  "challenge-captcha": "vpnDownload.reason.captcha",
  "challenge-cloudflare": "vpnDownload.reason.cloudflare",
  "manual-verification": "vpnDownload.reason.verification",
  "verification-unavailable": "vpnDownload.reason.verificationUnavailable",
  "authentication-required": "vpnDownload.reason.authentication",
  "download-failed": "vpnDownload.reason.downloadFailed",
  "chapter-failed": "vpnDownload.reason.chapterFailed",
  "runtime-error": "vpnDownload.reason.runtimeError",
};

/** A paused range that waits for the user to verify its worker's challenge. */
export function isVpnDownloadVerificationNeeded(plan: VpnDownloadPlan, range: VpnDownloadRangeState): boolean {
  return !range.userPaused && isManualChallenge(plan, range);
}

function isManualChallenge(plan: VpnDownloadPlan, range: VpnDownloadRangeState): boolean {
  if (range.phase !== "paused" || !range.challenge) return false;
  return range.pauseReason === "manual-verification" ||
    (range.pauseReason === `challenge-${range.challenge.kind}` && plan.policies[range.challenge.kind] === "pause");
}

export function isVpnDownloadVerificationCurrent(
  plans: readonly VpnDownloadPlan[],
  action: Extract<TaskNotificationAction, { type: "verifyVpnDownload" }>,
): boolean {
  const plan = plans.find(plan => plan.id === action.planId && plan.pluginId === action.sourceId);
  const range = plan?.ranges.find(range => range.id === action.rangeId);
  return !!plan && !!range && isManualChallenge(plan, range) &&
    range.profileId === action.profileId && range.generation === action.generation && range.checkpoint === action.checkpoint;
}

export type VpnDownloadAttention =
  | { kind: "interrupted" }
  | { kind: "verification"; planId: string; rangeId: string; title: string }
  | { kind: "exhausted"; ranges: number }
  | { kind: "failed"; ranges: { planId: string; rangeId: string }[] };

const FAILED_PAUSES: ReadonlySet<string> = new Set([
  "authentication-required", "download-failed", "runtime-error", "verification-unavailable", "profile-unavailable",
]);

/** The one VPN problem the Queue page asks the user about; restarts, offline waits and busy profiles resolve by themselves. */
export function vpnDownloadAttention(
  plans: readonly VpnDownloadPlan[], runStatus: VpnDownloadRunSnapshot["status"] | undefined,
): VpnDownloadAttention | null {
  if (runStatus === "interrupted") return { kind: "interrupted" };
  if (runStatus !== undefined && runStatus !== "running") return null;
  const paused = plans.flatMap(plan => plan.ranges.filter(range => range.phase === "paused" && !range.userPaused).map(range => ({ plan, range })));
  const verification = paused.find(({ plan, range }) => isVpnDownloadVerificationNeeded(plan, range));
  if (verification) return { kind: "verification", planId: verification.plan.id, rangeId: verification.range.id, title: verification.plan.title };
  const exhausted = paused.filter(({ range }) => range.pauseReason === "profiles-exhausted").length;
  if (exhausted) return { kind: "exhausted", ranges: exhausted };
  const failed = paused.filter(({ range }) => range.pauseReason !== null && FAILED_PAUSES.has(range.pauseReason));
  return failed.length ? { kind: "failed", ranges: failed.map(({ plan, range }) => ({ planId: plan.id, rangeId: range.id })) } : null;
}

export const VPN_DOWNLOAD_ATTENTION_NOTIFICATION_ID = "vpn-download-required:summary";

export function vpnDownloadNotifications(
  plans: readonly VpnDownloadPlan[], t: TaskNotificationTranslate, runStatus?: VpnDownloadRunSnapshot["status"],
): VpnDownloadNotification[] {
  const items: VpnDownloadNotification[] = [];
  const pausedWorks = new Set<string>();
  let pausedRanges = 0;
  let restartOnly = true;
  let firstPaused: { plan: VpnDownloadPlan; range: VpnDownloadRangeState } | null = null;
  for (const plan of plans) {
    for (const [index, range] of plan.ranges.entries()) {
      const reasonKey = range.pauseReason ? MANUAL_PAUSE_KEYS[range.pauseReason] : undefined;
      if (range.phase !== "paused" || !reasonKey) continue;
      if (range.pauseReason?.startsWith("challenge-") && !isManualChallenge(plan, range)) continue;
      // A restarted range only needs the user when the run did not resume by itself.
      if (range.pauseReason === "interrupted" && runStatus !== "interrupted") continue;
      const verification = isManualChallenge(plan, range) ? parseTaskNotificationAction({
        type: "verifyVpnDownload", planId: plan.id, sourceId: plan.pluginId, rangeId: range.id,
        profileId: range.profileId, generation: range.generation, checkpoint: range.checkpoint,
      }) : null;
      if (verification) {
        // A verification opens the exact worker session, so it keeps its own notification.
        items.push({
          id: `vpn-download-required:${JSON.stringify([plan.id, range.id])}`,
          planId: plan.id, rangeId: range.id,
          title: t("vpnDownload.rangeAction", {
            action: t("vpnDownload.phase.paused"), title: plan.title, interval: t("vpnDownload.interval", { number: index + 1 }),
          }),
          body: t(reasonKey), actionLabel: t("sourceAccess.notificationAction"),
          action: verification,
        });
        continue;
      }
      pausedRanges += 1;
      restartOnly &&= range.pauseReason === "interrupted";
      pausedWorks.add(JSON.stringify([plan.pluginId, plan.novelId]));
      firstPaused ??= { plan, range };
    }
  }
  if (firstPaused) {
    const reasonKey = MANUAL_PAUSE_KEYS[firstPaused.range.pauseReason!]!;
    items.push({
      id: VPN_DOWNLOAD_ATTENTION_NOTIFICATION_ID,
      planId: firstPaused.plan.id, rangeId: firstPaused.range.id,
      title: restartOnly ? t("vpnDownload.notice.restartTitle") : pausedRanges === 1
        ? t("vpnDownload.rangeAction", {
          action: t("vpnDownload.phase.paused"), title: firstPaused.plan.title,
          interval: t("vpnDownload.interval", { number: firstPaused.plan.ranges.indexOf(firstPaused.range) + 1 }),
        })
        : t("vpnDownload.attentionSummary", { ranges: pausedRanges, works: pausedWorks.size }),
      body: restartOnly ? t("vpnDownload.notice.restartBody") : pausedRanges === 1 ? t(reasonKey) : t("vpnDownload.attentionSummaryBody"),
      actionLabel: t("downloads.title"),
      action: { type: "openTasks" },
    });
  }
  return items;
}

export function hasActiveVpnDownloads(plans: readonly VpnDownloadPlan[]): boolean {
  return plans.some(plan => plan.ranges.some(range => !range.userPaused &&
    (range.phase === "connecting" || range.phase === "running")));
}
