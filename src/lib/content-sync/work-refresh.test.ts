import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./chapters", () => ({ fetchServerChapters: mocks.chapters }));
vi.mock("../../db/queries/content-sync", () => ({ cacheServerChapters: mocks.cache }));
import type { NovelMetadataV1 } from "../work-metadata";

const mocks = vi.hoisted(() => ({
  novel: vi.fn(), source: vi.fn(), read: vi.fn(), install: vi.fn(), cover: vi.fn(),
  plugin: vi.fn(), executor: vi.fn(), enqueue: vi.fn(), cancel: vi.fn(), sync: vi.fn(),
  load: vi.fn(), chapters: vi.fn(), cache: vi.fn(), storedCover: vi.fn(), commit: vi.fn(),
  settings: { serverUrl: "http://server", deviceName: "Tablet", lookupTimeoutSeconds: 3 },
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: mocks.novel }));
vi.mock("../../db/work-metadata", () => ({ knownNovelMetadataDirectory: () => "contents/source/Book-book" }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => mocks.settings } }));
vi.mock("./novel-source", () => ({ readServerNovelSource: mocks.source }));
vi.mock("./browse", () => ({ readServerCover: mocks.cover }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "token") }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("../work-metadata", async original => ({ ...await original<typeof import("../work-metadata")>(), readStoredNovelMetadata: mocks.read, installStoredNovelMetadata: mocks.install, readStoredNovelCover: mocks.storedCover }));
vi.mock("../plugins/manager", () => ({ pluginManager: { getPlugin: mocks.plugin, getPluginForExecutor: mocks.executor, loadInstalledFromDb: mocks.load } }));
vi.mock("../tauri-runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("../plugins/sync-novel", () => ({ syncNovelFromSource: mocks.sync }));
vi.mock("../tasks/source-tasks", () => ({ enqueueSourceTask: mocks.enqueue }));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: { cancel: mocks.cancel } }));

import { contentServerRequest, ContentServerError } from "./client";
import { contentWorkId } from "./works";
import { syncServerNovelOnOpen, refreshServerNovelFromSource } from "./work-refresh";

const chapter = { chapterPath: "/chapter/1", name: "One", chapterNumber: "1", position: 1, page: "1", contentType: "html" as const, releaseTime: null, directory: "1-One" };
const local: NovelMetadataV1 = {
  schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book" },
  novel: { name: "Book", author: "Author", artist: null, summary: "Local summary", status: null, rating: null, genres: null, isLocal: false },
  cover: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.chapters.mockResolvedValue([chapter]);
  mocks.cache.mockResolvedValue(true);
  mocks.settings.serverUrl = "http://server";
  mocks.novel.mockResolvedValue({ id: 42, ...local.novel, pluginId: "source", path: "/book" });
  mocks.source.mockResolvedValue(null);
  mocks.read.mockResolvedValue({ directory: "contents/source/Book-book", metadata: structuredClone(local) });
  mocks.storedCover.mockReset().mockResolvedValue(null);
  mocks.cover.mockReset().mockResolvedValue(null);
  mocks.install.mockImplementation(async (metadata, _cover, guard) => {
    if (await guard(await mocks.read()) === false) return null;
    mocks.commit(metadata);
    return { metadata };
  });
  mocks.plugin.mockReturnValue({ id: "source", name: "Source" });
  mocks.executor.mockReturnValue({ id: "source" });
  mocks.enqueue.mockImplementation(options => ({ id: "task", promise: options.run({ signal: new AbortController().signal, executor: "background" }) }));
  vi.mocked(contentServerRequest).mockReset();
});
afterEach(() => vi.useRealTimers());

it("refreshes only the opened work and retains locally known chapters", async () => {
  const metadata = { ...local, novel: { ...local.novel, summary: "Updated" } };
  const id = await contentWorkId(local.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: false });
  expect(await syncServerNovelOnOpen(42)).toBe(true);
  expect(mocks.cache).toHaveBeenCalledWith(42, [chapter], undefined);
  expect(contentServerRequest).toHaveBeenCalledOnce();
  expect(vi.mocked(contentServerRequest).mock.calls[0]![1]).toBe(`/works/${id}`);
  expect(mocks.install.mock.calls[0]![0]).toMatchObject({ identity: local.identity, novel: { summary: "Updated" } });
});

