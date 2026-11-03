import type { TranslationKey } from "../../i18n";
import { parseTaskNotificationAction, type TaskNotificationAction } from "./native-notification-actions";
import type { TaskNotificationTranslate } from "./task-notification-model";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "./vpn-download-types";

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
  "runtime-error": "vpnDownload.reason.runtimeError",
};

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

export function vpnDownloadNotifications(plans: readonly VpnDownloadPlan[], t: TaskNotificationTranslate): VpnDownloadNotification[] {
  const items: VpnDownloadNotification[] = [];
  for (const plan of plans) {
    for (const [index, range] of plan.ranges.entries()) {
      const reasonKey = range.pauseReason ? MANUAL_PAUSE_KEYS[range.pauseReason] : undefined;
      if (range.phase !== "paused" || !reasonKey) continue;
      if (range.pauseReason?.startsWith("challenge-") && !isManualChallenge(plan, range)) continue;
      const verification = isManualChallenge(plan, range) ? parseTaskNotificationAction({
        type: "verifyVpnDownload", planId: plan.id, sourceId: plan.pluginId, rangeId: range.id,
        profileId: range.profileId, generation: range.generation, checkpoint: range.checkpoint,
      }) : null;
      items.push({
        id: `vpn-download-required:${JSON.stringify([plan.id, range.id])}`,
        planId: plan.id, rangeId: range.id,
        title: t("vpnDownload.rangeAction", {
          action: t("vpnDownload.phase.paused"), title: plan.title, interval: t("vpnDownload.interval", { number: index + 1 }),
        }),
        body: t(reasonKey), actionLabel: t(verification ? "sourceAccess.notificationAction" : "downloads.title"),
        action: verification ?? { type: "openTasks" },
      });
    }
  }
  return items;
}

export function hasActiveVpnDownloads(plans: readonly VpnDownloadPlan[]): boolean {
  return plans.some(plan => plan.ranges.some(range => !range.userPaused &&
    (range.phase === "connecting" || range.phase === "running")));
}
