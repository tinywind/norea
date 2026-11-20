import { afterAll, beforeEach, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  vi.stubGlobal("window", { localStorage: globalThis.localStorage });
  return values;
});
import {
  AUTOMATIC_ACTIVE_WINDOW_CHOICES,
  AUTOMATIC_KEEP_AHEAD_CHOICES,
  DOWNLOAD_GOAL_SETTINGS_KEY,
  FINISHED_CHAPTER_KEEP_CHOICES,
  normalizeDownloadGoalSettings,
  useDownloadGoalSettingsStore,
  type FinishedChapterKeepChoice,
} from "./download-goals";

beforeEach(() => {
  storage.clear();
  useDownloadGoalSettingsStore.setState(normalizeDownloadGoalSettings(null));
});
afterAll(() => { vi.unstubAllGlobals(); });

it("keeps 3 chapters ahead, 14-day active window, and waits for unmetered networks by default", () => {
  expect(normalizeDownloadGoalSettings(null)).toEqual({
    automaticGoal: { kind: "keep_ahead", count: 3 },
    automaticActiveWindow: 14,
    automaticOnMobileData: false,
    legacyReadAheadMigrated: false,
    finishedChapterKeep: "off",
    finishedChapterKeepOffMigrated: true,
    finishedCleanupWithoutServer: false,
  });
  expect(normalizeDownloadGoalSettings({
    automaticGoal: { kind: "keep_ahead", count: 7 },
    automaticActiveWindow: 99,
    automaticOnMobileData: "yes",
    legacyReadAheadMigrated: 1,
  }))
    .toEqual(normalizeDownloadGoalSettings(null));
});

it.each([0, 1, 3, 5, 10])("carries the saved keep-ahead count %s into the global policy", count => {
  expect(normalizeDownloadGoalSettings({ defaultKeepAhead: count }).automaticGoal)
    .toEqual(count === 0 ? { kind: "none" } : { kind: "keep_ahead", count });
});

it("gives a valid global policy precedence over the older count and keeps the other settings", () => {
  expect(normalizeDownloadGoalSettings({
    automaticGoal: { kind: "entire" }, defaultKeepAhead: 0, automaticActiveWindow: "unlimited",
    automaticOnMobileData: true, legacyReadAheadMigrated: true, finishedChapterKeep: 10,
    finishedChapterKeepOffMigrated: true, finishedCleanupWithoutServer: true,
  })).toEqual({
    automaticGoal: { kind: "entire" }, automaticActiveWindow: "unlimited", automaticOnMobileData: true,
    legacyReadAheadMigrated: true, finishedChapterKeep: 10, finishedChapterKeepOffMigrated: true,
    finishedCleanupWithoutServer: true,
  });
  expect(normalizeDownloadGoalSettings({ automaticGoal: { kind: "none" }, defaultKeepAhead: 10 }).automaticGoal).toEqual({ kind: "none" });
  expect(normalizeDownloadGoalSettings({ automaticGoal: { kind: "unknown" }, defaultKeepAhead: 0 }).automaticGoal).toEqual({ kind: "none" });
});

it("migrates legacy finishedChapterKeep 0 to off while preserving explicit migrated 0", () => {
  expect(normalizeDownloadGoalSettings({ finishedChapterKeep: 0 })).toMatchObject({
    finishedChapterKeep: "off",
    finishedChapterKeepOffMigrated: true,
  });
  expect(normalizeDownloadGoalSettings({ finishedChapterKeep: 0, finishedChapterKeepOffMigrated: true })).toMatchObject({
    finishedChapterKeep: 0,
    finishedChapterKeepOffMigrated: true,
  });
});

it("accepts the global ranges, active windows, and only the offered keep-ahead counts", () => {
  for (const count of AUTOMATIC_KEEP_AHEAD_CHOICES) {
    useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "keep_ahead", count });
    expect(useDownloadGoalSettingsStore.getState().automaticGoal).toEqual({ kind: "keep_ahead", count });
  }
  for (const kind of ["none", "all_remaining", "entire"] as const) {
    useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind });
    expect(useDownloadGoalSettingsStore.getState().automaticGoal).toEqual({ kind });
  }
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "keep_ahead", count: 7 });
  expect(useDownloadGoalSettingsStore.getState().automaticGoal).toEqual({ kind: "keep_ahead", count: 3 });

  for (const window of AUTOMATIC_ACTIVE_WINDOW_CHOICES) {
    useDownloadGoalSettingsStore.getState().setAutomaticActiveWindow(window);
    expect(useDownloadGoalSettingsStore.getState().automaticActiveWindow).toBe(window);
  }
});

it("persists only the global policy and leaves unrelated settings intact when it changes", () => {
  useDownloadGoalSettingsStore.setState({ automaticOnMobileData: true, legacyReadAheadMigrated: true, finishedChapterKeep: 5 });
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "all_remaining" });
  const state = useDownloadGoalSettingsStore.getState();
  expect(state).toMatchObject({ automaticGoal: { kind: "all_remaining" }, automaticOnMobileData: true, legacyReadAheadMigrated: true, finishedChapterKeep: 5 });
  const stored = (JSON.parse(storage.get(DOWNLOAD_GOAL_SETTINGS_KEY)!) as { state: unknown }).state;
  expect(stored).toHaveProperty("automaticGoal", { kind: "all_remaining" });
  expect(stored).not.toHaveProperty("defaultKeepAhead");
});

it("keeps finished-chapter removal off unless an offered choice is stored", () => {
  expect(normalizeDownloadGoalSettings({ finishedChapterKeep: 7, finishedCleanupWithoutServer: "yes" }))
    .toMatchObject({ finishedChapterKeep: "off", finishedCleanupWithoutServer: false });
  for (const choice of FINISHED_CHAPTER_KEEP_CHOICES) {
    useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(choice, true);
    expect(useDownloadGoalSettingsStore.getState()).toMatchObject({
      finishedChapterKeep: choice,
      finishedChapterKeepOffMigrated: true,
      finishedCleanupWithoutServer: true,
    });
  }
  useDownloadGoalSettingsStore.getState().setFinishedChapterCleanup(3 as FinishedChapterKeepChoice, false);
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ finishedChapterKeep: "off", finishedCleanupWithoutServer: false });
});