it("does not try a folder-name work identity after an exact identity misses", async () => {
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
  expect(await syncServerNovelOnOpen(42)).toBe(false);
  expect(contentServerRequest).toHaveBeenCalledOnce();
  expect(mocks.install).not.toHaveBeenCalled();
});

it("does not replace edits made while the server request was in flight", async () => {
  vi.mocked(contentServerRequest).mockImplementationOnce(async () => {
    mocks.read.mockResolvedValue({ directory: "contents/source/Book-book", metadata: { ...local, novel: { ...local.novel, name: "Edited locally" } } });
    return { id: await contentWorkId(local.identity), metadata: { ...local, novel: { ...local.novel, summary: "Server summary" } }, hasCover: false };
  });
  await expect(syncServerNovelOnOpen(42)).resolves.toBe(true);
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.cache).toHaveBeenCalledWith(42, [chapter], undefined);
});

it("keeps unchanged work metadata out of the installation path while refreshing chapter availability", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata: structuredClone(local), hasCover: false });
  expect(await syncServerNovelOnOpen(42)).toBe(true);
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.cache).toHaveBeenCalledWith(42, [chapter], undefined);
});

it("does not report a local change when metadata and cached chapters are unchanged", async () => {
  mocks.cache.mockResolvedValue(false);
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata: structuredClone(local), hasCover: false });
  expect(await syncServerNovelOnOpen(42)).toBe(false);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("skips conflicting server metadata without failing the installation transaction", async () => {
  let guardResult: unknown = "not called";
  mocks.cache.mockResolvedValue(false);
  mocks.install.mockImplementation(async (_metadata, _cover, guard) => {
    guardResult = await guard({ directory: "contents/source/Book-book", metadata: { ...local, novel: { ...local.novel, name: "Edited locally" } } });
    return null;
  });
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata: { ...local, novel: { ...local.novel, summary: "Server summary" } }, hasCover: false });
  expect(await syncServerNovelOnOpen(42)).toBe(false);
  expect(guardResult).toBe(false);
});

it("does not reinstall an identical cover when the work is opened again", async () => {
  const metadata = { ...local, cover: { fileName: "cover.jpg", contentType: "image/jpeg" } };
  mocks.read.mockResolvedValue({ directory: "contents/source/Book-book", metadata });
  mocks.storedCover.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mocks.cover.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata, hasCover: true });
  expect(await syncServerNovelOnOpen(42)).toBe(true);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("installs changed cover bytes even when their metadata is unchanged", async () => {
  const metadata = { ...local, cover: { fileName: "cover.jpg", contentType: "image/jpeg" } };
  mocks.read.mockResolvedValue({ directory: "contents/source/Book-book", metadata });
  mocks.storedCover.mockResolvedValue(new Uint8Array([1]));
  mocks.cover.mockResolvedValue({ bytes: new Uint8Array([2]), contentType: "image/jpeg" });
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata, hasCover: true });
  expect(await syncServerNovelOnOpen(42)).toBe(true);
  expect(mocks.install).toHaveBeenCalledWith(metadata, new Uint8Array([2]), expect.any(Function));
  expect(mocks.commit).toHaveBeenCalledOnce();
});

it("retains source cover bytes changed while a server refresh was pending", async () => {
  const metadata = { ...local, cover: { fileName: "cover.jpg", contentType: "image/jpeg" } };
  mocks.read.mockResolvedValue({ directory: "contents/source/Book-book", metadata });
  mocks.storedCover.mockResolvedValueOnce(new Uint8Array([1])).mockResolvedValue(new Uint8Array([3]));
  mocks.cover.mockResolvedValue({ bytes: new Uint8Array([2]), contentType: "image/jpeg" });
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata, hasCover: true });
  expect(await syncServerNovelOnOpen(42)).toBe(true);
  expect(mocks.commit).not.toHaveBeenCalled();
});

