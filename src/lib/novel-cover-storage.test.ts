import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http", () => ({ pluginMediaFetch: vi.fn() }));
vi.mock("../db/work-metadata", () => ({ knownNovelMetadataDirectory: vi.fn() }));
vi.mock("./work-metadata", () => ({ workMetadataOperation: vi.fn(), persistNovelCover: vi.fn() }));
vi.mock("./chapter-storage-resolution", () => ({ resolvedNovelStorageDir: vi.fn() }));
vi.mock("./tauri-runtime", () => ({ isAndroidRuntime: vi.fn(), isTauriRuntime: vi.fn() }));

import { pluginMediaFetch } from "./http";
import {
  clearNovelCoverDisplayCache, acquireCachedNovelCoverSource, getNovelCoverSnapshot,
  invalidateAllNovelCoverSources, notifyNovelCoverChanged, peekCachedNovelCoverSrc,
  persistCachedNovelCoverSource,
  resolveCachedNovelCoverSrc, resolveNovelCoverDisplaySource, resolveStoredNovelCoverSrc,
  saveNovelCoverFromSource, subscribeNovelCoverChanges,
} from "./novel-cover-storage";
import { isAndroidRuntime, isTauriRuntime } from "./tauri-runtime";
import type { Plugin } from "./plugins/types";
import { runWithScraperExecutor } from "./tasks/scraper-queue";
import { knownNovelMetadataDirectory } from "../db/work-metadata";
import { workMetadataOperation, persistNovelCover } from "./work-metadata";
import { resolvedNovelStorageDir } from "./chapter-storage-resolution";

const workMetadataMock = vi.mocked(workMetadataOperation);
const pluginMediaFetchMock = vi.mocked(pluginMediaFetch);
const isAndroidRuntimeMock = vi.mocked(isAndroidRuntime);
const isTauriRuntimeMock = vi.mocked(isTauriRuntime);
const novel = { id: 7, name: "Sample Novel", path: "/novel", pluginId: "demo" };
const directory = "contents/demo/Sample-Novel-novel";
function coverVersion(): string {
  const snapshot = getNovelCoverSnapshot(novel.id);
  return snapshot ? `1-${snapshot}` : "1";
}
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


function desktopCoverResult(_sourceUrl: string) {
  return { cover: { fileName: "cover.jpg", modifiedAt: 1 } };
}
beforeEach(() => {
  invalidateAllNovelCoverSources();
  vi.clearAllMocks();
  isAndroidRuntimeMock.mockReturnValue(false);
  isTauriRuntimeMock.mockReturnValue(true);
  vi.mocked(knownNovelMetadataDirectory).mockReturnValue(undefined);
  vi.mocked(resolvedNovelStorageDir).mockImplementation(id => (id ?? 0) > 0 ? directory : null);
  workMetadataMock.mockReset().mockResolvedValue({ cover: null });
  vi.mocked(persistNovelCover).mockReset().mockResolvedValue(undefined);
  pluginMediaFetchMock.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "image/jpeg" }, status: 200,
  }));
});

