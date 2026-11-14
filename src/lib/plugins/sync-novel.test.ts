import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const renumberMock = vi.hoisted(() =>
  vi.fn((_input: unknown, publish: (journal: null) => Promise<unknown>) =>
    publish(null),
  ),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../observability", () => ({
  startPerformanceObservation: () => () => undefined,
  recordPerformanceObservation: () => undefined,
}));
vi.mock("./source-chapter-renumber", () => ({
  withSourceChapterNumberReconciliation: renumberMock,
}));
vi.mock("../updates/update-index-events", () => ({
  markUpdatesIndexDirty: vi.fn(),
}));
vi.mock("../novel-cover-storage", () => ({
  saveNovelCoverFromSource: vi.fn(),
}));
vi.mock("../tauri-runtime", () => ({
  isTauriRuntime: () => false,
}));

import { saveNovelCoverFromSource } from "../novel-cover-storage";
import { subscribeWorkMetadataChanges } from "../work-metadata";
import { isSourceAccessRequiredError } from "./source-access";
import {
  COVER_REFRESH_SECONDS,
  getSourceDuplicateChapterInfo,
  syncNovelFromSource,
} from "./sync-novel";
import type { Plugin, SourceNovel } from "./types";

const mockedSaveNovelCoverFromSource = vi.mocked(saveNovelCoverFromSource);

