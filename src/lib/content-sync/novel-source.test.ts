import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogEntry } from "./native";

const cache = new Map<string, string>();
const settings = vi.hoisted(() => ({ serverUrl: "", deviceName: "Tablet", lookupTimeoutSeconds: 3 }));
vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(async () => []), isNovelMigrationSourceHeldInDb: vi.fn(async () => false),
  readContentSyncCache: vi.fn(async (key: string) => cache.get(key) ?? null),
  writeContentSyncCache: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
}));
vi.mock("../../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("../../db/queries/chapter", () => ({ getChapterById: vi.fn() }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => settings } }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device-key") }));
vi.mock("./client", async (original) => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./sync", () => ({ downloadServerChapterFromServer: vi.fn(async () => ({ novelId: 3, chapterId: 7 })) }));
vi.mock("../plugins/manager", () => ({ pluginManager: { getPlugin: vi.fn(), loadInstalledFromDb: vi.fn(async () => undefined) } }));

import { getNovelById } from "../../db/queries/novel";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { getChapterById } from "../../db/queries/chapter";
import { ContentServerError, contentServerRequest } from "./client";
import { registerContentDevice } from "./device";
import { pluginManager } from "../plugins/manager";
import { downloadServerChapterFromServer } from "./sync";
import { listServerChapterAvailability, readServerNovelSource, rememberServerNovelSource } from "./novel-source";
let tryDownloadServerChapter: typeof import("./novel-source")["tryDownloadServerChapter"];

const job = { id: 7, novelId: 3, pluginId: "source-a", chapterPath: "/chapter/7" };
const entry = { deleted: false, manifest: { identity: { pluginId: "source-a", novelPath: "/novel/a", chapterPath: "/chapter/7" } } } as CatalogEntry;

beforeEach(async () => {
  vi.resetModules();
  ({ tryDownloadServerChapter } = await import("./novel-source"));
  cache.clear();
  vi.clearAllMocks();
  vi.mocked(pluginManager.getPlugin).mockReset();
  vi.mocked(pluginManager.loadInstalledFromDb).mockReset().mockResolvedValue(undefined);
  vi.mocked(contentServerRequest).mockReset();
  vi.mocked(registerContentDevice).mockReset();
  vi.mocked(downloadServerChapterFromServer).mockReset().mockResolvedValue({ novelId: 3, chapterId: 7 });
  Object.assign(settings, { serverUrl: "", lookupTimeoutSeconds: 3 });
  vi.mocked(registerContentDevice).mockResolvedValue("device-key");
  vi.mocked(getNovelById).mockResolvedValue({ id: 3, pluginId: "source-a", path: "/novel/a", name: "A work" } as never);
  vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, path: "/chapter/7", chapterNumber: "7", position: 7 } as never);
  vi.mocked(contentServerRequest).mockResolvedValue(entry);
});
afterEach(() => vi.useRealTimers());

it("checks the configured server before downloading an ordinary plugin chapter", async () => {
  settings.serverUrl = "http://configured";
  const onPhase = vi.fn();
  expect(await tryDownloadServerChapter(job, undefined, onPhase)).toBe(true);
  expect(onPhase.mock.calls).toEqual([["server-lookup"], ["server-download"]]);
  expect(contentServerRequest).toHaveBeenCalledWith("http://configured", expect.stringContaining("/catalog/chapter?"), "device-key", "GET", undefined, expect.any(AbortSignal));
  expect(downloadServerChapterFromServer).toHaveBeenCalledWith(entry, "http://configured", {
    token: "device-key", target: entry.manifest.identity,
  });
  expect(cache.size).toBe(0);
});

it("downloads every available server body including incomplete copies", async () => {
  settings.serverUrl = "http://configured";
  vi.mocked(contentServerRequest).mockResolvedValue({ ...entry, complete: false });
  expect(await tryDownloadServerChapter(job)).toBe(true);
  expect(downloadServerChapterFromServer).toHaveBeenCalledOnce();
  expect(await tryDownloadServerChapter(job)).toBe(true);
  vi.mocked(contentServerRequest).mockResolvedValue({ ...entry, complete: true });
  expect(await tryDownloadServerChapter(job)).toBe(true);
  expect(downloadServerChapterFromServer).toHaveBeenCalledTimes(3);
});

it.each([404])("falls back to the plugin when the optional server returns %i", async status => {
  settings.serverUrl = "http://configured";
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(status));
  const onPhase = vi.fn();
  expect(await tryDownloadServerChapter(job, undefined, onPhase)).toBe(false);
  expect(onPhase.mock.calls).toEqual([["server-lookup"]]);
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});

