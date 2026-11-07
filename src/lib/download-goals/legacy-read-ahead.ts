import { listLibraryNovelsWithoutDownloadGoal, setNovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { isAutomaticDownloadGoalStored, useDownloadGoalSettingsStore } from "../../store/download-goals";
import { getEffectiveReaderGeneralSettings, useReaderStore } from "../../store/reader";

/** Carries the retired reader option into an unsaved global policy and explicit pauses, without reviving positive per-work overrides. */
export async function migrateLegacyReadAhead(): Promise<void> {
  const settings = useDownloadGoalSettingsStore.getState();
  if (settings.legacyReadAheadMigrated) return;
  const { general, readerSettingsByNovel, readerSettingsBySource } = useReaderStore.getState();
  const automaticGoal = !general.autoDownloadNextChapter && !isAutomaticDownloadGoalStored()
    ? { kind: "none" as const } : settings.automaticGoal;
  const hasOverrides = Object.keys(readerSettingsByNovel).length > 0 || Object.keys(readerSettingsBySource).length > 0;
  for (const novel of hasOverrides ? await listLibraryNovelsWithoutDownloadGoal() : []) {
    const wanted = getEffectiveReaderGeneralSettings(
      general, readerSettingsBySource[novel.pluginId], readerSettingsByNovel[novel.id]).autoDownloadNextChapter;
    if (wanted || wanted === general.autoDownloadNextChapter) continue;
    await setNovelDownloadGoal(novel.id, { kind: "none" });
  }
  const current = useDownloadGoalSettingsStore.getState();
  current.completeLegacyReadAheadMigration(current.automaticGoal === settings.automaticGoal ? automaticGoal : current.automaticGoal);
}