it("keeps server chapters without applying metadata after the source has refreshed", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata: { ...local, novel: { ...local.novel, summary: "Server summary" } }, hasCover: false });
  expect(await syncServerNovelOnOpen(42, undefined, () => false)).toBe(true);
  expect(mocks.install).not.toHaveBeenCalled();
  expect(mocks.cache).toHaveBeenCalledWith(42, [chapter], undefined);
});

it("rechecks source precedence inside the metadata installation guard", async () => {
  let sourceRefreshed = false;
  vi.mocked(contentServerRequest).mockResolvedValue({ id: await contentWorkId(local.identity), metadata: { ...local, novel: { ...local.novel, summary: "Server summary" } }, hasCover: false });
  mocks.install.mockImplementation(async (metadata, _cover, guard) => {
    sourceRefreshed = true;
    if (await guard(await mocks.read()) === false) return null;
    mocks.commit(metadata);
    return { metadata };
  });
  expect(await syncServerNovelOnOpen(42, undefined, () => !sourceRefreshed)).toBe(true);
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.cache).toHaveBeenCalledWith(42, [chapter], undefined);
});

it("times out without installing a late server response", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  vi.mocked(contentServerRequest).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = expect(syncServerNovelOnOpen(42)).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(contentServerRequest).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(3000);
  await pending;
  finish({ id: await contentWorkId(local.identity), metadata: local, hasCover: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.install).not.toHaveBeenCalled();
});

it("skips disconnected work refresh without making a server request", async () => {
  mocks.settings.serverUrl = "";
  expect(await syncServerNovelOnOpen(42)).toBe(false);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("enriches a bound work through its installed plugin and the source task executor", async () => {
  mocks.source.mockResolvedValue({ serverUrl: "http://server", workId: "work" });
  expect(await refreshServerNovelFromSource(42, "Refresh Book")).toBe(true);
  expect(mocks.executor).toHaveBeenCalledWith("source", "background");
  expect(mocks.load).toHaveBeenCalledOnce();
  expect(mocks.sync).toHaveBeenCalledWith({ id: "source" }, { name: "Book", path: "/book", cover: undefined }, expect.objectContaining({ novelId: 42, preserveMissingMetadata: true }));
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ priority: "deferred" }));
});

it("keeps an explicit source refresh ahead of automatic work enrichment", async () => {
  mocks.source.mockResolvedValue({ serverUrl: "http://server", workId: "work" });
  expect(await refreshServerNovelFromSource(42, "Refresh Book", undefined, "user")).toBe(true);
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ priority: "user" }));
});

it.each(["norea-folder:Book-book", "local:book"])("does not guess a source path from %s", async path => {
  mocks.source.mockResolvedValue({ serverUrl: "http://server", workId: "work" });
  mocks.novel.mockResolvedValue({ id: 42, ...local.novel, pluginId: "source", path, isLocal: path.startsWith("local:") });
  expect(await refreshServerNovelFromSource(42, "Refresh Book")).toBe(false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("does not call a missing plugin or refresh ordinary source works on entry", async () => {
  expect(await refreshServerNovelFromSource(42, "Refresh Book")).toBe(false);
  mocks.source.mockResolvedValue({ serverUrl: "http://server", workId: "work" });
  mocks.plugin.mockReturnValue(undefined);
  expect(await refreshServerNovelFromSource(42, "Refresh Book")).toBe(false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
});

it("leaves server metadata intact when the original site rejects the request", async () => {
  mocks.source.mockResolvedValue({ serverUrl: "http://server", workId: "work" });
  mocks.sync.mockRejectedValueOnce(new Error("Source unavailable"));
  await expect(refreshServerNovelFromSource(42, "Refresh Book")).rejects.toThrow("Source unavailable");
  expect(mocks.install).not.toHaveBeenCalled();
});
