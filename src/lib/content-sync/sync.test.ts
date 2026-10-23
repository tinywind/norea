import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ download: vi.fn(), install: vi.fn(), stage: vi.fn() }));

vi.mock("../../db/queries/content-sync", () => ({
  listContentSyncChapters: vi.fn(), listContentSyncWorkChapters: vi.fn(), importContentMetadata: vi.fn(), markContentInstalled: vi.fn(),
  readContentSyncCache: vi.fn(), writeContentSyncCache: vi.fn(),
  contentJournalHead: vi.fn(), readContentJournal: vi.fn(), canUploadContentChapter: vi.fn(),
  contentIdentity: (plugin: string, novel: string, chapter = "") => JSON.stringify([plugin, novel, chapter]),
}));
vi.mock("./native", () => ({
  uploadContentChapter: vi.fn(), fingerprintContentChapter: vi.fn(),
  withDownloadedContentChapter: async (input: unknown, apply: (sizes: { contentBytes: number; mediaBytes: number }, install: (storageDir: string) => Promise<void>) => Promise<unknown>) => apply(await native.download(input), native.install),
  withContentChapterStage: (input: unknown, run: (stagePath: string) => Promise<unknown>) => { native.stage(input); return run("snapshot"); },
}));
vi.mock("./works", () => ({ syncWorkMetadata: vi.fn(), getWorkSyncCursor: vi.fn(async () => 0), contentWorkId: vi.fn(async () => "work-id") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "Test device") }));
import { fetch as appFetch } from "@tauri-apps/plugin-http";
import { contentJournalHead, readContentJournal, listContentSyncChapters, listContentSyncWorkChapters, importContentMetadata, readContentSyncCache, writeContentSyncCache, markContentInstalled, canUploadContentChapter } from "../../db/queries/content-sync";
import { uploadContentChapter, fingerprintContentChapter } from "./native";
import { useContentSyncStore } from "../../store/content-sync";
import { syncContentServer, downloadServerChapter, downloadServerChapterFromServer, deleteServerChapter, restoreServerChapter } from "./sync";
import { syncWorkMetadata } from "./works";
import { runWorkContentStorageOperation } from "./storage-operation";
import { ContentServerError } from "./client";
import { beginChapterDownloadQueueWrite } from "../tasks/chapter-download-activity";

const memory = new Map<string, string>();
let journal: { sequence: number; key: string; value: null }[];
function changed(key: string, value: null) { journal.push({ sequence: journal.length + 1, key, value }); }
beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); journal = [];
  vi.mocked(contentJournalHead).mockImplementation(async () => journal.length);
  vi.mocked(readContentJournal).mockImplementation(async (after, through) => journal.filter((entry) => entry.sequence > after && entry.sequence <= through));
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.stubGlobal("window", new EventTarget());
  vi.mocked(readContentSyncCache).mockImplementation(async (key) => memory.get(key) ?? null);
  vi.mocked(writeContentSyncCache).mockImplementation(async (key, payload) => { memory.set(key, payload); });
  useContentSyncStore.setState({ ...useContentSyncStore.getInitialState(), serverUrl: "http://localhost:7788" });
  vi.mocked(listContentSyncChapters).mockResolvedValue([]);
  vi.mocked(listContentSyncWorkChapters).mockReset().mockResolvedValue([]);
  vi.mocked(canUploadContentChapter).mockReset().mockResolvedValue(true);
  vi.mocked(syncWorkMetadata).mockResolvedValue(new Set());
  vi.mocked(uploadContentChapter).mockReset();
  native.download.mockReset();
  native.install.mockReset();
  vi.mocked(importContentMetadata).mockResolvedValue({ novelId: 90, chapterId: 91 });
  vi.mocked(fingerprintContentChapter).mockResolvedValue("fingerprint-a");
  vi.mocked(appFetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: false });
    if (url.endsWith("/devices/register")) return Response.json({ id: "one", deviceName: "Norea" });
    if (url.includes("/catalog/changes?")) return Response.json({ items: [], cursor: 0, hasMore: false });
    if (url.includes("/catalog/chapter?")) return new Response(null, { status: 404 });
    if (/\/chapters\//.test(url)) return new Response(null, { status: 204 });
    throw new Error(`Unexpected endpoint: ${url}`);
  });
});

it("uploads the plugin novel ID in the manifest and numeric directory without deriving it from the source route", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{
    chapterId: 811, novelId: 91, pluginId: "p", sourceNovelId: "literal-42", novelPath: "/source-route?book=42",
    chapterPath: "/chapter/side-story", novelName: "A title unrelated to the ID", chapterName: "Side story",
    chapterNumber: "1.5", position: 1, page: "1", contentType: "html", isDownloaded: true, mediaRepairNeeded: false,
  }] as never);
  await syncContentServer(true, true);
  expect(uploadContentChapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    storageDir: "contents/p/literal-42/1.5",
    manifest: expect.objectContaining({ identity: {
      pluginId: "p", novelId: "literal-42", novelPath: "/source-route?book=42", chapterPath: "/chapter/side-story",
    } }),
  }));
});

