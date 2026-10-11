import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../db/queries/content-sync", () => ({
  listContentSyncChapters: vi.fn(), importContentMetadata: vi.fn(), markContentInstalled: vi.fn(),
  readContentSyncStateCache: vi.fn(), writeContentSyncCache: vi.fn(),
  contentJournalHead: vi.fn(), readContentJournal: vi.fn(),
  contentIdentity: (plugin: string, novel: string, chapter = "") => JSON.stringify([plugin, novel, chapter]),
}));
vi.mock("./native", () => ({ uploadContentChapter: vi.fn(), downloadContentChapter: vi.fn(), fingerprintContentChapter: vi.fn() }));
vi.mock("./works", () => ({ syncWorkMetadata: vi.fn(), getWorkSyncCursor: vi.fn(async () => 0) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as appFetch } from "@tauri-apps/plugin-http";
import { contentJournalHead, readContentJournal, listContentSyncChapters, importContentMetadata, readContentSyncStateCache, writeContentSyncCache, markContentInstalled } from "../../db/queries/content-sync";
import { uploadContentChapter, fingerprintContentChapter, downloadContentChapter } from "./native";
import { useContentSyncStore } from "../../store/content-sync";
import { syncContentServer, downloadServerChapter, downloadServerChapterFromServer, deleteServerChapter, restoreServerChapter } from "./sync";
import { syncWorkMetadata } from "./works";

const memory = new Map<string, string>();
let journal: { sequence: number; key: string; value: null }[];
function changed(key: string, value: null) { journal.push({ sequence: journal.length + 1, key, value }); }
beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); journal = [];
  vi.mocked(contentJournalHead).mockImplementation(async () => journal.length);
  vi.mocked(readContentJournal).mockImplementation(async (after, through) => journal.filter((entry) => entry.sequence > after && entry.sequence <= through));
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.stubGlobal("window", new EventTarget());
  vi.mocked(readContentSyncStateCache).mockImplementation(async (key) => memory.get(key) ?? null);
  vi.mocked(writeContentSyncCache).mockImplementation(async (key, payload) => { memory.set(key, payload); });
  useContentSyncStore.setState({ ...useContentSyncStore.getInitialState(), serverUrl: "http://localhost:7788" });
  vi.mocked(listContentSyncChapters).mockResolvedValue([]);
  vi.mocked(importContentMetadata).mockResolvedValue({ novelId: 90, chapterId: 91 });
  vi.mocked(fingerprintContentChapter).mockResolvedValue("fingerprint-a");
  vi.mocked(appFetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: false });
    if (url.endsWith("/devices/register")) return Response.json({ id: "one", deviceName: "Norea" });
    if (url.includes("/catalog/changes?")) return Response.json({ items: [], cursor: 0, hasMore: false });
    if (/\/chapters\//.test(url)) return new Response(null, { status: 204 });
    throw new Error(`Unexpected endpoint: ${url}`);
  });
});

it("does not upload local content when the catalog contains a server tombstone", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", novelPath: "n", chapterPath: "c", isDownloaded: true, mediaRepairNeeded: false, contentBytes: 10, mediaBytes: 0 }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/changes?") ? Promise.resolve(Response.json({ items: [{ deleted: true, sequence: 1, identity: { pluginId: "p", novelPath: "n", chapterPath: "c" } }], cursor: 1, hasMore: false })) : original(url, init));
  await syncContentServer();
  expect(uploadContentChapter).not.toHaveBeenCalled();
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!).tombstones).toEqual({ '["p","n","c"]': true });
});

it("keeps chapter catalogs from replacing full work metadata with per-chapter files", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  const entry = { deleted: false, sequence: 1, identity: { pluginId: "p", novelPath: "n", chapterPath: "c" } };
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/changes?")
    ? Promise.resolve(Response.json({ items: [entry], cursor: 1, hasMore: false })) : original(url, init));
  await syncContentServer();
  expect(JSON.parse(memory.get("norea-content-catalog:http://localhost:7788")!)).toMatchObject({ cursor: 1, tombstones: {} });
  expect(importContentMetadata).not.toHaveBeenCalled();
});

it("detects equal-size content changes without uploading unchanged content again", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false, contentBytes: 10, mediaBytes: 0 }] as never);
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

it("does not mark a failed native import downloaded and preserves readable directory names", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(downloadContentChapter).mockRejectedValueOnce(new Error("invalid checksum"));
  await expect(downloadServerChapter({ id: "server-id", deleted: false, manifest: { identity: { pluginId: "source", novelPath: "/work", chapterPath: "/chapter" } } } as never)).rejects.toThrow("invalid checksum");
  expect(markContentInstalled).not.toHaveBeenCalled();
  expect(vi.mocked(downloadContentChapter).mock.calls[0]![0]).toMatchObject({ chapterId: 91, storageDir: "contents/source/A-work-work/1-Opening" });
});

