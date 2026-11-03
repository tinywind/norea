import { beforeEach, expect, it } from "vitest";
import { normalizeDownloadGoalSettings, useDownloadGoalSettingsStore } from "./download-goals";

beforeEach(() => {
  useDownloadGoalSettingsStore.setState(normalizeDownloadGoalSettings(null));
});

it("keeps 3 chapters ahead and waits for unmetered networks by default", () => {
  expect(normalizeDownloadGoalSettings(null))
    .toEqual({ defaultKeepAhead: 3, automaticOnMobileData: false, legacyReadAheadMigrated: false, finishedChapterKeep: 0, finishedCleanupWithoutServer: false });
  expect(normalizeDownloadGoalSettings({ defaultKeepAhead: 7, automaticOnMobileData: "yes", legacyReadAheadMigrated: 1 }))
    .toEqual({ defaultKeepAhead: 3, automaticOnMobileData: false, legacyReadAheadMigrated: false, finishedChapterKeep: 0, finishedCleanupWithoutServer: false });
});

it("accepts only the offered keep-ahead choices, including off", () => {
  for (const choice of [0, 1, 3, 5, 10]) {
    useDownloadGoalSettingsStore.getState().setDefaultKeepAhead(choice);
    expect(useDownloadGoalSettingsStore.getState().defaultKeepAhead).toBe(choice);
  }
  useDownloadGoalSettingsStore.getState().setDefaultKeepAhead(30);
  expect(useDownloadGoalSettingsStore.getState().defaultKeepAhead).toBe(3);
  useDownloadGoalSettingsStore.getState().setAutomaticOnMobileData(true);
  expect(normalizeDownloadGoalSettings(useDownloadGoalSettingsStore.getState()))
    .toEqual({ defaultKeepAhead: 3, automaticOnMobileData: true, legacyReadAheadMigrated: false, finishedChapterKeep: 0, finishedCleanupWithoutServer: false });
});

it("keeps finished-chapter removal off unless an offered choice is stored", () => {
  expect(normalizeDownloadGoalSettings({ finishedChapterKeep: 7, finishedCleanupWithoutServer: "yes" }))
    .toMatchObject({ finishedChapterKeep: 0, finishedCleanupWithoutServer: false });
  for (const choice of [5, 10, 20, 0]) {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(choice, true);
    expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ finishedChapterKeep: choice, finishedCleanupWithoutServer: true });
  }
  useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(3, false);
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ finishedChapterKeep: 0, finishedCleanupWithoutServer: false });
});
