import { Group, Progress, Stack, Text } from "@mantine/core";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startWorkMetadataRecovery } from "../../db/client";
import { useTranslation } from "../../i18n";
import { useStorageRecoveryStore } from "../../store/storage-recovery";
import { TextButton } from "../TextButton";
import { subscribeWorkMetadataChanges } from "../../lib/work-metadata";

export function StorageRecoveryNotifications() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let metadataChanged = false;
    const refresh = () => {
      timer = undefined;
      for (const queryKey of [["novel", "library"], ["category", "counts"], ["download-cache"]]) {
        void queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false });
      }
      void queryClient.invalidateQueries({ queryKey: ["novel", "detail"], refetchType: metadataChanged ? "active" : "none" });
      if (!metadataChanged) void queryClient.refetchQueries({
          queryKey: ["novel", "detail"],
          predicate: query => query.queryKey[3] === "chapters",
          type: "active",
        });
      metadataChanged = false;
    };
    const unsubscribe = useStorageRecoveryStore.subscribe((state, previous) => {
      if (state.progress?.recoveredWorks === previous.progress?.recoveredWorks && state.status !== "complete" && state.status !== "error") return;
      if (timer === undefined) timer = setTimeout(refresh, 100);
    });
    const unsubscribeMetadata = subscribeWorkMetadataChanges(() => {
      metadataChanged = true;
      if (timer === undefined) timer = setTimeout(refresh, 100);
    });
    refresh();
    return () => { unsubscribe(); unsubscribeMetadata(); if (timer !== undefined) clearTimeout(timer); };
  }, [queryClient]);
  return null;
}

export function StorageRecoveryStatus() {
  const { t } = useTranslation();
  const { status, progress, error } = useStorageRecoveryStore();
  if (status === "idle") return null;
  return (
    <Stack gap="xs" p="sm" role="status" aria-live="polite">
      <Text fw={600}>{t(status === "error" ? "storageRecovery.failed" : status === "complete" ? "storageRecovery.complete" : "storageRecovery.title")}</Text>
      {status === "scanning" ? <Text size="sm">{t("storageRecovery.description")}</Text> : null}
      {progress ? <Text size="sm">{t("storageRecovery.counts", {
        completed: progress.completedWorks, total: progress.totalWorks,
        works: progress.recoveredWorks, chapters: progress.recoveredChapters, skipped: progress.skippedWorks,
      })}</Text> : null}
      {status === "scanning" ? <>
        <Text size="sm" truncate>{progress?.currentWork ?? t("storageRecovery.discovering")}</Text>
        <Progress aria-label={t("storageRecovery.title")} animated value={progress?.totalWorks ? progress.completedWorks / progress.totalWorks * 100 : 0} />
      </> : null}
      {error ? <Text c="red" size="sm">{error}</Text> : null}
      {status !== "scanning" ? <Group gap="xs">
        {status === "error" ? <TextButton onClick={() => startWorkMetadataRecovery(true)}>{t("common.retry")}</TextButton> : null}
        <TextButton onClick={() => useStorageRecoveryStore.setState({ status: "idle" })}>{t("storageRecovery.dismiss")}</TextButton>
      </Group> : null}
    </Stack>
  );
}
