import { MultiSelect } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getNovelById, listLibraryNovels } from "../../db/queries/novel";
import { listNovelDownloadGoals, type NovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { useTranslation } from "../../i18n";
import { setDownloadGoal } from "../../lib/download-goals/goal-service";
import { describeError } from "../../lib/errors";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { DownloadGoalChoices, sameDownloadGoal, sharedDownloadGoal } from "../DownloadGoalChoices";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { SettingsFieldRow, SettingsSection } from "../SettingsPrimitives";

export function NovelDownloadGoalSettings({ isBusy }: { isBusy: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const novels = useQuery({ queryKey: ["novel", "library", "download-goal-settings"], queryFn: () => listLibraryNovels() });
  const goals = useQuery({ queryKey: DOWNLOAD_GOALS_QUERY_KEY, queryFn: listNovelDownloadGoals });
  const sources = (novels.data ?? []).filter(novel => !novel.isLocal);
  const sourceIds = new Set(sources.map(novel => novel.id));
  const novelIds = selected.map(Number).filter(id => sourceIds.has(id));
  const current = goals.data ? sharedDownloadGoal(novelIds, goals.data) : undefined;
  const loadError = novels.error ?? goals.error;
  const change = useMutation({
    mutationFn: async ({ goal, novelIds }: { goal: NovelDownloadGoal | null; novelIds: readonly number[] }) => {
      let applied = 0;
      let skippedLocal = 0;
      for (const novelId of novelIds) {
        const novel = await getNovelById(novelId);
        if (!novel) continue;
        if (novel.isLocal) { skippedLocal++; continue; }
        await setDownloadGoal(novelId, goal);
        applied++;
      }
      return { applied, skippedLocal };
    },
    onSuccess: ({ applied, skippedLocal }) => {
      notifications.show(applied === 0
        ? { color: "warn", message: t("library.downloadGoal.noneApplied", { skipped: skippedLocal }) }
        : {
            color: "ok",
            message: skippedLocal > 0
              ? t("library.downloadGoal.doneSkippedLocal", { count: applied, skipped: skippedLocal })
              : t("library.downloadGoal.done", { count: applied }),
          });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DOWNLOAD_GOALS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["download-goal"] });
    },
    onError: error => showErrorToast(t("settings.downloads.novelGoals.title"), error),
  });
  return (
    <SettingsSection title={t("settings.downloads.novelGoals.title")}>
      <SettingsFieldRow
        label={t("settings.downloads.novelGoals.label")}
        description={t("settings.downloads.novelGoals.description")}
        error={loadError ? describeError(loadError) : undefined}
        layout="stacked"
      >
        <MultiSelect
          aria-label={t("settings.downloads.novelGoals.label")}
          data={sources.map(novel => ({ value: String(novel.id), label: novel.name }))}
          disabled={isBusy || change.isPending || novels.isPending}
          onChange={setSelected}
          searchable
          value={novelIds.map(String)}
        />
      </SettingsFieldRow>
      {novelIds.length > 0 ? <DownloadGoalChoices
        allRemainingDescription={t("downloadGoals.kind.allRemaining.many")}
        current={current}
        disabled={isBusy || change.isPending || goals.isPending || goals.isError}
        entireDescription={t("downloadGoals.kind.entire.many")}
        onChoose={goal => {
          if (current === undefined || !sameDownloadGoal(goal, current)) change.mutate({ goal, novelIds });
        }}
        pending={change.isPending}
      /> : null}
    </SettingsSection>
  );
}
