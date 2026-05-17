import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db/queries/download-cache", () => ({
  listDownloadCacheChapters: vi.fn(),
  listDownloadCacheNovels: vi.fn(),
}));

vi.mock("./download-cache-media", () => ({
  backfillDownloadCacheMediaBytes: vi.fn(),
}));

import {
  listDownloadCacheChapters,
  listDownloadCacheNovels,
} from "../db/queries/download-cache";
import { backfillDownloadCacheMediaBytes } from "./download-cache-media";
import {
  loadDownloadCacheChapters,
  loadDownloadCacheNovels,
} from "./download-cache-loaders";

const mockedListNovels = vi.mocked(listDownloadCacheNovels);
const mockedListChapters = vi.mocked(listDownloadCacheChapters);
const mockedBackfill = vi.mocked(backfillDownloadCacheMediaBytes);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("download cache route loaders", () => {
  it("loads the route summary without running media backfill", async () => {
    mockedListNovels.mockResolvedValueOnce([]);

    await expect(loadDownloadCacheNovels()).resolves.toEqual([]);

    expect(mockedListNovels).toHaveBeenCalledTimes(1);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });

  it("loads expanded chapters without running media backfill", async () => {
    mockedListChapters.mockResolvedValueOnce([]);

    await expect(loadDownloadCacheChapters(7)).resolves.toEqual([]);

    expect(mockedListChapters).toHaveBeenCalledWith(7);
    expect(mockedBackfill).not.toHaveBeenCalled();
  });
});
