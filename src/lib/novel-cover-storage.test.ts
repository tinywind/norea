import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  androidStoragePathSize: vi.fn(),
  deleteAndroidStoragePath: vi.fn(),
  readAndroidStorageText: vi.fn(),
  writeAndroidStorageBytes: vi.fn(),
  writeAndroidStorageText: vi.fn(),
}));

vi.mock("./http", () => ({
  pluginMediaFetch: vi.fn(),
}));

vi.mock("./tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

import {
  androidStoragePathSize,
  deleteAndroidStoragePath,
  readAndroidStorageText,
  writeAndroidStorageBytes,
  writeAndroidStorageText,
} from "./android-storage";
import { invoke } from "@tauri-apps/api/core";
import { pluginMediaFetch } from "./http";
import {
  getNovelCoverSnapshot,
  resolveOrCacheSourceNovelCover,
  resolveStoredNovelCoverSrc,
  saveNovelCoverFromSource,
  subscribeNovelCoverChanges,
} from "./novel-cover-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import type { Plugin } from "./plugins/types";

const invokeMock = vi.mocked(invoke);
const androidStoragePathSizeMock = vi.mocked(androidStoragePathSize);
const deleteAndroidStoragePathMock = vi.mocked(deleteAndroidStoragePath);
const pluginMediaFetchMock = vi.mocked(pluginMediaFetch);
const readAndroidStorageTextMock = vi.mocked(readAndroidStorageText);
const writeAndroidStorageBytesMock = vi.mocked(writeAndroidStorageBytes);
const writeAndroidStorageTextMock = vi.mocked(writeAndroidStorageText);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isTauriRuntimeMock = vi.mocked(isTauriRuntime);

const novel = {
  id: 7,
  name: "Sample Novel",
  path: "/novel",
  pluginId: "demo",
};

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    apiVersion: "0.2",
    id: "demo",
    name: "Demo",
    lang: "en",
    version: "1.0.0",
    url: "https://source.test/plugin.js",
    iconUrl: "https://source.test/icon.png",
    getBaseUrl: () => "https://source.test/books/",
    popularNovels: () => Promise.resolve([]),
    parseNovel: () =>
      Promise.resolve({ name: "Sample Novel", path: "/novel", chapters: [] }),
    parseNovelSince: () =>
      Promise.resolve({ name: "Sample Novel", path: "/novel", chapters: [] }),
    getChapterAcquisitionPlan: () => ({ type: "resource" }),
    searchNovels: () => Promise.resolve([]),
    ...overrides,
  };
}

function coverManifest(sourceUrl: string, fileName = "cover.jpg"): string {
  return JSON.stringify({
    contentType: "image/jpeg",
    fileName,
    sourceUrl,
    updatedAt: 1,
    version: 1,
  });
}

function desktopCoverResult(
  sourceUrl: string,
  fileName = "cover.jpg",
  relativePath = `contents/demo/Sample-Novel-novel/${fileName}`,
) {
  return {
    manifest: coverManifest(sourceUrl, fileName),
    relativePath,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  deleteAndroidStoragePathMock.mockResolvedValue(undefined);
  invokeMock.mockImplementation((command) =>
    Promise.resolve(command === "novel_cover_read_manifest" ? null : undefined),
  );
  pluginMediaFetchMock.mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg" },
      status: 200,
    }),
  );
});