it("uses an installed source for new chapters absent from a bound server work", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work" });
  vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
  expect(await tryDownloadServerChapter(job)).toBe(false);
});

it("leaves plugin initialization to the source attempt after a bound work misses", async () => {
  await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work" });
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
  vi.mocked(pluginManager.loadInstalledFromDb).mockImplementationOnce(async () => {
    vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
  });
  expect(await tryDownloadServerChapter(job)).toBe(false);
  expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
});

it("stops without installing mismatched content from an optional server", async () => {
  settings.serverUrl = "http://configured";
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ ...entry, manifest: { identity: { ...entry.manifest.identity, chapterPath: "/other" } } });
  await expect(tryDownloadServerChapter(job)).rejects.toThrow("identity");
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});

it.each([401, 403, 429, 500, 503])("propagates optional server HTTP %i without a source fallback", async status => {
  settings.serverUrl = "http://configured";
  const failure = new ContentServerError(status);
  vi.mocked(contentServerRequest).mockRejectedValueOnce(failure);
  await expect(tryDownloadServerChapter(job)).rejects.toBe(failure);
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});

it("bounds registration and lookup together and ignores responses after timeout", async () => {
  vi.useFakeTimers(); settings.serverUrl = "http://configured";
  let complete!: (token: string) => void;
  vi.mocked(registerContentDevice).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const pending = tryDownloadServerChapter(job).catch(error => error);
  await vi.advanceTimersByTimeAsync(2999);
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ message: "Content server lookup timed out." });
  complete("device-key"); await vi.advanceTimersByTimeAsync(0);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("uses the configured deadline without limiting a successful package transfer", async () => {
  vi.useFakeTimers(); settings.serverUrl = "http://configured"; settings.lookupTimeoutSeconds = 5;
  vi.mocked(contentServerRequest).mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(entry), 4000)));
  vi.mocked(downloadServerChapterFromServer).mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ novelId: 3, chapterId: 7 }), 10000)));
  const pending = tryDownloadServerChapter(job);
  await vi.advanceTimersByTimeAsync(14000);
  expect(await pending).toBe(true);
});

it("allows a fresh explicit attempt after surfacing a server timeout", async () => {
  vi.useFakeTimers(); settings.serverUrl = "http://configured";
  vi.mocked(registerContentDevice).mockImplementationOnce(() => new Promise(() => undefined));
  const first = tryDownloadServerChapter(job).catch(error => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await first).toMatchObject({ message: "Content server lookup timed out." });
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(await tryDownloadServerChapter(job)).toBe(true);
});

it("propagates a failed optional package transfer without a source fallback", async () => {
  settings.serverUrl = "http://configured";
  const failure = new Error("server connection closed");
  vi.mocked(downloadServerChapterFromServer).mockRejectedValueOnce(failure);
  await expect(tryDownloadServerChapter(job)).rejects.toBe(failure);
});

it("does not treat an absent chapter as an unavailable server", async () => {
  settings.serverUrl = "http://configured";
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
  expect(await tryDownloadServerChapter(job)).toBe(false);
  expect(await tryDownloadServerChapter(job)).toBe(true);
});

it("does not fall back or install a package after task cancellation", async () => {
  settings.serverUrl = "http://configured";
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(tryDownloadServerChapter(job, controller.signal)).rejects.toThrow("cancelled");
  expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
});

it("accepts a chapter-number match within the exact work without creating another local work", async () => {
  settings.serverUrl = "http://configured";
  const stored = { ...entry, manifest: { identity: { pluginId: "source-a", novelPath: "/novel/a", chapterPath: "norea-folder:7" }, chapter: { chapterNumber: "7" } } };
  vi.mocked(contentServerRequest).mockResolvedValueOnce(stored);
  expect(await tryDownloadServerChapter(job)).toBe(true);
  expect(downloadServerChapterFromServer).toHaveBeenCalledWith(stored, "http://configured", { token: "device-key", target: entry.manifest.identity });
});

