import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
}));

vi.mock("../../db/queries/chapter", () => ({
  getLatestSourceChapterAnchor: vi.fn(),
  upsertSourceChaptersInDb: vi.fn(),
}));

vi.mock("../updates/update-index-events", () => ({
  markUpdatesIndexDirty: vi.fn(),
}));

import { getDb, runDatabaseTransaction } from "../../db/client";
import {
  getLatestSourceChapterAnchor,
  upsertSourceChaptersInDb,
} from "../../db/queries/chapter";
import { syncNovelFromSource } from "./sync-novel";
import type { Plugin, SourceNovel } from "./types";

const mockedGetDb = vi.mocked(getDb);
const mockedRunDatabaseTransaction = vi.mocked(runDatabaseTransaction);
const mockedGetLatestSourceChapterAnchor = vi.mocked(
  getLatestSourceChapterAnchor,
);
const mockedUpsertSourceChaptersInDb = vi.mocked(upsertSourceChaptersInDb);

let mockExecute: ReturnType<typeof vi.fn>;
let mockSelect: ReturnType<typeof vi.fn>;

function makeDetail(chapterNumbers: number[]): SourceNovel {
  return {
    name: "Novel",
    path: "/novel",
    chapters: chapterNumbers.map((chapterNumber) => ({
      chapterNumber,
      name: `Chapter ${chapterNumber}`,
      path: `/chapter-${chapterNumber}`,
    })),
  };
}

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: "demo",
    name: "Demo",
    lang: "en",
    version: "1.0.0",
    url: "https://example.test/index.js",
    iconUrl: "https://example.test/icon.png",
    getBaseUrl: () => "https://example.test",
    popularNovels: () => Promise.resolve([]),
    parseNovel: vi.fn(() => Promise.resolve(makeDetail([1, 2, 3]))),
    parseNovelSince: vi.fn((_path, since) =>
      Promise.resolve(makeDetail([since, since + 1])),
    ),
    parseChapter: () => Promise.resolve(""),
    searchNovels: () => Promise.resolve([]),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
  mockSelect = vi.fn().mockResolvedValue([{ id: 7 }]);
  mockedGetDb.mockResolvedValue({
    execute: mockExecute,
    select: mockSelect,
  } as never);
  mockedRunDatabaseTransaction.mockImplementation(async (run) =>
    run({
      execute: mockExecute,
      select: mockSelect,
    } as never),
  );
  mockedGetLatestSourceChapterAnchor.mockResolvedValue({
    novelId: 7,
    chapterNumber: 2,
    position: 2,
  });
  mockedUpsertSourceChaptersInDb.mockResolvedValue({
    chunks: 1,
    rowsAffected: 1,
  });
});

describe("syncNovelFromSource", () => {
  it("rejects chapters without finite numeric chapterNumber", async () => {
    const plugin = makePlugin({
      parseNovel: vi.fn(() =>
        Promise.resolve({
          ...makeDetail([]),
          chapters: [
            {
              chapterNumber: Number.NaN,
              name: "Broken",
              path: "/broken",
            },
          ],
        }),
      ),
    });

    await expect(
      syncNovelFromSource(plugin, { name: "Novel", path: "/novel" }),
    ).rejects.toThrow("finite numeric chapterNumber");
  });

  it("rejects duplicate chapterNumber values from a source result", async () => {
    const plugin = makePlugin({
      parseNovel: vi.fn(() => Promise.resolve(makeDetail([1, 1]))),
    });

    await expect(
      syncNovelFromSource(plugin, { name: "Novel", path: "/novel" }),
    ).rejects.toThrow("duplicate chapterNumber 1");
  });

  it("uses parseNovelSince and starts at the anchor position for suffix results", async () => {
    const plugin = makePlugin();

    await syncNovelFromSource(
      plugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );

    expect(plugin.parseNovelSince).toHaveBeenCalledWith("/novel", 2);
    expect(plugin.parseNovel).not.toHaveBeenCalled();
    expect(mockedUpsertSourceChaptersInDb).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          chapterNumber: "2",
          novelId: 7,
          path: "/chapter-2",
          position: 2,
        }),
        expect.objectContaining({
          chapterNumber: "3",
          novelId: 7,
          path: "/chapter-3",
          position: 3,
        }),
      ],
    );
  });

  it("treats a since result starting before the anchor as a full list", async () => {
    const plugin = makePlugin({
      parseNovelSince: vi.fn(() => Promise.resolve(makeDetail([1, 2, 3]))),
    });

    await syncNovelFromSource(
      plugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );

    expect(plugin.parseNovel).not.toHaveBeenCalled();
    expect(mockedUpsertSourceChaptersInDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          chapterNumber: "1",
          position: 1,
        }),
      ]),
    );
  });

  it("falls back to parseNovel when a since result skips the anchor", async () => {
    const plugin = makePlugin({
      parseNovelSince: vi.fn(() => Promise.resolve(makeDetail([3, 4]))),
    });

    await syncNovelFromSource(
      plugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );

    expect(plugin.parseNovelSince).toHaveBeenCalledWith("/novel", 2);
    expect(plugin.parseNovel).toHaveBeenCalledWith("/novel");
    expect(mockedUpsertSourceChaptersInDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          chapterNumber: "1",
          position: 1,
        }),
      ]),
    );
  });

  it("falls back to full refresh when existing chapters lack chapter numbers", async () => {
    mockedGetLatestSourceChapterAnchor.mockResolvedValueOnce(null);
    const plugin = makePlugin();

    await syncNovelFromSource(
      plugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );

    expect(plugin.parseNovelSince).not.toHaveBeenCalled();
    expect(plugin.parseNovel).toHaveBeenCalledWith("/novel");
  });

  it("preserves supported epub chapter content types", async () => {
    const plugin = makePlugin({
      parseNovel: vi.fn(() =>
        Promise.resolve({
          ...makeDetail([]),
          chapters: [
            {
              chapterNumber: 1,
              contentType: "epub" as const,
              name: "EPUB Chapter",
              path: "/chapter-1",
            },
          ],
        }),
      ),
    });

    await syncNovelFromSource(plugin, { name: "Novel", path: "/novel" });

    expect(mockedUpsertSourceChaptersInDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          contentType: "epub",
          path: "/chapter-1",
        }),
      ]),
    );
  });

  it("defaults missing chapter content types to html", async () => {
    const plugin = makePlugin({
      parseNovel: vi.fn(() => Promise.resolve(makeDetail([1]))),
    });

    await syncNovelFromSource(plugin, { name: "Novel", path: "/novel" });

    expect(mockedUpsertSourceChaptersInDb).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          contentType: "html",
          path: "/chapter-1",
        }),
      ]),
    );
  });

  it("rejects explicit unsupported chapter content types", async () => {
    const plugin = makePlugin({
      parseNovel: vi.fn(() =>
        Promise.resolve({
          ...makeDetail([]),
          chapters: [
            {
              chapterNumber: 1,
              contentType: "mobi" as never,
              name: "Broken",
              path: "/broken",
            },
          ],
        }),
      ),
    });

    await expect(
      syncNovelFromSource(plugin, { name: "Novel", path: "/novel" }),
    ).rejects.toThrow('unsupported chapter contentType "mobi"');

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockedUpsertSourceChaptersInDb).not.toHaveBeenCalled();
  });
});