it("ignores legacy account caches and sends only content requests", async () => {
  const key = "norea-content-account:http://localhost:7788:one";
  const legacy = JSON.stringify({ pending: { read: { progress: 2 } }, baseline: { library: { deleted: true } } });
  memory.set(key, legacy);
  await syncContentServer();
  expect(memory.get(key)).toBe(legacy);
  expect(vi.mocked(readContentSyncStateCache).mock.calls.every(([cacheKey]) => !cacheKey.includes("content-account"))).toBe(true);
  expect(vi.mocked(appFetch).mock.calls.every(([url]) => !String(url).includes("/state") && !String(url).includes("/sessions"))).toBe(true);
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
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(downloadContentChapter).mockResolvedValue({ contentBytes: 10, mediaBytes: 0 });
  const entry = { id: "one", deleted: false, manifest: { identity: { pluginId: "source", novelPath: "/work", chapterPath: "/chapter" }, chapter: { contentType: "html" } } } as never;
  await expect(downloadServerChapterFromServer(entry, "http://origin-server")).resolves.toEqual({ novelId: 90, chapterId: 91 });
  expect(downloadContentChapter).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: "http://origin-server" }));
  expect(syncWorkMetadata).not.toHaveBeenCalled();
  expect(readContentSyncStateCache).not.toHaveBeenCalled();
  expect(writeContentSyncCache).not.toHaveBeenCalled();
  expect(useContentSyncStore.getState().status).toBe("syncing");
  expect(useContentSyncStore.getState().deviceKey).toBeNull();
});

it("installs a legacy server package into the existing source chapter without creating another work", async () => {
  const target = { pluginId: "source", novelPath: "/work", chapterPath: "/chapter" };
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 7, novelId: 3, ...target, novelName: "Book", chapterName: "One", position: 1, page: "1" }] as never);
  vi.mocked(downloadContentChapter).mockResolvedValue({ contentBytes: 10, mediaBytes: 20 });
  const entry = { id: "legacy", deleted: false, manifest: { identity: { pluginId: "source", novelPath: "norea-folder:Book-work", chapterPath: "norea-folder:1" }, chapter: { contentType: "html" } } } as never;
  expect(await downloadServerChapterFromServer(entry, "http://origin", { token: "registered", target })).toEqual({ novelId: 3, chapterId: 7 });
  expect(importContentMetadata).not.toHaveBeenCalled();
  expect(appFetch).not.toHaveBeenCalled();
  expect(downloadContentChapter).toHaveBeenCalledWith({ serverUrl: "http://origin", token: "registered", entry, storageDir: "contents/source/Book-work/1-One", chapterId: 7 });
  expect(markContentInstalled).toHaveBeenCalledWith(7, "html", 10, 20);
});

it("checkpoints a large catalog instead of persisting its growing snapshot on every page", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => {
    if (!String(url).includes("/catalog/changes?")) return original(url, init);
    const cursor = Number(new URL(String(url)).searchParams.get("after"));
    return Promise.resolve(Response.json({ items: Array.from({ length: 100 }, (_, index) => ({ identity: { pluginId: "source", novelPath: "/book", chapterPath: `/chapter-${cursor + index}` }, deleted: false, sequence: cursor + index + 1 })), cursor: cursor + 100, hasMore: cursor < 900 }));
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
  let release!: () => void;
  vi.mocked(syncWorkMetadata).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const background = syncContentServer(false);
  await vi.waitFor(() => expect(release).toEqual(expect.any(Function)));
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(downloadContentChapter).mockResolvedValue({ contentBytes: 10, mediaBytes: 0 });
  const entry = { id: "one", deleted: false, manifest: { identity: { pluginId: "source", novelPath: "/work", chapterPath: "/chapter" }, chapter: { contentType: "html" } } } as never;
  try {
    await downloadServerChapter(entry);
    expect(markContentInstalled).toHaveBeenCalledWith(91, "html", 10, 0);
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

it("removes a compact tombstone on restore and only scans downloaded content initially", async () => {
  const key = "norea-content-catalog:http://localhost:7788";
  memory.set(key, JSON.stringify({ cursor: 1, tombstones: { '["p","n","c"]': true } }));
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false }] as never);
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/catalog/changes?")
    ? Promise.resolve(Response.json({ items: [{ identity: { pluginId: "p", novelPath: "n", chapterPath: "c" }, deleted: false, sequence: 2 }], cursor: 2, hasMore: false })) : original(url, init));
  await syncContentServer();
  expect(listContentSyncChapters).toHaveBeenCalledWith(undefined, true);
  expect(uploadContentChapter).toHaveBeenCalledOnce();
  expect(JSON.parse(memory.get(key)!).tombstones).toEqual({});
});
