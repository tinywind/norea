import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import en from "../../../strings/languages/en/app.json";
import ko from "../../../strings/languages/ko/app.json";
import { translate, type TranslationKey } from "../../i18n";
import { settingsRowSelector } from "./settings-reveal";
import { SETTINGS_SEARCH_ROWS, searchSettings, settingsRowDescriptionKey } from "./settings-search-index";

const SECTION_SOURCES = [
  "./AppearanceSection.tsx",
  "./GeneralSection.tsx",
  "./DownloadsSection.tsx",
  "./BackupSection.tsx",
  "./NetworkSection.tsx",
  "./ResetSection.tsx",
  "./AboutSection.tsx",
  "./DeveloperSection.tsx",
  "../LibrarySettingsPanel.tsx",
  "../ReaderSettingsPanel.tsx",
];
const ROW_LABEL = /<(?:SettingsFieldRow|SettingsPercentSlider|SettingSlider|SettingsAdvancedGroup)\b(?:(?!<)[\s\S]){0,400}?\blabel=\{t\("([^"]+)"/g;

const enT = (key: TranslationKey) => translate("en", key);
const koT = (key: TranslationKey) => translate("ko", key);
const titles = (query: string, t = enT) => searchSettings(query, t).map((result) => result.title);

describe("settings search index", () => {
  it("lists every labeled row the settings sections render", () => {
    const indexed = new Set<string>(SETTINGS_SEARCH_ROWS.map((row) => row.label));
    const rendered = SECTION_SOURCES.flatMap((path) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      return [...source.matchAll(ROW_LABEL)].map((match) => match[1]!);
    });
    expect(rendered.length).toBeGreaterThan(60);
    const missing = rendered.filter((label) => !indexed.has(label));
    expect(missing, "add these rows to SETTINGS_SEARCH_ROWS").toEqual([]);
    const stale = [...indexed].filter((label) => !rendered.includes(label));
    expect(stale, "remove these rows from SETTINGS_SEARCH_ROWS").toEqual([]);
  });

  it("names only keys that exist in both locales", () => {
    const keys = SETTINGS_SEARCH_ROWS.flatMap((row) => [row.label, row.condition, row.synonyms]).filter(Boolean) as string[];
    for (const key of keys) {
      expect(en, key).toHaveProperty([key]);
      expect(ko, key).toHaveProperty([key]);
    }
  });

  it("derives row descriptions from the label key", () => {
    expect(settingsRowDescriptionKey("settings.app.themeMode.label")).toBe("settings.app.themeMode.description");
    expect(settingsRowDescriptionKey("readerSettings.keepScreenOn")).toBe("readerSettings.keepScreenOn.description");
  });
});

describe("searchSettings", () => {
  it("reads results as Section › Row and matches labels first", () => {
    expect(titles("theme mode")[0]).toBe(`${enT("settings.category.appearance.title")} › ${enT("settings.app.themeMode.label")}`);
  });

  it("finds a row by a per-locale synonym", () => {
    expect(titles("dark")).toContain(`${enT("settings.category.appearance.title")} › ${enT("settings.app.themeMode.label")}`);
    expect(titles("다크", koT)).toContain(`${koT("settings.category.appearance.title")} › ${koT("settings.app.themeMode.label")}`);
  });

  it("finds a row by words of its description", () => {
    const description = enT(settingsRowDescriptionKey("browseSettings.chapterDownloadCooldown"));
    const word = description.split(/\s+/).find((part) => part.length > 6)!;
    expect(searchSettings(word, enT).map((result) => result.row.label)).toContain("browseSettings.chapterDownloadCooldown");
  });

  it("labels reader rows as global defaults and says when a row is under Advanced or conditional", () => {
    const custom = searchSettings("custom css", enT).find((result) => result.row.label === "readerSettings.customCss")!;
    expect(custom.notes).toEqual([enT("settingsSearch.globalDefault"), enT("settingsSearch.advanced")]);
    const interval = searchSettings(enT("readerSettings.autoScrollInterval"), enT)[0]!;
    expect(interval.notes).toContain(enT("settingsSearch.condition.autoScroll"));
  });

  it("returns nothing for an empty query or one that matches no row", () => {
    expect(searchSettings("   ", enT)).toEqual([]);
    expect(searchSettings("zzzz-no-such-setting", enT)).toEqual([]);
  });

  it("builds a row selector that survives quotes in a label", () => {
    expect(settingsRowSelector('Say "hi"')).toBe('[data-settings-label="Say \\"hi\\""]');
  });
});