it("skips local snapshots and uploads when a complete server chapter exists", async () => {
  const row = { chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c", chapterNumber: null, isDownloaded: true, mediaRepairNeeded: false };
  vi.mocked(listContentSyncChapters).mockResolvedValue([row] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/chapter?")
    ? Promise.resolve(Response.json({ id: "existing", deleted: false, manifest: { identity: { pluginId: "p", novelId: "n", novelPath: "n", chapterPath: "c" }, chapter: {} } })) : original(url, init));
  await syncContentServer(true, true);
  expect(native.stage).not.toHaveBeenCalled();
  expect(fingerprintContentChapter).not.toHaveBeenCalled();
  expect(uploadContentChapter).not.toHaveBeenCalled();
});

it("defers queued chapters without delaying completed chapters, then retries them after the queue clears", async () => {
  const chapters = [1, 2].map(chapterId => ({ chapterId, novelId: 1, pluginId: "p", sourceNovelId: "n", position: chapterId, novelPath: "n",
    chapterPath: `c${chapterId}`, novelName: "Novel", chapterName: `Chapter ${chapterId}`,
    isDownloaded: true, mediaRepairNeeded: false, isDownloadQueued: chapterId === 1 }));
  vi.mocked(listContentSyncChapters).mockResolvedValue(chapters as never);
  await syncContentServer(true, true);
  expect(vi.mocked(uploadContentChapter).mock.calls.map(([input]) => input.chapterId)).toEqual([2]);
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).pendingUploads).toEqual(['["p","n","c1"]']);
  expect(useContentSyncStore.getState()).toMatchObject({ status: "idle", error: null });

  chapters[0]!.isDownloadQueued = false;
  await syncContentServer();
  expect(vi.mocked(uploadContentChapter).mock.calls.map(([input]) => input.chapterId)).toEqual([2, 1]);
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).pendingUploads).toEqual([]);
});

it.each(["lookup", "snapshot"])("invalidates an upload when a download enters and leaves the queue during %s", async phase => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c",
    isDownloaded: true, mediaRepairNeeded: false }] as never);
  const interrupt = () => beginChapterDownloadQueueWrite([1])();
  if (phase === "lookup") {
    const original = vi.mocked(appFetch).getMockImplementation()!;
    vi.mocked(appFetch).mockImplementation(async (url, init) => {
      if (String(url).includes("/catalog/chapter?")) interrupt();
      return original(url, init);
    });
  } else {
    vi.mocked(fingerprintContentChapter).mockImplementationOnce(async () => { interrupt(); return "changed"; });
  }
  await syncContentServer(true, true);
  expect(uploadContentChapter).not.toHaveBeenCalled();
  expect(useContentSyncStore.getState()).toMatchObject({ status: "idle", error: null, progress: { failed: 0 } });
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).pendingUploads).toEqual(['["p","n","c"]']);
});

it("rechecks persisted completion and queue state after preparing the upload snapshot", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c",
    isDownloaded: true, mediaRepairNeeded: false }] as never);
  vi.mocked(canUploadContentChapter).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await syncContentServer();
  expect(fingerprintContentChapter).toHaveBeenCalledOnce();
  expect(uploadContentChapter).not.toHaveBeenCalled();
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledOnce();
});

it("rechecks a persisted server deletion without a rescan or a new local journal entry", async () => {
  vi.mocked(listContentSyncWorkChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c", isDownloaded: true, mediaRepairNeeded: false }] as never);
  memory.set("norea-content-catalog:http://localhost:7788", JSON.stringify({ cursor: 0, localCursor: 0, tombstones: { '["p","n","c"]': true }, uploaded: { '["p","n","c"]': "old" }, downloads: {}, excluded: [], pendingUploads: [] }));
  await syncContentServer();
  expect(listContentSyncChapters).toHaveBeenCalledWith([], false);
  expect(listContentSyncWorkChapters).toHaveBeenCalledExactlyOnceWith(['["p","n"]']);
  expect(uploadContentChapter).toHaveBeenCalledTimes(1);
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!)).toMatchObject({ tombstones: {}, pendingUploads: [] });
  await syncContentServer();
  expect(listContentSyncWorkChapters).toHaveBeenCalledOnce();
  expect(uploadContentChapter).toHaveBeenCalledOnce();
});

it("allows a local content change to upload a chapter previously deleted on the server", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c", isDownloaded: true, mediaRepairNeeded: false }] as never);
  memory.set("norea-content-catalog:http://localhost:7788", JSON.stringify({ cursor: 0, localCursor: 0, tombstones: { '["p","n","c"]': true }, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  changed('content:["p","n","c"]', null);
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledOnce();
});

it("skips every local chapter belonging to a deleted server work", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "not-yet-uploaded", isDownloaded: true, mediaRepairNeeded: false }] as never);
  vi.mocked(syncWorkMetadata).mockResolvedValue(new Set(["work-id"]));
  await syncContentServer();
  expect(fingerprintContentChapter).not.toHaveBeenCalled();
  expect(uploadContentChapter).not.toHaveBeenCalled();
  expect(useContentSyncStore.getState().status).toBe("idle");
});

