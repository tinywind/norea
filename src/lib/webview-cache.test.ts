import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./android-scraper", () => ({
  androidScraperClearCache: vi.fn(),
}));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: () => true,
}));

import { androidScraperClearCache } from "./android-scraper";
import { isAndroidRuntime } from "./tauri-runtime";
import { clearWebViewCache } from "./webview-cache";

const mockedAndroidClearCache = vi.mocked(androidScraperClearCache);
const mockedInvoke = vi.mocked(invoke);
const mockedIsAndroidRuntime = vi.mocked(isAndroidRuntime);

describe("clearWebViewCache", () => {
  beforeEach(() => {
    mockedAndroidClearCache.mockReset();
    mockedInvoke.mockReset();
    mockedIsAndroidRuntime.mockReset();
  });

  it("clears every source WebView cache through the desktop command", async () => {
    mockedIsAndroidRuntime.mockReturnValue(false);
    mockedInvoke.mockResolvedValue(undefined);

    await expect(clearWebViewCache()).resolves.toBeUndefined();

    expect(mockedInvoke).toHaveBeenCalledWith("scraper_clear_cache");
    expect(mockedAndroidClearCache).not.toHaveBeenCalled();
  });

  it("uses the Android scraper bridge on Android", async () => {
    mockedIsAndroidRuntime.mockReturnValue(true);
    mockedAndroidClearCache.mockResolvedValue(undefined);

    await expect(clearWebViewCache()).resolves.toBeUndefined();

    expect(mockedAndroidClearCache).toHaveBeenCalledOnce();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
