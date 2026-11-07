import { Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { listNovelDownloadGoals } from "../db/queries/novel-download-goal";
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
  const novelId = tasks.find((task) => task.subject?.novelId !== undefined)?.subject?.novelId;
  const automatic = tasks.some((task) => task.automatic);
  const goals = useQuery({
    queryKey: DOWNLOAD_GOALS_QUERY_KEY,
    queryFn: listNovelDownloadGoals,
    enabled: novelId !== undefined && automatic,
  }).data;
  const automaticGoal = useDownloadGoalSettingsStore((state) => state.automaticGoal);
  const cooldownSeconds = useBrowseStore((state) => state.chapterDownloadCooldownSeconds);
  if (novelId === undefined) return null;
  const paused = goals?.some((row) => row.novelId === novelId && row.goal.kind === "none");
  const label = !automatic || !goals || paused || automaticGoal.kind === "none"
    ? null
    : automaticGoal.kind === "keep_ahead"
      ? t("downloadGoals.goal.keepAhead", { count: automaticGoal.count })
      : t(automaticGoal.kind === "entire" ? "downloadGoals.goal.entire" : "downloadGoals.goal.allRemaining");
  const etaMs = estimateNovelDownloadMs(novelId, records, cooldownSeconds * 1000);
  const eta = etaMs === null ? null : formatDownloadEta(etaMs);
  const line = [label, eta ? t(eta.key, { count: eta.minutes }) : null].filter(Boolean).join(" · ");
  if (!line) return null;
  return (
    <Text c="dimmed" data-download-goal-work={novelId} size="xs">
      {line}
    </Text>
  );
}
