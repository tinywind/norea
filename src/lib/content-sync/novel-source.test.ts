import { beforeEach, expect, it, vi } from "vitest";
import type { CatalogEntry } from "./native";

const cache = new Map<string, string>();
vi.mock("../../db/queries/content-sync", () => ({
  readContentSyncCache: vi.fn(async (key: string) => cache.get(key) ?? null),
  writeContentSyncCache: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("../../db/queries/chapter", () => ({ getChapterById: vi.fn() }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => ({ serverUrl: "http://other", deviceName: "Tablet" }) } }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device-key") }));
vi.mock("./client", async (original) => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./sync", () => ({ downloadServerChapterFromServer: vi.fn(async () => ({ novelId: 3, chapterId: 7 })) }));

import { getNovelById } from "../../db/queries/novel";
import { getChapterById } from "../../db/queries/chapter";
import { contentServerRequest } from "./client";
import { registerContentDevice } from "./device";
import { downloadServerChapterFromServer } from "./sync";
import { listServerChapterPaths, readServerNovelSource, rememberServerNovelSource, tryDownloadServerChapter } from "./novel-source";

const job = { id: 7, novelId: 3, pluginId: "source-a", chapterPath: "/chapter/7" };
const entry = { deleted: false, manifest: { identity: { pluginId: "source-a", novelPath: "/novel/a", chapterPath: "/chapter/7" } } } as CatalogEntry;

beforeEach(() => {
  cache.clear();
  vi.clearAllMocks();
  vi.mocked(getNovelById).mockResolvedValue({ id: 3, pluginId: "source-a", path: "/novel/a" } as never);
  vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, path: "/chapter/7" } as never);
  vi.mocked(contentServerRequest).mockResolvedValue(entry);
});

it("restores the original server after a restart even when the configured server changes", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin:80/", workId: "work-a" });
  vi.resetModules();
  const restarted = await import("./novel-source");
  expect(await restarted.readServerNovelSource(3)).toEqual({ serverUrl: "http://origin", workId: "work-a" });
  expect(await readServerNovelSource(4)).toBeNull();
});

it("downloads from the persisted origin without using the configured server", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work-a" });
  expect(await tryDownloadServerChapter(job)).toBe(true);
  expect(registerContentDevice).toHaveBeenCalledWith("http://origin", "Tablet");
  expect(contentServerRequest).toHaveBeenCalledWith("http://origin", "/catalog/chapter?pluginId=source-a&novelPath=%2Fnovel%2Fa&chapterPath=%2Fchapter%2F7", "device-key");
  expect(downloadServerChapterFromServer).toHaveBeenCalledWith(entry, "http://origin");
});

it("derives the novel binding from the local chapter for older queued jobs", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work-a" });
  expect(await tryDownloadServerChapter({ ...job, novelId: undefined })).toBe(true);
});

it("returns false only for an unbound novel", async () => {
  expect(await tryDownloadServerChapter(job)).toBe(false);
  expect(registerContentDevice).not.toHaveBeenCalled();
});

it("surfaces server failures instead of falling back to the source site", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work-a" });
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new Error("server unavailable"));
  await expect(tryDownloadServerChapter(job)).rejects.toThrow("server unavailable");
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});

it("rejects corrupt persisted bindings rather than treating them as source-site novels", async () => {
  cache.set("norea-content-source:3", "{}");
  await expect(readServerNovelSource(3)).rejects.toThrow("invalid");
});

it("rejects mismatched server identities before installing another chapter", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work-a" });
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ ...entry, manifest: { identity: { ...entry.manifest.identity, chapterPath: "/other" } } });
  await expect(tryDownloadServerChapter(job)).rejects.toThrow("identity");
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});

it("pages only the selected work when reading available server chapter paths", async () => {
  vi.mocked(contentServerRequest)
    .mockResolvedValueOnce({ items: [{ id: "first", chapterPath: "/chapter/7", position: 7, name: "Seven" }], total: 2, hasMore: true })
    .mockResolvedValueOnce({ items: [{ id: "second", chapterPath: "/chapter/8", position: 8, name: "Eight" }], total: 2, hasMore: false });
  const signal = new AbortController().signal;
  expect(await listServerChapterPaths({ serverUrl: "http://origin", workId: "work-a" }, signal))
    .toEqual(new Set(["/chapter/7", "/chapter/8"]));
  expect(vi.mocked(contentServerRequest).mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ["http://origin", "/catalog/works/work-a/chapters?offset=0&limit=100"],
    ["http://origin", "/catalog/works/work-a/chapters?offset=1&limit=100"],
  ]);
});
