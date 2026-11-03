import { useSyncExternalStore } from "react";
import { Button, Group, Text } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation, type TranslationKey } from "../i18n";
import type { DownloadGoalPause } from "../lib/download-goals/budget";
import {
  allowAutomaticDownloadsOnce,
  getDownloadGoalPauseSnapshot,
  resumeDownloadGoalsAfterRestore,
  subscribeDownloadGoalPause,
} from "../lib/download-goals/goal-service";

const MESSAGE_KEYS: Readonly<Record<DownloadGoalPause, TranslationKey>> = {
  metered: "downloadGoals.paused.metered",
  battery: "downloadGoals.paused.battery",
  storage: "downloadGoals.paused.storage",
  restore: "downloadGoals.paused.restore",
};

const ACTION_KEYS: Readonly<Record<DownloadGoalPause, TranslationKey>> = {
  metered: "downloadGoals.paused.allowOnce",
  battery: "downloadGoals.paused.allowOnce",
  storage: "downloadGoals.paused.manageStorage",
  restore: "downloadGoals.paused.resume",
};

/** One Needs attention line while a budget pauses automatic goal downloads. */
export function DownloadGoalAttention() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pause } = useSyncExternalStore(subscribeDownloadGoalPause, getDownloadGoalPauseSnapshot, getDownloadGoalPauseSnapshot);
  if (pause === null) return null;

  const act = () => {
    if (pause === "storage") void navigate({ to: "/downloads", search: { view: "storage" } });
    else if (pause === "restore") resumeDownloadGoalsAfterRestore();
    else allowAutomaticDownloadsOnce();
  };

  return (
    <section className="norea-source-access-banner" data-download-goal-pause={pause} role="status">
      <div className="norea-source-access-copy">
        <Text component="h3" fw={700} size="sm">{t(MESSAGE_KEYS[pause])}</Text>
      </div>
      <Group gap="xs" justify="flex-end">
        <Button onClick={act} size="xs" variant="light">{t(ACTION_KEYS[pause])}</Button>
      </Group>
    </section>
  );
}