it("queues a remote deletion before advancing the catalog checkpoint without local changes", async () => {
  const key = "norea-content-catalog:http://localhost:7788";
  const row = { chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c", isDownloaded: true, mediaRepairNeeded: false, contentBytes: 10, mediaBytes: 0 };
  memory.set(key, JSON.stringify({ cursor: 0, localCursor: 0, tombstones: {}, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  vi.mocked(listContentSyncWorkChapters).mockResolvedValue([row] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/changes?") ? Promise.resolve(Response.json({
    items: new URL(String(url)).searchParams.get("after") === "0" ? [{ deleted: true, sequence: 1, identity: { pluginId: "p", novelId: "n", novelPath: "n", chapterPath: "c" } }] : [],
    cursor: 1, hasMore: false,
  })) : original(url, init));
  vi.mocked(uploadContentChapter).mockImplementationOnce(async () => {
    expect(JSON.parse(memory.get(key)!)).toMatchObject({ cursor: 1, localCursor: 0, tombstones: {}, pendingUploads: ['["p","n","c"]'] });
    return {} as never;
  });
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledOnce();
  expect(JSON.parse(memory.get(key)!)).toMatchObject({ cursor: 1, tombstones: {}, pendingUploads: [] });
});

it.each([false, true])("handles a deletion discovered only in the final catalog pull with one bounded upload phase (failure: %s)", async failUpload => {
  const key = "norea-content-catalog:http://localhost:7788";
  const row = { chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c",
    novelName: "Novel", chapterName: "One", isDownloaded: true, mediaRepairNeeded: false };
  memory.set(key, JSON.stringify({ cursor: 0, localCursor: 0, tombstones: {}, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  vi.mocked(listContentSyncWorkChapters).mockResolvedValue([row] as never);
  let catalogRequests = 0;
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => {
    if (!String(url).includes("/catalog/changes?")) return original(url, init);
    catalogRequests++;
    return Promise.resolve(Response.json(catalogRequests === 1 ? { items: [], cursor: 0, hasMore: false } : {
      items: [{ deleted: true, sequence: catalogRequests - 1, identity: { pluginId: "p", novelId: "n", novelPath: "n", chapterPath: "c" } }],
      cursor: catalogRequests - 1, hasMore: false,
    }));
  });
  if (failUpload) vi.mocked(uploadContentChapter).mockRejectedValueOnce(new Error("offline"));
  const syncing = syncContentServer();
  if (failUpload) await expect(syncing).rejects.toThrow("offline");
  else await syncing;
  expect(catalogRequests).toBe(2);
  expect(readContentJournal).toHaveBeenCalledTimes(2);
  expect(uploadContentChapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chapterId: 1 }));
  expect(listContentSyncWorkChapters).toHaveBeenCalledExactlyOnceWith(['["p","n"]']);
  expect(JSON.parse(memory.get(key)!)).toMatchObject({
    cursor: 1, localCursor: 0, tombstones: {}, pendingUploads: failUpload ? ['["p","n","c"]'] : [],
  });
});

it.each([
  { localPath: "norea-folder:1", remotePath: "/chapter/1" },
  { localPath: "/chapter/1", remotePath: "norea-folder:1" },
])("rechecks deleted chapter $remotePath against local $localPath and skips existing sibling files", async ({ localPath, remotePath }) => {
  const key = "norea-content-catalog:http://localhost:7788";
  const chapters = [1, 2].map(chapterId => ({ chapterId, novelId: 1, pluginId: "p", sourceNovelId: "n", position: chapterId, novelPath: "/work",
    chapterPath: chapterId === 1 ? localPath : "/chapter/2", chapterNumber: String(chapterId),
    novelName: "Novel", chapterName: `Chapter ${chapterId}`, isDownloaded: true, mediaRepairNeeded: false }));
  memory.set(key, JSON.stringify({ cursor: 1, localCursor: 0, tombstones: { [JSON.stringify(["p", "/work", remotePath])]: true }, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  vi.mocked(listContentSyncWorkChapters).mockResolvedValue(chapters as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/chapter?") && new URL(String(url)).searchParams.get("chapterPath") === "/chapter/2"
    ? Promise.resolve(Response.json({ id: "existing", deleted: false, manifest: { identity: { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: "/chapter/2" }, chapter: { chapterNumber: "2" } } })) : original(url, init));
  await syncContentServer();
  expect(listContentSyncWorkChapters).toHaveBeenCalledExactlyOnceWith(['["p","/work"]']);
  expect(native.stage).toHaveBeenCalledOnce();
  expect(uploadContentChapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    chapterId: 1, manifest: expect.objectContaining({ identity: { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: localPath } }),
  }));
  expect(JSON.parse(memory.get(key)!)).toMatchObject({ tombstones: {}, pendingUploads: [] });
});

it("retains the resolved local identity after a deleted chapter upload fails", async () => {
  const key = "norea-content-catalog:http://localhost:7788";
  const row = { chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "/work", chapterPath: "norea-folder:1", chapterNumber: "1",
    novelName: "Novel", chapterName: "One", isDownloaded: true, mediaRepairNeeded: false };
  memory.set(key, JSON.stringify({ cursor: 1, localCursor: 0, tombstones: { '["p","/work","/chapter/1"]': true }, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  vi.mocked(listContentSyncWorkChapters).mockResolvedValue([row] as never);
  vi.mocked(uploadContentChapter).mockRejectedValueOnce(new Error("offline"));
  await expect(syncContentServer()).rejects.toThrow("offline");
  expect(JSON.parse(memory.get(key)!)).toMatchObject({ tombstones: {}, pendingUploads: ['["p","/work","norea-folder:1"]'] });

  vi.mocked(listContentSyncChapters).mockResolvedValue([row] as never);
  await syncContentServer();
  expect(listContentSyncChapters).toHaveBeenLastCalledWith(['["p","/work","norea-folder:1"]'], false);
  expect(listContentSyncWorkChapters).toHaveBeenCalledOnce();
  expect(uploadContentChapter).toHaveBeenCalledTimes(2);
  expect(JSON.parse(memory.get(key)!)).toMatchObject({ tombstones: {}, pendingUploads: [] });
});

it("does not restore a whole work while processing its deleted chapter signals", async () => {
  const key = "norea-content-catalog:http://localhost:7788";
  memory.set(key, JSON.stringify({ cursor: 1, localCursor: 0, tombstones: { '["p","n","c"]': true }, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  vi.mocked(listContentSyncWorkChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c", isDownloaded: true, mediaRepairNeeded: false }] as never);
  vi.mocked(syncWorkMetadata).mockResolvedValue(new Set(["work-id"]));
  await syncContentServer();
  expect(native.stage).not.toHaveBeenCalled();
  expect(uploadContentChapter).not.toHaveBeenCalled();
  expect(JSON.parse(memory.get(key)!)).toMatchObject({ tombstones: {}, pendingUploads: [] });
});

it("keeps chapter catalogs from replacing full work metadata with per-chapter files", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  const entry = { deleted: false, sequence: 1, identity: { pluginId: "p", novelId: "n", novelPath: "n", chapterPath: "c" } };
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/changes?")
    ? Promise.resolve(Response.json({ items: [entry], cursor: 1, hasMore: false })) : original(url, init));
  await syncContentServer();
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!)).toMatchObject({ cursor: 1, tombstones: {} });
  expect(importContentMetadata).not.toHaveBeenCalled();
});

it("detects equal-size content changes without uploading unchanged content again", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false, contentBytes: 10, mediaBytes: 0 }] as never);
  await syncContentServer();
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledTimes(1);
  useContentSyncStore.setState({ deviceKey: null });
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledTimes(1);
  vi.mocked(fingerprintContentChapter).mockResolvedValue("fingerprint-b");
  changed('content:["p","n","c"]', null);
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledTimes(2);
});

it("uploads later chapters after a local package failure and retries only the failed chapter", async () => {
  const chapters = [1, 2].map(id => ({ chapterId: id, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "n",
    chapterPath: `c${id}`, novelName: "Novel", chapterName: `Chapter ${id}`, contentType: "html",
    position: id, page: "1", isDownloaded: true, mediaRepairNeeded: false }));
  vi.mocked(listContentSyncChapters).mockResolvedValue(chapters as never);
  vi.mocked(uploadContentChapter).mockImplementation(async input => {
    if (input.chapterId === 1) throw new Error("content sync: body references missing media: image.png");
    return {} as never;
  });
  await expect(syncContentServer()).rejects.toThrow("Novel / Chapter 1");
  expect(vi.mocked(uploadContentChapter).mock.calls.map(([input]) => input.chapterId)).toEqual([1, 2]);
  const saved = JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!);
  expect(saved.pendingUploads).toEqual(['["p","n","c1"]']);
  expect(Object.keys(saved.uploaded)).toEqual(['["p","n","c2"]']);
  vi.mocked(uploadContentChapter).mockClear();
  vi.mocked(uploadContentChapter).mockResolvedValue({} as never);
  await syncContentServer();
  expect(vi.mocked(uploadContentChapter).mock.calls.map(([input]) => input.chapterId)).toEqual([1]);
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).pendingUploads).toEqual([]);
});

