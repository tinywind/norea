import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("./android-storage", () => ({
  deleteAndroidStoragePath: vi.fn(),
  inspectAndroidNovelCover: vi.fn(),
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
  deleteAndroidStoragePath,
  inspectAndroidNovelCover,
  writeAndroidStorageBytes,
  writeAndroidStorageText,
} from "./android-storage";
import { invoke } from "@tauri-apps/api/core";
import { pluginMediaFetch } from "./http";
import {
  clearNovelCoverDisplayCache,
  getNovelCoverSnapshot,
  invalidateAllNovelCoverSources,
  peekCachedNovelCoverSrc,
  resolveCachedNovelCoverSrc,
  resolveNovelCoverDisplaySource,
  resolveStoredNovelCoverSrc,
  saveNovelCoverFromSource,
  subscribeNovelCoverChanges,
} from "./novel-cover-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import type { Plugin } from "./plugins/types";

const invokeMock = vi.mocked(invoke);
const deleteAndroidStoragePathMock = vi.mocked(deleteAndroidStoragePath);
const inspectAndroidNovelCoverMock = vi.mocked(inspectAndroidNovelCover);
const pluginMediaFetchMock = vi.mocked(pluginMediaFetch);
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
    novelPath: "/novel",
    sourceId: "demo",
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
  clearNovelCoverDisplayCache();
  vi.clearAllMocks();
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  deleteAndroidStoragePathMock.mockResolvedValue(undefined);
  inspectAndroidNovelCoverMock.mockResolvedValue(null);
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
    expect(listener).not.toHaveBeenCalled();
    expect(getNovelCoverSnapshot(novel.id)).toBe(snapshot);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      expectedSourceUrl: null,
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
        novelPath: "/novel",
        sourceId: "demo",
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

  it("does not store a successful challenge page as a cover", async () => {
    pluginMediaFetchMock.mockResolvedValueOnce(
      new Response("<html>challenge</html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
      }),
    );
    const listener = vi.fn();
    const unsubscribe = subscribeNovelCoverChanges(listener);

    try {
      await expect(
        saveNovelCoverFromSource(
          makePlugin(),
          novel,
          "https://source.test/covers/cover.jpg",
        ),
      ).rejects.toThrow("non-image content type (text/html)");
    } finally {
      unsubscribe();
    }

    expect(listener).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "novel_cover_store"),
    ).toHaveLength(0);
  });

  it("serializes cover saves across title changes by stable source identity", async () => {
    let storedCover: ReturnType<typeof desktopCoverResult> | null = null;
    invokeMock.mockImplementation((command, args) => {
      if (command === "novel_cover_read_manifest") {
        return Promise.resolve(storedCover);
      }
      if (command === "novel_cover_store") {
        storedCover = {
          manifest: (args as { manifest: string }).manifest,
          relativePath: "contents/demo/Old-Title-novel/cover.jpg",
        };
      }
      return Promise.resolve(undefined);
    });
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    pluginMediaFetchMock.mockReturnValueOnce(pendingFetch);
    const listener = vi.fn();
    const snapshot = getNovelCoverSnapshot(novel.id);
    const unsubscribe = subscribeNovelCoverChanges(listener);

    try {
      const first = saveNovelCoverFromSource(
        makePlugin(),
        { ...novel, name: "Old Title" },
        "https://source.test/covers/cover.jpg",
      );
      await vi.waitFor(() => expect(pluginMediaFetchMock).toHaveBeenCalledOnce());
      const second = saveNovelCoverFromSource(
        makePlugin(),
        { ...novel, name: "New Title" },
        "https://source.test/covers/cover.jpg",
      );
      resolveFetch(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
      );

      await Promise.all([first, second]);
    } finally {
      unsubscribe();
    }

    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "novel_cover_store"),
    ).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(novel.id);
    expect(getNovelCoverSnapshot(novel.id)).toBe(snapshot + 1);
  });

  it("writes Android cover files under the contents novel directory", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
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
    inspectAndroidNovelCoverMock.mockResolvedValueOnce({
      manifest: coverManifest("https://source.test/old.jpg", "cover.jpg"),
      relativePath: "contents/demo/Old-Title-novel/cover.jpg",
    });
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
      "contents/demo/Old-Title-novel/cover.png",
      new Uint8Array([6]),
      "image/png",
    );
    expect(deleteAndroidStoragePathMock).toHaveBeenCalledWith(
      "contents/demo/Old-Title-novel/cover.jpg",
    );
  });

  it("does not reuse a legacy Android cover directory while storing", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    inspectAndroidNovelCoverMock.mockResolvedValueOnce({
      manifest: JSON.stringify({
        contentType: "image/jpeg",
        fileName: "cover.jpg",
        sourceUrl: "https://source.test/covers/cover.jpg",
        updatedAt: 1,
        version: 1,
      }),
      relativePath: "contents/demo/Old-Title-novel/cover.jpg",
    });

    await saveNovelCoverFromSource(
      makePlugin(),
      { ...novel, name: "New Title" },
      "https://source.test/covers/cover.jpg",
    );

    expect(inspectAndroidNovelCoverMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSourceUrl: null }),
    );
    expect(writeAndroidStorageBytesMock).toHaveBeenCalledWith(
      "contents/demo/New-Title-novel/cover.jpg",
      new Uint8Array([1, 2, 3]),
      "image/jpeg",
    );
    expect(deleteAndroidStoragePathMock).not.toHaveBeenCalled();
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
      "http://norea-media.localhost/contents/demo/Sample-Novel-foo--bar/cover.jpg?v=1",
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      expectedSourceUrl: null,
      novelId: 7,
      novelName: "Sample Novel",
      novelPath: "/foo//bar",
      sourceId: "demo",
    });
  });

  it("resolves a stored Android cover to the direct storage URL", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    inspectAndroidNovelCoverMock.mockResolvedValueOnce({
      manifest: coverManifest(
        "https://source.test/covers/cover.webp",
        "cover.webp",
      ),
      relativePath: "contents/demo/Sample-Novel-novel/cover.webp",
    });

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "/__norea_android_media__/file/Y29udGVudHMvZGVtby9TYW1wbGUtTm92ZWwtbm92ZWwvY292ZXIud2VicA?v=1",
    );
  });

  it("encodes unicode Android cover paths in the direct storage URL", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    inspectAndroidNovelCoverMock.mockResolvedValueOnce({
      manifest: coverManifest("https://source.test/covers/cover.jpg"),
      relativePath:
        "contents/naver-webtoon/광마회귀-webtoon-list-titleId-776601/cover.jpg",
    });

    await expect(
      resolveStoredNovelCoverSrc({
        id: 776601,
        name: "광마회귀",
        path: "webtoon/list?titleId=776601",
        pluginId: "naver-webtoon",
      }),
    ).resolves.toBe(
      "/__norea_android_media__/file/Y29udGVudHMvbmF2ZXItd2VidG9vbi_qtJHrp4jtmozqt4Atd2VidG9vbi1saXN0LXRpdGxlSWQtNzc2NjAxL2NvdmVyLmpwZw?v=1",
    );
  });

  it("reuses an Android cover stored under an older novel title", async () => {
    isAndroidRuntimeMock.mockReturnValue(true);
    inspectAndroidNovelCoverMock.mockResolvedValueOnce({
      manifest: coverManifest("https://source.test/covers/cover.jpg"),
      relativePath: "contents/demo/Old-Title-novel/cover.jpg",
    });

    await expect(
      resolveStoredNovelCoverSrc({
        ...novel,
        cover: "https://source.test/covers/cover.jpg",
        name: "New Title",
      }),
    ).resolves.toBe(
      "/__norea_android_media__/file/Y29udGVudHMvZGVtby9PbGQtVGl0bGUtbm92ZWwvY292ZXIuanBn?v=1",
    );
    expect(inspectAndroidNovelCoverMock).toHaveBeenCalledWith({
      expectedSourceUrl: "https://source.test/covers/cover.jpg",
      novelPath: "/novel",
      novelIdentitySuffix: "-novel",
      preferredNovelDir: "contents/demo/New-Title-novel",
      sourceId: "demo",
      sourceDir: "contents/demo",
    });
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("prefers a stored desktop cover when the current remote URL differs", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult("https://source.test/old-cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg?v=1",
    );
  });

  it("canonicalizes a relative cover URL for legacy desktop lookup", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult("https://source.test/covers/cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc(
        { ...novel, cover: "/covers/cover.jpg" },
        makePlugin(),
      ),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg?v=1",
    );
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      expectedSourceUrl: "https://source.test/covers/cover.jpg",
      novelId: 7,
      novelName: "Sample Novel",
      novelPath: "/novel",
      sourceId: "demo",
    });
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
      "http://norea-media.localhost/contents/naver-webtoon/%EA%B4%91%EB%A7%88%ED%9A%8C%EA%B7%80-webtoon-list-titleId-776601/cover.jpg?v=1",
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
      "http://norea-media.localhost/contents/newtoki-webtoon/%EA%B0%80%EC%A0%95%EB%B6%80-%EA%B8%B8%EB%93%A4%EC%9D%B4%EA%B8%B0-webtoon-2025/cover.jpg?v=1",
    );
  });

  it("returns null instead of a remote cover when no stored cover exists", async () => {
    invokeMock.mockResolvedValueOnce(null);

    await expect(resolveStoredNovelCoverSrc(novel)).resolves.toBeNull();
  });
});

