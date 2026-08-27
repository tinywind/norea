import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./android-scraper", () => ({
  androidScraperClearCookies: vi.fn(),
}));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: () => true,
}));
vi.mock("../store/user-agent", () => ({
  getScraperUserAgent: () => "Norea/Test",
}));

import { androidScraperClearCookies } from "./android-scraper";
import { clearPluginCookies } from "./plugin-cookies";
import { isAndroidRuntime } from "./tauri-runtime";

const mockedAndroidClearCookies = vi.mocked(androidScraperClearCookies);
const mockedInvoke = vi.mocked(invoke);
const mockedIsAndroidRuntime = vi.mocked(isAndroidRuntime);

describe("clearPluginCookies", () => {
  beforeEach(() => {
    mockedAndroidClearCookies.mockReset();
    mockedInvoke.mockReset();
    mockedIsAndroidRuntime.mockReset();
  });

  it("passes the plugin URL and assigned executor to the desktop command", async () => {
    mockedIsAndroidRuntime.mockReturnValue(false);
    mockedInvoke.mockResolvedValue(2);

    await expect(
      clearPluginCookies("source-a", "https://example.com/", "pool:1"),
    ).resolves.toBe(2);
    expect(mockedInvoke).toHaveBeenCalledWith("scraper_clear_cookies", {
      queue: "pool:1",
      sourceId: "source-a",
      url: "https://example.com/",
      userAgent: "Norea/Test",
    });
  });

  it("uses the Android scraper bridge on Android", async () => {
    mockedIsAndroidRuntime.mockReturnValue(true);
    mockedAndroidClearCookies.mockResolvedValue(3);

    await expect(
      clearPluginCookies("source-a", "https://example.com/", "pool:0"),
    ).resolves.toBe(3);
    expect(mockedAndroidClearCookies).toHaveBeenCalledWith(
      "source-a",
      "https://example.com/",
      "pool:0",
    );
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