it("preserves the upload rejection when an expired device registration is forgotten", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  vi.mocked(uploadContentChapter).mockImplementation(async () => {
    useContentSyncStore.setState({ deviceKey: null });
    throw new ContentServerError(401, "Device registration expired");
  });
  await expect(syncContentServer()).rejects.toMatchObject({ status: 401, message: "Device registration expired" });
  expect(useContentSyncStore.getState()).toMatchObject({ status: "error", error: "Device registration expired" });
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).pendingUploads).toEqual(['["p","n","c"]']);
});

it("shows and saves upload progress before a large batch finishes", async () => {
  const chapters = Array.from({ length: 30 }, (_, index) => ({ chapterId: index + 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "n",
    chapterPath: `c${index + 1}`, novelName: "Novel", chapterName: `Chapter ${index + 1}`, contentType: "html",
    position: index + 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }));
  vi.mocked(listContentSyncChapters).mockResolvedValue(chapters as never);
  let resume!: () => void;
  vi.mocked(uploadContentChapter).mockImplementation(async input => {
    if (input.chapterId === 26) await new Promise<void>(resolve => { resume = resolve; });
    return {} as never;
  });
  const running = syncContentServer();
  await vi.waitFor(() => expect(resume).toEqual(expect.any(Function)));
  try {
    const saved = JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!);
    expect(Object.keys(saved.uploaded)).toHaveLength(25);
    expect(useContentSyncStore.getState()).toMatchObject({ status: "syncing", progress: { completed: 25, total: 30, uploaded: 25, failed: 0 } });
  } finally { resume(); await running; }
  expect(useContentSyncStore.getState()).toMatchObject({ status: "idle", progress: { completed: 30, total: 30, uploaded: 30, failed: 0 } });
});

