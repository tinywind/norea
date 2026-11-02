import { expect, it } from "vitest";
import type { VpnDownloadPlan, VpnDownloadRangeState } from "./vpn-download-types";
import { hasActiveVpnDownloads, isVpnDownloadVerificationCurrent, vpnDownloadNotifications } from "./vpn-download-notifications";
import type { TaskNotificationTranslate } from "./task-notification-model";

const t = ((key: string, params?: Record<string, string | number>) =>
  `${key}${params ? `:${JSON.stringify(params)}` : ""}`) as TaskNotificationTranslate;

function range(id: string, patch: Partial<VpnDownloadRangeState> = {}): VpnDownloadRangeState {
  return {
    id, profileId: `profile-${id}`, profileHash: "hash", startChapterId: 1, endChapterId: 3,
    chapterIds: [1, 2, 3], selectedChapterIds: [1, 3], checkpoint: 0, phase: "paused", userPaused: false,
    pauseReason: "challenge-captcha", attemptedProfileIds: [], attemptProfileId: null, generation: 7,
    challenge: { kind: "captcha", url: "https://source.test/chapter" }, ...patch,
  };
}
function plan(ranges: VpnDownloadRangeState[], patch: Partial<VpnDownloadPlan> = {}): VpnDownloadPlan {
  return { id: "plan-a", batchId: "batch-a", pluginId: "source-a", novelId: 1, title: "Work", mode: "parallel",
    policies: { captcha: "pause", cloudflare: "nextProfile" }, createdAt: 1, revision: 1, ranges, ...patch };
}

it("keeps same-source range cards separate and clears only the fully settled owner", () => {
  const a = range("a"), b = range("b");
  const original = vpnDownloadNotifications([plan([a, b])], t);
  expect(original).toHaveLength(2);
  expect(original[0]?.id).not.toBe(original[1]?.id);
  expect(original[0]?.action).toEqual({
    type: "verifyVpnDownload", sourceId: "source-a", planId: "plan-a", rangeId: "a", profileId: "profile-a", generation: 7, checkpoint: 0,
  });
  expect(vpnDownloadNotifications([plan([{ ...a, phase: "running", challenge: null, pauseReason: null, checkpoint: 1 }, b])], t))
    .toEqual([original[1]]);
  expect(vpnDownloadNotifications([plan([a]), plan([a], { id: "plan-b" })], t)[1]?.id).not.toBe(original[0]?.id);
});

it("never emits manual cards for automatic rotation, offline waits or user pauses", () => {
  expect(vpnDownloadNotifications([plan([
    range("connecting", { phase: "connecting" }), range("running", { phase: "running" }),
    range("next", { challenge: { kind: "cloudflare", url: "https://source.test" }, pauseReason: "challenge-cloudflare" }),
    range("offline", { pauseReason: "offline" }), range("user", { pauseReason: "user-paused", userPaused: true }),
    range("lease", { pauseReason: "profile-in-use" }), range("off", { pauseReason: "automatic-off" }),
  ])], t)).toEqual([]);
});

it("opens only Tasks for exhaustion, restart and authentication notices without a current manual browser", () => {
  const items = vpnDownloadNotifications([plan([
    range("exhausted", { pauseReason: "profiles-exhausted" }),
    range("restored", { pauseReason: "interrupted", generation: 0 }),
    range("auth", { pauseReason: "authentication-required" }),
  ])], t);
  expect(items.map(item => item.action)).toEqual([{ type: "openTasks" }, { type: "openTasks" }, { type: "openTasks" }]);
  expect(items[0]?.body).toBe("vpnDownload.reason.exhausted");
  expect(items[1]?.body).toBe("vpnDownload.reason.interrupted");
});

it("validates the current paused challenge owner, including its settled chapter checkpoint", () => {
  const owner = range("a");
  const current = plan([owner]);
  const action = vpnDownloadNotifications([current], t)[0]!.action;
  if (action.type !== "verifyVpnDownload") throw new Error("Expected a verification action");
  expect(isVpnDownloadVerificationCurrent([current], action)).toBe(true);
  for (const patch of [{ phase: "cancelled" }, { phase: "completed" }, { phase: "running" }, { challenge: null },
    { generation: 8 }, { profileId: "replacement" }, { checkpoint: 1 }, { pauseReason: "profiles-exhausted" }, { pauseReason: "interrupted" }] as Partial<VpnDownloadRangeState>[]) {
    expect(isVpnDownloadVerificationCurrent([plan([{ ...owner, ...patch }])], action)).toBe(false);
  }
  expect(isVpnDownloadVerificationCurrent([plan([owner], { pluginId: "another-source" })], action)).toBe(false);
  expect(isVpnDownloadVerificationCurrent([plan([owner], { id: "another-plan" })], action)).toBe(false);
});

it("counts connecting and running automatic ranges as working without reading chapter history", () => {
  const active = range("a", { phase: "connecting", pauseReason: null });
  Object.defineProperty(active, "chapterIds", { get: () => { throw new Error("Chapter history scanned"); } });
  expect(hasActiveVpnDownloads([plan([active])])).toBe(true);
  expect(hasActiveVpnDownloads([plan([range("paused"), range("cancelled", { phase: "cancelled" })])])).toBe(false);
  expect(hasActiveVpnDownloads([plan([range("manual", { phase: "paused", pauseReason: "manual-verification" })])])).toBe(false);
});
