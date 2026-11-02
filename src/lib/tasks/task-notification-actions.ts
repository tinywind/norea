import { parseTaskNotificationAction, type TaskNotificationAction } from "./native-notification-actions";
import { waitForChapterDownloadQueueRestoration } from "./chapter-download";
import { taskScheduler } from "./scheduler";
import { openSourceAccessBrowser, sourceAccessBlockSourceNames } from "./source-access-coordinator";
import type { TaskNotificationTranslate } from "./task-notification-model";
import { isVpnDownloadVerificationCurrent } from "./vpn-download-notifications";
import { getVpnDownloadRuntimeSnapshot, initializeVpnDownloadRuntime, openVpnDownloadVerification } from "./vpn-download-runtime";

let taskNotificationNavigationGeneration = 0;
let taskNotificationSourceOpening: Promise<unknown> | null = null;

export async function applyTaskNotificationAction(
  action: TaskNotificationAction,
  openTasks: () => void | Promise<void>,
  t: TaskNotificationTranslate,
): Promise<void> {
  const parsed = parseTaskNotificationAction(action);
  if (!parsed) return;
  action = parsed;
  if (action.type === "pause") {
    taskScheduler.pauseTaskGroup(action.groupKey);
    return;
  }
  if (action.type === "resume") {
    taskScheduler.resumeTaskGroup(action.groupKey);
    return;
  }
  const generation = ++taskNotificationNavigationGeneration;
  await openTasks();
  if (generation !== taskNotificationNavigationGeneration || action.type === "openTasks") return;
  if (action.type === "verifyVpnDownload") {
    await Promise.all([initializeVpnDownloadRuntime(), waitForChapterDownloadQueueRestoration()]);
    while (generation === taskNotificationNavigationGeneration) {
      if (taskNotificationSourceOpening) {
        await taskNotificationSourceOpening.catch(() => undefined);
        continue;
      }
      if (!isVpnDownloadVerificationCurrent(getVpnDownloadRuntimeSnapshot().plans, action)) return;
      const opening = openVpnDownloadVerification(action.planId, action.rangeId);
      taskNotificationSourceOpening = opening;
      try {
        await opening;
      } finally {
        if (taskNotificationSourceOpening === opening) taskNotificationSourceOpening = null;
      }
      return;
    }
    return;
  }
  if (action.type !== "verifySource") return;
  await waitForChapterDownloadQueueRestoration();
  while (generation === taskNotificationNavigationGeneration) {
    if (taskNotificationSourceOpening) {
      await taskNotificationSourceOpening.catch(() => undefined);
      continue;
    }
    const snapshot = taskScheduler.getSnapshot();
    const block = snapshot.sourceAccessBlocks.find(block => block.sourceId === action.sourceId &&
      block.scopeKey === action.scopeKey && block.revision === action.revision);
    if (!block || block.rangeId !== undefined) return;
    if (taskScheduler.canBeginSourceAccessVerification(block.scopeKey)) {
      const opening = openSourceAccessBrowser(block, {
        isRequestCurrent: () => generation === taskNotificationNavigationGeneration,
        sourceName: sourceAccessBlockSourceNames(block, snapshot).join(", ") || block.sourceId,
        title: t(block.challenge.kind === "captcha" ? "sourceAccess.captchaTitle" : "sourceAccess.cloudflareTitle"),
      });
      taskNotificationSourceOpening = opening;
      try {
        await opening;
      } finally {
        if (taskNotificationSourceOpening === opening) taskNotificationSourceOpening = null;
      }
      return;
    }
    const running = snapshot.records.filter(task => task.lane === "source" && task.status === "running" &&
      task.source?.id === block.sourceId && task.kind !== "source.openSite");
    if (running.length === 0) return;
    await Promise.all(running.map(task => taskScheduler.waitForSourceTaskSettlement(task.id)));
  }
}
