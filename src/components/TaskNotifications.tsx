import { useEffect } from "react";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "../i18n";
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
  const queryClient = useQueryClient();
  const taskProgressMode = useNotificationStore(
    (state) => state.taskProgressMode,
  );

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
      void queryClient.invalidateQueries({
        queryKey: ["novel"],
        refetchType: "active",
      });
    });
    const unsubscribeChapterDownloadBatches =
      subscribeChapterDownloadBatchesSettled(() => {
        void flushBatchCompletions()
          .finally(() =>
            queryClient.invalidateQueries({
              queryKey: ["novel"],
              refetchType: "active",
            }),
          )
          .catch(() => undefined);
      });
    void startChapterDownloadQueueExecutor();
    return () => {
      unsubscribeChapterDownloadBatches();
      unsubscribeChapterDownloads();
      if (pendingCompletions.size > 0 || pendingCompletionWithoutNovel) {
        void flushBatchCompletions().catch(() => undefined);
      } else if (completionFrame !== null) {
        cancelAnimationFrame(completionFrame);
      }
    };
  }, [queryClient]);

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
