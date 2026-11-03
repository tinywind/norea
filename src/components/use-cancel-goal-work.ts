import { useCallback } from "react";
import { useTranslation } from "../i18n";
import { stopDownloadGoals } from "../lib/download-goals/goal-service";
import { taskScheduler, type TaskRecord } from "../lib/tasks/scheduler";
import { useConfirm } from "./ui/ConfirmDialog";

/** Novels whose queued or running goal work is among the tasks; cancelling that work stops their goals. */
export function goalNovelIdsOf(tasks: readonly TaskRecord[]): number[] {
  const ids = new Set<number>();
  for (const task of tasks) {
    const novelId = task.subject?.novelId;
    if (task.kind === "chapter.download" && task.automatic && task.canCancel &&
        (task.status === "queued" || task.status === "running") && novelId !== undefined) ids.add(novelId);
  }
  return [...ids].sort((left, right) => left - right);
}

/** Novels the user already chose to keep after cancelling one of their goal chapters this session. */
const keptAfterCancel = new Set<number>();

/**
 * Cancels one Downloads row. A single goal chapter is ambiguous, so the first one per novel asks
 * whether the novel's goal stops too; either way the cancelled chapter is not downloaded again.
 */
export function useCancelDownloadTask(): (task: TaskRecord) => Promise<void> {
  const { t } = useTranslation();
  const confirm = useConfirm();
  return useCallback(async (task: TaskRecord) => {
    const [novelId] = goalNovelIdsOf([task]);
    if (novelId === undefined || keptAfterCancel.has(novelId)) {
      taskScheduler.cancel(task.id);
      return;
    }
    const stop = await confirm({
      title: t("downloadGoals.stopAfterCancel.title", { name: task.subject?.novelName ?? "" }),
      message: t("downloadGoals.stopAfterCancel.message"),
      confirmLabel: t("downloadGoals.stopAfterDelete.stop"),
      cancelLabel: t("downloadGoals.stopAfterCancel.chapterOnly"),
    });
    taskScheduler.cancel(task.id);
    if (stop) await stopDownloadGoals([novelId]);
    else keptAfterCancel.add(novelId);
  }, [confirm, t]);
}

/** The line a cancel confirmation adds when it also stops novels' download goals. */
export function stopsGoalsLine(t: ReturnType<typeof useTranslation>["t"], novelIds: readonly number[]): string | null {
  if (novelIds.length === 0) return null;
  return novelIds.length === 1
    ? t("tasks.cancelStopsGoals.one")
    : t("tasks.cancelStopsGoals.many", { count: novelIds.length });
}
