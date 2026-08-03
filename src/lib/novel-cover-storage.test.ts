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
  isWindowsRuntime: vi.fn(),
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
  resolveStoredNovelCoverSrc,
  saveNovelCoverFromSource,
  subscribeNovelCoverChanges,
} from "./novel-cover-storage";
import {
  isAndroidRuntime,
  isTauriRuntime,
  isWindowsRuntime,
} from "./tauri-runtime";
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
const isWindowsRuntimeMock = vi.mocked(isWindowsRuntime);

const novel = {
  id: 7,
  name: "Sample Novel",
  path: "/novel",
  pluginId: "demo",
};

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
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
    parseChapter: () => Promise.resolve(""),
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

beforeEach(() => {
  vi.clearAllMocks();
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  isWindowsRuntimeMock.mockReturnValue(false);
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
      coverManifest("https://source.test/covers/cover.jpg"),
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

  it("resolves a stored desktop cover to a norea-media URL", async () => {
    invokeMock.mockResolvedValueOnce(
      coverManifest("https://source.test/covers/cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "norea-media://reader-asset/contents/demo/Sample-Novel-novel/cover.jpg",
    );

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("novel_cover_read_manifest", {
      novelId: 7,
      novelName: "Sample Novel",
      novelPath: "/novel",
      sourceId: "demo",
    });
  });

  it("resolves a stored Windows desktop cover to the custom protocol host", async () => {
    isWindowsRuntimeMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce(
      coverManifest("https://source.test/covers/cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg",
    );
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
      coverManifest("https://source.test/old-cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc(novel),
    ).resolves.toBe(
      "norea-media://reader-asset/contents/demo/Sample-Novel-novel/cover.jpg",
    );
  });

  it("keeps cover URLs content-relative when the novel folder has unicode", async () => {
    invokeMock.mockResolvedValueOnce(
      coverManifest("https://source.test/covers/cover.jpg"),
    );

    await expect(
      resolveStoredNovelCoverSrc({
        id: 776601,
        name: "광마회귀",
        path: "webtoon/list?titleId=776601",
        pluginId: "naver-webtoon",
      }),
    ).resolves.toBe(
      "norea-media://reader-asset/contents/naver-webtoon/%EA%B4%91%EB%A7%88%ED%9A%8C%EA%B7%80-webtoon-list-titleId-776601/cover.jpg",
    );
  });

  it("keeps Windows cover URLs content-relative when the novel folder has unicode", async () => {
    isWindowsRuntimeMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce(
      coverManifest("https://source.test/covers/cover.jpg"),
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
