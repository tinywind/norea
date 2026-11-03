import { useCallback } from "react";
import { useTranslation } from "../i18n";
import { noteDownloadDeletion, stopDownloadGoals } from "../lib/download-goals/goal-service";
import { useConfirm } from "./ui/ConfirmDialog";

/**
 * After downloads are deleted, asks whether novels with a download goal should stop
 * keeping their chapters downloaded. Deleted chapters are not downloaded again either way.
 */
export function useStopDownloadGoalsOffer() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return useCallback(async (scope: "chapter" | "novel" | "all", ids: readonly number[]): Promise<void> => {
    const novelIds = await noteDownloadDeletion(scope, ids);
    if (novelIds.length === 0) return;
    const stop = await confirm({
      title: novelIds.length === 1
        ? t("downloadGoals.stopAfterDelete.titleOne")
        : t("downloadGoals.stopAfterDelete.titleMany", { count: novelIds.length }),
      message: t("downloadGoals.stopAfterDelete.message"),
      confirmLabel: t("downloadGoals.stopAfterDelete.stop"),
      cancelLabel: t("downloadGoals.stopAfterDelete.keep"),
    });
    if (stop) await stopDownloadGoals(novelIds);
  }, [confirm, t]);
}