describe("recovered folder chapters", () => {
  const folderJob = { ...job, chapterPath: "norea-folder:7" };
  beforeEach(async () => {
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, path: "norea-folder:7", chapterNumber: "7", position: 7 } as never);
    await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work" });
  });

  it("leaves a chapter missing on the server to an installed source instead of failing", async () => {
    vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
    vi.mocked(pluginManager.loadInstalledFromDb).mockImplementationOnce(async () => {
      vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
    });
    expect(await tryDownloadServerChapter(folderJob)).toBe(false);
    expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
    // A missing chapter does not delay the next server lookup.
    vi.mocked(contentServerRequest).mockResolvedValueOnce({ ...entry, manifest: { identity: { ...entry.manifest.identity, chapterPath: "norea-folder:7" }, chapter: { chapterNumber: "7" } } } as CatalogEntry);
    expect(await tryDownloadServerChapter(folderJob)).toBe(true);
  });

  it("surfaces a server failure instead of silently skipping the server", async () => {
    vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
    const failure = new ContentServerError(503);
    vi.mocked(contentServerRequest).mockRejectedValueOnce(failure);
    await expect(tryDownloadServerChapter(folderJob)).rejects.toBe(failure);
    expect(contentServerRequest).toHaveBeenCalledOnce();
  });

  it.each([
    ["no installed source", { id: 3, pluginId: "source-a", path: "/novel/a", name: "A work" }, undefined],
    ["a local work", { id: 3, pluginId: "source-a", path: "/novel/a", name: "A work", isLocal: true }, { id: "source-a" }],
  ])("reports an absent body without inspecting %s", async (_case, novel, plugin) => {
    vi.mocked(getNovelById).mockResolvedValue(novel as never);
    vi.mocked(pluginManager.getPlugin).mockReturnValue(plugin as never);
    vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
    expect(await tryDownloadServerChapter(folderJob)).toBe(false);
  });
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
  expect(registerContentDevice).toHaveBeenCalledWith("http://origin", "Tablet", expect.any(AbortSignal));
  expect(contentServerRequest).toHaveBeenCalledWith("http://origin", expect.stringContaining("/catalog/chapter?pluginId=source-a&novelPath=%2Fnovel%2Fa&chapterPath=%2Fchapter%2F7"), "device-key", "GET", undefined, expect.any(AbortSignal));
  expect(downloadServerChapterFromServer).toHaveBeenCalledWith(entry, "http://origin", { token: "device-key", target: entry.manifest.identity });
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

it("keeps per-path completeness without assigning ambiguous chapter numbers", async () => {
  vi.mocked(contentServerRequest).mockResolvedValueOnce({
    items: [
      { id: "one", chapterPath: "/chapter/a", chapterNumber: "7", position: 1, name: "First seven", complete: false },
      { id: "two", chapterPath: "/chapter/b", chapterNumber: "7.0", position: 2, name: "Second seven", complete: true },
      { id: "three", chapterPath: "/chapter/c", chapterNumber: "extra", position: 3, name: "Extra", complete: false },
      { id: "four", chapterPath: "/chapter/d", chapterNumber: "8.5", position: 4, name: "Eight and a half", complete: true },
    ],
    total: 4,
    hasMore: false,
  });

  expect(await listServerChapterAvailability({ serverUrl: "http://origin", workId: "work-a" })).toEqual({
    paths: new Map([["/chapter/a", false], ["/chapter/b", true], ["/chapter/c", false], ["/chapter/d", true]]),
    numbers: new Map([[8.5, true]]),
  });
});

it("pages only the selected work when reading available server chapter paths", async () => {
  vi.mocked(contentServerRequest)
    .mockResolvedValueOnce({ items: [{ id: "first", chapterPath: "/chapter/7", chapterNumber: "7", position: 7, name: "Seven", complete: false }], total: 2, hasMore: true })
    .mockResolvedValueOnce({ items: [{ id: "second", chapterPath: "/chapter/8", chapterNumber: "8", position: 8, name: "Eight", complete: true }], total: 2, hasMore: false });
  const signal = new AbortController().signal;
  expect(await listServerChapterAvailability({ serverUrl: "http://origin", workId: "work-a" }, signal))
    .toEqual({ paths: new Map([["/chapter/7", false], ["/chapter/8", true]]), numbers: new Map([[7, false], [8, true]]) });
  expect(vi.mocked(contentServerRequest).mock.calls.map((args) => args.slice(0, 2))).toEqual([
    ["http://origin", "/catalog/works/work-a/chapters?offset=0&limit=100"],
    ["http://origin", "/catalog/works/work-a/chapters?offset=1&limit=100"],
  ]);
});