describe("saveNovelCoverFromSource", () => {
  it.each([false, true])("stores only image bytes and a local descriptor (Android: %s)", async android => {
    isAndroidRuntimeMock.mockReturnValue(android);
    await saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg");
    expect(persistNovelCover).toHaveBeenCalledExactlyOnceWith(directory, {
      body: new Uint8Array([1, 2, 3]), contentType: "image/jpeg", fileName: "cover.jpg",
    });
    expect(pluginMediaFetchMock).toHaveBeenCalledWith("https://source.test/cover.jpg", {
      contextUrl: "https://source.test/books/", sourceId: "demo",
    });
  });
  it("preserves an existing local cover during automatic metadata updates", async () => {
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    await saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg?v=1");
    await saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg?v=2");
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(persistNovelCover).not.toHaveBeenCalled();
  });
  it("fetches the cover again on every explicit metadata refresh even with the same URL", async () => {
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    const plugin = makePlugin({ imageRequestInit: { headers: { Referer: "https://source.test/" } } });
    await saveNovelCoverFromSource(plugin, novel, "/cover.jpg", { refresh: true });
    await saveNovelCoverFromSource(plugin, novel, "/cover.jpg", { refresh: true });
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(pluginMediaFetchMock).toHaveBeenCalledWith("https://source.test/cover.jpg", expect.objectContaining({
      headers: { Referer: "https://source.test/", "Cache-Control": "no-cache" },
    }));
    expect(persistNovelCover).toHaveBeenCalledTimes(2);
  });
  it("keeps the loaded local cover when an explicit refresh fails", async () => {
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const src = await resolveCachedNovelCoverSrc(displayNovel);
    pluginMediaFetchMock.mockRejectedValueOnce(new Error("Source unavailable"));
    await expect(saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg", { refresh: true })).rejects.toThrow("Source unavailable");
    expect(peekCachedNovelCoverSrc(displayNovel)).toBe(src);
    expect(persistNovelCover).not.toHaveBeenCalled();
  });
  it("does not let automatic cover storage supersede an explicit refresh", async () => {
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    await Promise.all([
      saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg", { refresh: true }),
      saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg"),
    ]);
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
    expect(persistNovelCover).toHaveBeenCalledOnce();
  });
  it("stores an unlabelled image without adding a source URL or invalid MIME descriptor", async () => {
    pluginMediaFetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "application/octet-stream" } }));
    await saveNovelCoverFromSource(makePlugin(), novel, "/image?id=1");
    expect(persistNovelCover).toHaveBeenCalledExactlyOnceWith(directory, {
      body: new Uint8Array([1, 2]), fileName: "cover.img", contentType: null,
    });
  });
  it("does not save a challenge page as an image", async () => {
    pluginMediaFetchMock.mockResolvedValue(new Response("challenge", { headers: { "content-type": "text/html" } }));
    await expect(saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg")).rejects.toThrow("non-image");
    expect(persistNovelCover).not.toHaveBeenCalled();
  });
  it("notifies the affected work after publication", async () => {
    const listener = vi.fn(); const unsubscribe = subscribeNovelCoverChanges(listener);
    try {
      await saveNovelCoverFromSource(makePlugin(), novel, "/cover.jpg");
      expect(listener).toHaveBeenCalledExactlyOnceWith(novel.id);
    } finally { unsubscribe(); }
  });
  it("serializes competing saves under the exact work identity across title changes", async () => {
    let finish!: () => void;
    vi.mocked(persistNovelCover).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = saveNovelCoverFromSource(makePlugin(), novel, "/first.jpg");
    await vi.waitFor(() => expect(persistNovelCover).toHaveBeenCalledOnce());
    const second = saveNovelCoverFromSource(makePlugin(), { ...novel, name: "Renamed" }, "/second.jpg");
    expect(persistNovelCover).toHaveBeenCalledOnce();
    finish(); await Promise.all([first, second]);
    expect(persistNovelCover).toHaveBeenCalledTimes(2);
    expect(pluginMediaFetchMock.mock.calls[1]?.[0]).toBe("https://source.test/second.jpg");
  });
});

describe("stored cover discovery", () => {
  it.each([false, true])("uses the actual cover file without a source URL or sidecar (Android: %s)", async android => {
    isAndroidRuntimeMock.mockReturnValue(android);
    workMetadataMock.mockResolvedValue({ cover: { fileName: "cover.jpg", modifiedAt: 1 } });
    const src = await resolveStoredNovelCoverSrc(novel);
    expect(src).toContain(android ? "/__norea_android_media__/file/" : `http://norea-media.localhost/${directory}/cover.jpg`);
    expect(workMetadataMock).toHaveBeenCalledExactlyOnceWith({ operation: "cover", path: `${directory}/novel.json` });
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });
  it("uses the indexed directory after a work title changes", async () => {
    vi.mocked(resolvedNovelStorageDir).mockReturnValue("contents/demo/Original");
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    expect(await resolveStoredNovelCoverSrc({ ...novel, name: "New title" })).toContain("/Original/cover.jpg");
  });
  it("does not derive an unindexed work location from its title", async () => {
    vi.mocked(resolvedNovelStorageDir).mockReturnValue(null);
    expect(await resolveStoredNovelCoverSrc(novel)).toBeNull();
    expect(workMetadataMock).not.toHaveBeenCalled();
  });
});

