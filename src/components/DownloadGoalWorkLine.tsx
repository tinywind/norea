import { Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { listNovelDownloadGoals, type NovelDownloadGoal } from "../db/queries/novel-download-goal";
import { useTranslation } from "../i18n";
import { estimateNovelDownloadMs } from "../lib/download-goals/download-eta";
import { formatDownloadEta } from "../lib/download-goals/goal-status";
import type { TaskRecord } from "../lib/tasks/task-types";
import { useBrowseStore } from "../store/browse";
import { useDownloadGoalSettingsStore } from "../store/download-goals";

export const DOWNLOAD_GOALS_QUERY_KEY = ["download-goals"] as const;

/** The goal behind a novel's queued work and when it should finish, shown on its Downloads row. */
export function DownloadGoalWorkLine({ records, tasks }: { records: readonly TaskRecord[]; tasks: readonly TaskRecord[] }) {
  const { t } = useTranslation();
  const novelId = tasks.find((task) => task.automatic)?.subject?.novelId;
  const goals = useQuery({
    queryKey: DOWNLOAD_GOALS_QUERY_KEY,
    queryFn: listNovelDownloadGoals,
    enabled: novelId !== undefined,
  }).data;
  const defaultKeepAhead = useDownloadGoalSettingsStore((state) => state.defaultKeepAhead);
  const cooldownSeconds = useBrowseStore((state) => state.chapterDownloadCooldownSeconds);
  if (novelId === undefined || !goals) return null;
  const goal: NovelDownloadGoal | undefined = goals.find((row) => row.novelId === novelId)?.goal;
  const label = !goal
    ? t("downloadGoals.goal.defaultKeepAhead", { count: defaultKeepAhead })
    : goal.kind === "keep_ahead"
      ? t("downloadGoals.goal.keepAhead", { count: goal.count })
      : t(goal.kind === "entire" ? "downloadGoals.goal.entire" : "downloadGoals.goal.allRemaining");
  const etaMs = estimateNovelDownloadMs(novelId, records, cooldownSeconds * 1000);
  const eta = etaMs === null ? null : formatDownloadEta(etaMs);
  return (
    <Text c="dimmed" data-download-goal-work={novelId} size="xs">
      {eta ? `${label} · ${t(eta.key, { count: eta.minutes })}` : label}
    </Text>
  );
}
