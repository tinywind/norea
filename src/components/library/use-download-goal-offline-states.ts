import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { describeDownloadGoalOfflineStates } from "../../lib/download-goals/goal-offline-state";
import { subscribeChapterDownloadFailures } from "../../lib/tasks/chapter-download-failures";
import { taskScheduler } from "../../lib/tasks/scheduler";
import { useDownloadGoalSettingsStore } from "../../store/download-goals";
import { useReaderStore } from "../../store/reader";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";

/** Under the goals key, so changing a goal refreshes the card states too. */
export const DOWNLOAD_GOAL_OFFLINE_QUERY_KEY = [...DOWNLOAD_GOALS_QUERY_KEY, "offline"] as const;
const REFRESH_DELAY_MS = 2000;

/** Offline states of the library novels with a goal in effect, refreshed as downloads settle. */
export function useDownloadGoalOfflineStates(enabled: boolean) {
  const queryClient = useQueryClient();
  const states = useQuery({
    enabled,
    queryKey: DOWNLOAD_GOAL_OFFLINE_QUERY_KEY,
    queryFn: () => describeDownloadGoalOfflineStates(),
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        void queryClient.invalidateQueries({ queryKey: DOWNLOAD_GOAL_OFFLINE_QUERY_KEY, exact: true });
      }, REFRESH_DELAY_MS);
    };
    const unsubscribers = [
      taskScheduler.subscribeEvents((event) => {
        if ((event.task.kind === "chapter.download" || event.task.kind === "chapter.repairMedia" ||
            event.task.kind === "chapter.deleteDownload") && event.previousStatus !== event.task.status) refresh();
      }),
      subscribeChapterDownloadFailures(refresh),
      useReaderStore.subscribe((state, previous) => {
        if (state.lastReadChapterByNovel !== previous.lastReadChapterByNovel) refresh();
      }),
      useDownloadGoalSettingsStore.subscribe(refresh),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled, queryClient]);

  return states.data;
}
