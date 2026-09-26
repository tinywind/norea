import { isAndroidRuntime } from "../tauri-runtime";
import type { TaskNotificationMode } from "../../store/notifications";
import {
  buildActiveTaskNotificationPayload,
  type TaskNotificationTranslate,
} from "./task-notification-model";
import { taskScheduler, type TaskRecord } from "./scheduler";

interface AndroidTaskNotificationBridge {
  isExecutionSuspended?: () => boolean;
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

// Android only keeps task work alive through the foreground service, so it
// runs in every mode; without progress notifications it posts a quiet one.
export function startAndroidTaskNotifications(
  t: TaskNotificationTranslate,
  mode: TaskNotificationMode,
): () => void {
  if (!isAndroidRuntime()) return () => undefined;

  let lastPayload = "";
  let executionSuspended = false;
  const suspendExecution = () => {
    if (executionSuspended) return;
    executionSuspended = true;
    taskScheduler.setBackgroundExecutionSuspended(true, t("tasks.backgroundExecutionSuspended"));
    window.__NoreaAndroidTasks?.stop();
    lastPayload = "";
  };
  let publishTimer: ReturnType<typeof setTimeout> | null = null;

  const publish = () => {
    const bridge = window.__NoreaAndroidTasks;
    if (!bridge) return;
    if (bridge.isExecutionSuspended?.()) suspendExecution();
    if (executionSuspended) return;

    const payload = buildActiveTaskNotificationPayload(
      taskScheduler.getSnapshot(),
      t,
    );
    if (!payload) {
      if (lastPayload !== "") {
        bridge.stop();
        lastPayload = "";
      }
      return;
    }

    const serialized = JSON.stringify(
      mode === "progress"
        ? payload
        : { body: "", quiet: true, title: t("tasks.notification.title") },
    );
    if (serialized === lastPayload) return;
    bridge.update(serialized);
    lastPayload = serialized;
  };

  const schedulePublish = () => {
    if (publishTimer !== null) return;
    publishTimer = globalThis.setTimeout(() => {
      publishTimer = null;
      publish();
    }, ANDROID_TASK_NOTIFICATION_PUBLISH_INTERVAL_MS);
  };

  const resumeExecution = () => {
    if (window.__NoreaAndroidTasks?.isExecutionSuspended?.()) return;
    if (executionSuspended) taskScheduler.setBackgroundExecutionSuspended(false);
    executionSuspended = false;
    lastPayload = "";
    publish();
  };
  window.addEventListener("norea-background-execution-suspended", suspendExecution);
  window.addEventListener("norea-app-resumed", resumeExecution);
  const unsubscribeSnapshots = taskScheduler.subscribe(schedulePublish);
  const unsubscribeEvents = taskScheduler.subscribeEvents(schedulePublish);
  publish();

  return () => {
    window.removeEventListener("norea-background-execution-suspended", suspendExecution);
    window.removeEventListener("norea-app-resumed", resumeExecution);
    unsubscribeSnapshots();
    unsubscribeEvents();
    if (publishTimer !== null) clearTimeout(publishTimer);
    if (lastPayload !== "") {
      window.__NoreaAndroidTasks?.stop();
    }
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
