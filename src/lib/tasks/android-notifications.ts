import { isAndroidRuntime } from "../tauri-runtime";
import { isHostNetworkConnected, isNetworkOnline, useNetworkStore } from "../network";
import type { TaskNotificationMode } from "../../store/notifications";
import { TaskNotificationTracker, type TaskNotificationTranslate } from "./task-notification-model";
import { subscribeChapterDownloadBatchProgress } from "./chapter-download";
import { taskScheduler, type TaskRecord } from "./scheduler";
import { parseTaskNotificationActions, type TaskNotificationAction } from "./native-notification-actions";
import { SourceAccessNotificationTracker, type SourceAccessNotification } from "./source-access-notifications";
import {
  buildContentSyncNotificationGroup,
  buildSyncFailureNotification,
  getLastEmittedSyncFailureId,
  getSyncRuntimeSnapshot,
  markSyncFailureNotificationEmitted,
  setSyncBackgroundExecutionSuspended,
  subscribeSyncRuntime,
} from "./sync-runtime";
import { getVpnDownloadRuntimeSnapshot, subscribeVpnDownloadRuntime } from "./vpn-download-runtime";
import { hasActiveVpnDownloads, vpnDownloadNotifications } from "./vpn-download-notifications";

interface AndroidTaskNotificationBridge {
  isAppActive?: () => boolean;
  isExecutionSuspended?: () => boolean;
  setPendingBackgroundUpload?: (pending: boolean) => void;
  drainActions?: () => string;
  stop: () => void;
  update: (payload: string) => void;
}

const ANDROID_BACKGROUND_DOWNLOAD_YIELD_DELAY_MS = 15_000;
const ANDROID_TASK_NOTIFICATION_PUBLISH_INTERVAL_MS = 250;

declare global {
  interface Window {
    __NoreaAndroidTasks?: AndroidTaskNotificationBridge;
  }
}

