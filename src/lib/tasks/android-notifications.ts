import { isAndroidRuntime } from "../tauri-runtime";
import type { TaskNotificationMode } from "../../store/notifications";
import {
  buildActiveTaskNotificationPayload,
  type TaskNotificationTranslate,
} from "./task-notification-model";
import { taskScheduler, type TaskRecord } from "./scheduler";

interface AndroidTaskNotificationBridge {
  stop: () => void;
  update: (payload: string) => void;
}

const ANDROID_BACKGROUND_DOWNLOAD_REQUEUE_DELAY_MS = 15_000;

declare global {
  interface Window {
    __NoreaAndroidTasks?: AndroidTaskNotificationBridge;
  }
}

export function startAndroidTaskNotifications(
  t: TaskNotificationTranslate,
  mode: TaskNotificationMode,
): () => void {
  if (!isAndroidRuntime() || mode !== "progress") {
    window.__NoreaAndroidTasks?.stop();
    return () => undefined;
  }

  let lastPayload = "";

  const publish = () => {
    const bridge = window.__NoreaAndroidTasks;
    if (!bridge) return;

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

    const serialized = JSON.stringify(payload);
    if (serialized === lastPayload) return;
    bridge.update(serialized);
    lastPayload = serialized;
  };

  const unsubscribe = taskScheduler.subscribe(publish);
  publish();

  return () => {
    unsubscribe();
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
    if (backgroundDuration < ANDROID_BACKGROUND_DOWNLOAD_REQUEUE_DELAY_MS) {
      return;
    }

    const hasRunningDownload = taskScheduler
      .getSnapshot()
      .records.some(isRunningInterruptibleDownload);
    if (!hasRunningDownload) return;

    taskScheduler.requeueRunningInterruptibleDownloads();
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
