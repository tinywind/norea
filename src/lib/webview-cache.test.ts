import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./android-scraper", () => ({
  androidScraperClearCache: vi.fn(),
  androidScraperInvalidateChapterPageCache: vi.fn(),
}));
vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: () => true,
}));

import {
  androidScraperClearCache,
  androidScraperInvalidateChapterPageCache,
} from "./android-scraper";
import { isAndroidRuntime } from "./tauri-runtime";
import {
  clearWebViewCache,
  invalidateChapterPageCache,
} from "./webview-cache";

const mockedAndroidClearCache = vi.mocked(androidScraperClearCache);
const mockedAndroidInvalidateChapterPageCache = vi.mocked(
  androidScraperInvalidateChapterPageCache,
);
const mockedInvoke = vi.mocked(invoke);
const mockedIsAndroidRuntime = vi.mocked(isAndroidRuntime);

describe("clearWebViewCache", () => {
  beforeEach(() => {
    mockedAndroidClearCache.mockReset();
    mockedAndroidInvalidateChapterPageCache.mockReset();
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

describe("invalidateChapterPageCache", () => {
  const entries = [
    {
      sourceId: "source-a",
      url: "https://source.test/chapter/1",
    },
    {
      sourceId: "source-b",
      url: "https://other.test/chapter/2",
    },
  ];

  beforeEach(() => {
    mockedAndroidClearCache.mockReset();
    mockedAndroidInvalidateChapterPageCache.mockReset();
    mockedInvoke.mockReset();
    mockedIsAndroidRuntime.mockReset();
  });

  it("skips the native bridge when there are no entries", async () => {
    await expect(invalidateChapterPageCache([])).resolves.toBeUndefined();

    expect(mockedAndroidInvalidateChapterPageCache).not.toHaveBeenCalled();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("invalidates exact entries through the desktop command", async () => {
    mockedIsAndroidRuntime.mockReturnValue(false);
    mockedInvoke.mockResolvedValue(undefined);

    await expect(invalidateChapterPageCache(entries)).resolves.toBeUndefined();

    expect(mockedInvoke).toHaveBeenCalledWith(
      "scraper_invalidate_chapter_page_cache",
      { entries },
    );
    expect(mockedAndroidInvalidateChapterPageCache).not.toHaveBeenCalled();
  });

  it("invalidates exact entries through the Android bridge", async () => {
    mockedIsAndroidRuntime.mockReturnValue(true);
    mockedAndroidInvalidateChapterPageCache.mockResolvedValue(undefined);

    await expect(invalidateChapterPageCache(entries)).resolves.toBeUndefined();

    expect(mockedAndroidInvalidateChapterPageCache).toHaveBeenCalledWith(entries);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("chunks large invalidations within the native payload limit", async () => {
    mockedIsAndroidRuntime.mockReturnValue(true);
    mockedAndroidInvalidateChapterPageCache.mockResolvedValue(undefined);
    const manyEntries = Array.from({ length: 1_001 }, (_, index) => ({
      sourceId: "source-a",
      url: `https://source.test/chapter/${index + 1}`,
    }));

    await invalidateChapterPageCache(manyEntries);

    expect(mockedAndroidInvalidateChapterPageCache).toHaveBeenCalledTimes(2);
    expect(mockedAndroidInvalidateChapterPageCache.mock.calls[0]?.[0]).toHaveLength(
      1_000,
    );
    expect(mockedAndroidInvalidateChapterPageCache.mock.calls[1]?.[0]).toHaveLength(
      1,
    );
  });

  it("stops between invalidation chunks when cancelled", async () => {
    mockedIsAndroidRuntime.mockReturnValue(false);
    const controller = new AbortController();
    mockedInvoke.mockImplementationOnce(async () => {
      controller.abort(new DOMException("Cancelled", "AbortError"));
    });
    const manyEntries = Array.from({ length: 1_001 }, (_, index) => ({
      sourceId: "source-a",
      url: `https://source.test/chapter/${index + 1}`,
    }));

    await expect(
      invalidateChapterPageCache(manyEntries, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockedInvoke).toHaveBeenCalledOnce();
  });
});
