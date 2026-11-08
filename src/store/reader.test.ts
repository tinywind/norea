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
  getPortableReaderAnchor,
  isApplyingSharedReaderResume,
  getEffectiveReaderAppearanceSettings,
  getEffectiveReaderGeneralSettings,
  READER_APPEARANCE_DEFAULTS,
  READER_CHAPTER_SCROLL_ANCHOR_LIMIT,
  READER_GENERAL_DEFAULTS,
  READER_PRESET_THEMES,
  READER_TAP_PRESETS,
  TAP_ZONE_DEFAULTS,
  useReaderStore,
} from "./reader";

beforeEach(() => {
  localStorageHarness.values.clear();
  useReaderStore.getState().resetReaderSettings();
  useReaderStore.getState().resetReadingProgress();
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
  it("fills omitted current reader settings with defaults", async () => {
    localStorageHarness.values.set(
      "reader-settings",
      JSON.stringify({
        state: { general: { pageReader: true } },
        version: 0,
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().general.pageReader).toBe(true);
    expect(
      useReaderStore.getState().general.autoDownloadNextChapter,
    ).toBe(true);
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

  it("uses only the top center for previous in the top-center-previous preset", () => {
    useReaderStore.getState().applyTapZonePreset("top-center-previous");
    const general = useReaderStore.getState().general;

    expect(general.tapZonePresetId).toBe("top-center-previous");
    expect(general.tapZones).toEqual({
      topLeft: "next",
      topCenter: "previous",
      topRight: "next",
      middleLeft: "next",
      middleCenter: "menu",
      middleRight: "next",
      bottomLeft: "next",
      bottomCenter: "next",
      bottomRight: "next",
    });
  });

  it("restores the top-center-previous preset after settings rehydration", async () => {
    useReaderStore.getState().applyTapZonePreset("top-center-previous");
    const selectedGeneral = useReaderStore.getState().general;
    const storedSettings = localStorageHarness.values.get("reader-settings")!;
    useReaderStore.getState().resetReaderSettings();
    localStorageHarness.values.set("reader-settings", storedSettings);

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().general.tapZonePresetId).toBe(
      "top-center-previous",
    );
    expect(useReaderStore.getState().general.tapZones).toEqual(
      selectedGeneral.tapZones,
    );
  });

  it("offers each tap zone layout once", () => {
    const layouts = READER_TAP_PRESETS.map((preset) => JSON.stringify(preset.zones));
    expect(new Set(layouts).size).toBe(layouts.length);
    expect(READER_TAP_PRESETS.map((preset) => preset.id)).not.toContain("bottom-forward");
  });

  it("rehydrates the removed bottom-forward preset as balanced in every scope", async () => {
    const customZones = { ...TAP_ZONE_DEFAULTS, topLeft: "none" as const, bottomRight: "previous" as const };
    localStorageHarness.values.set(
      "reader-settings",
      JSON.stringify({
        state: {
          general: { tapZonePresetId: "bottom-forward", tapZones: customZones },
          readerSettingsBySource: {
            "source-a": { enabled: true, general: { tapZonePresetId: "bottom-forward" } },
          },
          readerSettingsByNovel: {
            7: { enabled: true, general: { tapZonePresetId: "bottom-forward", tapZones: customZones } },
          },
        },
        version: 0,
      }),
    );

    await useReaderStore.persist.rehydrate();

    const state = useReaderStore.getState();
    expect(state.general.tapZonePresetId).toBe("balanced");
    expect(state.general.tapZones).toEqual(customZones);
    expect(state.readerSettingsBySource["source-a"]?.general?.tapZonePresetId).toBe("balanced");
    expect(state.readerSettingsBySource["source-a"]?.general?.tapZones).toBeUndefined();
    expect(state.readerSettingsByNovel[7]?.general?.tapZonePresetId).toBe("balanced");
    expect(state.readerSettingsByNovel[7]?.general?.tapZones).toEqual(customZones);
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
      autoDownloadNextChapter: false,
    });
    state.setNovelAppearance(novelId, { textSize: 22 });

    const override = useReaderStore.getState().readerSettingsByNovel[novelId];
    expect(override).toEqual({
      enabled: true,
      general: {
        pageReader: true,
        keepScreenOn: true,
        bionicReading: true,
        autoDownloadNextChapter: false,
      },
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
    expect(effectiveGeneral.autoDownloadNextChapter).toBe(false);
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

  it("starts a scope from what it inherits and keeps a scope that is already on", () => {
    const state = useReaderStore.getState();
    useReaderStore.setState({
      readerSettingsByNovel: { 7: { appearance: { textSize: 40 }, enabled: false } },
    });

    state.startNovelReaderSettings(7);
    state.startSourceReaderSettings("source-a");
    expect(useReaderStore.getState().readerSettingsByNovel[7]).toEqual({ enabled: true });
    expect(useReaderStore.getState().readerSettingsBySource["source-a"]).toEqual({ enabled: true });

    state.setNovelAppearance(7, { textSize: 30 }, READER_APPEARANCE_DEFAULTS);
    state.startNovelReaderSettings(7);
    expect(useReaderStore.getState().readerSettingsByNovel[7]?.appearance?.textSize).toBe(30);
  });

  it("copies a novel's effective settings, source values included, to all novels", () => {
    const state = useReaderStore.getState();
    state.setSourceAppearance("source-a", { lineHeight: 2 });
    state.setSourceGeneral("source-a", { pageReader: true });
    state.startNovelReaderSettings(7);
    state.setNovelAppearance(7, { textSize: 30 }, {
      ...READER_APPEARANCE_DEFAULTS,
      lineHeight: 2,
    });

    state.copyReaderSettingsToGlobal({ kind: "novel", novelId: 7, sourceId: "source-a" });

    const next = useReaderStore.getState();
    expect(next.appearance.textSize).toBe(30);
    expect(next.appearance.lineHeight).toBe(2);
    expect(next.general.pageReader).toBe(true);
    expect(next.readerSettingsByNovel[7]?.enabled).toBe(false);
    expect(next.readerSettingsBySource["source-a"]?.enabled).toBe(true);
  });

  it("copies a source's settings to all novels and turns the source override off", () => {
    const state = useReaderStore.getState();
    state.setSourceAppearance("source-a", { textSize: 20 });

    state.copyReaderSettingsToGlobal({ kind: "source", sourceId: "source-a" });

    expect(useReaderStore.getState().appearance.textSize).toBe(20);
    expect(useReaderStore.getState().readerSettingsBySource["source-a"]?.enabled).toBe(false);
  });

  it("does not copy a scope whose override is off", () => {
    const state = useReaderStore.getState();
    useReaderStore.setState({
      readerSettingsByNovel: { 7: { appearance: { textSize: 40 }, enabled: false } },
    });
    const before = useReaderStore.getState();

    state.copyReaderSettingsToGlobal({ kind: "novel", novelId: 7 });

    expect(useReaderStore.getState()).toBe(before);
  });

  it("setNovelPageIndex floors negatives to 1 and rounds fractional input", () => {
    useReaderStore.getState().setNovelPageIndex(7, 0);
    expect(useReaderStore.getState().novelPageIndexByNovel[7]).toBe(1);
    useReaderStore.getState().setNovelPageIndex(7, 3.6);
    expect(useReaderStore.getState().novelPageIndexByNovel[7]).toBe(4);
  });

  it("removes only the deleted work's reading state and keeps it removed after rehydration", async () => {
    const retainedSettings = { enabled: true, appearance: { textSize: 18 } };
    useReaderStore.setState({
      lastReadChapterByNovel: { 1: 11, 2: 22 },
      novelPageIndexByNovel: { 1: 4, 2: 8 },
      readerSettingsByNovel: { 1: { enabled: true }, 2: retainedSettings },
      readerSettingsBySource: { demo: retainedSettings },
    });

    useReaderStore.getState().removeNovelReaderState(1);
    await useReaderStore.persist.rehydrate();

    const state = useReaderStore.getState();
    expect(state.lastReadChapterByNovel).toEqual({ 2: 22 });
    expect(state.novelPageIndexByNovel).toEqual({ 2: 8 });
    expect(state.readerSettingsByNovel).toEqual({ 2: retainedSettings });
    expect(state.readerSettingsBySource).toEqual({ demo: retainedSettings });
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

  it("saves, forgets and caps chapter scroll anchors", () => {
    const anchor = {
      novelId: 1,
      progress: 40,
      segmentCount: 10,
      segmentIndex: 4,
      mediaOrdinal: 0,
      offset: 0.5,
    };
    useReaderStore.setState({ chapterScrollAnchors: {} });
    for (let chapterId = 1; chapterId <= READER_CHAPTER_SCROLL_ANCHOR_LIMIT + 1; chapterId += 1) {
      vi.spyOn(Date, "now").mockReturnValueOnce(chapterId);
      useReaderStore.getState().setChapterScrollAnchor(chapterId, anchor);
    }

    const anchors = useReaderStore.getState().chapterScrollAnchors;
    expect(Object.keys(anchors)).toHaveLength(READER_CHAPTER_SCROLL_ANCHOR_LIMIT);
    expect(anchors[1]).toBeUndefined();
    expect(anchors[2]).toEqual({ ...anchor, savedAt: 2 });

    const before = useReaderStore.getState();
    useReaderStore.getState().setChapterScrollAnchor(1, null);
    expect(useReaderStore.getState()).toBe(before);
    useReaderStore.getState().setChapterScrollAnchor(2, null);
    expect(useReaderStore.getState().chapterScrollAnchors[2]).toBeUndefined();
  });

  it("keeps valid chapter scroll anchors through rehydration and drops malformed ones", async () => {
    const valid = {
      novelId: 1,
      progress: 40,
      savedAt: 5,
      segmentCount: 10,
      segmentIndex: 4,
      offset: 0.5,
    };
    localStorageHarness.values.set(
      "reader-settings",
      JSON.stringify({
        state: {
          chapterScrollAnchors: {
            11: valid,
            12: { ...valid, segmentIndex: 10 },
            13: { ...valid, offset: 2 },
            nope: valid,
          },
        },
        version: 0,
      }),
    );

    await useReaderStore.persist.rehydrate();

    expect(useReaderStore.getState().chapterScrollAnchors).toEqual({ 11: valid });
  });

  it("moves chapter scroll anchors with novel merges and drops them with the work", () => {
    const anchor = {
      progress: 40,
      savedAt: 5,
      segmentCount: 10,
      segmentIndex: 4,
      offset: 0.5,
    };
    useReaderStore.setState({
      chapterScrollAnchors: {
        11: { ...anchor, novelId: 1 },
        12: { ...anchor, novelId: 1 },
        21: { ...anchor, novelId: 2, segmentIndex: 1 },
        31: { ...anchor, novelId: 3 },
      },
    });

    useReaderStore.getState().mergeNovelReaderState({
      sourceNovelId: 1,
      targetNovelId: 2,
      chapterIdMap: { 11: 21, 12: 22 },
    });

    expect(useReaderStore.getState().chapterScrollAnchors).toEqual({
      21: { ...anchor, novelId: 2, segmentIndex: 1 },
      22: { ...anchor, novelId: 2 },
      31: { ...anchor, novelId: 3 },
    });

    useReaderStore.getState().removeNovelReaderState(2);
    expect(useReaderStore.getState().chapterScrollAnchors).toEqual({
      31: { ...anchor, novelId: 3 },
    });
    useReaderStore.getState().resetReadingProgress();
    expect(useReaderStore.getState().chapterScrollAnchors).toEqual({});
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

  it("resetReaderSettings clears novel and source overrides unless asked to keep them", () => {
    const store = useReaderStore.getState();
    store.setAppearance({ textSize: 30 });
    store.setNovelAppearance(7, { textSize: 24 });
    store.setSourceGeneral("source-a", { pageReader: true });

    useReaderStore.getState().resetReaderSettings({ keepScopedSettings: true });

    let state = useReaderStore.getState();
    expect(state.appearance).toEqual(READER_APPEARANCE_DEFAULTS);
    expect(state.readerSettingsByNovel[7]?.appearance?.textSize).toBe(24);
    expect(state.readerSettingsBySource["source-a"]?.general?.pageReader).toBe(true);

    useReaderStore.getState().resetReaderSettings();

    state = useReaderStore.getState();
    expect(state.readerSettingsByNovel).toEqual({});
    expect(state.readerSettingsBySource).toEqual({});
  });
});


describe("portable shared reading positions", () => {
  const anchor = { novelId: 7, segmentIndex: 2, mediaOrdinal: 0, offset: 0.25, segmentCount: 12, progress: 20, savedAt: 1000 };

  it("projects document-relative anchors without local row identities or page indexes", () => {
    expect(getPortableReaderAnchor({ ...anchor, novelId: 12345 })).toEqual({
      segmentIndex: 2, mediaOrdinal: 0, offset: 0.25, segmentCount: 12, progress: 20, savedAt: 1000,
    });
    expect(getPortableReaderAnchor({ ...anchor, segmentIndex: 12 })).toBeNull();
    expect(getPortableReaderAnchor({ ...anchor, offset: Number.NaN })).toBeNull();
  });

  it("maps an incoming position to destination IDs and suppresses synchronous publication", () => {
    const state = useReaderStore.getState();
    state.setNovelPageIndex(99, 50);
    state.setLastReadChapter(8, 80);
    const observed: boolean[] = [];
    const unsubscribe = useReaderStore.subscribe(() => observed.push(isApplyingSharedReaderResume()));
    state.applySharedResume({ novelId: 99, chapterId: 901, anchor: getPortableReaderAnchor(anchor), openedAt: 10 });
    unsubscribe();
    expect(observed).toEqual([true]);
    expect(isApplyingSharedReaderResume()).toBe(false);
    expect(useReaderStore.getState().lastReadChapterByNovel).toEqual({ 8: 80, 99: 901 });
    expect(useReaderStore.getState().chapterScrollAnchors[901]).toEqual({ ...anchor, novelId: 99 });
    expect(useReaderStore.getState().novelPageIndexByNovel[99]).toBeUndefined();
  });

  it("clears an obsolete anchor when shared progress has no valid anchor", () => {
    const state = useReaderStore.getState();
    state.setChapterScrollAnchor(70, anchor);
    state.applySharedResume({ novelId: 7, chapterId: 70, anchor: { ...getPortableReaderAnchor(anchor)!, segmentCount: 0 }, openedAt: 10 });
    expect(useReaderStore.getState().chapterScrollAnchors[70]).toBeUndefined();
    expect(useReaderStore.getState().lastReadChapterByNovel[7]).toBe(70);
  });

  it("applies an explicit resume clear only to the named work", () => {
    const state = useReaderStore.getState();
    state.setLastReadChapter(7, 70);
    state.setLastReadChapter(8, 80);
    state.setChapterScrollAnchor(70, anchor);
    state.setChapterScrollAnchor(80, { ...anchor, novelId: 8 });
    state.applySharedResume({ novelId: 7, chapterId: null, anchor: null, openedAt: null });
    expect(useReaderStore.getState().lastReadChapterByNovel).toEqual({ 8: 80 });
    expect(Object.keys(useReaderStore.getState().chapterScrollAnchors)).toEqual(["80"]);
  });
});
