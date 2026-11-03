import { useCallback, useEffect } from "react";
import { Button } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
import { startDownloadGoals } from "../lib/download-goals/goal-service";
import { describeError } from "../lib/errors";
import {
  applyNovelChapterDownloadCompletion,
  applyNovelChapterDownloadCompletions,
} from "../lib/reader-query-invalidation";
import {
  startAndroidBackgroundDownloadRecovery,
  startAndroidTaskNotifications,
} from "../lib/tasks/android-notifications";
import {
  startChapterDownloadQueueExecutor,
  subscribeChapterDownloadBatchesSettled,
  subscribeChapterDownloads,
} from "../lib/tasks/chapter-download";
import { startDownloadCacheDeleteWorkExecutor } from "../lib/tasks/download-cache-delete";
import { SourceAccessNotificationTracker } from "../lib/tasks/source-access-notifications";
import {
  applyTaskNotificationAction,
  navigateToTaskNotificationDestination,
} from "../lib/tasks/task-notification-actions";
import type { TaskNotificationAction } from "../lib/tasks/native-notification-actions";
import { showErrorToast } from "../lib/runtime/error-toast";
import { taskScheduler } from "../lib/tasks/scheduler";
import { vpnDownloadNotifications } from "../lib/tasks/vpn-download-notifications";
import { getVpnDownloadRuntimeSnapshot, subscribeVpnDownloadRuntime } from "../lib/tasks/vpn-download-runtime";
import { startTrayTaskProgress } from "../lib/tasks/tray-progress";
import { useNotificationStore } from "../store/notifications";
import { WindowsTaskNotificationBridge } from "./WindowsTaskNotificationBridge";

