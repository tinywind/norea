import { Button, Group, Loader, Progress, Text } from "@mantine/core";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startWorkMetadataRecovery } from "../../db/client";
import type { NovelDetailRecord } from "../../db/queries/novel";
import { useTranslation } from "../../i18n";
import { useStorageRecoveryStore } from "../../store/storage-recovery";
import { CheckIcon, WarningIcon } from "../ui/icons";
import { subscribeWorkMetadataChanges } from "../../lib/work-metadata";

export function StorageRecoveryNotifications() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let metadataChanged = false;
    let refreshAll = true;
    const changedWorks = new Set<string>();
    const refresh = () => {
      timer = undefined;
      for (const queryKey of [["novel", "library"], ["category", "counts"], ["download-cache"]]) {
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      }
      if (refreshAll) {
        void queryClient.invalidateQueries({ queryKey: ["novel", "detail"], refetchType: metadataChanged ? "active" : "none" });
        if (!metadataChanged) void queryClient.refetchQueries({
          queryKey: ["novel", "detail"],
          predicate: query => query.queryKey[3] === "chapters",
          type: "active",
        });
      } else {
        const cachedNovels = queryClient.getQueriesData<NovelDetailRecord | null>({ queryKey: ["novel", "detail"] });
        for (const [queryKey, novel] of cachedNovels) {
          if (queryKey.length !== 3 || !novel || !changedWorks.has(JSON.stringify([novel.pluginId, novel.path]))) continue;
          void queryClient.invalidateQueries({ queryKey });
        }
      }
      metadataChanged = false;
      refreshAll = false;
      changedWorks.clear();
    };
    const unsubscribe = useStorageRecoveryStore.subscribe((state, previous) => {
      if (state.progress?.recoveredWorks === previous.progress?.recoveredWorks && state.status !== "complete" && state.status !== "error") return;
      refreshAll = true;
      if (timer === undefined) timer = setTimeout(refresh, 100);
    });
    const unsubscribeMetadata = subscribeWorkMetadataChanges((identity) => {
      metadataChanged = true;
      if (identity) changedWorks.add(JSON.stringify([identity.pluginId, identity.novelPath]));
      else refreshAll = true;
      if (timer === undefined) timer = setTimeout(refresh, 100);
    });
    refresh();
    return () => { unsubscribe(); unsubscribeMetadata(); if (timer !== undefined) clearTimeout(timer); };
  }, [queryClient]);
  return null;
}

/**
 * A compact banner while local content recovery runs, after it fails (Retry)
 * and once it completes (Dismiss). The raw error stays under Details.
 */
export function StorageRecoveryBanner() {
  const { t } = useTranslation();
  const { status, progress, error } = useStorageRecoveryStore();
  if (status === "idle") return null;
  const title = t(status === "error" ? "storageRecovery.failed" : status === "complete" ? "storageRecovery.complete" : "storageRecovery.title");
  return (
    <div aria-live="polite" className="norea-recovery-banner" data-status={status} role="status">
      <span aria-hidden="true" className="norea-recovery-banner-icon">
        {status === "scanning" ? <Loader size="xs" /> : status === "error" ? <WarningIcon size="1.125rem" /> : <CheckIcon size="1.125rem" />}
      </span>
      <div className="norea-recovery-banner-text">
        <Text fw="var(--norea-weight-bold)" size="sm">{title}</Text>
        {progress ? (
          <Text c="dimmed" size="xs">
            {t("storageRecovery.counts", {
              completed: progress.completedWorks, total: progress.totalWorks,
              works: progress.recoveredWorks, chapters: progress.recoveredChapters, skipped: progress.skippedWorks,
            })}
          </Text>
        ) : status === "scanning" ? <Text c="dimmed" size="xs">{t("storageRecovery.description")}</Text> : null}
        {status === "scanning" ? (
          <Progress
            aria-label={title}
            mt={4}
            size="xs"
            value={progress?.totalWorks ? progress.completedWorks / progress.totalWorks * 100 : 0}
          />
        ) : null}
        {error ? (
          <details className="norea-state-details">
            <summary>{t("common.details")}</summary>
            <Text c="dimmed" component="div" size="xs">{error}</Text>
          </details>
        ) : null}
      </div>
      {status !== "scanning" ? (
        <Group className="norea-recovery-banner-actions" gap="xs" wrap="nowrap">
          {status === "error" ? (
            <Button onClick={() => startWorkMetadataRecovery(true)} size="compact-sm" variant="default">
              {t("common.retry")}
            </Button>
          ) : null}
          <Button onClick={() => useStorageRecoveryStore.setState({ status: "idle" })} size="compact-sm" variant="subtle">
            {t("storageRecovery.dismiss")}
          </Button>
        </Group>
      ) : null}
    </div>
  );
}