describe("cached novel cover display sources", () => {
  it("reuses a browse cover without searching local work folders", async () => {
    const displayNovel = { ...novel, id: 0, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    const first = acquireCachedNovelCoverSource(displayNovel, options);
    const src = await first.promise;
    first.release();
    const second = acquireCachedNovelCoverSource(displayNovel, options);
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBe(src);
    await expect(second.promise).resolves.toBe(src);
    second.release();
    expect(workMetadataMock).not.toHaveBeenCalled();
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
  });

  it("uses the indexed cover of a browse result without enumerating chapter folders", async () => {
    vi.mocked(knownNovelMetadataDirectory).mockReturnValue("contents/demo/Renamed-novel");
    workMetadataMock.mockResolvedValue({ cover: { fileName: "cover.jpg", modifiedAt: 1 } });
    const source = await resolveNovelCoverDisplaySource(makePlugin(), { ...novel, id: 0, cover: "/cover.jpg" });
    expect(source?.src).toContain("contents/demo/Renamed-novel/cover.jpg");
    expect(workMetadataOperation).toHaveBeenCalledExactlyOnceWith({ operation: "cover", path: "contents/demo/Renamed-novel/novel.json" });
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("cancels an unfinished cover only after its last consumer leaves", async () => {
    pluginMediaFetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const displayNovel = { ...novel, id: 0, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    const first = acquireCachedNovelCoverSource(displayNovel, options);
    const second = acquireCachedNovelCoverSource(displayNovel, options);
    const settled = Promise.allSettled([first.promise, second.promise]);
    await vi.waitFor(() => expect(pluginMediaFetchMock).toHaveBeenCalledOnce());
    const signal = pluginMediaFetchMock.mock.calls[0]![1]!.signal!;
    first.release();
    expect(signal.aborted).toBe(false);
    second.release();
    expect(signal.aborted).toBe(true);
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBeUndefined();
  });

  it("invalidates a browse cover by source identity after it is saved to the library", async () => {
    const displayNovel = { ...novel, id: 0, cover: "/cover.jpg" };
    const other = { ...displayNovel, path: "/other" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    await resolveCachedNovelCoverSrc(displayNovel, options);
    await resolveCachedNovelCoverSrc(other, options);
    const snapshot = getNovelCoverSnapshot(0);
    notifyNovelCoverChanged(novel.id, novel);
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBeUndefined();
    expect(peekCachedNovelCoverSrc(other, options)).toEqual(expect.any(String));
    expect(getNovelCoverSnapshot(0)).toBeGreaterThan(snapshot);
  });

  it("bounds unused browse covers while retaining covers still on screen", async () => {
    pluginMediaFetchMock.mockImplementation(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    const displayNovel = { ...novel, id: 0, cover: "/cover.jpg" };
    const visible = acquireCachedNovelCoverSource(displayNovel, options);
    await visible.promise;
    const oldest = { ...displayNovel, path: "/oldest" };
    const first = acquireCachedNovelCoverSource(oldest, options);
    await first.promise;
    first.release();
    for (let index = 0; index < 100; index++) {
      const handle = acquireCachedNovelCoverSource({ ...displayNovel, path: `/book/${index}` }, options);
      await handle.promise;
      handle.release();
    }
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toEqual(expect.any(String));
    expect(peekCachedNovelCoverSrc(oldest, options)).toBeUndefined();
    visible.release();
  });

  it("reuses a resolved stored cover without another native lookup", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    workMetadataMock.mockResolvedValue(
      desktopCoverResult("https://source.test/covers/cover.jpg"),
    );

    const first = await resolveCachedNovelCoverSrc(displayNovel, { plugin });
    const cached = peekCachedNovelCoverSrc(displayNovel, { plugin });
    const second = await resolveCachedNovelCoverSrc(displayNovel, { plugin });

    expect(first).toBe(
      `http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg?v=${coverVersion()}`,
    );
    expect(cached).toBe(first);
    expect(second).toBe(first);
    expect(workMetadataMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])("shares a loaded local cover between the library and work home (Android: %s)", async android => {
    isAndroidRuntimeMock.mockReturnValue(android);
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const library = acquireCachedNovelCoverSource(displayNovel);
    const src = await library.promise;
    library.release();

    const refreshedNovel = { ...displayNovel, name: "Updated title", cover: "/updated.jpg" };
    const homeOptions = { allowSourceFallback: true, plugin: makePlugin({ version: "2.0.0" }) };
    expect(peekCachedNovelCoverSrc(refreshedNovel, homeOptions)).toBe(src);
    const home = acquireCachedNovelCoverSource(refreshedNovel, homeOptions);
    await expect(home.promise).resolves.toBe(src);
    home.release();

    expect(peekCachedNovelCoverSrc(refreshedNovel)).toBe(src);
    expect(workMetadataMock).toHaveBeenCalledOnce();
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("reuses a local cover loaded by the work home when returning to the library", async () => {
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const home = acquireCachedNovelCoverSource(displayNovel, { allowSourceFallback: true, plugin: makePlugin() });
    const src = await home.promise;
    home.release();

    expect(peekCachedNovelCoverSrc(displayNovel)).toBe(src);
    await expect(resolveCachedNovelCoverSrc(displayNovel)).resolves.toBe(src);
    expect(workMetadataMock).toHaveBeenCalledOnce();
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("shares an unfinished local lookup across a library to work home transition", async () => {
    let finish!: (result: ReturnType<typeof desktopCoverResult>) => void;
    const lookup = new Promise<ReturnType<typeof desktopCoverResult>>(resolve => { finish = resolve; });
    workMetadataMock.mockReturnValue(lookup);
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const library = acquireCachedNovelCoverSource(displayNovel);
    await vi.waitFor(() => expect(workMetadataMock).toHaveBeenCalledOnce());
    const homeOptions = { allowSourceFallback: true, plugin: makePlugin() };
    const home = acquireCachedNovelCoverSource(displayNovel, homeOptions);
    await vi.dynamicImportSettled();
    library.release();
    finish(desktopCoverResult(""));

    const [, src] = await Promise.all([library.promise, home.promise]);
    home.release();
    expect(workMetadataMock).toHaveBeenCalledOnce();
    expect(src).toContain("/cover.jpg?v=");
    expect(peekCachedNovelCoverSrc(displayNovel)).toBe(src);
    expect(peekCachedNovelCoverSrc(displayNovel, homeOptions)).toBe(src);
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("fetches a missing cover only for source-enabled views without caching a missing local file", async () => {
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    await expect(resolveCachedNovelCoverSrc(displayNovel)).resolves.toBeNull();
    const remote = await resolveCachedNovelCoverSrc(displayNovel, options);
    expect(remote).toMatch(/^blob:/);
    expect(peekCachedNovelCoverSrc(displayNovel)).toBeUndefined();
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBe(remote);

    await resolveCachedNovelCoverSrc({ ...displayNovel, cover: "/updated.jpg" }, options);
    expect(pluginMediaFetchMock).toHaveBeenCalledTimes(2);
    expect(workMetadataMock).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("persists a recovered library cover once and reopens it offline (Android: %s)", async android => {
    isAndroidRuntimeMock.mockReturnValue(android);
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    const source = await resolveCachedNovelCoverSrc(displayNovel, options);
    expect(source).toMatch(/^blob:/);
    vi.mocked(persistNovelCover).mockImplementationOnce(async () => {
      workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    });

    await persistCachedNovelCoverSource(displayNovel, options);
    expect(persistNovelCover).toHaveBeenCalledExactlyOnceWith(directory, {
      body: new Uint8Array([1, 2, 3]), contentType: "image/jpeg", fileName: "cover.jpg",
    }, { preserveExisting: true });
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();

    const local = await resolveCachedNovelCoverSrc(displayNovel, options);
    expect(local).toContain(android ? "/__norea_android_media__/file/" : "/cover.jpg?v=");
    await persistCachedNovelCoverSource(displayNovel, options);
    invalidateAllNovelCoverSources();
    pluginMediaFetchMock.mockRejectedValue(new Error("offline"));
    await expect(resolveCachedNovelCoverSrc(displayNovel, options)).resolves.toContain(android ? "/__norea_android_media__/file/" : "/cover.jpg?v=");
    expect(persistNovelCover).toHaveBeenCalledOnce();
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
  });

  it("retains a transient cover across library and work home navigation before storage completes", async () => {
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    const library = acquireCachedNovelCoverSource(displayNovel, options);
    const source = await library.promise;
    library.release();
    const home = acquireCachedNovelCoverSource(displayNovel, options);
    await expect(home.promise).resolves.toBe(source);
    home.release();
    const returned = acquireCachedNovelCoverSource(displayNovel, options);
    await expect(returned.promise).resolves.toBe(source);
    returned.release();
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a cover installed after the fallback image was fetched", async () => {
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    await resolveCachedNovelCoverSrc(displayNovel, options);
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    await persistCachedNovelCoverSource(displayNovel, options);
    expect(persistNovelCover).not.toHaveBeenCalled();
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
  });

  it("retains the displayed cover when recovered cover persistence fails", async () => {
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    const source = await resolveCachedNovelCoverSrc(displayNovel, options);
    vi.mocked(persistNovelCover).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(persistCachedNovelCoverSource(displayNovel, options)).rejects.toThrow("storage unavailable");
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBe(source);
    await expect(resolveCachedNovelCoverSrc(displayNovel, options)).resolves.toBe(source);
    expect(pluginMediaFetchMock).toHaveBeenCalledOnce();
  });

  it("does not write a transient browse result or a work without an indexed storage directory", async () => {
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    for (const id of [0, novel.id]) {
      const displayNovel = { ...novel, id, cover: "/cover.jpg" };
      vi.mocked(resolvedNovelStorageDir).mockReturnValue(null);
      await resolveCachedNovelCoverSrc(displayNovel, options);
      await persistCachedNovelCoverSource(displayNovel, options);
    }
    expect(persistNovelCover).not.toHaveBeenCalled();
  });

  it("retries a missing local cover after its work directory is registered", async () => {
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    vi.mocked(resolvedNovelStorageDir).mockReturnValue(null);
    await expect(resolveCachedNovelCoverSrc(displayNovel)).resolves.toBeNull();
    vi.mocked(resolvedNovelStorageDir).mockReturnValue(directory);
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    await expect(resolveCachedNovelCoverSrc(displayNovel)).resolves.toContain("/cover.jpg?v=");
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("invalidates the shared local cover after replacement", async () => {
    const displayNovel = { ...novel, cover: "/cover.jpg" };
    const options = { allowSourceFallback: true, plugin: makePlugin() };
    workMetadataMock.mockResolvedValue(desktopCoverResult(""));
    const previous = await resolveCachedNovelCoverSrc(displayNovel, options);
    notifyNovelCoverChanged(novel.id, novel);
    workMetadataMock.mockResolvedValue({ cover: { fileName: "cover.png", modifiedAt: 2 } });

    expect(peekCachedNovelCoverSrc(displayNovel)).toBeUndefined();
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBeUndefined();
    const current = await resolveCachedNovelCoverSrc(displayNovel);
    expect(current).not.toBe(previous);
    expect(current).toContain("/cover.png?v=");
    expect(peekCachedNovelCoverSrc(displayNovel, options)).toBe(current);
    expect(workMetadataMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a loaded cover without another native lookup or fetch during automatic storage", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/cover.jpg",
    };
    workMetadataMock.mockResolvedValue(
      desktopCoverResult("https://source.test/covers/cover.jpg"),
    );

    await saveNovelCoverFromSource(plugin, novel, displayNovel.cover);
    workMetadataMock.mockClear();
    const cached = await resolveCachedNovelCoverSrc(displayNovel, { plugin });
    await saveNovelCoverFromSource(plugin, novel, displayNovel.cover);

    expect(peekCachedNovelCoverSrc(displayNovel, { plugin })).toBe(cached);
    await expect(
      resolveCachedNovelCoverSrc(displayNovel, { plugin }),
    ).resolves.toBe(cached);
    expect(workMetadataMock).toHaveBeenCalledOnce();
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
  });

  it("invalidates a cached cover after storing new cover bytes", async () => {
    const plugin = makePlugin();
    const displayNovel = {
      ...novel,
      cover: "https://source.test/covers/old.jpg",
    };
    workMetadataMock.mockResolvedValue(
      desktopCoverResult("https://source.test/covers/old.jpg"),
    );

    await resolveCachedNovelCoverSrc(displayNovel, { plugin });
    await saveNovelCoverFromSource(
      plugin,
      novel,
      "https://source.test/covers/new.jpg",
      { refresh: true },
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
      expect(workMetadataMock).toHaveBeenCalledOnce();
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
    workMetadataMock.mockResolvedValueOnce(
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
      `http://norea-media.localhost/contents/demo/Sample-Novel-novel/cover.jpg?v=${coverVersion()}`,
    );
    expect(pluginMediaFetchMock).not.toHaveBeenCalled();
    expect(persistNovelCover).not.toHaveBeenCalled();
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
          priority: "deferred",
          signal: controller.signal,
          sourceId: "demo",
        },
      );
      expect(persistNovelCover).not.toHaveBeenCalled();

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
    workMetadataMock.mockRejectedValueOnce(new Error("storage unavailable"));
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
          priority: "deferred",
          signal: expect.any(AbortSignal),
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

  it("keeps cached display covers independent of the active source task", async () => {
    const controller = new AbortController();
    await runWithScraperExecutor("demo", "open-novel", "immediate", controller.signal, async () => {
      const resolved = await resolveNovelCoverDisplaySource(makePlugin(), {
        ...novel,
        cover: "https://source.test/covers/cover.jpg",
      });
      const signal = pluginMediaFetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal).not.toBe(controller.signal);
      resolved?.dispose();
    });
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
          priority: "deferred",
          signal: controller.signal,
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

it("changes only the affected stored cover URL when its bytes change without a new metadata timestamp", async () => {
  const current = { ...novel, id: 401 };
  const other = { ...novel, id: 402 };
  workMetadataMock.mockResolvedValue({ cover: { fileName: "cover.png", modifiedAt: 100 } });
  const before = await resolveStoredNovelCoverSrc(current);
  const otherBefore = await resolveStoredNovelCoverSrc(other);
  notifyNovelCoverChanged(current.id);
  expect(await resolveStoredNovelCoverSrc(current)).not.toBe(before);
  expect(await resolveStoredNovelCoverSrc(other)).toBe(otherBefore);
});
