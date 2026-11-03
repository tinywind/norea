import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "../i18n";
import { isWindowsRuntime } from "../lib/tauri-runtime";
import { taskScheduler, type TaskProgress } from "../lib/tasks/scheduler";
import { subscribeChapterDownloadBatchProgress } from "../lib/tasks/chapter-download";
import {
  TaskNotificationTracker,
  type ActiveTaskNotificationGroup,
  type TaskNotificationGroupKey,
  type TaskNotificationCompletion,
} from "../lib/tasks/task-notification-model";
import {
  parseTaskNotificationAction,
  type TaskNotificationAction,
} from "../lib/tasks/native-notification-actions";
import {
  SourceAccessNotificationTracker,
  type SourceAccessNotification,
} from "../lib/tasks/source-access-notifications";
import type { TaskNotificationMode } from "../store/notifications";

interface WindowsTaskNotificationBridgeProps {
  onAction?: (action: TaskNotificationAction) => void;
  taskProgressMode: TaskNotificationMode;
}

interface SentGroupState {
  group: ActiveTaskNotificationGroup;
  lastPercent?: number;
  lastSentAt: number;
  serialized: string;
}

const PUBLISH_DELAY_MS = 250;
const MIN_PROGRESS_INTERVAL_MS = 2_500;
const MIN_PROGRESS_PERCENT_DELTA = 10;

function progressPercent(progress: TaskProgress | undefined): number | undefined {
  if (!progress?.total || progress.total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.round(progress.current / progress.total * 100)));
}

export function WindowsTaskNotificationBridge({
  onAction,
  taskProgressMode,
}: WindowsTaskNotificationBridgeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isWindowsRuntime()) return;

    let snapshot = taskScheduler.getSnapshot();
    const tracker = new TaskNotificationTracker(snapshot);
    const sourceTracker = new SourceAccessNotificationTracker(snapshot);
    const sentByGroup = new Map<TaskNotificationGroupKey, SentGroupState>();
    const pendingCompletions = new Map<TaskNotificationGroupKey, TaskNotificationCompletion>();
    let sending = false;
    let publishRequested = false;
    let disposed = false;
    let ready = false;
    let actionUnlisten: UnlistenFn | undefined;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let publishAt = 0;
    let lastPayload = "";
    let challengeRevision: string | undefined;
    let challenges: SourceAccessNotification[] = [];

    const schedulePublish = (delay = PUBLISH_DELAY_MS) => {
      if (disposed) return;
      const nextPublishAt = Date.now() + delay;
      if (publishTimer !== undefined && publishAt <= nextPublishAt) return;
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      publishAt = nextPublishAt;
      publishTimer = setTimeout(publish, delay);
    };

    function publish(): void {
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      publishTimer = undefined;
      if (disposed || !ready) return;

      const groups = tracker.groups(t, snapshot);
      const completed = tracker.takeCompletions(t);
      if (taskProgressMode !== "off") {
        for (const completion of completed) pendingCompletions.set(completion.key, completion);
      }
      const revision = sourceTracker.revision(snapshot.sourceAccessBlocks);
      if (revision !== challengeRevision) {
        challengeRevision = revision;
        challenges = sourceTracker.notifications(snapshot.sourceAccessBlocks, t);
      }

      if (sending) { publishRequested = true; return; }

      const activeKeys = new Set(groups.map(group => group.key));
      for (const key of sentByGroup.keys()) {
        if (!activeKeys.has(key)) sentByGroup.delete(key);
      }

      const now = Date.now();
      let retryDelay: number | undefined;
      const presentedGroups = taskProgressMode !== "progress" ? [] : groups.map(group => {
        const previous = sentByGroup.get(group.key);
        const serialized = JSON.stringify(group);
        const percent = progressPercent(group.progress);
        if (previous && serialized === previous.serialized) return previous.group;

        const elapsed = previous ? now - previous.lastSentAt : MIN_PROGRESS_INTERVAL_MS;
        const meaningfulProgress = percent !== undefined && previous?.lastPercent !== undefined &&
          percent - previous.lastPercent >= MIN_PROGRESS_PERCENT_DELTA;
        if (previous && previous.group.paused === group.paused &&
            elapsed < MIN_PROGRESS_INTERVAL_MS && !meaningfulProgress) {
          const remaining = MIN_PROGRESS_INTERVAL_MS - elapsed;
          retryDelay = Math.min(retryDelay ?? remaining, remaining);
          return previous.group;
        }

        sentByGroup.set(group.key, { group, lastPercent: percent, lastSentAt: now, serialized });
        return group;
      });
      if (retryDelay !== undefined) schedulePublish(retryDelay);

      const payload = {
        quiet: taskProgressMode !== "progress",
        groups: presentedGroups.map(group => ({
          key: group.key, title: group.title,
          body: group.paused ? `${t("tasks.notification.paused")} · ${group.body}` : group.body,
          paused: group.paused, progress: group.progress,
          pauseLabel: t("tasks.notification.pause"), resumeLabel: t("tasks.notification.resume"),
        })),
        challenges,
        completions: [...pendingCompletions.values()].map(({ key, title, body }) => ({ key, title, body })),
      };
      const serialized = JSON.stringify({ ...payload, completions: [] });
      if (serialized === lastPayload && payload.completions.length === 0) return;
      sending = true;
      publishRequested = false;
      const sentCompletions = new Map(pendingCompletions);
      let failed = false;
      void invoke("task_notification_reconcile", { payload })
        .then(() => {
          for (const [key, completion] of sentCompletions) {
            if (pendingCompletions.get(key) === completion) pendingCompletions.delete(key);
          }
          lastPayload = serialized;
        })
        .catch(error => {
          failed = true;
          lastPayload = "";
          console.warn("[task-notifications] native reconciliation failed", error);
        })
        .finally(() => {
          sending = false;
          if (failed || publishRequested || pendingCompletions.size > 0) {
            schedulePublish(failed ? MIN_PROGRESS_INTERVAL_MS : 0);
          }
        });
    }

    const receiveAction = (value: unknown) => {
      const action = parseTaskNotificationAction(value);
      if (!action || disposed) return;
      if (action.type === "pause" || action.type === "resume") {
        onAction?.(action);
        return;
      }
      void (async () => {
        try {
          const window = getCurrentWindow();
          await window.show();
          await window.unminimize();
          await window.setFocus();
        } catch (error) {
          console.warn("[task-notifications] window focus failed", error);
        }
        if (disposed) return;
        if (onAction) onAction(action);
        else if (action.type === "openTasks") void navigate({ to: "/downloads", search: { view: "queue" } });
      })();
    };

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
    void listen<unknown>("task-notification-action", event => receiveAction(event.payload))
      .then(unlisten => {
        if (disposed) { unlisten(); return; }
        actionUnlisten = unlisten;
        ready = true;
        publish();
      })
      .catch(error => console.warn("[task-notifications] action listener failed", error));

    return () => {
      disposed = true;
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      unsubscribeSnapshots();
      unsubscribeEvents();
      unsubscribeBatches();
      actionUnlisten?.();
      void invoke("task_notification_reconcile", {
        payload: { groups: [], challenges: [], completions: [], quiet: true },
      }).catch(error => console.warn("[task-notifications] cleanup failed", error));
    };
  }, [navigate, onAction, t, taskProgressMode]);

  return null;
}