export function startAndroidTaskNotifications(
  t: TaskNotificationTranslate,
  mode: TaskNotificationMode,
  onAction: (action: TaskNotificationAction) => void = () => undefined,
): () => void {
  if (!isAndroidRuntime()) return () => undefined;

  let snapshot = taskScheduler.getSnapshot();
  const tracker = new TaskNotificationTracker(snapshot);
  const sourceTracker = new SourceAccessNotificationTracker(snapshot);
  let lastPayload = "";
  let lastExecutionActive = false;
  let lastEmittedSyncFailureId = getLastEmittedSyncFailureId("android");
  let lastClearedSyncFailureSerial = getSyncRuntimeSnapshot().failureClearedSerial;
  let executionSuspended = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let challengeRevision: string | undefined;
  let challenges: SourceAccessNotification[] = [];

  const drainActions = () => {
    const raw = window.__NoreaAndroidTasks?.drainActions?.();
    if (!raw) return;
    for (const action of parseTaskNotificationActions(raw)) onAction(action);
  };
  const suspendExecution = () => {
    if (executionSuspended) return;
    executionSuspended = true;
    taskScheduler.setBackgroundExecutionSuspended(true, t("tasks.backgroundExecutionSuspended"));
    setSyncBackgroundExecutionSuspended(true);
    window.__NoreaAndroidTasks?.stop();
    lastPayload = "";
    lastExecutionActive = false;
  };
  const publish = () => {
    const bridge = window.__NoreaAndroidTasks;
    if (!bridge) return;
    if (bridge.isExecutionSuspended?.()) suspendExecution();
    const taskGroups = tracker.groups(t, snapshot);
    const completed = tracker.takeCompletions(t);
    const revision = sourceTracker.revision(snapshot.sourceAccessBlocks);
    if (revision !== challengeRevision) {
      challengeRevision = revision;
      challenges = sourceTracker.notifications(snapshot.sourceAccessBlocks, t);
    }
    const online = isNetworkOnline();
    const hostConnected = isHostNetworkConnected();
    const { plans, run } = getVpnDownloadRuntimeSnapshot();
    const ranges = vpnDownloadNotifications(plans, t, run?.status);
    const vpnActive = hasActiveVpnDownloads(plans);
    const syncState = getSyncRuntimeSnapshot();
    const syncGroup = hostConnected && !executionSuspended
      ? buildContentSyncNotificationGroup(t, syncState)
      : null;
    const groups = [...taskGroups, ...(syncGroup ? [syncGroup] : [])];
    const quiet = mode !== "progress";
    const taskCompletions = mode === "off"
      ? []
      : completed.map(({ action, key, title, body }) => ({ action, key, title, body }));
    const syncFailure =
      mode !== "off" &&
      syncState.latestFailure !== null &&
      syncState.latestFailure.id > lastEmittedSyncFailureId
        ? buildSyncFailureNotification(syncState.latestFailure, t)
        : null;
    if (syncState.latestFailure !== null && syncState.latestFailure.id > lastEmittedSyncFailureId) {
      lastEmittedSyncFailureId = syncState.latestFailure.id;
      markSyncFailureNotificationEmitted("android", syncState.latestFailure.id);
    }
    const cancelledCompletions: string[] = [];
    if (syncState.failureClearedSerial > lastClearedSyncFailureSerial) {
      lastClearedSyncFailureSerial = syncState.failureClearedSerial;
      if (!syncFailure) cancelledCompletions.push("contentSync");
    }
    const completions = [...taskCompletions, ...(syncFailure ? [syncFailure] : [])];
    const taskOrVpnActive = online && !executionSuspended && (taskGroups.length > 0 || vpnActive);
    const syncExecutionActive = hostConnected && !executionSuspended && syncState.executionActive;
    const executionActive = taskOrVpnActive || syncExecutionActive;
    const working =
      (online && !executionSuspended && (tracker.hasRunningWork() || vpnActive)) ||
      syncExecutionActive;
    lastExecutionActive = executionActive;
    const payload = {
      title: t("tasks.notification.title"), quiet,
      channels: {
        verificationName: t("tasks.notification.verificationChannel"),
        verificationDescription: t("tasks.notification.verificationChannelDescription"),
        resultsName: t("tasks.notification.resultsChannel"),
        resultsDescription: t("tasks.notification.resultsChannelDescription"),
      },
      executionActive,
      working,
      requiresScraperWebViews: taskOrVpnActive,
      requestPermission: ranges.length > 0 || challenges.length > 0 || (mode !== "off" && (groups.length > 0 || completions.length > 0)),
      groups: quiet ? [] : groups.map(group => ({
        key: group.key, title: group.title,
        body: group.paused ? `${t("tasks.notification.paused")} · ${group.body}` : group.body,
        paused: group.paused,
        pausable: group.pausable ?? true,
        progress: group.progress,
        pauseLabel: t("tasks.notification.pause"), resumeLabel: t("tasks.notification.resume"),
      })),
      challenges, ranges, completions,
      ...(syncExecutionActive && !taskOrVpnActive ? { syncQuietAnchor: true } : {}),
      ...(cancelledCompletions.length > 0 ? { cancelledCompletions } : {}),
    };
    const serialized = JSON.stringify(payload);
    if (serialized === lastPayload) return;
    bridge.update(serialized);
    lastPayload = serialized;
  };
  const publishImmediately = () => {
    if (publishTimer !== null) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    publish();
  };
  const schedulePublish = () => {
    if (publishTimer !== null) return;
    publishTimer = globalThis.setTimeout(() => {
      publishTimer = null;
      publish();
    }, ANDROID_TASK_NOTIFICATION_PUBLISH_INTERVAL_MS);
  };
  const onSuspended = () => { suspendExecution(); schedulePublish(); };
  const resumeExecution = () => {
    if (!window.__NoreaAndroidTasks?.isExecutionSuspended?.()) {
      if (executionSuspended) {
        taskScheduler.setBackgroundExecutionSuspended(false);
        setSyncBackgroundExecutionSuspended(false);
      }
      executionSuspended = false;
    }
    snapshot = taskScheduler.getSnapshot();
    lastPayload = "";
    publishImmediately();
    drainActions();
  };
  window.addEventListener("norea-background-execution-suspended", onSuspended);
  window.addEventListener("norea-app-resumed", resumeExecution);
  window.addEventListener("norea-task-notification-action", drainActions);
  const unsubscribeSnapshots = taskScheduler.subscribe(() => {
    snapshot = taskScheduler.getSnapshot();
    schedulePublish();
  });
  const unsubscribeEvents = taskScheduler.subscribeEvents(event => {
    tracker.update(event);
    sourceTracker.update(event);
    schedulePublish();
  });
  const unsubscribeBatches = subscribeChapterDownloadBatchProgress(event => {
    tracker.updateBatch(event);
    schedulePublish();
  });
  const unsubscribeNetwork = useNetworkStore.subscribe(schedulePublish);
  const unsubscribeVpn = subscribeVpnDownloadRuntime(schedulePublish);
  const unsubscribeSync = subscribeSyncRuntime(() => {
    const syncState = getSyncRuntimeSnapshot();
    const needsImmediate =
      (!lastExecutionActive && syncState.executionActive) ||
      (syncState.latestFailure !== null && syncState.latestFailure.id > lastEmittedSyncFailureId) ||
      syncState.failureClearedSerial > lastClearedSyncFailureSerial;
    if (needsImmediate) publishImmediately();
    else schedulePublish();
  });
  window.__NoreaAndroidTasks?.setPendingBackgroundUpload?.(
    getSyncRuntimeSnapshot().hasPendingBackgroundUpload,
  );
  publish();
  drainActions();

  return () => {
    window.removeEventListener("norea-background-execution-suspended", onSuspended);
    window.removeEventListener("norea-app-resumed", resumeExecution);
    window.removeEventListener("norea-task-notification-action", drainActions);
    unsubscribeSnapshots(); unsubscribeEvents(); unsubscribeBatches(); unsubscribeNetwork(); unsubscribeVpn(); unsubscribeSync();
    if (publishTimer !== null) clearTimeout(publishTimer);
    window.__NoreaAndroidTasks?.stop();
  };
}

