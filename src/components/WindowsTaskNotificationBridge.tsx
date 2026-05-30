import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
  type Options as NotificationOptions,
} from "@tauri-apps/plugin-notification";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { isWindowsRuntime } from "../lib/tauri-runtime";
import {
  taskScheduler,
  type TaskEvent,
  type TaskProgress,
} from "../lib/tasks/scheduler";
import {
  buildActiveTaskNotificationGroups,
  buildTaskEventNotificationBody,
  isChapterDownloadNotificationTask,
  isTaskEventNotificationCandidate,
  isTerminalTaskStatus,
  taskNotificationKey,
  taskNotificationProgressPercent,
  taskNotificationRouteForTask,
  taskNotificationTitleForTask,
  type ActiveTaskNotificationGroup,
  type TaskNotificationRoute,
} from "../lib/tasks/task-notification-model";
import type { TaskNotificationMode } from "../store/notifications";

interface WindowsTaskNotificationBridgeProps {
  taskProgressMode: TaskNotificationMode;
}

interface SentNotificationState {
  lastPercent?: number;
  lastSentAt: number;
  nativeProgressDismissed?: boolean;
  nativeProgressShown?: boolean;
  terminalSent: boolean;
}

const NOTIFICATION_GROUP = "task-progress";
const DOWNLOAD_PROGRESS_NOTIFICATION_TAG = "norea-download-progress";
const MIN_PROGRESS_INTERVAL_MS = 2_500;
const MIN_PROGRESS_PERCENT_DELTA = 10;

type NativeDownloadProgressUpdateResult =
  | "failed"
  | "notFound"
  | "succeeded";

interface NativeDownloadProgressPayload {
  status: string;
  tag: string;
  title: string;
  value: number;
  valueString: string;
}

let permissionPromise: Promise<boolean> | null = null;

function notificationId(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1;
}

function shouldSendNotification(
  event: TaskEvent,
  mode: TaskNotificationMode,
  state: SentNotificationState | undefined,
  now: number,
): boolean {
  if (mode === "off" || !isTaskEventNotificationCandidate(event.task)) {
    return false;
  }

  if (isTerminalTaskStatus(event.task.status)) {
    return !state?.terminalSent;
  }

  if (mode === "completion" || event.task.status !== "running") {
    return false;
  }

  const percent = taskNotificationProgressPercent(event.task);
  if (percent === undefined) {
    return false;
  }

  if (!state) return true;
  if (now - state.lastSentAt >= MIN_PROGRESS_INTERVAL_MS) return true;
  if (state.lastPercent === undefined) return true;
  return percent - state.lastPercent >= MIN_PROGRESS_PERCENT_DELTA;
}

async function ensureNotificationPermission(): Promise<boolean> {
  permissionPromise ??= (async () => {
    try {
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === "granted";
    } catch (error) {
      console.warn("[task-notifications] permission unavailable", error);
      return false;
    }
  })();
  return permissionPromise;
}

function routeFromNotification(
  notification: NotificationOptions,
): TaskNotificationRoute | null {
  const route = notification.extra?.route;
  if (route === "/downloads" || route === "/tasks" || route === "/updates") {
    return route;
  }
  return null;
}

function groupKeyFromNotificationKey(key: string): string | null {
  return key.startsWith("group:") ? key.slice("group:".length) : null;
}

function progressPercent(
  progress: TaskProgress | undefined,
): number | undefined {
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.min(
    100,
    Math.round(
      (Math.min(progress.current, progress.total) / progress.total) * 100,
    ),
  );
}

function progressValue(progress: TaskProgress | undefined): number | undefined {
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.min(progress.current, progress.total) / progress.total;
}

function isCompleteProgress(progress: TaskProgress | undefined): boolean {
  return progress?.total !== undefined && progress.current >= progress.total;
}

function shouldSendDownloadNotification(
  event: TaskEvent,
  mode: TaskNotificationMode,
  state: SentNotificationState | undefined,
  now: number,
  progress: TaskProgress | undefined,
): boolean {
  if (mode === "off" || !isTaskEventNotificationCandidate(event.task)) {
    return false;
  }
  if (mode === "progress" && state?.nativeProgressDismissed) {
    return false;
  }

  if (mode === "completion") {
    return (
      isTerminalTaskStatus(event.task.status) &&
      isCompleteProgress(progress) &&
      !state?.terminalSent
    );
  }

  const percent = progressPercent(progress);
  if (percent === undefined) return false;
  if (!state) return true;
  if (isTerminalTaskStatus(event.task.status) && isCompleteProgress(progress)) {
    return !state.terminalSent;
  }
  if (now - state.lastSentAt >= MIN_PROGRESS_INTERVAL_MS) return true;
  if (state.lastPercent === undefined) return true;
  return percent - state.lastPercent >= MIN_PROGRESS_PERCENT_DELTA;
}

function nativeDownloadProgressPayload(
  group: ActiveTaskNotificationGroup | undefined,
): NativeDownloadProgressPayload | null {
  const value = progressValue(group?.progress);
  if (!group || value === undefined) return null;
  return {
    status: group.body,
    tag: DOWNLOAD_PROGRESS_NOTIFICATION_TAG,
    title: group.title,
    value,
    valueString: group.body,
  };
}

