import { beforeEach, expect, it, vi } from "vitest";
const reader = vi.hoisted(() => ({ active: false }));

vi.mock("../../db/queries/content-sync", () => ({
  listContentSyncChapters: vi.fn(), readContentState: vi.fn(), applyContentState: vi.fn(),
  importContentMetadata: vi.fn(), markContentInstalled: vi.fn(),
  readContentSyncCache: vi.fn(), writeContentSyncCache: vi.fn(),
  contentIdentity: (plugin: string, novel: string, chapter = "") => JSON.stringify([plugin, novel, chapter]),
}));
vi.mock("./native", () => ({ uploadContentChapter: vi.fn(), downloadContentChapter: vi.fn(), fingerprintContentChapter: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ fullPageReaderActive: reader.active, setLastReadChapter: vi.fn() }) } }));
vi.mock("../tasks/scheduler", () => ({ taskScheduler: { subscribeEvents: vi.fn() } }));
import { fetch as appFetch } from "@tauri-apps/plugin-http";
import { listContentSyncChapters, readContentState, importContentMetadata, applyContentState, readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { uploadContentChapter, fingerprintContentChapter, downloadContentChapter } from "./native";
import { useContentSyncStore } from "../../store/content-sync";
import { syncContentServer, loginContentServer, logoutContentServer, downloadServerChapter } from "./sync";
import { markContentInstalled } from "../../db/queries/content-sync";

const memory = new Map<string, string>();
const stateKey = 'read:["p","n","c"]';
const local = { [stateKey]: { unread: false, progress: 60 } };
let remote: Record<string, unknown>;
let mutations: Record<string, unknown>[];
let rejectMutation: boolean;
beforeEach(() => {
  vi.clearAllMocks(); memory.clear();
  reader.active = false;
  vi.stubGlobal("localStorage", { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.stubGlobal("window", new EventTarget());
  vi.mocked(readContentSyncCache).mockImplementation(async (key) => memory.get(key) ?? null);
  vi.mocked(writeContentSyncCache).mockImplementation(async (key, payload) => { memory.set(key, payload); });
  useContentSyncStore.setState({ serverUrl: "http://localhost:7788", user: null, token: null, catalog: [], conflicts: [], status: "idle", error: null });
  vi.mocked(listContentSyncChapters).mockResolvedValue([]);
  vi.mocked(readContentState).mockResolvedValue(local);
  vi.mocked(importContentMetadata).mockResolvedValue({ novelId: 90, chapterId: 91 });
  vi.mocked(fingerprintContentChapter).mockResolvedValue("fingerprint-a");
  remote = {}; mutations = []; rejectMutation = false;
  vi.mocked(appFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/sessions")) return Response.json({ token: "secret", user: { id: "one", username: "reader", role: "member" } });
    if (url.endsWith("/sessions/current")) return new Response(null, { status: 204 });
    if (url.includes("/chapters?")) return Response.json({ items: [], cursor: 0, hasMore: false });
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body as string) as Record<string, unknown>; mutations.push(body);
      if (rejectMutation) throw new Error("offline");
      return Response.json({ key: body.key, version: 1, value: body.value, conflicts: [] });
    }
    return Response.json({ items: Object.values(remote) });
  });
});

it("persists a failed state mutation and retries its original operation ID", async () => {
  rejectMutation = true;
  await expect(loginContentServer("reader", "password", "merge")).rejects.toThrow("offline");
  expect(mutations).toHaveLength(1);
  const operationId = mutations[0]!.operationId;
  rejectMutation = false;
  await syncContentServer();
  expect(mutations[1]!.operationId).toBe(operationId);
  expect([...memory.values()].join("")).not.toContain("secret");
  expect([...memory.values()].join("")).not.toContain("password");
});

it("keeps server conflicts visible and never silently overwrites the local reading state", async () => {
  const conflict = { key: stateKey, version: 4, value: { unread: false, progress: 20 }, conflicts: [{ operationId: "other", deviceName: "Tablet", value: { unread: false, progress: 80 } }] };
  remote = { [stateKey]: conflict };
  await loginContentServer("reader", "password", "server");
  expect(useContentSyncStore.getState().conflicts).toEqual([conflict]);
  expect(vi.mocked(applyContentState).mock.calls.some(([key]) => key === stateKey)).toBe(false);
});

it("does not upload local content when the catalog contains a server tombstone", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, pluginId: "p", novelPath: "n", chapterPath: "c", isDownloaded: true, mediaRepairNeeded: false, contentBytes: 10, mediaBytes: 0 }] as never);
  useContentSyncStore.setState({ user: { id: "one", username: "reader", role: "member" }, token: "secret" });
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).includes("/chapters?") ? Promise.resolve(Response.json({ items: [{ id: "deleted", revision: "r", deleted: true, sequence: 1, manifest: { identity: { pluginId: "p", novelPath: "n", chapterPath: "c" } } }], cursor: 1, hasMore: false })) : original(url, init));
  await syncContentServer();
  expect(uploadContentChapter).not.toHaveBeenCalled();
  expect(useContentSyncStore.getState().catalog[0]?.deleted).toBe(true);
});

