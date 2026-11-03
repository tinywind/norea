import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ novels: [] as { id: number; pluginId: string }[], goals: new Map<number, unknown>() }));
vi.mock("../../db/queries/novel-download-goal", () => ({
  listLibraryNovelsWithoutDownloadGoal: vi.fn(async () => mocks.novels),
  setNovelDownloadGoal: vi.fn(async (id: number, goal: unknown) => { mocks.goals.set(id, goal); return true; }),
}));

import { DOWNLOAD_GOAL_SETTINGS_KEY, normalizeDownloadGoalSettings, useDownloadGoalSettingsStore } from "../../store/download-goals";
import { READER_GENERAL_DEFAULTS, useReaderStore } from "../../store/reader";
import { migrateLegacyReadAhead } from "./legacy-read-ahead";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  mocks.novels = [{ id: 1, pluginId: "a" }, { id: 2, pluginId: "b" }, { id: 3, pluginId: "a" }];
  mocks.goals = new Map();
  useDownloadGoalSettingsStore.setState(normalizeDownloadGoalSettings(null));
  values.clear();
  useReaderStore.setState({
    general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: true }, readerSettingsByNovel: {}, readerSettingsBySource: {},
  });
});

const general = (autoDownloadNextChapter: boolean) => ({ enabled: true, general: { autoDownloadNextChapter } });

it("turns the default keep-ahead off when the old option was off and no default was saved", async () => {
  useReaderStore.setState({ general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false } });
  await migrateLegacyReadAhead();
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ defaultKeepAhead: 0, legacyReadAheadMigrated: true });
  expect(mocks.goals.size).toBe(0);
});

it("keeps a saved default keep-ahead over the old option", async () => {
  values.set(DOWNLOAD_GOAL_SETTINGS_KEY, JSON.stringify({ state: { defaultKeepAhead: 5 }, version: 0 }));
  useDownloadGoalSettingsStore.setState({ defaultKeepAhead: 5 });
  useReaderStore.setState({ general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false } });
  await migrateLegacyReadAhead();
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ defaultKeepAhead: 5, legacyReadAheadMigrated: true });
});

it("turns source and novel overrides that differ from the default into the library novel's own goal", async () => {
  useReaderStore.setState({
    readerSettingsBySource: { a: general(false) },
    readerSettingsByNovel: { 3: general(true), 9: general(false) },
  });
  await migrateLegacyReadAhead();
  expect([...mocks.goals]).toEqual([[1, { kind: "none" }]]);
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ defaultKeepAhead: 3, legacyReadAheadMigrated: true });
});

it("keeps one ahead for a novel that turned the option on while it was off for all novels", async () => {
  useReaderStore.setState({
    general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false }, readerSettingsByNovel: { 2: general(true) },
  });
  await migrateLegacyReadAhead();
  expect([...mocks.goals]).toEqual([[2, { kind: "keep_ahead", count: 1 }]]);
});

it("runs once", async () => {
  await migrateLegacyReadAhead();
  useReaderStore.setState({ general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false } });
  await migrateLegacyReadAhead();
  expect(useDownloadGoalSettingsStore.getState().defaultKeepAhead).toBe(3);
});
