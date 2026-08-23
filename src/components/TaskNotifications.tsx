import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
import { useTranslation } from "../i18n";
import {
  startAndroidBackgroundDownloadRecovery,
  startAndroidTaskNotifications,
} from "../lib/tasks/android-notifications";
import { startChapterDownloadQueueExecutor } from "../lib/tasks/chapter-download";
import { startDownloadCacheDeleteWorkExecutor } from "../lib/tasks/download-cache-delete";
import {
  openSourceAccessBrowser,
  sourceAccessBlockSourceNames,
} from "../lib/tasks/source-access-coordinator";
import {
  taskScheduler,
  type SourceAccessBlock,
} from "../lib/tasks/scheduler";
import { startTrayTaskProgress } from "../lib/tasks/tray-progress";
import { useNotificationStore } from "../store/notifications";
import { WindowsTaskNotificationBridge } from "./WindowsTaskNotificationBridge";

const SOURCE_ACCESS_NOTIFICATION_ID = "source-access-required";

export function nextAutoOpenSourceAccessBlock(
  blocks: readonly SourceAccessBlock[],
  knownScopes: Set<string>,
  pendingScopes: Set<string>,
  canBegin: (scopeKey: string) => boolean,
): SourceAccessBlock | undefined {
  const currentScopes = new Set<string>();
  for (const block of blocks) {
    currentScopes.add(block.scopeKey);
    if (!knownScopes.has(block.scopeKey)) {
      pendingScopes.add(block.scopeKey);
    }
  }
  for (const scopeKey of pendingScopes) {
    if (!currentScopes.has(scopeKey)) pendingScopes.delete(scopeKey);
  }
  knownScopes.clear();
  for (const scopeKey of currentScopes) knownScopes.add(scopeKey);
  return blocks.find(
    (block) => pendingScopes.has(block.scopeKey) && canBegin(block.scopeKey),
  );
}

export function completeAutoOpenSourceAccessAttempt(
  scopeKey: string,
  opened: boolean,
  pendingScopes: Set<string>,
  inFlightScopes: Set<string>,
): void {
  inFlightScopes.delete(scopeKey);
  if (opened) pendingScopes.delete(scopeKey);
}

export function TaskNotifications() {
  const { t } = useTranslation();
  const taskProgressMode = useNotificationStore(
    (state) => state.taskProgressMode,
  );

  useEffect(() => {
    void startChapterDownloadQueueExecutor();
  }, []);

  useEffect(() => {
    const initialSnapshot = taskScheduler.getSnapshot();
    const knownScopes = new Set(
      initialSnapshot.sourceAccessBlocks.map((block) => block.scopeKey),
    );
    const pendingAutoOpenScopes = new Set<string>();
    const autoOpenInFlightScopes = new Set<string>();
    let notificationVisible = false;

    const syncSourceAccess = () => {
      const snapshot = taskScheduler.getSnapshot();
      const autoOpenBlock = nextAutoOpenSourceAccessBlock(
        snapshot.sourceAccessBlocks,
        knownScopes,
        pendingAutoOpenScopes,
        (scopeKey) =>
          !autoOpenInFlightScopes.has(scopeKey) &&
          taskScheduler.canBeginSourceAccessVerification(scopeKey),
      );

      const firstBlock = snapshot.sourceAccessBlocks[0];
      if (!firstBlock) {
        if (notificationVisible) {
          notifications.hide(SOURCE_ACCESS_NOTIFICATION_ID);
          notificationVisible = false;
        }
        return;
      }

      const sourceNames = sourceAccessBlockSourceNames(firstBlock, snapshot);
      const sourceName = sourceNames.join(", ") || firstBlock.scopeKey;
      const notification = {
        id: SOURCE_ACCESS_NOTIFICATION_ID,
        autoClose: false as const,
        color: "orange",
        message: t("sourceAccess.notificationMessage", {
          source: sourceName,
        }),
        title: t("sourceAccess.notificationTitle"),
        withCloseButton: false,
      };
      if (notificationVisible) {
        notifications.update(notification);
      } else {
        notifications.show(notification);
        notificationVisible = true;
      }

      if (
        autoOpenBlock &&
        typeof document !== "undefined" &&
        document.visibilityState !== "hidden"
      ) {
        const scopeKey = autoOpenBlock.scopeKey;
        autoOpenInFlightScopes.add(scopeKey);
        const title =
          autoOpenBlock.challenge.kind === "captcha"
            ? t("sourceAccess.captchaTitle")
            : t("sourceAccess.cloudflareTitle");
        const newSourceNames = sourceAccessBlockSourceNames(
          autoOpenBlock,
          snapshot,
        );
        void openSourceAccessBrowser(autoOpenBlock, {
          sourceName: newSourceNames.join(", ") || scopeKey,
          title,
        }).then(
          (opened) =>
            completeAutoOpenSourceAccessAttempt(
              scopeKey,
              opened,
              pendingAutoOpenScopes,
              autoOpenInFlightScopes,
            ),
          () =>
            completeAutoOpenSourceAccessAttempt(
              scopeKey,
              false,
              pendingAutoOpenScopes,
              autoOpenInFlightScopes,
            ),
        );
      }
    };

    const unsubscribe = taskScheduler.subscribe(syncSourceAccess);
    syncSourceAccess();
    return () => {
      unsubscribe();
      notifications.hide(SOURCE_ACCESS_NOTIFICATION_ID);
    };
  }, [t]);

  useEffect(() => {
    void startDownloadCacheDeleteWorkExecutor(
      t("tasks.task.deleteDownloadCache"),
    );
  }, [t]);

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
