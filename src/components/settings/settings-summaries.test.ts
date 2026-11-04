import { describe, expect, it } from "vitest";
import { translate } from "../../i18n";
import { formatStorageFolder } from "./DownloadsSection";
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
  autoBackupSchedule: "off",
  autoUpdateExtensions: false,
  pluginVpnEnabled: false,
  logLevel: "info",
};

function summaries(overrides: Partial<SettingsSummaryState> = {}) {
  return buildSettingsSummaries({ ...base, ...overrides }, (key, values) => translate("en", key, values));
}

describe("settings section summaries", () => {
  it("names an Android folder grant by its folder instead of the encoded tree URI", () => {
    expect(summaries({ storageRoot: "content://com.android.externalstorage.documents/tree/primary%3ANorea" }).downloads)
      .toBe("Norea");
  });

  it("states the current value of each section in one line", () => {
    expect(summaries()).toEqual({
      appearance: "Lavender · Dark",
      general: "English",
      reader: "Text 18 · Scroll",
      library: "Sorted by Title",
      downloads: "Norea",
      backup: "192.168.0.10:8080",
      browse: "Extension updates are shown",
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
    expect(summaries({ autoUpdateExtensions: true }).browse).toBe("Extensions update automatically");
    expect(summaries({ autoBackupSchedule: "weekly" }).backup).toBe("Weekly backup · 192.168.0.10:8080");
    expect(summaries({ autoBackupSchedule: "daily", contentServerUrl: "" }).backup).toBe("Daily backup · No content server");
  });
});

describe("storage folder label", () => {
  it("shows an Android document tree as its volume and path", () => {
    const uri = "content://com.android.externalstorage.documents/tree/primary%3ABooks%2FNorea";
    expect(formatStorageFolder(uri, "Internal storage")).toBe("Internal storage/Books/Norea");
    expect(formatStorageFolder("content://com.android.externalstorage.documents/tree/1A2B-3C4D%3ANorea", "Internal storage"))
      .toBe("1A2B-3C4D/Norea");
  });

  it("keeps desktop paths and unknown URIs as they are", () => {
    expect(formatStorageFolder("C:\\Users\\reader\\Norea", "Internal storage")).toBe("C:\\Users\\reader\\Norea");
    expect(formatStorageFolder("content://other/document/x", "Internal storage")).toBe("content://other/document/x");
  });
});