it("does not mark a failed native import downloaded and preserves readable directory names", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", sourceNovelId: "work", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(native.download).mockRejectedValueOnce(new Error("invalid checksum"));
  await expect(downloadServerChapter({ id: "server-id", deleted: false, manifest: { identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" } } } as never)).rejects.toThrow("invalid checksum");
  expect(markContentInstalled).not.toHaveBeenCalled();
  expect(vi.mocked(native.download).mock.calls[0]![0]).toMatchObject({ chapterId: 91, storageDir: "contents/source/work/1" });
});

it("skips a recovered chapter already stored under the exact-work server identity", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "/work", chapterPath: "norea-folder:1", chapterNumber: "1", novelName: "Novel", chapterName: "One", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/chapter?")
    ? Promise.resolve(Response.json({ deleted: false, manifest: { identity: { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: "/chapter/1" }, chapter: { chapterNumber: "1" } } })) : original(url, init));
  await syncContentServer();
  expect(uploadContentChapter).not.toHaveBeenCalled();
  const lookup = vi.mocked(appFetch).mock.calls.find(([url]) => String(url).includes("/catalog/chapter?"));
  expect(new URL(String(lookup?.[0])).searchParams.get("chapterNumber")).toBe("1");
});

it.each(["norea-folder:1", "/other-chapter/1", "/chapter/1"])("resolves a source upload against server chapter %s without merging different source paths", async remotePath => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "/work", chapterPath: "/chapter/1", chapterNumber: "1", novelName: "Novel", chapterName: "One", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/chapter?")
    ? Promise.resolve(Response.json({ deleted: false, manifest: { identity: { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: remotePath }, chapter: { chapterNumber: remotePath === "/chapter/1" ? null : "1" } } })) : original(url, init));
  if (remotePath.startsWith("norea-folder:") || remotePath === "/chapter/1") {
    await syncContentServer();
    expect(uploadContentChapter).not.toHaveBeenCalled();
  } else {
    await expect(syncContentServer()).rejects.toThrow("identity does not match");
    expect(uploadContentChapter).not.toHaveBeenCalled();
  }
});

it.each([404, 409])("handles recovered chapter lookup status %s without replacing ambiguous content", async status => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "/work", chapterPath: "norea-folder:1", chapterNumber: "1", novelName: "Novel", chapterName: "One", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/chapter?")
    ? Promise.resolve(new Response(null, { status })) : original(url, init));
  if (status === 404) {
    await syncContentServer();
    expect(uploadContentChapter).toHaveBeenCalledWith(expect.objectContaining({ manifest: expect.objectContaining({ identity: { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: "norea-folder:1" } }) }));
  } else {
    await expect(syncContentServer()).rejects.toThrow("409");
    expect(uploadContentChapter).not.toHaveBeenCalled();
    expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).pendingUploads).toEqual(['["p","/work","norea-folder:1"]']);
  }
});

