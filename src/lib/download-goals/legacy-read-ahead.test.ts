import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ novels: [] as { id: number; pluginId: string }[], goals: new Map<number, unknown>() }));
vi.mock("../../db/queries/novel-download-goal", () => ({
  listLibraryNovelsWithoutDownloadGoal: vi.fn(async () => mocks.novels),
  setNovelDownloadGoal: vi.fn(async (id: number, goal: unknown) => { mocks.goals.set(id, goal); return true; }),
}));

import { listLibraryNovelsWithoutDownloadGoal } from "../../db/queries/novel-download-goal";
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
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ automaticGoal: { kind: "none" }, legacyReadAheadMigrated: true });
  expect(mocks.goals.size).toBe(0);
});

it("keeps a saved default keep-ahead over the old option", async () => {
  values.set(DOWNLOAD_GOAL_SETTINGS_KEY, JSON.stringify({ state: { defaultKeepAhead: 5 }, version: 0 }));
  useDownloadGoalSettingsStore.setState({ automaticGoal: { kind: "keep_ahead", count: 5 } });
  useReaderStore.setState({ general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false } });
  await migrateLegacyReadAhead();
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ automaticGoal: { kind: "keep_ahead", count: 5 }, legacyReadAheadMigrated: true });
});

it("preserves explicit source and novel off overrides as pauses", async () => {
  useReaderStore.setState({
    readerSettingsBySource: { a: general(false) },
    readerSettingsByNovel: { 3: general(true), 9: general(false) },
  });
  await migrateLegacyReadAhead();
  expect([...mocks.goals]).toEqual([[1, { kind: "none" }]]);
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ automaticGoal: { kind: "keep_ahead", count: 3 }, legacyReadAheadMigrated: true });
});

it("does not let a retired per-work on override bypass the global off policy", async () => {
  useReaderStore.setState({
    general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false }, readerSettingsByNovel: { 2: general(true) },
  });
  await migrateLegacyReadAhead();
  expect([...mocks.goals]).toEqual([]);
  expect(useDownloadGoalSettingsStore.getState().automaticGoal).toEqual({ kind: "none" });
});

it("runs once", async () => {
  await migrateLegacyReadAhead();
  useReaderStore.setState({ general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false } });
  await migrateLegacyReadAhead();
  expect(useDownloadGoalSettingsStore.getState().automaticGoal).toEqual({ kind: "keep_ahead", count: 3 });
});

it("keeps a new saved global range instead of replacing it with the retired reader preference", async () => {
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "entire" });
  values.set(DOWNLOAD_GOAL_SETTINGS_KEY, JSON.stringify({ state: { automaticGoal: { kind: "entire" }, defaultKeepAhead: 0 }, version: 0 }));
  useReaderStore.setState({ general: { ...READER_GENERAL_DEFAULTS, autoDownloadNextChapter: false } });
  await migrateLegacyReadAhead();
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ automaticGoal: { kind: "entire" }, legacyReadAheadMigrated: true });
});

it("preserves an off override while the global policy is off, so re-enabling it does not erase a pause", async () => {
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "none" });
  useReaderStore.setState({ readerSettingsByNovel: { 2: general(false) } });
  await migrateLegacyReadAhead();
  expect([...mocks.goals]).toEqual([[2, { kind: "none" }]]);
  expect(useDownloadGoalSettingsStore.getState().automaticGoal).toEqual({ kind: "none" });
});

it("preserves a global choice made while legacy pauses are being read", async () => {
  let release!: (novels: { id: number; pluginId: string }[]) => void;
  vi.mocked(listLibraryNovelsWithoutDownloadGoal).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  useReaderStore.setState({ readerSettingsByNovel: { 2: general(false) } });
  const pending = migrateLegacyReadAhead();
  useDownloadGoalSettingsStore.getState().setAutomaticGoal({ kind: "all_remaining" });
  release(mocks.novels);
  await pending;
  expect(useDownloadGoalSettingsStore.getState()).toMatchObject({ automaticGoal: { kind: "all_remaining" }, legacyReadAheadMigrated: true });
});