async function sendNativeDownloadProgressNotification(
  payload: NativeDownloadProgressPayload,
  update: boolean,
): Promise<NativeDownloadProgressUpdateResult> {
  if (update) {
    return invoke<NativeDownloadProgressUpdateResult>(
      "task_notification_update_download_progress",
      { payload },
    );
  }
  await invoke("task_notification_show_download_progress", { payload });
  return "succeeded";
}

export function WindowsTaskNotificationBridge({
  taskProgressMode,
}: WindowsTaskNotificationBridgeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isWindowsRuntime() || taskProgressMode === "off") return;

    let disposed = false;
    let actionListener: { unregister: () => Promise<void> } | undefined;
    let activeGroupKeys = new Set<string>();
    const sentByKey = new Map<string, SentNotificationState>();

    void onAction((notification) => {
      const route = routeFromNotification(notification);
      if (!route) return;
      void (async () => {
        try {
          const window = getCurrentWindow();
          await window.show();
          await window.unminimize();
          await window.setFocus();
        } catch (error) {
          console.warn("[task-notifications] window focus failed", error);
        }
        void navigate({ to: route });
      })();
    })
      .then((listener) => {
        if (disposed) {
          void listener.unregister();
          return;
        }
        actionListener = listener;
      })
      .catch((error) => {
        console.warn("[task-notifications] action listener failed", error);
      });

    const unsubscribeSnapshots = taskScheduler.subscribe(() => {
      const nextGroupKeys = new Set(
        buildActiveTaskNotificationGroups(
          taskScheduler.getSnapshot(),
          t,
        ).map((group) => `group:${group.key}`),
      );
      for (const key of nextGroupKeys) {
        if (!activeGroupKeys.has(key)) sentByKey.delete(key);
      }
      activeGroupKeys = nextGroupKeys;
    });

    const unsubscribeEvents = taskScheduler.subscribeEvents((event) => {
      const key = taskNotificationKey(event.task);
      const isDownloadTask = isChapterDownloadNotificationTask(event.task);
      if (
        isTerminalTaskStatus(event.task.status) &&
        activeGroupKeys.has(key) &&
        !isDownloadTask
      ) {
        return;
      }
      const groupKey = groupKeyFromNotificationKey(key);
      const group = groupKey
        ? buildActiveTaskNotificationGroups(
            taskScheduler.getSnapshot(),
            t,
          ).find((item) => item.key === groupKey)
        : undefined;
      if (isDownloadTask && !group) return;

      const state = sentByKey.get(key);
      const now = Date.now();
      const shouldSend = isDownloadTask
        ? shouldSendDownloadNotification(
            event,
            taskProgressMode,
            state,
            now,
            group?.progress,
          )
        : shouldSendNotification(event, taskProgressMode, state, now);
      if (!shouldSend) {
        return;
      }

      const percent = isDownloadTask
        ? progressPercent(group?.progress)
        : taskNotificationProgressPercent(event.task);
      const nativeDownloadPayload =
        isDownloadTask && taskProgressMode === "progress"
          ? nativeDownloadProgressPayload(group)
          : null;
      sentByKey.set(key, {
        lastPercent: percent,
        lastSentAt: now,
        nativeProgressDismissed: state?.nativeProgressDismissed,
        nativeProgressShown: nativeDownloadPayload
          ? true
          : state?.nativeProgressShown,
        terminalSent:
          isTerminalTaskStatus(event.task.status) &&
          (!isDownloadTask || isCompleteProgress(group?.progress)),
      });

      void ensureNotificationPermission().then((granted) => {
        if (!granted || disposed) return;
        if (nativeDownloadPayload) {
          void sendNativeDownloadProgressNotification(
            nativeDownloadPayload,
            state?.nativeProgressShown === true,
          )
            .then((result) => {
              const latestState = sentByKey.get(key);
              if (!latestState) return;
              sentByKey.set(key, {
                ...latestState,
                nativeProgressDismissed:
                  result === "notFound"
                    ? true
                    : latestState.nativeProgressDismissed,
                nativeProgressShown:
                  result === "succeeded" || latestState.nativeProgressShown,
              });
            })
            .catch((error) => {
              console.warn(
                "[task-notifications] native progress send failed",
                error,
              );
            });
          return;
        }
        try {
          sendNotification({
            id: notificationId(key),
            title: group?.title ?? taskNotificationTitleForTask(t, event.task),
            body: group?.body ?? buildTaskEventNotificationBody(t, event.task),
            group: NOTIFICATION_GROUP,
            autoCancel: true,
            extra: {
              route: group?.route ?? taskNotificationRouteForTask(event.task),
            },
          });
        } catch (error) {
          console.warn("[task-notifications] send failed", error);
        }
      });
    });

    return () => {
      disposed = true;
      unsubscribeEvents();
      unsubscribeSnapshots();
      void actionListener?.unregister();
    };
  }, [navigate, t, taskProgressMode]);

  return null;
}