it.each([
  { pluginId: "other", novelPath: "/work", chapterPath: "/chapter/1", number: "1", deleted: false },
  { pluginId: "p", novelId: "n", novelPath: "/other", chapterPath: "/chapter/1", number: "1", deleted: false },
  { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: "/chapter/2", number: "2", deleted: false },
  { pluginId: "p", novelId: "n", novelPath: "/work", chapterPath: "/chapter/1", number: "1", deleted: true },
])("rejects a recovered upload lookup outside its requested chapter: %j", async match => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "/work", chapterPath: "norea-folder:1", chapterNumber: "1", novelName: "Novel", chapterName: "One", isDownloaded: true, mediaRepairNeeded: false }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/chapter?")
    ? Promise.resolve(Response.json({ deleted: match.deleted, manifest: { identity: { pluginId: match.pluginId, novelPath: match.novelPath, chapterPath: match.chapterPath }, chapter: { chapterNumber: match.number } } })) : original(url, init));
  await expect(syncContentServer()).rejects.toThrow("identity does not match");
  expect(uploadContentChapter).not.toHaveBeenCalled();
});

it("keeps the saved device key when registration is blocked and retries it after unblocking", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  let blocked = true;
  vi.mocked(appFetch).mockImplementation((url, init) => blocked && String(url).endsWith("/devices/register")
    ? Promise.resolve(new Response(null, { status: 403 })) : original(url, init));
  await expect(syncContentServer()).rejects.toThrow("403");
  const saved = memory.get("norea-content-device:http://localhost:7788");
  expect(saved).toMatch(/^[a-f0-9]{64}$/);
  expect(useContentSyncStore.getState().blocked).toBe(true);
  await expect(syncContentServer()).rejects.toThrow("403");
  expect(memory.get("norea-content-device:http://localhost:7788")).toBe(saved);
  expect(uploadContentChapter).not.toHaveBeenCalled();
  blocked = false;
  await syncContentServer();
  expect(useContentSyncStore.getState()).toMatchObject({ blocked: false, deviceKey: saved });
});