function isRunningInterruptibleDownload(task: TaskRecord): boolean {
  return (
    task.status === "running" &&
    (task.kind === "chapter.download" || task.kind === "chapter.repairMedia")
  );
}

export function startAndroidBackgroundDownloadRecovery(): () => void {
  if (
    !isAndroidRuntime() ||
    typeof document === "undefined" ||
    typeof window === "undefined"
  ) {
    return () => undefined;
  }

  let hiddenAt =
    document.visibilityState === "hidden" ? Date.now() : null;

  const recoverIfNeeded = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt === null) return;

    const backgroundDuration = Date.now() - hiddenAt;
    hiddenAt = null;
    if (backgroundDuration < ANDROID_BACKGROUND_DOWNLOAD_YIELD_DELAY_MS) {
      return;
    }

    const hasRunningDownload = taskScheduler
      .getSnapshot()
      .records.some(isRunningInterruptibleDownload);
    if (!hasRunningDownload) return;

    taskScheduler.yieldRunningInterruptibleDownloads();
  };

  document.addEventListener("visibilitychange", recoverIfNeeded);
  window.addEventListener("focus", recoverIfNeeded);
  window.addEventListener("pageshow", recoverIfNeeded);

  return () => {
    document.removeEventListener("visibilitychange", recoverIfNeeded);
    window.removeEventListener("focus", recoverIfNeeded);
    window.removeEventListener("pageshow", recoverIfNeeded);
  };
}