it("clears private conflict state immediately on logout even if revocation fails", async () => {
  useContentSyncStore.setState({ user: { id: "one", username: "reader", role: "member" }, token: "secret", conflicts: [{ key: stateKey, version: 1, value: local[stateKey]!, conflicts: [] }] });
  vi.mocked(appFetch).mockRejectedValueOnce(new Error("offline"));
  await expect(logoutContentServer()).rejects.toThrow("offline");
  expect(useContentSyncStore.getState()).toMatchObject({ user: null, token: null, conflicts: [] });
});

it("retains a newer local reading change while acknowledging an older failed mutation", async () => {
  rejectMutation = true;
  await expect(loginContentServer("reader", "password", "merge")).rejects.toThrow("offline");
  vi.mocked(readContentState).mockResolvedValue({ [stateKey]: { unread: false, progress: 85 } });
  rejectMutation = false;
  await syncContentServer();
  expect(vi.mocked(applyContentState).mock.calls.some(([key, value]) => key === stateKey && "progress" in value && value.progress === 60)).toBe(false);
  await syncContentServer();
  expect(mutations.at(-1)?.value).toEqual({ unread: false, progress: 85 });
});

it("detects equal-size content changes without uploading unchanged content again", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 1, novelId: 1, pluginId: "p", novelPath: "n", chapterPath: "c", novelName: "Novel", chapterName: "Chapter", contentType: "html", position: 1, page: "1", isDownloaded: true, mediaRepairNeeded: false, contentBytes: 10, mediaBytes: 0 }] as never);
  await loginContentServer("reader", "password", "merge");
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledTimes(1);
  vi.mocked(fingerprintContentChapter).mockResolvedValue("fingerprint-b");
  await syncContentServer();
  expect(uploadContentChapter).toHaveBeenCalledTimes(2);
});

it("retains the server-only sign-in choice when the first catalog request fails", async () => {
  const original = vi.mocked(appFetch).getMockImplementation()!;
  let failCatalog = true;
  vi.mocked(appFetch).mockImplementation((url, init) => {
    if (String(url).includes("/chapters?") && failCatalog) return Promise.reject(new Error("offline catalog"));
    return original(url, init);
  });
  await expect(loginContentServer("reader", "password", "server")).rejects.toThrow("offline catalog");
  failCatalog = false;
  await syncContentServer();
  expect(mutations).toHaveLength(0);
});

it("isolates the previous account's pending mutations when using a second account's server state", async () => {
  rejectMutation = true;
  await expect(loginContentServer("reader", "password", "merge")).rejects.toThrow("offline");
  const original = vi.mocked(appFetch).getMockImplementation()!;
  vi.mocked(appFetch).mockImplementation((url, init) => String(url).endsWith("/sessions") ? Promise.resolve(Response.json({ token: "second-secret", user: { id: "two", username: "second", role: "member" } })) : original(url, init));
  rejectMutation = false;
  await loginContentServer("second", "different-password", "server");
  expect(mutations).toHaveLength(1);
  expect(useContentSyncStore.getState().user?.id).toBe("two");
  expect([...memory.values()].join("")).not.toContain("second-secret");
});

it("defers remote reading changes while a reader is active", async () => {
  useContentSyncStore.setState({ user: { id: "one", username: "reader", role: "member" }, token: "secret" });
  reader.active = true;
  remote = { [stateKey]: { key: stateKey, version: 2, value: { unread: true, progress: 0 }, conflicts: [] } };
  await syncContentServer(false);
  expect(applyContentState).not.toHaveBeenCalled();
  expect(mutations).toHaveLength(0);
});

it("does not mark a failed native import downloaded and preserves readable directory names", async () => {
  vi.mocked(listContentSyncChapters).mockResolvedValue([{ chapterId: 91, novelId: 90, pluginId: "source", novelPath: "/work", chapterPath: "/chapter", novelName: "A work", chapterName: "Opening", position: 1, page: "1" }] as never);
  vi.mocked(downloadContentChapter).mockRejectedValueOnce(new Error("invalid checksum"));
  await expect(downloadServerChapter({ id: "server-id", deleted: false, manifest: { identity: { pluginId: "source", novelPath: "/work", chapterPath: "/chapter" } } } as never)).rejects.toThrow("invalid checksum");
  expect(markContentInstalled).not.toHaveBeenCalled();
  expect(vi.mocked(downloadContentChapter).mock.calls[0]![0]).toMatchObject({ chapterId: 91, storageDir: "contents/source/A-work-work/1-Opening" });
});

it("publishes an explicit cleared reading position instead of resurrecting server history", async () => {
  const key = 'position:["p","n",""]';
  vi.mocked(readContentState).mockResolvedValue({ [key]: { chapterPath: "c", progress: 60, readAt: 200 } });
  await loginContentServer("reader", "password", "merge");
  vi.mocked(readContentState).mockResolvedValue({});
  await syncContentServer(false);
  expect(mutations.at(-1)?.value).toEqual({ chapterPath: "c", progress: 0, readAt: null });
});