it.each(["chapter", "work", "source"] as const)("preserves %s database failures as storage errors before server traffic", async operation => {
  settings.serverUrl = "http://configured";
  const failure = new Error("Connection pool closed");
  if (operation === "chapter") vi.mocked(getChapterById).mockRejectedValueOnce(failure);
  if (operation === "work") vi.mocked(getNovelById).mockRejectedValueOnce(failure);
  if (operation === "source") vi.mocked(readContentSyncCache).mockRejectedValueOnce(failure);
  await expect(tryDownloadServerChapter(job)).rejects.toMatchObject({ code: "chapter-storage-failed", cause: failure });
  expect(registerContentDevice).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("preserves a failed content source database write as a storage error", async () => {
  const failure = new Error("Connection pool closed");
  vi.mocked(writeContentSyncCache).mockRejectedValueOnce(failure);
  await expect(rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work" }))
    .rejects.toMatchObject({ code: "chapter-storage-failed", cause: failure });
});


describe("server work downloads", () => {
  it("downloads a recovered chapter without loading or inspecting its broken source plugin", async () => {
    await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work" });
    const folderJob = { ...job, chapterPath: "norea-folder:7" };
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, path: folderJob.chapterPath, chapterNumber: "7", position: 7 } as never);
    vi.mocked(pluginManager.loadInstalledFromDb).mockRejectedValue(new Error("Bookkor episode IDs do not follow the source reading order."));
    const copy = { ...entry, complete: true, manifest: { ...entry.manifest, chapter: { chapterNumber: "7" } } } as CatalogEntry;
    vi.mocked(contentServerRequest).mockResolvedValueOnce(copy);

    expect(await tryDownloadServerChapter(folderJob)).toBe(true);
    expect(downloadServerChapterFromServer).toHaveBeenCalledWith(copy, "http://origin", {
      token: "device-key", target: { ...entry.manifest.identity, chapterPath: folderJob.chapterPath },
    });
    expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(pluginManager.getPlugin).not.toHaveBeenCalled();
  });

  it("allows source fallback after confirming a bound server payload is absent", async () => {
    await rememberServerNovelSource(3, { serverUrl: "http://origin", workId: "work" });
    vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
    const failure = new ContentServerError(404);
    vi.mocked(contentServerRequest).mockRejectedValueOnce(failure);

    expect(await tryDownloadServerChapter(job)).toBe(false);
    expect(pluginManager.getPlugin).not.toHaveBeenCalled();
    expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
    expect(downloadServerChapterFromServer).not.toHaveBeenCalled();
  });

  it("keeps an incomplete server body on the server route without consulting the source", async () => {
    settings.serverUrl = "http://configured";
    const copy = { ...entry, complete: false };
    vi.mocked(contentServerRequest).mockResolvedValueOnce(copy);
    expect(await tryDownloadServerChapter(job)).toBe(true);
    expect(downloadServerChapterFromServer).toHaveBeenCalledWith(copy, "http://configured", {
      token: "device-key", target: entry.manifest.identity,
    });
    expect(pluginManager.getPlugin).not.toHaveBeenCalled();
    expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
  });

  it("allows the source route when no server is configured", async () => {
    expect(await tryDownloadServerChapter(job)).toBe(false);
    expect(pluginManager.getPlugin).not.toHaveBeenCalled();
    expect(pluginManager.loadInstalledFromDb).not.toHaveBeenCalled();
  });
});

describe("server-first download boundaries", () => {
  it("uses an incomplete server body on the server lane instead of requesting the plugin", async () => {
    settings.serverUrl = "http://configured";
    vi.mocked(contentServerRequest).mockResolvedValue({ ...entry, complete: false });
    expect(await tryDownloadServerChapter(job)).toBe(true);
    expect(downloadServerChapterFromServer).toHaveBeenCalledOnce();
    expect(pluginManager.getPlugin).not.toHaveBeenCalled();
  });

  it.each([404, 410])("does not interpret package HTTP %i after a catalog hit as an absent server body", async status => {
    settings.serverUrl = "http://configured";
    const failure = new ContentServerError(status);
    vi.mocked(downloadServerChapterFromServer).mockRejectedValueOnce(failure);
    await expect(tryDownloadServerChapter(job)).rejects.toBe(failure);
  });

  it("does not interpret registration HTTP 404 as an absent server body", async () => {
    settings.serverUrl = "http://configured";
    const failure = new ContentServerError(404);
    vi.mocked(registerContentDevice).mockRejectedValueOnce(failure);
    await expect(tryDownloadServerChapter(job)).rejects.toBe(failure);
    expect(contentServerRequest).not.toHaveBeenCalled();
  });

  it("omits chapterNumber when looking up an unnumbered chapter with a numeric position", async () => {
    settings.serverUrl = "http://configured";
    const unnumberedJob = { ...job, chapterPath: "/prologue" };
    vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, path: "/prologue", chapterNumber: null, position: 1 } as never);
    vi.mocked(contentServerRequest).mockResolvedValueOnce({
      ...entry,
      manifest: { identity: { ...entry.manifest.identity, chapterPath: "/prologue" }, chapter: { chapterNumber: null } },
    } as CatalogEntry);

    expect(await tryDownloadServerChapter(unnumberedJob)).toBe(true);
    const requestedPath = vi.mocked(contentServerRequest).mock.calls[0]?.[1] ?? "";
    expect(requestedPath).toContain("chapterPath=%2Fprologue");
    expect(requestedPath).not.toContain("chapterNumber=");
  });
});
