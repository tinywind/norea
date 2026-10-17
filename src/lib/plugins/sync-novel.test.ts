import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

vi.mock("../../db/client", () => ({
  getDb: vi.fn(),
  runDatabaseTransaction: vi.fn(),
}));
vi.mock("../../db/queries/novel-identity", () => ({ reconcileImportedNovelIdentityInDb: vi.fn(async () => null) }));

vi.mock("../../db/queries/chapter", () => ({
  getLatestSourceChapterAnchor: vi.fn(),
  upsertSourceChaptersInDb: vi.fn(),
}));

vi.mock("../updates/update-index-events", () => ({
  markUpdatesIndexDirty: vi.fn(),
}));

vi.mock("../novel-cover-storage", () => ({
  saveNovelCoverFromSource: vi.fn(),
}));

import { getDb, runDatabaseTransaction } from "../../db/client";
import {
  getLatestSourceChapterAnchor,
  upsertSourceChaptersInDb,
} from "../../db/queries/chapter";
import { saveNovelCoverFromSource } from "../novel-cover-storage";
import { subscribeWorkMetadataChanges } from "../work-metadata";
import { isSourceAccessRequiredError } from "./source-access";
import { syncNovelFromSource } from "./sync-novel";
import type { Plugin, SourceNovel } from "./types";

const mockedGetDb = vi.mocked(getDb);
const mockedRunDatabaseTransaction = vi.mocked(runDatabaseTransaction);
const mockedGetLatestSourceChapterAnchor = vi.mocked(
  getLatestSourceChapterAnchor,
);
const mockedSaveNovelCoverFromSource = vi.mocked(saveNovelCoverFromSource);
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
    apiVersion: "0.2",
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
    getChapterAcquisitionPlan: () => ({ type: "resource" }),
    searchNovels: () => Promise.resolve([]),
    ...overrides,
  };
}

function applyCapturedNovelUpsert() {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync("src-tauri/src/schema.sql", "utf8"));
    sqlite.exec(`INSERT INTO novel(plugin_id, path, name, cover, summary, author, artist, status, genres, rating)
      VALUES ('demo', '/novel', 'Novel', 'https://source.test/saved.jpg', 'Saved summary',
        'Saved author', 'Saved artist', 'Completed', 'Fantasy', 4.5)`);
    const [sql, values] = mockExecute.mock.calls[0]!;
    const result = sqlite.prepare(sql).run(
      Object.fromEntries(values.map((value: unknown, index: number) => [`$${index + 1}`, value])) as never,
    );
    const row = sqlite.prepare("SELECT name, cover, summary, author, artist, status, genres, rating FROM novel").get();
    return { result, row };
  } finally { sqlite.close(); }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute = vi.fn().mockResolvedValue({ rowsAffected: 0 });
  mockSelect = vi.fn().mockResolvedValue([{ id: 7, inLibrary: 0 }]);
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
  mockedSaveNovelCoverFromSource.mockResolvedValue(undefined);
});

