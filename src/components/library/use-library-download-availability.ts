import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { subscribeContentSyncChanges } from "../../db/content-sync-journal";
import { subscribeChapterDownloadsSettled } from "../../lib/tasks/chapter-download-activity";
import { taskScheduler } from "../../lib/tasks/scheduler";
import { hasLibraryBatchDownloadTargets } from "./library-batch-download";

export function useLibraryDownloadAvailability(
  selectedIds: ReadonlySet<number>,
  active: boolean,
) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => [
      "novel",
      "library",
      "batch-download",
      [...selectedIds].sort((left, right) => left - right),
    ] as const,
    [selectedIds],
  );
  const availability = useQuery({
    enabled: active && selectedIds.size > 0,
    queryKey,
    queryFn: ({ signal }) => hasLibraryBatchDownloadTargets(queryKey[3], signal),
  });

  useEffect(() => {
    if (!active || selectedIds.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        // Invalidating an initial fetch alone can reuse its stale in-flight result.
        void queryClient.cancelQueries({ queryKey, exact: true })
          .then(() => queryClient.invalidateQueries({ queryKey, exact: true }))
          .catch(() => undefined);
      }, 100);
    };
    const unsubscribeTasks = taskScheduler.subscribeEvents((event) => {
      if (
        (event.task.kind === "chapter.download" ||
          event.task.kind === "chapter.repairMedia" ||
          event.task.kind === "chapter.deleteDownload") &&
        event.previousStatus !== event.task.status &&
        (event.task.subject?.novelId === undefined ||
          selectedIds.has(event.task.subject.novelId))
      ) {
        refresh();
      }
    });
    const unsubscribeQueue = subscribeChapterDownloadsSettled(refresh);
    const unsubscribeMetadata = subscribeContentSyncChanges(refresh);
    return () => {
      unsubscribeTasks();
      unsubscribeQueue();
      unsubscribeMetadata();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, queryClient, queryKey, selectedIds]);

  return availability;
}
