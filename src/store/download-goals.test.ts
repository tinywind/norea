import { beforeEach, expect, it } from "vitest";
import { normalizeDownloadGoalSettings, useDownloadGoalSettingsStore } from "./download-goals";

beforeEach(() => {
  useDownloadGoalSettingsStore.setState(normalizeDownloadGoalSettings(null));
});

it("keeps 3 chapters ahead and waits for unmetered networks by default", () => {
  expect(normalizeDownloadGoalSettings(null)).toEqual({ defaultKeepAhead: 3, automaticOnMobileData: false });
  expect(normalizeDownloadGoalSettings({ defaultKeepAhead: 7, automaticOnMobileData: "yes" }))
    .toEqual({ defaultKeepAhead: 3, automaticOnMobileData: false });
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
    .toEqual({ defaultKeepAhead: 3, automaticOnMobileData: true });
});