describe("syncNovelFromSource", () => {
  it.each([undefined, "", " \t\n "])("preserves stored metadata when a default source refresh returns %j", async missing => {
    await syncNovelFromSource(makePlugin({
      parseNovel: async () => ({
        ...makeDetail([1]), cover: missing, summary: missing, author: missing,
        artist: missing, status: missing, genres: missing,
      }),
    }), { name: "Novel", path: "/novel" });
    const { result, row } = applyCapturedNovelUpsert();
    expect(result.changes).toBe(0);
    expect(row).toEqual({
      name: "Novel", cover: "https://source.test/saved.jpg", summary: "Saved summary",
      author: "Saved author", artist: "Saved artist", status: "Completed", genres: "Fantasy", rating: 4.5,
    });
  });

  it("replaces stored metadata with nonempty source fields and a zero rating", async () => {
    await syncNovelFromSource(makePlugin({
      parseNovel: async () => ({
        ...makeDetail([1]), name: "Updated title", cover: "https://source.test/new.jpg",
        summary: "New summary", author: "New author", artist: "New artist",
        status: "Ongoing", genres: "Adventure", rating: 0,
      }),
    }), { name: "Novel", path: "/novel" });
    expect(applyCapturedNovelUpsert().row).toEqual({
      name: "Updated title", cover: "https://source.test/new.jpg", summary: "New summary",
      author: "New author", artist: "New artist", status: "Ongoing", genres: "Adventure", rating: 0,
    });
  });

  it("keeps explicitly requested metadata replacement available", async () => {
    await syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" }, { preserveMissingMetadata: false });
    expect(applyCapturedNovelUpsert().row).toEqual({
      name: "Novel", cover: null, summary: null, author: null, artist: null,
      status: null, genres: null, rating: null,
    });
  });

  it("queues unchanged source metadata for upload and notifies after commit", async () => {
    mockedUpsertSourceChaptersInDb.mockResolvedValue({ chunks: 1, rowsAffected: 0 });
    let committed = false;
    mockedRunDatabaseTransaction.mockImplementationOnce(async run => {
      const result = await run({ execute: mockExecute, select: mockSelect } as never);
      committed = true;
      return result;
    });
    const changed = vi.fn(() => { expect(committed).toBe(true); });
    const unsubscribe = subscribeWorkMetadataChanges(changed);
    try {
      expect((await syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" })).changed).toBe(false);
      expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO work_metadata_sync_journal"), ["demo", "/novel"]);
      expect(changed).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it("does not notify an upload when the source metadata transaction fails", async () => {
    mockedRunDatabaseTransaction.mockRejectedValueOnce(new Error("Commit failed"));
    const changed = vi.fn();
    const unsubscribe = subscribeWorkMetadataChanges(changed);
    try {
      await expect(syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" })).rejects.toThrow("Commit failed");
      expect(changed).not.toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it.each(["/novel/123", "/webtoon/list?titleId=650305&q=%2f#info", "opaque:{\"id\":123}"])("preserves the requested plugin identity %s through parsing and storage", async path => {
    const plugin = makePlugin({
      parseNovel: vi.fn(async () => ({ ...makeDetail([1]), rating: 4.5, status: "On break" })),
    });
    await syncNovelFromSource(plugin, {
      name: "Novel", path,
    });
    expect(plugin.parseNovel).toHaveBeenCalledWith(path);
    const [sql, values] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("genres, rating");
    expect(values).toEqual([
      "demo", path, "Novel", null, null,
      null, null, "On break", null, 4.5,
    ]);
    expect(mockSelect).toHaveBeenCalledWith(expect.any(String), ["demo", path]);
  });

  it("preserves an omitted rating during partial metadata refresh", async () => {
    await syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" }, {
      preserveMissingMetadata: true,
    });
    expect(mockExecute.mock.calls[0]?.[0]).toContain("rating = COALESCE(excluded.rating, rating)");
    expect(mockExecute.mock.calls[0]?.[1]?.[9]).toBeNull();
  });

  it.each([0, 5])("stores the valid rating boundary %s", async (rating) => {
    await syncNovelFromSource(makePlugin({
      parseNovel: async () => ({ ...makeDetail([1]), rating }),
    }), { name: "Novel", path: "/novel" });
    expect(mockExecute.mock.calls[0]?.[1]?.[9]).toBe(rating);
  });

  it.each([-1, 5.1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid source rating %s", async (rating) => {
    await expect(syncNovelFromSource(makePlugin({
      parseNovel: async () => ({ ...makeDetail([1]), rating }),
    }), { name: "Novel", path: "/novel" })).rejects.toThrow("rating outside 0 to 5");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does not parse or mutate an aborted refresh", async () => {
    const plugin = makePlugin();
    await expect(syncNovelFromSource(plugin, { name: "Novel", path: "/novel" }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(plugin.parseNovel).not.toHaveBeenCalled();
    expect(mockedRunDatabaseTransaction).not.toHaveBeenCalled();
  });

  it("does not mutate when cancellation arrives during source parsing", async () => {
    const controller = new AbortController();
    const plugin = makePlugin({ parseNovel: async () => { controller.abort(); return makeDetail([1]); } });
    await expect(syncNovelFromSource(plugin, { name: "Novel", path: "/novel" }, { signal: controller.signal })).rejects.toThrow();
    expect(mockedRunDatabaseTransaction).not.toHaveBeenCalled();
  });

  it("checks cancellation again when the queued transaction starts", async () => {
    const controller = new AbortController();
    mockedRunDatabaseTransaction.mockImplementationOnce(async run => {
      controller.abort();
      return run({ execute: mockExecute, select: mockSelect } as never);
    });
    await expect(syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" }, { signal: controller.signal })).rejects.toThrow();
    expect(mockExecute).not.toHaveBeenCalled();
  });

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

  it("keeps the first duplicate chapterNumber from a source result", async () => {
    const plugin = makePlugin({
      parseNovel: vi.fn(() =>
        Promise.resolve({
          ...makeDetail([]),
          chapters: [
            {
              chapterNumber: 1,
              name: "First",
              path: "/first",
            },
            {
              chapterNumber: 1,
              name: "Duplicate",
              path: "/duplicate",
            },
            {
              chapterNumber: 2,
              name: "Second",
              path: "/second",
            },
          ],
        }),
      ),
    });

    const result = await syncNovelFromSource(plugin, {
      name: "Novel",
      path: "/novel",
    });

    expect(result.duplicateChapters).toEqual([
      {
        chapterNumber: 1,
        keptName: "First",
        keptPath: "/first",
        discardedCount: 1,
      },
    ]);
    expect(mockedUpsertSourceChaptersInDb).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          chapterNumber: "1",
          name: "First",
          path: "/first",
          position: 1,
        }),
        expect.objectContaining({
          chapterNumber: "2",
          name: "Second",
          path: "/second",
          position: 2,
        }),
      ],
    );
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

  it("stores the resolved novel cover when the synced novel is in the library", async () => {
    mockSelect.mockResolvedValueOnce([{ id: 7, inLibrary: 1 }]);
    const plugin = makePlugin({
      parseNovel: vi.fn(() =>
        Promise.resolve({
          ...makeDetail([1]),
          cover: "https://source.test/cover.jpg",
          name: "Updated Novel",
        }),
      ),
    });

    await syncNovelFromSource(plugin, {
      cover: "https://source.test/old.jpg",
      name: "Novel",
      path: "/novel",
    });

    expect(mockedSaveNovelCoverFromSource).toHaveBeenCalledWith(
      plugin,
      {
        id: 7,
        name: "Updated Novel",
        path: "/novel",
        pluginId: "demo",
      },
      "https://source.test/cover.jpg",
      { refresh: false },
    );
    expect(mockSelect.mock.calls[0]?.[0]).toContain(
      "in_library AS inLibrary",
    );
  });

  it("stores the preserved database cover when an update omits cover metadata", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        cover: "https://source.test/preserved-cover.jpg",
        id: 7,
        inLibrary: 1,
      },
    ]);

    const plugin = makePlugin({
      parseNovelSince: vi.fn((_path, since) =>
        Promise.resolve(makeDetail([since, since + 1])),
      ),
    });
    await syncNovelFromSource(
      plugin,
      { name: "Novel", path: "/novel" },
      {
        chapterRefreshMode: "since",
        novelId: 7,
        preserveMissingMetadata: true,
      },
    );

    expect(mockedSaveNovelCoverFromSource).toHaveBeenCalledWith(
      plugin,
      {
        id: 7,
        name: "Novel",
        path: "/novel",
        pluginId: "demo",
      },
      "https://source.test/preserved-cover.jpg",
      { refresh: false },
    );
    expect(mockSelect.mock.calls[0]?.[0]).toContain("SELECT id, cover");
  });

  it("does not persist a cover when opening a novel outside the library", async () => {
    await syncNovelFromSource(
      makePlugin({
        parseNovel: vi.fn(() =>
          Promise.resolve({
            ...makeDetail([1]),
            cover: "https://source.test/cover.jpg",
          }),
        ),
      }),
      {
        name: "Novel",
        path: "/novel",
      },
    );

    expect(mockedSaveNovelCoverFromSource).not.toHaveBeenCalled();
  });

  it.each([0, 1])("refreshes a cover on an explicit metadata update (in library: %s)", async inLibrary => {
    mockSelect.mockResolvedValue([{ id: 7, inLibrary, cover: "https://source.test/cover.jpg" }]);
    await syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" }, { refreshCover: true });
    expect(mockedSaveNovelCoverFromSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "demo" }),
      expect.objectContaining({ id: 7, path: "/novel" }),
      "https://source.test/cover.jpg",
      { refresh: true },
    );
  });

  it("propagates a source access challenge from cover storage", async () => {
    mockSelect.mockResolvedValueOnce([{ id: 7, inLibrary: 1 }]);
    mockedSaveNovelCoverFromSource.mockRejectedValueOnce(
      Object.assign(new Error("Complete the Cloudflare check."), {
        challenge: {
          kind: "cloudflare",
          url: "https://example.test/cdn-cgi/challenge-platform/",
        },
        code: "manual-action-required",
      }),
    );

    const request = syncNovelFromSource(makePlugin(), {
      name: "Novel",
      path: "/novel",
    });

    await expect(request).rejects.toSatisfy(isSourceAccessRequiredError);
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