describe("saveNovelCoverFromSource", () => {
  it("skips the download when the stored cover uses the same source URL", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult("https://source.test/covers/cover.jpg"),
    );
    const listener = vi.fn();
    const snapshot = getNovelCoverSnapshot(novel.id);
    const unsubscribe = subscribeNovelCoverChanges(listener);

    try {
      await saveNovelCoverFromSource(
        makePlugin(),
        novel,
        "https://source.test/covers/cover.jpg",
      );
    } finally {
      unsubscribe();
    }

    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(novel.id);
    expect(getNovelCoverSnapshot(novel.id)).toBe(snapshot + 1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      novelId: 7,
      novelName: "Sample Novel",
      novelPath: "/novel",
      sourceId: "demo",
    });
  });

  it("refreshes the cover when the source URL query changed", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult("https://source.test/covers/cover.jpg?token=old"),
    );

    await saveNovelCoverFromSource(
      makePlugin(),
      novel,
      "https://source.test/covers/cover.jpg?token=new",
    );

    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/covers/cover.jpg?token=new",
      {
        contextUrl: "https://source.test/books/",
        preferBrowserCache: true,
        sourceId: "demo",
      },
    );
  });

  it("downloads and stores a missing desktop cover in the novel folder", async () => {
    await saveNovelCoverFromSource(
      makePlugin(),
      novel,
      "https://source.test/covers/cover.jpg",
    );

    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/covers/cover.jpg",
      {
        contextUrl: "https://source.test/books/",
        preferBrowserCache: true,
        sourceId: "demo",
      },
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "novel_cover_store", {
      body: [1, 2, 3],
      fileName: "cover.jpg",
      manifest: expect.any(String),
      novelId: 7,
      novelName: "Sample Novel",
      novelPath: "/novel",
      sourceId: "demo",
    });

    const storeArgs = invokeMock.mock.calls[1]?.[1] as { manifest: string };
    expect(JSON.parse(storeArgs.manifest)).toEqual(
      expect.objectContaining({
        contentType: "image/jpeg",
        fileName: "cover.jpg",
        sourceUrl: "https://source.test/covers/cover.jpg",
        version: 1,
      }),
    );
  });

  it("notifies cover subscribers after storing a desktop cover", async () => {
    const listener = vi.fn();
    const snapshot = getNovelCoverSnapshot(novel.id);
    const unsubscribe = subscribeNovelCoverChanges(listener);

    try {
      await saveNovelCoverFromSource(
        makePlugin(),
        novel,
        "https://source.test/covers/cover.jpg",
      );
    } finally {
      unsubscribe();
    }

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(novel.id);
    expect(getNovelCoverSnapshot(novel.id)).toBe(snapshot + 1);
  });

  it("writes Android cover files under the contents novel directory", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    readAndroidStorageTextMock.mockResolvedValueOnce(null);
    pluginMediaFetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([4, 5]), {
        headers: { "content-type": "image/webp" },
        status: 200,
      }),
    );

    await saveNovelCoverFromSource(makePlugin(), novel, "/covers/current");

    expect(writeAndroidStorageBytesMock).toHaveBeenCalledWith(
      "contents/demo/Sample-Novel-novel/cover.webp",
      new Uint8Array([4, 5]),
      "image/webp",
    );
    expect(writeAndroidStorageTextMock).toHaveBeenCalledWith(
      "contents/demo/Sample-Novel-novel/cover.json",
      expect.any(String),
    );
  });

  it("removes the previous Android cover file when the extension changes", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    readAndroidStorageTextMock.mockResolvedValueOnce(
      coverManifest("https://source.test/old.jpg", "cover.jpg"),
    );
    androidStoragePathSizeMock.mockResolvedValueOnce(10);
    pluginMediaFetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([6]), {
        headers: { "content-type": "image/png" },
        status: 200,
      }),
    );

    await saveNovelCoverFromSource(
      makePlugin(),
      novel,
      "https://source.test/new.png",
    );

    expect(writeAndroidStorageBytesMock).toHaveBeenCalledWith(
      "contents/demo/Sample-Novel-novel/cover.png",
      new Uint8Array([6]),
      "image/png",
    );
    expect(deleteAndroidStoragePathMock).toHaveBeenCalledWith(
      "contents/demo/Sample-Novel-novel/cover.jpg",
    );
  });

  it("resolves a stored Windows desktop cover to the custom protocol host", async () => {
    const repeatedSeparatorNovel = {
      ...novel,
      path: "/foo//bar",
    };
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult(
        "https://source.test/covers/cover.jpg",
        "cover.jpg",
        "contents/demo/Sample-Novel-foo--bar/cover.jpg",
      ),
    );

    await expect(
      resolveStoredNovelCoverSrc(repeatedSeparatorNovel),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-foo--bar/cover.jpg",
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      novelId: 7,
      novelName: "Sample Novel",
      novelPath: "/foo//bar",
      sourceId: "demo",
    });
  });

  it("resolves a stored Android cover to the direct storage URL", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    readAndroidStorageTextMock.mockResolvedValueOnce(
      coverManifest("https://source.test/covers/cover.webp", "cover.webp"),
    );
    androidStoragePathSizeMock.mockResolvedValueOnce(10);

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "/__norea_android_media__/file/Y29udGVudHMvZGVtby9TYW1wbGUtTm92ZWwtbm92ZWwvY292ZXIud2VicA",
    );
  });

  it("encodes unicode Android cover paths in the direct storage URL", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    readAndroidStorageTextMock.mockResolvedValueOnce(
      coverManifest("https://source.test/covers/cover.jpg"),
    );
    androidStoragePathSizeMock.mockResolvedValueOnce(10);

    await expect(
      resolveStoredNovelCoverSrc({
        id: 776601,
        name: "광마회귀",
        path: "webtoon/list?titleId=776601",
        pluginId: "naver-webtoon",
      }),
    ).resolves.toBe(
      "/__norea_android_media__/file/Y29udGVudHMvbmF2ZXItd2VidG9vbi_qtJHrp4jtmozqt4Atd2VidG9vbi1saXN0LXRpdGxlSWQtNzc2NjAxL2NvdmVyLmpwZw",
    );
  });

  it("prefers a stored desktop cover when the current remote URL differs", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult("https://source.test/old-cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
    );
  });

  it("keeps cover URLs content-relative when the novel folder has unicode", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult(
        "https://source.test/covers/cover.jpg",
        "cover.jpg",
        "contents/naver-webtoon/광마회귀-webtoon-list-titleId-776601/cover.jpg",
      ),
    );

    await expect(
      resolveStoredNovelCoverSrc({
        id: 776601,
        name: "광마회귀",
        path: "webtoon/list?titleId=776601",
        pluginId: "naver-webtoon",
      }),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/naver-webtoon/%EA%B4%91%EB%A7%88%ED%9A%8C%EA%B7%80-webtoon-list-titleId-776601/cover.jpg",
    );
  });

  it("keeps Windows cover URLs content-relative when the novel folder has unicode", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult(
        "https://source.test/covers/cover.jpg",
        "cover.jpg",
        "contents/newtoki-webtoon/가정부-길들이기-webtoon-2025/cover.jpg",
      ),
    );

    await expect(
      resolveStoredNovelCoverSrc({
        id: 2025,
        name: "가정부 길들이기",
        path: "webtoon/2025",
        pluginId: "newtoki-webtoon",
      }),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/newtoki-webtoon/%EA%B0%80%EC%A0%95%EB%B6%80-%EA%B8%B8%EB%93%A4%EC%9D%B4%EA%B8%B0-webtoon-2025/cover.jpg",
    );
  });

  it("returns null instead of a remote cover when no stored cover exists", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(resolveStoredNovelCoverSrc(novel)).resolves.toBeNull();
  });
});

