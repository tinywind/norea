import { useEffect } from "react";
import { useTranslation } from "../i18n";
import {
  startAndroidBackgroundDownloadRecovery,
  startAndroidTaskNotifications,
} from "../lib/tasks/android-notifications";
import { startChapterDownloadQueueExecutor } from "../lib/tasks/chapter-download";
import { startTrayTaskProgress } from "../lib/tasks/tray-progress";
import { useNotificationStore } from "../store/notifications";
import { WindowsTaskNotificationBridge } from "./WindowsTaskNotificationBridge";

export function TaskNotifications() {
  const { t } = useTranslation();
  const taskProgressMode = useNotificationStore(
    (state) => state.taskProgressMode,
  );

  useEffect(() => {
    void startChapterDownloadQueueExecutor();
  }, []);

  useEffect(() => {
    return startAndroidTaskNotifications(t, taskProgressMode);
  }, [t, taskProgressMode]);

  useEffect(() => {
    return startAndroidBackgroundDownloadRecovery();
  }, []);

  useEffect(() => {
    return startTrayTaskProgress(t);
  }, [t]);

  return (
    <WindowsTaskNotificationBridge taskProgressMode={taskProgressMode} />
  );
}
