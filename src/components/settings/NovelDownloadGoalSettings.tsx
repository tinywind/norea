import { Button, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listLibraryNovels } from "../../db/queries/novel";
import { listNovelDownloadGoals } from "../../db/queries/novel-download-goal";
import { useTranslation } from "../../i18n";
import { resumeStoppedDownloadGoals } from "../../lib/download-goals/goal-service";
import { describeError } from "../../lib/errors";
import { showErrorToast } from "../../lib/runtime/error-toast";
import { DOWNLOAD_GOALS_QUERY_KEY } from "../DownloadGoalWorkLine";
import { SettingsFieldRow, SettingsSection } from "../SettingsPrimitives";
import { ListRow } from "../ui/ListRow";

/** Keeps explicit work pauses visible without offering a second automatic download policy. */
export function NovelDownloadGoalSettings({ isBusy }: { isBusy: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const novels = useQuery({ queryKey: ["novel", "library", "download-goal-settings"], queryFn: () => listLibraryNovels() });
  const goals = useQuery({ queryKey: DOWNLOAD_GOALS_QUERY_KEY, queryFn: listNovelDownloadGoals });
  const stopped = new Set((goals.data ?? []).filter(row => row.goal.kind === "none").map(row => row.novelId));
  const paused = (novels.data ?? []).filter(novel => !novel.isLocal && stopped.has(novel.id));
  const loadError = novels.error ?? goals.error;
  const resume = useMutation({
    mutationFn: (novelIds: readonly number[]) => resumeStoppedDownloadGoals(novelIds),
    onSuccess: count => notifications.show({ color: "ok", message: t("settings.downloads.pausedWorks.resumed", { count }) }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: DOWNLOAD_GOALS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: ["download-goal"] });
    },
    onError: error => showErrorToast(t("settings.downloads.pausedWorks.title"), error),
  });
  const disabled = isBusy || resume.isPending || novels.isPending || goals.isPending || Boolean(loadError);
  return (
    <SettingsSection title={t("settings.downloads.pausedWorks.title")}>
      <SettingsFieldRow label={t("settings.downloads.pausedWorks.label")}
        description={t("settings.downloads.pausedWorks.description")}
        error={loadError ? describeError(loadError) : undefined} layout="stacked">
        <Stack gap="xs">
          {paused.length === 0 ? <Text c="dimmed" size="sm">{t("settings.downloads.pausedWorks.empty")}</Text> : (
            <>
              <Button disabled={disabled} onClick={() => resume.mutate(paused.map(novel => novel.id))} variant="default">
                {t("settings.downloads.pausedWorks.resumeAll", { count: paused.length })}
              </Button>
              {paused.map(novel => <ListRow key={novel.id} title={novel.name}
                subtitle={t("settings.downloads.pausedWorks.paused")}
                trailing={<Button disabled={disabled} onClick={() => resume.mutate([novel.id])} size="compact-sm" variant="subtle">
                  {t("downloadGoals.paused.resume")}
                </Button>} />)}
            </>
          )}
        </Stack>
      </SettingsFieldRow>
    </SettingsSection>
  );
}