describe("resolveOrCacheSourceNovelCover", () => {
  it("reuses a stored cover when only the current URL query changed", async () => {
    invokeMock.mockResolvedValue(
      desktopCoverResult(
        "https://source.test/covers/cover.jpg?token=old",
      ),
    );

    await expect(
      resolveOrCacheSourceNovelCover(makePlugin(), {
        cover: "https://source.test/covers/cover.jpg?token=new",
        name: "Sample Novel",
        path: "/novel",
      }),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
    );

    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      novelId: 0,
      novelName: "Sample Novel",
      novelPath: "/novel",
      sourceId: "demo",
    });
  });

  it("keeps exact save semantics when relaxed cache resolution is queued", async () => {
    let storedCover: ReturnType<typeof desktopCoverResult> | null =
      desktopCoverResult(
        "https://source.test/covers/cover.jpg?token=old",
      );
    invokeMock.mockImplementation((command, args) => {
      if (command === "novel_cover_read_manifest") {
        return Promise.resolve(storedCover);
      }
      if (command === "novel_cover_store") {
        storedCover = {
          manifest: (args as { manifest: string }).manifest,
          relativePath: "contents/demo/Sample-Novel-novel/cover.jpg",
        };
      }
      return Promise.resolve(undefined);
    });
    const plugin = makePlugin();
    const sourceUrl = "https://source.test/covers/cover.jpg?token=new";

    await Promise.all([
      saveNovelCoverFromSource(plugin, novel, sourceUrl),
      resolveOrCacheSourceNovelCover(plugin, {
        cover: sourceUrl,
        name: "Sample Novel",
        path: "/novel",
      }),
    ]);

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(sourceUrl, {
      contextUrl: "https://source.test/books/",
      preferBrowserCache: true,
      sourceId: "demo",
    });
    const storeCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "novel_cover_store",
    );
    expect(storeCalls).toHaveLength(1);
    const storeArgs = storeCalls[0]?.[1] as { manifest?: string } | undefined;
    expect(
      JSON.parse(storeArgs?.manifest ?? "null") as { sourceUrl: string },
    ).toEqual(expect.objectContaining({ sourceUrl }));
  });

  it("refreshes a stored cover when the source path changed", async () => {
    let storedCover: ReturnType<typeof desktopCoverResult> | null =
      desktopCoverResult("https://source.test/covers/old-cover.jpg");
    invokeMock.mockImplementation((command, args) => {
      if (command === "novel_cover_read_manifest") {
        return Promise.resolve(storedCover);
      }
      if (command === "novel_cover_store") {
        storedCover = {
          manifest: (args as { manifest: string }).manifest,
          relativePath: "contents/demo/Sample-Novel-novel/cover.jpg",
        };
      }
      return Promise.resolve(undefined);
    });

    await expect(
      resolveOrCacheSourceNovelCover(makePlugin(), {
        cover: "https://source.test/covers/new-cover.jpg",
        name: "Sample Novel",
        path: "/novel",
      }),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
    );

    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/covers/new-cover.jpg",
      {
        contextUrl: "https://source.test/books/",
        preferBrowserCache: true,
        sourceId: "demo",
      },
    );
  });

  it("deduplicates concurrent cache misses and returns the stored local cover", async () => {
    let storedCover: ReturnType<typeof desktopCoverResult> | null = null;
    invokeMock.mockImplementation((command, args) => {
      if (command === "novel_cover_read_manifest") {
        return Promise.resolve(storedCover);
      }
      if (command === "novel_cover_store") {
        storedCover = {
          manifest: (args as { manifest: string }).manifest,
          relativePath: "contents/demo/Sample-Novel-novel/cover.jpg",
        };
      }
      return Promise.resolve(undefined);
    });
    const plugin = makePlugin();
    const item = {
      cover: "https://source.test/covers/cover.jpg",
      name: "Sample Novel",
      path: "/novel",
    };

    const [first, second] = await Promise.all([
      resolveOrCacheSourceNovelCover(plugin, item),
      resolveOrCacheSourceNovelCover(plugin, item),
    ]);

    expect(first).toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
    );
    expect(second).toBe(first);
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(1);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith(
      "https://source.test/covers/cover.jpg",
      {
        contextUrl: "https://source.test/books/",
        preferBrowserCache: true,
        sourceId: "demo",
      },
    );
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "novel_cover_store"),
    ).toHaveLength(1);
  });

  it("keeps distinct native cover paths when normalized queue keys collide", async () => {
    const storedCovers = new Map<
      string,
      ReturnType<typeof desktopCoverResult>
    >();
    invokeMock.mockImplementation((command, args) => {
      const novelPath = (args as { novelPath: string }).novelPath;
      if (command === "novel_cover_read_manifest") {
        return Promise.resolve(storedCovers.get(novelPath) ?? null);
      }
      if (command === "novel_cover_store") {
        const relativePath =
          novelPath === "/foo//bar"
            ? "contents/demo/Sample-Novel-foo--bar/cover.jpg"
            : "contents/demo/Sample-Novel-foo-bar/cover.jpg";
        storedCovers.set(novelPath, {
          manifest: (args as { manifest: string }).manifest,
          relativePath,
        });
      }
      return Promise.resolve(undefined);
    });
    pluginMediaFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
      ),
    );
    const plugin = makePlugin();

    const [singleSeparator, repeatedSeparator] = await Promise.all([
      resolveOrCacheSourceNovelCover(plugin, {
        cover: "https://source.test/covers/cover.jpg",
        name: "Sample Novel",
        path: "/foo/bar",
      }),
      resolveOrCacheSourceNovelCover(plugin, {
        cover: "https://source.test/covers/cover.jpg",
        name: "Sample Novel",
        path: "/foo//bar",
      }),
    ]);

    expect(singleSeparator).toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-foo-bar/cover.jpg",
    );
    expect(repeatedSeparator).toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-foo--bar/cover.jpg",
    );
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "novel_cover_store"),
    ).toHaveLength(2);
  });

  it("restores cached A when an active B request is followed by A", async () => {
    let storedCover: ReturnType<typeof desktopCoverResult> | null =
      desktopCoverResult("https://source.test/covers/a.jpg");
    invokeMock.mockImplementation((command, args) => {
      if (command === "novel_cover_read_manifest") {
        return Promise.resolve(storedCover);
      }
      if (command === "novel_cover_store") {
        storedCover = {
          manifest: (args as { manifest: string }).manifest,
          relativePath: "contents/demo/Sample-Novel-novel/cover.jpg",
        };
      }
      return Promise.resolve(undefined);
    });

    let markFirstFetchStarted!: () => void;
    let resolveFirstFetch!: (response: Response) => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const firstFetch = new Promise<Response>((resolve) => {
      resolveFirstFetch = resolve;
    });
    pluginMediaFetchMock.mockImplementationOnce(() => {
      markFirstFetchStarted();
      return firstFetch;
    });

    const plugin = makePlugin();
    const middle = resolveOrCacheSourceNovelCover(plugin, {
      cover: "https://source.test/covers/b.jpg",
      name: "Sample Novel",
      path: "/novel",
    });
    await firstFetchStarted;
    const latest = resolveOrCacheSourceNovelCover(plugin, {
      cover: "https://source.test/covers/a.jpg",
      name: "Sample Novel",
      path: "/novel",
    });
    resolveFirstFetch(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/jpeg" },
        status: 200,
      }),
    );

    await expect(Promise.all([middle, latest])).resolves.toEqual([
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
    ]);
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(pluginMediaFetchMock).toHaveBeenNthCalledWith(
      1,
      "https://source.test/covers/b.jpg",
      {
        contextUrl: "https://source.test/books/",
        preferBrowserCache: true,
        sourceId: "demo",
      },
    );
    expect(pluginMediaFetchMock).toHaveBeenNthCalledWith(
      2,
      "https://source.test/covers/a.jpg",
      {
        contextUrl: "https://source.test/books/",
        preferBrowserCache: true,
        sourceId: "demo",
      },
    );
    const storeCalls = invokeMock.mock.calls.filter(
      ([command]) => command === "novel_cover_store",
    );
    expect(storeCalls).toHaveLength(2);
    const storeArgs = storeCalls[1]?.[1] as { manifest?: string } | undefined;
    expect(
      JSON.parse(storeArgs?.manifest ?? "null") as { sourceUrl: string },
    ).toEqual(
      expect.objectContaining({
        sourceUrl: "https://source.test/covers/a.jpg",
      }),
    );
  });
});