function makeDetail(chapterNumbers: number[]): SourceNovel {
  return {
    novelId: "novel",
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

function publishResult(overrides: Record<string, unknown> = {}) {
  return {
    value: {
      republish: true,
      changedChapters: 1,
      newChapters: 0,
      cover: null,
      coverChanged: false,
      coverFetchedAt: null,
      novelChanged: false,
      inLibrary: false,
      novelId: 7,
      ...overrides,
    },
    effects: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  renumberMock.mockImplementation((_input, publish) => publish(null));
  mockedSaveNovelCoverFromSource.mockResolvedValue(undefined);
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "db_chapter_get_sync_since_anchor") {
      return {
        existingNovelId: 7,
        anchor: { novelId: 7, chapterNumber: 2, position: 2 },
      };
    }
    if (command === "db_novel_sync_from_source") {
      return publishResult();
    }
    if (command === "db_novel_freshness_record_cover_fetched") {
      return { value: null, effects: {} };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("syncNovelFromSource", () => {
  it.each([undefined, "", " \t\n "])(
    "normalizes blank source metadata %j to null while preserving missing metadata",
    async (missing) => {
      await syncNovelFromSource(
        makePlugin({
          parseNovel: async () => ({
            ...makeDetail([1]),
            cover: missing,
            summary: missing,
            author: missing,
            artist: missing,
            status: missing,
            genres: missing,
          }),
        }),
        { name: "Novel", path: "/novel" },
      );

      expect(invokeMock).toHaveBeenCalledWith("db_novel_sync_from_source", {
        input: expect.objectContaining({
          pluginId: "demo",
          novelPath: "/novel",
          novelName: "Novel",
          preserveMissingMetadata: true,
          cover: null,
          summary: null,
          author: null,
          artist: null,
          status: null,
          genres: null,
          rating: null,
        }),
      });
    },
  );

  it("sends nonempty source fields, zero rating, and authoritativeMetadata when preserveMissingMetadata is false", async () => {
    const result = await syncNovelFromSource(
      makePlugin({
        parseNovel: async () => ({
          ...makeDetail([1]),
          name: "Updated title",
          cover: "https://source.test/new.jpg",
          summary: "New summary",
          author: "New author",
          artist: "New artist",
          status: "Ongoing",
          genres: "Adventure",
          rating: 0,
        }),
      }),
      {
        name: "Novel",
        path: "/novel",
        cover: "https://source.test/stale-browse.jpg",
      },
      { preserveMissingMetadata: false, refreshCover: true },
    );

    expect(invokeMock).toHaveBeenCalledWith("db_novel_sync_from_source", {
      input: expect.objectContaining({
        novelName: "Updated title",
        cover: "https://source.test/new.jpg",
        summary: "New summary",
        author: "New author",
        artist: "New artist",
        status: "Ongoing",
        genres: "Adventure",
        rating: 0,
        preserveMissingMetadata: false,
      }),
    });
    expect(result.authoritativeMetadata).toEqual({
      identity: { pluginId: "demo", novelId: "novel", novelPath: "/novel" },
      novel: {
        name: "Updated title",
        author: "New author",
        artist: "New artist",
        summary: "New summary",
        status: "Ongoing",
        genres: "Adventure",
        rating: 0,
        isLocal: false,
      },
      coverUrl: "https://source.test/new.jpg",
    });
  });

  it("does not revive stale browse cover when preserveMissingMetadata is false", async () => {
    await syncNovelFromSource(
      makePlugin(),
      {
        name: "Novel",
        path: "/novel",
        cover: "https://source.test/stale-browse.jpg",
      },
      { preserveMissingMetadata: false, refreshCover: true },
    );

    expect(mockedSaveNovelCoverFromSource).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "demo" }),
      expect.objectContaining({ id: 7 }),
      null,
      { refresh: true, clearMissing: true },
    );
  });

  it("fails an authoritative refresh when the new cover cannot be stored", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "db_novel_sync_from_source") {
        return publishResult({ cover: "/fresh.jpg" });
      }
      return { value: null, effects: {} };
    });
    mockedSaveNovelCoverFromSource.mockRejectedValueOnce(
      new Error("New cover unavailable"),
    );

    await expect(
      syncNovelFromSource(
        makePlugin({
          parseNovel: async () => ({ ...makeDetail([1]), cover: "/fresh.jpg" }),
        }),
        { name: "Novel", path: "/novel" },
        { preserveMissingMetadata: false, refreshCover: true },
      ),
    ).rejects.toThrow("New cover unavailable");
  });

  it("notifies work metadata listeners only when republish is true and IPC succeeds", async () => {
    const changed = vi.fn();
    const unsubscribe = subscribeWorkMetadataChanges(changed);
    try {
      invokeMock.mockResolvedValueOnce(
        publishResult({ republish: false, changedChapters: 0 }),
      );
      expect(
        (
          await syncNovelFromSource(
            makePlugin(),
            { name: "Novel", path: "/novel" },
            { markFoundByCheck: true },
          )
        ).changed,
      ).toBe(false);
      expect(changed).not.toHaveBeenCalled();

      invokeMock.mockResolvedValueOnce(
        publishResult({ republish: true, changedChapters: 0 }),
      );
      await syncNovelFromSource(makePlugin(), {
        name: "Novel",
        path: "/novel",
      });
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        pluginId: "demo",
        novelPath: "/novel",
      });

      invokeMock.mockRejectedValueOnce(new Error("Commit failed"));
      await expect(
        syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" }),
      ).rejects.toThrow("Commit failed");
      expect(changed).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it.each([
    "/novel/123",
    "/webtoon/list?titleId=650305&q=%2f#info",
    'opaque:{"id":123}',
  ])(
    "preserves the requested plugin identity %s through parsing and IPC",
    async (path) => {
      const plugin = makePlugin({
        parseNovel: vi.fn(async () => ({
          ...makeDetail([1]),
          rating: 4.5,
          status: "On break",
        })),
      });
      await syncNovelFromSource(plugin, { name: "Novel", path });
      expect(plugin.parseNovel).toHaveBeenCalledWith(path);
      expect(invokeMock).toHaveBeenCalledWith("db_novel_sync_from_source", {
        input: expect.objectContaining({
          pluginId: "demo",
          novelPath: path,
          status: "On break",
          rating: 4.5,
        }),
      });
    },
  );

  it.each([-1, 5.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid source rating %s before invoking IPC",
    async (rating) => {
      await expect(
        syncNovelFromSource(
          makePlugin({
            parseNovel: async () => ({ ...makeDetail([1]), rating }),
          }),
          { name: "Novel", path: "/novel" },
        ),
      ).rejects.toThrow("rating outside 0 to 5");
      expect(invokeMock).not.toHaveBeenCalled();
    },
  );

  it("checks cancellation before parsing, after parsing, and before publishing", async () => {
    const plugin = makePlugin();
    await expect(
      syncNovelFromSource(
        plugin,
        { name: "Novel", path: "/novel" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(plugin.parseNovel).not.toHaveBeenCalled();

    const midParse = new AbortController();
    await expect(
      syncNovelFromSource(
        makePlugin({
          parseNovel: async () => {
            midParse.abort();
            return makeDetail([1]);
          },
        }),
        { name: "Novel", path: "/novel" },
        { signal: midParse.signal },
      ),
    ).rejects.toThrow();

    const beforePublish = new AbortController();
    renumberMock.mockImplementationOnce(async (_input, publish) => {
      beforePublish.abort();
      return publish(null);
    });
    await expect(
      syncNovelFromSource(
        makePlugin(),
        { name: "Novel", path: "/novel" },
        { signal: beforePublish.signal },
      ),
    ).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("validates chapterNumber, contentType, and deduplicates duplicate chapter numbers", async () => {
    await expect(
      syncNovelFromSource(
        makePlugin({
          parseNovel: async () => ({
            ...makeDetail([]),
            chapters: [
              { chapterNumber: Number.NaN, name: "Broken", path: "/broken" },
            ],
          }),
        }),
        { name: "Novel", path: "/novel" },
      ),
    ).rejects.toThrow("finite numeric chapterNumber");

    await expect(
      syncNovelFromSource(
        makePlugin({
          parseNovel: async () => ({
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
        }),
        { name: "Novel", path: "/novel" },
      ),
    ).rejects.toThrow('unsupported chapter contentType "mobi"');

    const result = await syncNovelFromSource(
      makePlugin({
        parseNovel: async () => ({
          ...makeDetail([]),
          chapters: [
            {
              chapterNumber: 1,
              name: "First",
              path: "/first",
              contentType: "epub",
            },
            { chapterNumber: 1, name: "Duplicate", path: "/duplicate" },
            { chapterNumber: 2, name: "Second", path: "/second" },
          ],
        }),
      }),
      { name: "Novel", path: "/novel" },
    );

    expect(result.duplicateChapters).toEqual([
      {
        chapterNumber: 1,
        keptName: "First",
        keptPath: "/first",
        discardedCount: 1,
      },
    ]);
    expect(getSourceDuplicateChapterInfo(7)).toEqual(result.duplicateChapters);
    expect(invokeMock).toHaveBeenCalledWith("db_novel_sync_from_source", {
      input: expect.objectContaining({
        chapters: [
          expect.objectContaining({
            chapterNumber: 1,
            name: "First",
            path: "/first",
            contentType: "epub",
          }),
          expect.objectContaining({
            chapterNumber: 2,
            name: "Second",
            path: "/second",
            contentType: "html",
          }),
        ],
      }),
    });
  });

  it("uses parseNovelSince at the anchor and falls back to parseNovel when the anchor is missing or skipped", async () => {
    const suffixPlugin = makePlugin();
    await syncNovelFromSource(
      suffixPlugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );
    expect(suffixPlugin.parseNovelSince).toHaveBeenCalledWith("/novel", 2);
    expect(suffixPlugin.parseNovel).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("db_novel_sync_from_source", {
      input: expect.objectContaining({
        startPosition: 2,
        expectedNovelId: 7,
      }),
    });

    const skippedPlugin = makePlugin({
      parseNovelSince: vi.fn(async () => makeDetail([3, 4])),
    });
    await syncNovelFromSource(
      skippedPlugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );
    expect(skippedPlugin.parseNovel).toHaveBeenCalledWith("/novel");

    invokeMock.mockImplementationOnce(async (command: string) => {
      if (command === "db_chapter_get_sync_since_anchor") {
        return { existingNovelId: 7, anchor: null };
      }
      return publishResult();
    });
    const noAnchorPlugin = makePlugin();
    await syncNovelFromSource(
      noAnchorPlugin,
      { name: "Novel", path: "/novel" },
      { chapterRefreshMode: "since", novelId: 7 },
    );
    expect(noAnchorPlugin.parseNovelSince).not.toHaveBeenCalled();
    expect(noAnchorPlugin.parseNovel).toHaveBeenCalledWith("/novel");
  });

  it("refreshes library covers only on change, after 30 days, or on explicit refresh, and propagates challenges", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    invokeMock.mockImplementationOnce(async () =>
      publishResult({
        inLibrary: true,
        cover: "https://source.test/a.jpg",
        coverChanged: false,
        coverFetchedAt: nowSeconds - 60,
      }),
    );
    await syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" });
    expect(mockedSaveNovelCoverFromSource).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 7 }),
      "https://source.test/a.jpg",
      { refresh: false },
    );

    invokeMock.mockImplementationOnce(async () =>
      publishResult({
        inLibrary: true,
        cover: "https://source.test/a.jpg",
        coverChanged: false,
        coverFetchedAt: nowSeconds - COVER_REFRESH_SECONDS - 5,
      }),
    );
    await syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" });
    expect(mockedSaveNovelCoverFromSource).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 7 }),
      "https://source.test/a.jpg",
      { refresh: true },
    );

    invokeMock.mockImplementationOnce(async () =>
      publishResult({ inLibrary: true, cover: "https://source.test/a.jpg" }),
    );
    mockedSaveNovelCoverFromSource.mockRejectedValueOnce(
      Object.assign(new Error("Complete the Cloudflare check."), {
        challenge: {
          kind: "cloudflare",
          url: "https://example.test/cdn-cgi/challenge-platform/",
        },
        code: "manual-action-required",
      }),
    );
    await expect(
      syncNovelFromSource(makePlugin(), { name: "Novel", path: "/novel" }),
    ).rejects.toSatisfy(isSourceAccessRequiredError);
  });
});
