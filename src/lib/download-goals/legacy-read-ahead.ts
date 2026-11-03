import { listLibraryNovelsWithoutDownloadGoal, setNovelDownloadGoal } from "../../db/queries/novel-download-goal";
import { isDefaultKeepAheadStored, useDownloadGoalSettingsStore } from "../../store/download-goals";
import { getEffectiveReaderGeneralSettings, useReaderStore } from "../../store/reader";

/** The retired option downloaded one chapter ahead. */
const LEGACY_READ_AHEAD_COUNT = 1;

/**
 * Turns the retired reader option "Download next chapter in advance" into download goals once (RD4).
 * Turned off for all novels, it turns the default keep-ahead off unless that was already saved.
 * A source or novel override that differs from the default becomes the library novel's own goal:
 * None where the old option was off, keep one ahead where it was on. Novels outside the library
 * get no goal, because only the default would have applied to them.
 */
export async function migrateLegacyReadAhead(): Promise<void> {
  const settings = useDownloadGoalSettingsStore.getState();
  if (settings.legacyReadAheadMigrated) return;
  const { general, readerSettingsByNovel, readerSettingsBySource } = useReaderStore.getState();
  const defaultKeepAhead = !general.autoDownloadNextChapter && !isDefaultKeepAheadStored() ? 0 : settings.defaultKeepAhead;
  const defaultOn = defaultKeepAhead > 0;
  const hasOverrides = Object.keys(readerSettingsByNovel).length > 0 || Object.keys(readerSettingsBySource).length > 0;
  for (const novel of hasOverrides ? await listLibraryNovelsWithoutDownloadGoal() : []) {
    const wanted = getEffectiveReaderGeneralSettings(
      general, readerSettingsBySource[novel.pluginId], readerSettingsByNovel[novel.id]).autoDownloadNextChapter;
    if (wanted === general.autoDownloadNextChapter || wanted === defaultOn) continue;
    await setNovelDownloadGoal(novel.id, wanted ? { kind: "keep_ahead", count: LEGACY_READ_AHEAD_COUNT } : { kind: "none" });
  }
  useDownloadGoalSettingsStore.getState().completeLegacyReadAheadMigration(defaultKeepAhead);
}