describe("cached novel cover display sources", () => {
  it("reuses a resolved stored cover without another native lookup", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    invokeMock.mockResolvedValue(
      desktopCoverResult("https://source.test/covers/cover.jpg"),
    );

    const first = await resolveCachedNovelCoverSrc(displayNovel, { plugin });
    const cached = peekCachedNovelCoverSrc(displayNovel, { plugin });
    const second = await resolveCachedNovelCoverSrc(displayNovel, { plugin });

    expect(first).toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg?v=1",
    );
    expect(cached).toBe(first);
    expect(second).toBe(first);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("keeps a cached cover when saving the same source is a no-op", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    invokeMock.mockResolvedValue(
      desktopCoverResult("https://source.test/covers/cover.jpg"),
    );

    const cached = await resolveCachedNovelCoverSrc(displayNovel, { plugin });
    await saveNovelCoverFromSource(plugin, novel, displayNovel.cover);

    expect(peekCachedNovelCoverSrc(displayNovel, { plugin })).toBe(cached);
    await expect(
      resolveCachedNovelCoverSrc(displayNovel, { plugin }),
    ).resolves.toBe(cached);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates a cached cover after storing new cover bytes", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/old.jpg",
    };
    invokeMock.mockResolvedValue(
      desktopCoverResult("https://source.test/covers/old.jpg"),
    );

    await resolveCachedNovelCoverSrc(displayNovel, { plugin });
    await saveNovelCoverFromSource(
      plugin,
      novel,
      "https://source.test/covers/new.jpg",
    );

    expect(peekCachedNovelCoverSrc(displayNovel, { plugin })).toBeUndefined();
  });

  it("coalesces concurrent source fallback requests and owns the blob URL", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    let resolveFetch!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    pluginMediaFetchMock.mockReturnValueOnce(pendingFetch);
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:cached-cover");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");

    try {
      const options = { allowSourceFallback: true, plugin };
      const first = resolveCachedNovelCoverSrc(displayNovel, options);
      const second = resolveCachedNovelCoverSrc(displayNovel, options);
      await vi.waitFor(() => expect(pluginMediaFetchMock).toHaveBeenCalledOnce());
      resolveFetch(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
      );

      await expect(Promise.all([first, second])).resolves.toEqual([
        "blob:cached-cover",
        "blob:cached-cover",
      ]);
      expect(invokeMock).toHaveBeenCalledOnce();
      expect(createObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).not.toHaveBeenCalled();

      clearNovelCoverDisplayCache(novel.id);
      expect(revokeObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:cached-cover");
    } finally {
      clearNovelCoverDisplayCache(novel.id);
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });

  it("retries a cached request after a challenge response", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    pluginMediaFetchMock
      .mockResolvedValueOnce(
        new Response("<html>challenge</html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/jpeg" },
          status: 200,
        }),
      );
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:retry-cover");

    try {
      const options = { allowSourceFallback: true, plugin };
      await expect(
        resolveCachedNovelCoverSrc(displayNovel, options),
      ).rejects.toThrow("non-image content type (text/html)");
      await expect(
        resolveCachedNovelCoverSrc(displayNovel, options),
      ).resolves.toBe("blob:retry-cover");
      expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    } finally {
      clearNovelCoverDisplayCache(novel.id);
      createObjectUrl.mockRestore();
    }
  });
});

