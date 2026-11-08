import { sourceAccessChallengeTitleKey } from "../plugins/source-access";
import type { UseNavigateResult } from "@tanstack/react-router";
import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { parseTaskNotificationAction, type TaskNotificationAction } from "./native-notification-actions";
import { waitForChapterDownloadQueueRestoration } from "./chapter-download";
import { taskScheduler } from "./scheduler";
import { openSourceAccessBrowser, sourceAccessBlockSourceNames } from "./source-access-coordinator";
import type { TaskNotificationTranslate } from "./task-notification-model";
import { isVpnDownloadVerificationCurrent } from "./vpn-download-notifications";
import { getVpnDownloadRuntimeSnapshot, initializeVpnDownloadRuntime, openVpnDownloadVerification } from "./vpn-download-runtime";

let taskNotificationNavigationGeneration = 0;
let taskNotificationSourceOpening: Promise<unknown> | null = null;

/** The page a notification tap opens; the queue holds Needs attention at its top. */
export type TaskNotificationDestination =
  | { kind: "queue" }
  | { kind: "attention" }
  | { kind: "updates" }
  | { kind: "backupSettings" }
  | { kind: "novel"; novelId: number }
  | { kind: "chapter"; chapterId: number };

export interface TaskNotificationTargetLookup {
  chapterNovelId: (chapterId: number) => Promise<number | null>;
  novelExists: (novelId: number) => Promise<boolean>;
}

const databaseTargetLookup: TaskNotificationTargetLookup = {
  chapterNovelId: async (chapterId) => (await getChapterById(chapterId, "committed"))?.novelId ?? null,
  novelExists: async (novelId) => (await getNovelById(novelId, "committed")) !== null,
};

/**
 * Resolves a notification target against current data. A chapter that is gone
 * or moved opens its novel, and a novel that is gone opens the queue.
 */
export async function resolveTaskNotificationDestination(
  action: TaskNotificationAction,
  lookup: TaskNotificationTargetLookup = databaseTargetLookup,
): Promise<TaskNotificationDestination> {
  const queue: TaskNotificationDestination = { kind: "queue" };
  try {
    if (action.type === "openUpdates") return { kind: "updates" };
    if (action.type === "openChapter" && await lookup.chapterNovelId(action.chapterId) === action.novelId) {
      return { kind: "chapter", chapterId: action.chapterId };
    }
    if ((action.type === "openNovel" || action.type === "openChapter") && await lookup.novelExists(action.novelId)) {
      return { kind: "novel", novelId: action.novelId };
    }
  } catch {
    // An unreadable target still opens the app somewhere useful.
  }
  return queue;
}

export function navigateToTaskNotificationDestination(
  navigate: UseNavigateResult<string>,
  destination: TaskNotificationDestination,
): Promise<void> {
  switch (destination.kind) {
    case "queue": return navigate({ to: "/downloads", search: { view: "queue" } });
    case "attention": return navigate({ to: "/downloads", search: { view: "queue", focus: "attention" } });
    case "updates": return navigate({ to: "/updates" });
    case "backupSettings": return navigate({ to: "/settings", search: { section: "backup" } });
    case "novel": return navigate({ to: "/novel", search: { id: destination.novelId } });
    case "chapter": return navigate({ to: "/reader", search: { chapterId: destination.chapterId } });
  }
}

export async function applyTaskNotificationAction(
  action: TaskNotificationAction,
  open: (destination: TaskNotificationDestination) => void | Promise<void>,
  t: TaskNotificationTranslate,
  lookup?: TaskNotificationTargetLookup,
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
  if (action.type === "openAttention") {
    await open({ kind: "attention" });
    return;
  }
  if (action.type === "openBackupSettings") {
    await open({ kind: "backupSettings" });
    return;
  }
  if (action.type === "openUpdates" || action.type === "openNovel" || action.type === "openChapter") {
    const destination = await resolveTaskNotificationDestination(action, lookup);
    if (generation === taskNotificationNavigationGeneration) await open(destination);
    return;
  }
  await open({ kind: "queue" });
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
    if (taskScheduler.canOpenSourceAccessBrowser(block.scopeKey)) {
      const opening = openSourceAccessBrowser(block, {
        isRequestCurrent: () => generation === taskNotificationNavigationGeneration,
        sourceName: sourceAccessBlockSourceNames(block, snapshot).join(", ") || block.sourceId,
        title: t(sourceAccessChallengeTitleKey(block.challenge.kind)),
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