export function TaskNotifications() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const taskProgressMode = useNotificationStore(
    (state) => state.taskProgressMode,
  );

  const handleNotificationAction = useCallback((action: TaskNotificationAction) => {
    void applyTaskNotificationAction(action, (destination) => navigateToTaskNotificationDestination(navigate, destination), t)
      .catch(error => showErrorToast(t("common.actionFailed"), error, "task-notification-action"));
  }, [navigate, t]);

  useEffect(() => {
    let completionFrame: number | null = null;
    let pendingCompletions = new Map<number, Set<number>>();
    let pendingCompletionWithoutNovel = false;

    const invalidateCompletionWithoutNovel = (includeLibrary = true) => {
      const invalidations = [
        queryClient.invalidateQueries({
          queryKey: ["novel", "detail"],
          refetchType: "none",
        }),
      ];
      if (includeLibrary) {
        invalidations.push(
          queryClient.invalidateQueries({
            queryKey: ["novel", "library"],
            refetchType: "none",
          }),
        );
      }
      return Promise.all(invalidations);
    };

    const flushBatchCompletions = async () => {
      if (completionFrame !== null) {
        cancelAnimationFrame(completionFrame);
        completionFrame = null;
      }
      const completions = pendingCompletions;
      const invalidateUnknownNovel = pendingCompletionWithoutNovel;
      pendingCompletions = new Map();
      pendingCompletionWithoutNovel = false;
      await Promise.all([
        applyNovelChapterDownloadCompletions(queryClient, completions),
        invalidateUnknownNovel
          ? invalidateCompletionWithoutNovel(completions.size === 0)
          : Promise.resolve(),
      ]);
    };

    const unsubscribeChapterDownloads = subscribeChapterDownloads((event) => {
      if (event.status.kind !== "done") return;
      if (event.job.batchId) {
        if (event.job.novelId && event.job.novelId > 0) {
          const chapterIds =
            pendingCompletions.get(event.job.novelId) ?? new Set<number>();
          chapterIds.add(event.job.id);
          pendingCompletions.set(event.job.novelId, chapterIds);
        } else {
          pendingCompletionWithoutNovel = true;
        }
        completionFrame ??= requestAnimationFrame(() => {
          void flushBatchCompletions().catch(() => undefined);
        });
        return;
      }
      if (event.job.novelId && event.job.novelId > 0) {
        void applyNovelChapterDownloadCompletion(queryClient, {
          chapterId: event.job.id,
          novelId: event.job.novelId,
        });
      } else {
        void invalidateCompletionWithoutNovel();
      }
    });
    const unsubscribeChapterDownloadBatches =
      subscribeChapterDownloadBatchesSettled(() => {
        void flushBatchCompletions().catch(() => undefined);
      });
    const restoreQueue = () => {
      notifications.hide("chapter-queue-restore-error");
      startChapterDownloadQueueExecutor((error) => {
        notifications.show({
          id: "chapter-queue-restore-error",
          autoClose: 5_000,
          color: "danger",
          title: t("tasks.restoreQueueFailed"),
          message: describeError(error),
        });
      });
    };
    restoreQueue();
    startDownloadGoals();
    if (typeof window !== "undefined") {
      window.addEventListener("norea-app-resumed", restoreQueue);
      window.addEventListener("focus", restoreQueue);
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("norea-app-resumed", restoreQueue);
        window.removeEventListener("focus", restoreQueue);
      }
      unsubscribeChapterDownloadBatches();
      unsubscribeChapterDownloads();
      if (pendingCompletions.size > 0 || pendingCompletionWithoutNovel) {
        void flushBatchCompletions().catch(() => undefined);
      } else if (completionFrame !== null) {
        cancelAnimationFrame(completionFrame);
      }
    };
  }, [queryClient, t]);

  useEffect(() => {
    const sourceTracker = new SourceAccessNotificationTracker(taskScheduler.getSnapshot());
    const shown = new Map<string, string>();
    const dismissed = new Map<string, string>();
    let lastRevision: string | undefined;
    const syncSourceAccess = () => {
      const snapshot = taskScheduler.getSnapshot();
      const revision = sourceTracker.revision(snapshot.sourceAccessBlocks);
      if (lastRevision === revision) return;
      lastRevision = revision;
      const items = sourceTracker.notifications(snapshot.sourceAccessBlocks, t);
      const currentSources = new Set(items.map(item => item.sourceId));
      for (const sourceId of shown.keys()) {
        if (currentSources.has(sourceId)) continue;
        shown.delete(sourceId);
        dismissed.delete(sourceId);
        notifications.hide(`source-access-required:${sourceId}`);
      }
      for (const sourceId of dismissed.keys()) {
        if (!currentSources.has(sourceId)) dismissed.delete(sourceId);
      }
      for (const item of items) {
        const id = `source-access-required:${item.sourceId}`;
        const identity = JSON.stringify([item.scopeKey, item.revision, item.body]);
        if (shown.get(item.sourceId) === identity || dismissed.get(item.sourceId) === identity) continue;
        const wasShown = shown.has(item.sourceId);
        shown.set(item.sourceId, identity);
        const notification = {
          id, autoClose: false, color: "warn", title: item.title,
          message: <>{item.body} <Button variant="subtle" onClick={() => handleNotificationAction({ type: "verifySource", sourceId: item.sourceId, scopeKey: item.scopeKey, revision: item.revision })}>{item.actionLabel}</Button></>,
          withCloseButton: true,
          closeButtonProps: { "aria-label": t("sourceAccess.dismissNotification") },
          onClose: () => {
            if (shown.get(item.sourceId) !== identity) return;
            shown.delete(item.sourceId);
            dismissed.set(item.sourceId, identity);
          },
        };
        if (wasShown) notifications.update(notification);
        else notifications.show(notification);
      }
    };
    const unsubscribe = taskScheduler.subscribe(syncSourceAccess);
    const unsubscribeEvents = taskScheduler.subscribeEvents(event => {
      if (sourceTracker.update(event)) syncSourceAccess();
    });
    syncSourceAccess();
    return () => {
      unsubscribe();
      unsubscribeEvents();
      const sources = [...shown.keys()];
      shown.clear();
      for (const sourceId of sources) notifications.hide(`source-access-required:${sourceId}`);
    };
  }, [handleNotificationAction, t]);

  useEffect(() => {
    void startDownloadCacheDeleteWorkExecutor(
      t("tasks.task.deleteDownloadCache"),
    ).catch((error) => {
      showErrorToast(t("tasks.task.deleteDownloadCache"), error, "download-cache-delete");
    });
  }, [t]);

  useEffect(() => {
    return startAndroidTaskNotifications(t, taskProgressMode, handleNotificationAction);
  }, [t, taskProgressMode, handleNotificationAction]);

  useEffect(() => {
    return startAndroidBackgroundDownloadRecovery();
  }, []);

  useEffect(() => {
    return startTrayTaskProgress(t);
  }, [t]);

  useEffect(() => {
    const shown = new Map<string, string>();
    const dismissed = new Map<string, string>();
    let previousPlans: ReturnType<typeof getVpnDownloadRuntimeSnapshot>["plans"] | undefined;
    let previousStatus: string | undefined;
    const syncRanges = () => {
      const { plans, run } = getVpnDownloadRuntimeSnapshot();
      if (plans === previousPlans && run?.status === previousStatus) return;
      previousPlans = plans;
      previousStatus = run?.status;
      const items = vpnDownloadNotifications(plans, t, run?.status);
      const current = new Set(items.map(item => item.id));
      for (const id of shown.keys()) {
        if (current.has(id)) continue;
        shown.delete(id);
        dismissed.delete(id);
        notifications.hide(id);
      }
      for (const id of dismissed.keys()) {
        if (!current.has(id)) dismissed.delete(id);
      }
      for (const item of items) {
        const identity = JSON.stringify([item.title, item.body, item.action]);
        if (shown.get(item.id) === identity || dismissed.get(item.id) === identity) continue;
        const wasShown = shown.has(item.id);
        shown.set(item.id, identity);
        const notification = {
          id: item.id, autoClose: false, color: "warn", title: item.title,
          message: <>{item.body} <Button variant="subtle" onClick={() => handleNotificationAction(item.action)}>{item.actionLabel}</Button></>,
          withCloseButton: true,
          closeButtonProps: { "aria-label": t("sourceAccess.dismissNotification") },
          onClose: () => {
            if (shown.get(item.id) !== identity) return;
            shown.delete(item.id);
            dismissed.set(item.id, identity);
          },
        };
        if (wasShown) notifications.update(notification);
        else notifications.show(notification);
      }
    };
    const unsubscribe = subscribeVpnDownloadRuntime(syncRanges);
    syncRanges();
    return () => {
      unsubscribe();
      const ids = [...shown.keys()];
      shown.clear();
      for (const id of ids) notifications.hide(id);
    };
  }, [handleNotificationAction, t]);

  return (
    <WindowsTaskNotificationBridge taskProgressMode={taskProgressMode} onAction={handleNotificationAction} />
  );
}
