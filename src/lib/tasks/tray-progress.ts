import { invoke } from "@tauri-apps/api/core";
import { isWindowsRuntime } from "../tauri-runtime";
import { taskScheduler } from "./scheduler";
import { subscribeChapterDownloadBatchProgress } from "./chapter-download";
import {
  buildContentSyncNotificationGroup,
  subscribeSyncRuntime,
} from "./sync-runtime";
import {
  buildTrayTaskProgressForGroups,
  TaskNotificationTracker,
  type TaskNotificationTranslate,
} from "./task-notification-model";

const TRAY_UPDATE_DELAY_MS = 250;

export function startTrayTaskProgress(
  t: TaskNotificationTranslate,
): () => void {
  if (!isWindowsRuntime()) return () => undefined;

  let snapshot = taskScheduler.getSnapshot();
  const tracker = new TaskNotificationTracker(snapshot);
  let disposed = false;
  let lastPayload = "";
  let publishTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = () => {
    if (publishTimer !== undefined) return;
    publishTimer = setTimeout(() => {
      publishTimer = undefined;
      if (disposed) return;

      const syncGroup = buildContentSyncNotificationGroup(t);
      const groups = [...tracker.groups(t, snapshot), ...(syncGroup ? [syncGroup] : [])];
      const payload = buildTrayTaskProgressForGroups(groups, t);
      tracker.takeCompletions(t);
      const serialized = JSON.stringify(payload);
      if (serialized === lastPayload) return;
      lastPayload = serialized;

      void invoke("tray_set_task_progress", {
        items: payload.items,
        summary: payload.summary,
      }).catch((error) => {
        console.warn("[tray-task-progress] update failed", error);
      });
    }, TRAY_UPDATE_DELAY_MS);
  };

  const unsubscribeSnapshots = taskScheduler.subscribe(() => {
    snapshot = taskScheduler.getSnapshot();
    publish();
  });
  const unsubscribeEvents = taskScheduler.subscribeEvents(event => {
    tracker.update(event);
    publish();
  });
  const unsubscribeBatches = subscribeChapterDownloadBatchProgress(event => {
    tracker.updateBatch(event);
    publish();
  });
  const unsubscribeSync = subscribeSyncRuntime(publish);
  publish();

  return () => {
    disposed = true;
    if (publishTimer) clearTimeout(publishTimer);
    unsubscribeSnapshots();
    unsubscribeEvents();
    unsubscribeBatches();
    unsubscribeSync();
    void invoke("tray_set_task_progress", {
      items: [],
      summary: t("tasks.tray.none"),
    }).catch(() => undefined);
  };
}
