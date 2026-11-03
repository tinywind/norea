import { describe, expect, it } from "vitest";
import { translate } from "../../i18n";
import { buildSettingsSummaries, type SettingsSummaryState } from "./settings-summaries";

const base: SettingsSummaryState = {
  appThemeId: "lavender",
  themeMode: "dark",
  appLocale: "en",
  readerTextSize: 18,
  readerPageReader: false,
  readerTwoPageReader: false,
  librarySortOrder: "nameAsc",
  storageRoot: "C:\\Users\\reader\\Norea",
  contentServerUrl: "http://192.168.0.10:8080",
  pluginVpnEnabled: false,
  logLevel: "info",
};

function summaries(overrides: Partial<SettingsSummaryState> = {}) {
  return buildSettingsSummaries({ ...base, ...overrides }, (key, values) => translate("en", key, values));
}

describe("settings section summaries", () => {
  it("states the current value of each section in one line", () => {
    expect(summaries()).toEqual({
      appearance: "Lavender · Dark",
      general: "English",
      reader: "Text 18 · Scroll",
      library: "Sorted by Title",
      downloads: "Norea",
      backup: "192.168.0.10:8080",
      network: "Plugin VPN off",
      reset: "Clear library, progress and settings",
      about: "Version and updates",
      developer: "Log level: Info",
    });
  });

  it("follows the reader mode, storage folder, server and VPN state", () => {
    const result = summaries({
      readerPageReader: true,
      readerTwoPageReader: true,
      storageRoot: null,
      contentServerUrl: "",
      pluginVpnEnabled: true,
    });
    expect(result.reader).toBe("Text 18 · Two-page");
    expect(result.downloads).toBe("No folder selected");
    expect(result.backup).toBe("No content server");
    expect(result.network).toBe("Plugin VPN on");
    expect(summaries({ storageRoot: undefined }).downloads).toBe("Loading...");
  });
});