describe("resolveNovelCoverDisplaySource", () => {
  it("uses an existing local cover without fetching or storing", async () => {
    invokeMock.mockResolvedValueOnce(
      desktopCoverResult("https://source.test/covers/old-cover.jpg"),
    );

    const resolved = await resolveNovelCoverDisplaySource(
      makePlugin(),
      {
        ...novel,
        cover: "https://source.test/covers/new-cover.jpg",
      },
      new AbortController().signal,
    );

    expect(resolved?.src).toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg?v=1",
    );
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "novel_cover_store"),
    ).toHaveLength(0);
  });

  it("uses a transient object URL when no local cover exists", async () => {
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:norea-cover");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const controller = new AbortController();

    try {
      const resolved = await resolveNovelCoverDisplaySource(
        makePlugin(),
        {
          ...novel,
          cover: "https://source.test/covers/cover.jpg",
        },
        controller.signal,
      );

      expect(resolved?.src).toBe("blob:norea-cover");
      expect(pluginMediaFetchMock).toHaveBeenCalledWith(
        "https://source.test/covers/cover.jpg",
        {
          contextUrl: "https://source.test/books/",
          sourceId: "demo",
        },
      );
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "novel_cover_store",
        ),
      ).toHaveLength(0);

      resolved?.dispose();
      resolved?.dispose();
      expect(revokeObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:norea-cover");
    } finally {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });

  it("uses the source WebView when local cover inspection fails", async () => {
    invokeMock.mockRejectedValueOnce(new Error("storage unavailable"));
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:norea-cover");

    try {
      const resolved = await resolveNovelCoverDisplaySource(makePlugin(), {
        ...novel,
        cover: "https://source.test/covers/cover.jpg",
      });

      expect(resolved?.src).toBe("blob:norea-cover");
      expect(pluginMediaFetchMock).toHaveBeenCalledWith(
        "https://source.test/covers/cover.jpg",
        {
          contextUrl: "https://source.test/books/",
          sourceId: "demo",
        },
      );
      resolved?.dispose();
    } finally {
      debug.mockRestore();
      createObjectUrl.mockRestore();
    }
  });

  it("returns the remote URL directly outside the app runtime", async () => {
    isTauriRuntimeMock.mockReturnValue(false);

    const resolved = await resolveNovelCoverDisplaySource(makePlugin(), {
      ...novel,
      cover: "/covers/cover.jpg",
    });

    expect(resolved?.src).toBe("https://source.test/covers/cover.jpg");
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("rejects an aborted transient request before creating an object URL", async () => {
    const controller = new AbortController();
    controller.abort();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");

    try {
      await expect(
        resolveNovelCoverDisplaySource(
          makePlugin(),
          {
            ...novel,
            cover: "https://source.test/covers/cover.jpg",
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(pluginMediaFetchMock).not.toHaveBeenCalled();
      expect(createObjectUrl).not.toHaveBeenCalled();
    } finally {
      createObjectUrl.mockRestore();
    }
  });

  it("discards a fetch result when the UI request is aborted", async () => {
    const controller = new AbortController();
    let resolveFetch!: (response: Response) => void;
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg" },
      status: 200,
    });
    const blob = vi.spyOn(response, "blob");
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    pluginMediaFetchMock.mockReturnValueOnce(fetchResponse);

    try {
      const request = resolveNovelCoverDisplaySource(
        makePlugin(),
        {
          ...novel,
          cover: "https://source.test/covers/cover.jpg",
        },
        controller.signal,
      );
      await vi.waitFor(() => expect(pluginMediaFetchMock).toHaveBeenCalled());
      expect(pluginMediaFetchMock).toHaveBeenCalledWith(
        "https://source.test/covers/cover.jpg",
        {
          contextUrl: "https://source.test/books/",
          sourceId: "demo",
        },
      );

      controller.abort();
      resolveFetch(response);

      await expect(request).rejects.toMatchObject({ name: "AbortError" });
      expect(blob).not.toHaveBeenCalled();
      expect(createObjectUrl).not.toHaveBeenCalled();
    } finally {
      blob.mockRestore();
      createObjectUrl.mockRestore();
    }
  });
});

describe("invalidateAllNovelCoverSources", () => {
  it("clears shared sources and advances every cover snapshot", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:global-cover");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const listener = vi.fn();
    const snapshot = getNovelCoverSnapshot(novel.id);
    const unsubscribe = subscribeNovelCoverChanges(listener);

    try {
      await resolveCachedNovelCoverSrc(displayNovel, {
        allowSourceFallback: true,
        plugin,
      });
      invalidateAllNovelCoverSources();

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(0);
      expect(getNovelCoverSnapshot(novel.id)).toBe(snapshot + 1);
      expect(revokeObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:global-cover");
      expect(
        peekCachedNovelCoverSrc(displayNovel, {
          allowSourceFallback: true,
          plugin,
        }),
      ).toBeUndefined();
    } finally {
      unsubscribe();
      clearNovelCoverDisplayCache();
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
    }
  });
});