it("uses the device credential for delete and restore without changing local downloads", async () => {
  const entry = { id: "chapter-1" } as never;
  await deleteServerChapter(entry);
  await restoreServerChapter(entry);
  const calls = vi.mocked(appFetch).mock.calls.filter(([url]) => String(url).includes("/chapters/chapter-1"));
  expect(calls.map(([, init]) => init?.method)).toEqual(["DELETE", "POST"]);
  expect(calls[0]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${memory.get("norea-content-device:http://localhost:7788")}` });
  expect(markContentInstalled).not.toHaveBeenCalled();
});

it("does not transfer to a newly selected server when registration completes for the previous server", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith("/devices/register")) useContentSyncStore.getState().setServerUrl("http://other-server");
    return original(url, init);
  });
  await expect(syncContentServer()).rejects.toThrow("changed during device registration");
  expect(vi.mocked(appFetch).mock.calls.some(([url]) => String(url).includes("/chapters"))).toBe(false);
  expect(useContentSyncStore.getState().deviceKey).toBeNull();
});

it("downloads a selected origin chapter without full catalogs or foreground sync state changes", async () => {
  useContentSyncStore.setState({ status: "syncing" });
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", sourceNovelId: "work", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(native.download).mockResolvedValue({ contentBytes: 10, mediaBytes: 0 });
  const entry = { id: "one", deleted: false, manifest: { identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" }, chapter: { contentType: "html" } } } as never;
  await expect(downloadServerChapterFromServer(entry, "http://origin-server")).resolves.toEqual({ novelId: 90, chapterId: 91 });
  expect(native.download).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: "http://origin-server" }));
  expect(syncWorkMetadata).not.toHaveBeenCalled();
  expect(readContentSyncCache).not.toHaveBeenCalled();
  expect(writeContentSyncCache).not.toHaveBeenCalled();
  expect(useContentSyncStore.getState().status).toBe("syncing");
  expect(useContentSyncStore.getState().deviceKey).toBeNull();
});

it.each(["before transfer", "before installation"])("rejects a different source novel ID %s", async phase => {
  const target = { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" };
  const row = { chapterId: 7, novelId: 3, pluginId: "source", sourceNovelId: "work", novelPath: "/work", chapterPath: "/chapter",
    novelName: "Book", chapterName: "One", chapterNumber: "1", position: 1, page: "1" };
  const other = { ...row, sourceNovelId: "different-work" };
  if (phase === "before transfer") vi.mocked(listContentSyncChapters).mockResolvedValue([other] as never);
  else vi.mocked(listContentSyncChapters).mockResolvedValueOnce([row] as never).mockResolvedValue([other] as never);
  native.download.mockResolvedValue({ contentBytes: 10, mediaBytes: 0 });
  const entry = { id: "one", deleted: false, manifest: { identity: target, chapter: { contentType: "html" } } } as never;
  await expect(downloadServerChapterFromServer(entry, "http://server", { token: "registered", target })).rejects.toThrow("novel ID");
  expect(native.install).not.toHaveBeenCalled();
  expect(markContentInstalled).not.toHaveBeenCalled();
});

it("installs a scanned chapter into the existing source chapter of the same work", async () => {
  const target = { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" };
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 7, novelId: 3, pluginId: target.pluginId, sourceNovelId: target.novelId, novelPath: target.novelPath, chapterPath: target.chapterPath, novelName: "Book", chapterName: "One", position: 1, page: "1" }] as never);
  vi.mocked(native.download).mockResolvedValue({ contentBytes: 10, mediaBytes: 20 });
  const entry = { id: "scanned", deleted: false, manifest: { identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "norea-folder:1" }, chapter: { contentType: "html" } } } as never;
  expect(await downloadServerChapterFromServer(entry, "http://origin", { token: "registered", target })).toEqual({ novelId: 3, chapterId: 7 });
  expect(importContentMetadata).not.toHaveBeenCalled();
  expect(appFetch).not.toHaveBeenCalled();
  expect(native.download).toHaveBeenCalledWith({ serverUrl: "http://origin", token: "registered", entry, storageDir: "contents/source/work/1", chapterId: 7 });
  expect(markContentInstalled).toHaveBeenCalledWith(7, "html", 10, 20);
});

it("checkpoints a large catalog instead of persisting its growing snapshot on every page", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => {
    if (!String(url).includes("/catalog/changes?")) return original(url, init);
    const cursor = Number(new URL(String(url)).searchParams.get("after"));
    return Promise.resolve(Response.json({ items: Array.from({ length: 100 }, (_, index) => ({ identity: { pluginId: "source", novelId: "book", novelPath: "/book", chapterPath: `/chapter-${cursor + index}` }, deleted: false, sequence: cursor + index + 1 })), cursor: cursor + 100, hasMore: cursor < 900 }));
  });
  await syncContentServer(false);
  expect(writeContentSyncCache).toHaveBeenCalledTimes(1);
  const saved = memory.get("norea-content-catalog:http://localhost:7788")!;
  expect(JSON.parse(saved)).toMatchObject({ cursor: 1000, tombstones: {} });
  expect(saved).not.toContain("entries");
  expect(saved.length).toBeLessThan(200);
  expect(useContentSyncStore.getState()).not.toHaveProperty("catalog");
  expect(useContentSyncStore.getState()).not.toHaveProperty("works");
});

it("keeps selected downloads usable while the background work catalog is still transferring", async () => {
  const changed = vi.fn();
  window.addEventListener("norea-content-state-changed", changed);
  let release!: () => void;
  vi.mocked(syncWorkMetadata).mockImplementationOnce(() => new Promise<ReadonlySet<string>>(resolve => { release = () => resolve(new Set()); }));
  const background = syncContentServer(false);
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", sourceNovelId: "work", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(native.download).mockResolvedValue({ contentBytes: 10, mediaBytes: 0 });
  const entry = { id: "one", deleted: false, manifest: { identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" }, chapter: { contentType: "html" } } } as never;
  try {
    await downloadServerChapter(entry);
    expect(markContentInstalled).toHaveBeenCalledWith(91, "html", 10, 0);
    expect(changed).not.toHaveBeenCalled();
    expect(useContentSyncStore.getState().status).toBe("syncing");
  } finally {
    release();
    await background;
  }
});

it("does not rewrite unchanged catalog snapshots on subsequent background polls", async () => {
  await syncContentServer();
  vi.mocked(writeContentSyncCache).mockClear();
  await syncContentServer();
  expect(writeContentSyncCache).not.toHaveBeenCalled();
});

it("runs a fresh metadata pass when another request arrives during chapter upload", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", position: 1, novelPath: "n", chapterPath: "c",
    novelName: "Novel", chapterName: "One", isDownloaded: true, mediaRepairNeeded: false }] as never);
  let release!: () => void;
  vi.mocked(uploadContentChapter).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({} as never); }));
  const manual = syncContentServer();
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  expect(syncWorkMetadata).toHaveBeenCalledOnce();
  const afterMetadataRefresh = syncContentServer();
  expect(afterMetadataRefresh).not.toBe(manual);
  try {
    expect(syncWorkMetadata).toHaveBeenCalledOnce();
  } finally {
    release();
    await Promise.all([manual, afterMetadataRefresh]);
  }
  expect(syncWorkMetadata).toHaveBeenCalledTimes(2);
  expect(uploadContentChapter).toHaveBeenCalledOnce();
});

it("coalesces waiting sync requests while preserving upload and rescan options", async () => {
  let release!: () => void;
  vi.mocked(syncWorkMetadata).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(new Set()); }));
  const active = syncContentServer(false);
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  const waiting = syncContentServer(false);
  expect(syncContentServer(true)).toBe(waiting);
  expect(syncContentServer(false, true)).toBe(waiting);
  expect(waiting).not.toBe(active);
  release();
  await Promise.all([active, waiting]);
  expect(vi.mocked(syncWorkMetadata).mock.calls.map(([, , upload, , rescan]) => ({ upload, rescan }))).toEqual([
    { upload: false, rescan: false }, { upload: true, rescan: true },
  ]);
  expect(listContentSyncChapters).toHaveBeenCalledExactlyOnceWith(undefined, true);
});

it("runs a queued sync after the active pass fails", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(syncWorkMetadata).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const active = syncContentServer();
  await vi.waitFor(() => expect(reject).toEqual(expect.any(Function)));
  const waiting = syncContentServer();
  const results = Promise.allSettled([active, waiting]);
  reject(new Error("first pass failed"));
  expect(await results).toEqual([
    { status: "rejected", reason: new Error("first pass failed") }, { status: "fulfilled", value: undefined },
  ]);
  expect(syncWorkMetadata).toHaveBeenCalledTimes(2);
  expect(useContentSyncStore.getState().status).toBe("idle");
});

it("allows a work operation to finish while its background upload waits for the server", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  let release!: () => void;
  vi.mocked(uploadContentChapter).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({} as never); }));
  const background = syncContentServer();
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  let completed = false;
  const foreground = runWorkContentStorageOperation("p", "n", async () => { completed = true; });
  try {
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 100 });
    expect(useContentSyncStore.getState().status).toBe("syncing");
  } finally {
    release();
    await Promise.all([background, foreground]);
  }
});

it("keeps work metadata usable while a selected package download waits for the server", async () => {
  const target = { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" };
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 7, novelId: 3, pluginId: target.pluginId, sourceNovelId: target.novelId, novelPath: target.novelPath, chapterPath: target.chapterPath, novelName: "Book", chapterName: "One", position: 1, page: "1" }] as never);
  let release!: () => void;
  vi.mocked(native.download).mockImplementationOnce(() => new Promise(resolve => {
    release = () => resolve({ contentBytes: 10, mediaBytes: 0 });
  }));
  const entry = { id: "one", deleted: false, manifest: { identity: target, chapter: { contentType: "html" } } } as never;
  const downloading = downloadServerChapterFromServer(entry, "http://server", { token: "registered", target });
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  let completed = false;
  const foreground = runWorkContentStorageOperation("source", "/work", async () => { completed = true; });
  try {
    await vi.waitFor(() => expect(completed).toBe(true), { timeout: 100 });
    expect(markContentInstalled).not.toHaveBeenCalled();
  } finally {
    release();
    await Promise.all([downloading, foreground]);
  }
});

it("uses the current chapter folder when metadata changes during the transfer", async () => {
  const target = { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" };
  const row = { chapterId: 7, novelId: 3, pluginId: target.pluginId, sourceNovelId: target.novelId, novelPath: target.novelPath, chapterPath: target.chapterPath, novelName: "Before", chapterName: "One", position: 1, page: "1" };
  vi.mocked(listContentSyncChapters).mockResolvedValueOnce([row] as never)
    .mockResolvedValue([{ ...row, novelName: "After" }] as never);
  native.download.mockResolvedValue({ contentBytes: 10, mediaBytes: 0 });
  const entry = { id: "one", deleted: false, manifest: { identity: target, chapter: { contentType: "html" } } } as never;
  await downloadServerChapterFromServer(entry, "http://server", { token: "registered", target });
  expect(native.install).toHaveBeenCalledExactlyOnceWith("contents/source/work/1");
  expect(markContentInstalled).toHaveBeenCalledWith(7, "html", 10, 0);
});

it("does not publish a cancelled package after its transfer finishes", async () => {
  const target = { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" };
  const controller = new AbortController();
  const reason = new DOMException("Deleted", "AbortError");
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 7, novelId: 3, pluginId: target.pluginId, sourceNovelId: target.novelId, novelPath: target.novelPath, chapterPath: target.chapterPath, novelName: "Book", chapterName: "One", position: 1, page: "1" }] as never);
  native.download.mockImplementationOnce(async () => {
    controller.abort(reason);
    return { contentBytes: 10, mediaBytes: 0 };
  });
  const entry = { id: "one", deleted: false, manifest: { identity: target, chapter: { contentType: "html" } } } as never;
  await expect(downloadServerChapterFromServer(entry, "http://server", { token: "registered", target, signal: controller.signal })).rejects.toBe(reason);
  expect(native.install).not.toHaveBeenCalled();
  expect(markContentInstalled).not.toHaveBeenCalled();
});

it("removes a compact tombstone on restore and only scans downloaded content initially", async () => {
  const key = "norea-content-catalog:http://localhost:7788";
  memory.set(key, JSON.stringify({ cursor: 1, tombstones: { '["p","n","c"]': true }, uploaded: {}, downloads: {}, excluded: [], pendingUploads: [] }));
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", sourceNovelId: "n", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/changes?")
    ? Promise.resolve(Response.json({ items: [{ identity: { pluginId: "p", novelId: "n", novelPath: "n", chapterPath: "c" }, deleted: false, sequence: 2 }], cursor: 2, hasMore: false })) : original(url, init));
  await syncContentServer();
  expect(listContentSyncChapters).toHaveBeenCalledWith(undefined, true);
  expect(uploadContentChapter).toHaveBeenCalledOnce();
  expect(JSON.parse(memory.get(key)!).tombstones).toEqual({});
});
