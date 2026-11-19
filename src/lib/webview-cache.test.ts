import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./android-scraper", () => ({
  androidScraperClearCache: vi.fn(),
}));
vi.mock("./novel-cover-storage", () => ({
  clearPersistentSourceCoverCache: vi.fn(async () => undefined),
  invalidateAllNovelCoverSources: vi.fn(),
}));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: () => true,
}));

import { androidScraperClearCache } from "./android-scraper";
import {
  clearPersistentSourceCoverCache,
  invalidateAllNovelCoverSources,
} from "./novel-cover-storage";
import { isAndroidRuntime } from "./tauri-runtime";
import { clearWebViewCache } from "./webview-cache";

const mockedAndroidClearCache = vi.mocked(androidScraperClearCache);
const mockedClearPersistentCovers = vi.mocked(clearPersistentSourceCoverCache);
const mockedInvalidateCovers = vi.mocked(invalidateAllNovelCoverSources);
const mockedInvoke = vi.mocked(invoke);
const mockedIsAndroidRuntime = vi.mocked(isAndroidRuntime);

describe("clearWebViewCache", () => {
  beforeEach(() => {
    mockedAndroidClearCache.mockReset();
    mockedClearPersistentCovers.mockClear();
    mockedInvalidateCovers.mockClear();
    mockedInvoke.mockReset();
    mockedIsAndroidRuntime.mockReset();
  });

  it("clears every source WebView cache through the desktop command", async () => {
    mockedIsAndroidRuntime.mockReturnValue(false);
    mockedInvoke.mockResolvedValue(undefined);

    await expect(clearWebViewCache()).resolves.toBeUndefined();

    expect(mockedInvoke).toHaveBeenCalledWith("scraper_clear_cache");
    expect(mockedAndroidClearCache).not.toHaveBeenCalled();
    expect(mockedClearPersistentCovers).toHaveBeenCalledExactlyOnceWith();
    expect(mockedInvalidateCovers).toHaveBeenCalledOnce();
  });

  it("uses the Android scraper bridge on Android", async () => {
    mockedIsAndroidRuntime.mockReturnValue(true);
    mockedAndroidClearCache.mockResolvedValue(undefined);

    await expect(clearWebViewCache()).resolves.toBeUndefined();

    expect(mockedAndroidClearCache).toHaveBeenCalledOnce();
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(mockedClearPersistentCovers).toHaveBeenCalledExactlyOnceWith();
    expect(mockedInvalidateCovers).toHaveBeenCalledOnce();
  });
});
