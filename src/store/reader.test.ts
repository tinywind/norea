import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const localStorageHarness = vi.hoisted(() => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  } as Storage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return { originalDescriptor, originalWindowDescriptor, values };
});

import {
  getEffectiveReaderAppearanceSettings,
  getEffectiveReaderGeneralSettings,
  READER_APPEARANCE_DEFAULTS,
  READER_GENERAL_DEFAULTS,
  READER_PRESET_THEMES,
  READER_TAP_PRESETS,
  useReaderStore,
} from "./reader";

beforeEach(() => {
  localStorageHarness.values.clear();
  useReaderStore.getState().resetReaderSettings();
});

afterAll(() => {
  if (localStorageHarness.originalDescriptor) {
    Object.defineProperty(
      globalThis,
      "localStorage",
      localStorageHarness.originalDescriptor,
    );
  } else {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
  if (localStorageHarness.originalWindowDescriptor) {
    Object.defineProperty(
      globalThis,
      "window",
      localStorageHarness.originalWindowDescriptor,
    );
  } else {
    delete (globalThis as { window?: Window }).window;
  }
});

describe("useReaderStore", () => {
  it("starts at defaults", () => {
    const state = useReaderStore.getState();
    expect(state.general).toEqual(READER_GENERAL_DEFAULTS);
    expect(state.appearance).toEqual(READER_APPEARANCE_DEFAULTS);
  });

  it("setGeneral merges pageReader without dropping other fields", () => {
    useReaderStore
      .getState()
      .setGeneral({ pageReader: true, autoScroll: true });
    expect(useReaderStore.getState().general.pageReader).toBe(true);
    expect(useReaderStore.getState().general.autoScroll).toBe(true);
    expect(useReaderStore.getState().general.swipeGestures).toBe(
      READER_GENERAL_DEFAULTS.swipeGestures,
    );
  });

  it("setGeneral keeps two-page reader tied to paged reading", () => {
    useReaderStore.getState().setGeneral({ twoPageReader: true });
    expect(useReaderStore.getState().general.pageReader).toBe(true);
    expect(useReaderStore.getState().general.twoPageReader).toBe(true);

    useReaderStore.getState().setGeneral({ pageReader: false });
    expect(useReaderStore.getState().general.pageReader).toBe(false);
    expect(useReaderStore.getState().general.twoPageReader).toBe(false);
  });

  it("setGeneral clamps autoScrollInterval to [16, 500] and rounds", () => {
    useReaderStore.getState().setGeneral({ autoScrollInterval: 0 });
    expect(useReaderStore.getState().general.autoScrollInterval).toBe(16);
    useReaderStore.getState().setGeneral({ autoScrollInterval: 9999 });
    expect(useReaderStore.getState().general.autoScrollInterval).toBe(500);
    useReaderStore.getState().setGeneral({ autoScrollInterval: 80.4 });
    expect(useReaderStore.getState().general.autoScrollInterval).toBe(80);
  });

  it("applyTapZonePreset writes the preset map and keeps the center action as menu", () => {
    const preset = READER_TAP_PRESETS.find(
      (candidate) => candidate.id === "vertical-scroll",
    )!;
    useReaderStore.getState().applyTapZonePreset(preset.id);
    const general = useReaderStore.getState().general;

    expect(general.tapZonePresetId).toBe(preset.id);
    expect(general.tapZones.topLeft).toBe(preset.zones.topLeft);
    expect(general.tapZones.bottomRight).toBe(preset.zones.bottomRight);
    expect(general.tapZones.middleCenter).toBe("menu");
  });

  it("setAppearance clamps textSize to [12, 36] and rounds", () => {
    useReaderStore.getState().setAppearance({ textSize: 0 });
    expect(useReaderStore.getState().appearance.textSize).toBe(12);
    useReaderStore.getState().setAppearance({ textSize: 999 });
    expect(useReaderStore.getState().appearance.textSize).toBe(36);
    useReaderStore.getState().setAppearance({ textSize: 20.6 });
    expect(useReaderStore.getState().appearance.textSize).toBe(21);
  });

  it("setAppearance clamps lineHeight to [1.0, 2.6]", () => {
    useReaderStore.getState().setAppearance({ lineHeight: 0.5 });
    expect(useReaderStore.getState().appearance.lineHeight).toBe(1.0);
    useReaderStore.getState().setAppearance({ lineHeight: 5 });
    expect(useReaderStore.getState().appearance.lineHeight).toBe(2.6);
  });

  it("applyTheme writes themeId + backgroundColor + textColor", () => {
    const dark = READER_PRESET_THEMES.find((theme) => theme.id === "dark")!;
    useReaderStore.getState().applyTheme(dark);
    const appearance = useReaderStore.getState().appearance;
    expect(appearance.themeId).toBe(dark.id);
    expect(appearance.backgroundColor).toBe(dark.backgroundColor);
    expect(appearance.textColor).toBe(dark.textColor);
  });

  it("saveCustomTheme adds the theme and replaces a previous entry by id", () => {
    useReaderStore.getState().saveCustomTheme({
      id: "myth",
      label: "My Theme",
      backgroundColor: "#101010",
      textColor: "#fafafa",
    });
    expect(useReaderStore.getState().appearance.customThemes).toHaveLength(1);
    useReaderStore.getState().saveCustomTheme({
      id: "myth",
      label: "My Theme v2",
      backgroundColor: "#202020",
      textColor: "#eeeeee",
    });
    const stored = useReaderStore.getState().appearance.customThemes;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.label).toBe("My Theme v2");
  });

  it("deleteCustomTheme removes only the matching id", () => {
    useReaderStore.getState().saveCustomTheme({
      id: "a",
      label: "A",
      backgroundColor: "#000",
      textColor: "#fff",
    });
    useReaderStore.getState().saveCustomTheme({
      id: "b",
      label: "B",
      backgroundColor: "#111",
      textColor: "#fff",
    });
    useReaderStore.getState().deleteCustomTheme("a");
    const remaining = useReaderStore.getState().appearance.customThemes;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("b");
  });

  it("stores only novel-specific reader setting overrides", () => {
    const novelId = 7;
    const state = useReaderStore.getState();
    state.setNovelReaderSettingsEnabled(novelId, true);
    state.setNovelGeneral(novelId, {
      pageReader: true,
      keepScreenOn: true,
      bionicReading: true,
    });
    state.setNovelAppearance(novelId, { textSize: 22 });

    const override = useReaderStore.getState().readerSettingsByNovel[novelId];
    expect(override).toEqual({
      enabled: true,
      general: { pageReader: true, keepScreenOn: true, bionicReading: true },
      appearance: { textSize: 22 },
    });

    const effectiveGeneral = getEffectiveReaderGeneralSettings(
      READER_GENERAL_DEFAULTS,
      override,
    );
    const effectiveAppearance = getEffectiveReaderAppearanceSettings(
      READER_APPEARANCE_DEFAULTS,
      override,
    );
    expect(effectiveGeneral.pageReader).toBe(true);
    expect(effectiveGeneral.keepScreenOn).toBe(true);
    expect(effectiveGeneral.bionicReading).toBe(true);
    expect(effectiveAppearance.textSize).toBe(22);
    expect(effectiveAppearance.customThemes).toBe(
      READER_APPEARANCE_DEFAULTS.customThemes,
    );
  });

  it("keeps disabled novel-specific settings without applying them", () => {
    const novelId = 7;
    useReaderStore.getState().setNovelReaderSettingsEnabled(novelId, true);
    useReaderStore.getState().setNovelAppearance(novelId, { textSize: 22 });
    useReaderStore.getState().setNovelReaderSettingsEnabled(novelId, false);

    const override = useReaderStore.getState().readerSettingsByNovel[novelId];
    expect(override).toEqual({
      enabled: false,
      appearance: { textSize: 22 },
    });
    expect(
      getEffectiveReaderAppearanceSettings(
        READER_APPEARANCE_DEFAULTS,
        override,
      ).textSize,
    ).toBe(READER_APPEARANCE_DEFAULTS.textSize);
  });

  it("applies source settings before novel settings", () => {
    const novelId = 7;
    const sourceId = "source-a";
    const state = useReaderStore.getState();

    state.setSourceReaderSettingsEnabled(sourceId, true);
    state.setSourceAppearance(sourceId, { textSize: 20, lineHeight: 1.6 });
    const sourceOverride = useReaderStore.getState().readerSettingsBySource[
      sourceId
    ];
    const sourceAppearance = getEffectiveReaderAppearanceSettings(
      READER_APPEARANCE_DEFAULTS,
      sourceOverride,
    );

    state.setNovelReaderSettingsEnabled(novelId, true);
    state.setNovelAppearance(novelId, { textSize: 24 }, sourceAppearance);
    const novelOverride = useReaderStore.getState().readerSettingsByNovel[
      novelId
    ];
    const effectiveAppearance = getEffectiveReaderAppearanceSettings(
      READER_APPEARANCE_DEFAULTS,
      sourceOverride,
      novelOverride,
    );

    expect(effectiveAppearance.textSize).toBe(24);
    expect(effectiveAppearance.lineHeight).toBe(1.6);
  });

  it("setLastReadChapter records the chapter id under the novel id", () => {
    useReaderStore.getState().setLastReadChapter(7, 42);
    expect(useReaderStore.getState().lastReadChapterByNovel[7]).toBe(42);
  });

  it("setNovelPageIndex floors negatives to 1 and rounds fractional input", () => {
    useReaderStore.getState().setNovelPageIndex(7, 0);
    expect(useReaderStore.getState().novelPageIndexByNovel[7]).toBe(1);
    useReaderStore.getState().setNovelPageIndex(7, 3.6);
    expect(useReaderStore.getState().novelPageIndexByNovel[7]).toBe(4);
  });

  it("moves A reader state to B and remaps the last-read chapter", () => {
    useReaderStore.setState({
      lastReadChapterByNovel: { 1: 11 },
      novelPageIndexByNovel: { 1: 4 },
      readerSettingsByNovel: {
        1: { enabled: true, appearance: { textSize: 24 } },
      },
    });

    useReaderStore.getState().mergeNovelReaderState({
      sourceNovelId: 1,
      targetNovelId: 2,
      chapterIdMap: { 11: 21 },
    });

    const state = useReaderStore.getState();
    expect(state.lastReadChapterByNovel).toEqual({ 2: 21 });
    expect(state.novelPageIndexByNovel).toEqual({ 2: 4 });
    expect(state.readerSettingsByNovel).toEqual({
      2: { enabled: true, appearance: { textSize: 24 } },
    });
  });

  it("keeps existing B reader overrides while always deleting A keys", () => {
    useReaderStore.setState({
      lastReadChapterByNovel: { 1: 11, 2: 22 },
      novelPageIndexByNovel: { 1: 4, 2: 8 },
      readerSettingsByNovel: {
        1: { enabled: true, appearance: { textSize: 24 } },
        2: { enabled: true, appearance: { textSize: 18 } },
      },
    });

    useReaderStore.getState().mergeNovelReaderState({
      sourceNovelId: 1,
      targetNovelId: 2,
      chapterIdMap: { 11: 21 },
      preferredLastReadChapterId: 23,
    });

    const state = useReaderStore.getState();
    expect(state.lastReadChapterByNovel).toEqual({ 2: 23 });
    expect(state.novelPageIndexByNovel).toEqual({ 2: 8 });
    expect(state.readerSettingsByNovel).toEqual({
      2: { enabled: true, appearance: { textSize: 18 } },
    });
  });

  it("drops an excluded A last-read pointer when B has no replacement", () => {
    useReaderStore.setState({
      lastReadChapterByNovel: { 1: 11 },
      novelPageIndexByNovel: { 1: 4 },
      readerSettingsByNovel: {},
    });

    useReaderStore.getState().mergeNovelReaderState({
      sourceNovelId: 1,
      targetNovelId: 2,
      chapterIdMap: {},
    });

    expect(useReaderStore.getState().lastReadChapterByNovel).toEqual({});
    expect(useReaderStore.getState().novelPageIndexByNovel).toEqual({});
  });

  it("resetReaderSettings returns general + appearance to defaults", () => {
    useReaderStore
      .getState()
      .setGeneral({ pageReader: true, twoPageReader: true });
    useReaderStore.getState().setAppearance({ textSize: 30 });
    useReaderStore.getState().resetReaderSettings();
    const state = useReaderStore.getState();
    expect(state.general).toEqual(READER_GENERAL_DEFAULTS);
    expect(state.appearance).toEqual(READER_APPEARANCE_DEFAULTS);
  });
});
