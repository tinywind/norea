import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChapterMediaManifestFile } from "../chapter-media/types";
import type { CatalogEntry } from "./native";

const settings = vi.hoisted(() => ({ serverUrl: "http://configured", deviceName: "Tablet", lookupTimeoutSeconds: 3 }));
vi.mock("../../db/queries/chapter", () => ({ getChapterById: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({ getNovelById: vi.fn() }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => settings } }));
vi.mock("../plugins/manager", () => ({ pluginManager: { getPlugin: vi.fn() } }));
vi.mock("./novel-source", () => ({ readServerNovelSource: vi.fn() }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(), forgetContentDeviceRegistration: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { getChapterById } from "../../db/queries/chapter";
import { getNovelById } from "../../db/queries/novel";
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { pluginManager } from "../plugins/manager";
import { readServerNovelSource } from "./novel-source";
import { forgetContentDeviceRegistration, registerContentDevice } from "./device";
import { createServerChapterMediaFetcher } from "./media-repair";

const job = { id: 7, pluginId: "source-a" };
const file: ChapterMediaManifestFile = { bytes: 5, fileName: "page.png", path: "media/page.png", sourceUrl: "epub/images/page.png", status: "stored", updatedAt: 1 };
const entry: CatalogEntry = {
  id: "a".repeat(64), revision: "b".repeat(64), fileBytes: 123, complete: false, deleted: false, sequence: 1,
  manifest: { packageVersion: 1, layout: "chapter-files", identity: { pluginId: "source-a", novelId: "work", novelPath: "/work", chapterPath: "/chapter/7" },
    novel: { name: "Work", isLocal: false }, chapter: { name: "Seven", chapterNumber: "7", position: 7, page: "1", contentType: "html" }, bodyPath: "content.html",
    files: [{ path: "content.html", size: 4, modifiedAt: 1 }, { path: "manifest.json", size: 100, modifiedAt: 1 }, { path: "media.zip", size: 19, modifiedAt: 1 }] },
};

beforeEach(() => {
  vi.resetAllMocks();
  settings.serverUrl = "http://configured";
  vi.mocked(getChapterById).mockResolvedValue({ id: 7, novelId: 3, path: "/chapter/7", chapterNumber: "7", position: 7 } as never);
  vi.mocked(getNovelById).mockResolvedValue({ id: 3, pluginId: "source-a", sourceNovelId: "work", path: "/work" } as never);
  vi.mocked(readServerNovelSource).mockResolvedValue({ serverUrl: "http://origin", workId: "server-work" });
  vi.mocked(registerContentDevice).mockResolvedValue("device-key");
  vi.mocked(nativeFetch).mockImplementation(async url => String(url).includes("/catalog/chapter?")
    ? Response.json(entry) : new Response("image", { headers: { "Content-Length": "5", "Content-Type": "application/octet-stream" } }));
});
afterEach(() => vi.useRealTimers());

it("does no work until an asset is missing and resolves the server chapter once for concurrent repairs", async () => {
  const fetchAsset = createServerChapterMediaFetcher(job);
  expect(getChapterById).not.toHaveBeenCalled();
  expect(nativeFetch).not.toHaveBeenCalled();
  const results = await Promise.all([fetchAsset(file), fetchAsset({ ...file, fileName: "other.png", path: "media/other.png", sourceUrl: "epub/images/other.png" })]);
  expect(await Promise.all(results.map(response => response!.text()))).toEqual(["image", "image"]);
  expect(registerContentDevice).toHaveBeenCalledOnce();
  const requests = vi.mocked(nativeFetch).mock.calls;
  expect(requests.filter(([url]) => String(url).includes("/catalog/chapter?"))).toHaveLength(1);
  expect(requests[0]![0]).toContain("http://origin/api/v1/catalog/chapter?");
  expect(requests[0]![0]).toContain("includeUnavailable=true");
  const assetUrl = new URL(String(requests[1]![0]));
  expect(assetUrl.pathname).toBe(`/api/v1/chapters/${"a".repeat(64)}/media`);
  expect(Object.fromEntries(assetUrl.searchParams)).toEqual({ revision: "b".repeat(64), fileName: "page.png", sourceUrl: "epub/images/page.png" });
  expect(requests[1]![1]).toMatchObject({ headers: { Authorization: "Bearer device-key" }, maxRedirections: 0 });
});

it("accepts the exact work's chapter-number fallback and does not require a source plugin", async () => {
  vi.mocked(nativeFetch).mockResolvedValueOnce(Response.json({ ...entry, manifest: { ...entry.manifest, identity: { ...entry.manifest.identity, chapterPath: "norea-folder:7" } } }));
  const response = await createServerChapterMediaFetcher(job)(file);
  expect(await response!.text()).toBe("image");
});

it("rejects a different source-owned work before downloading an asset", async () => {
  vi.mocked(nativeFetch).mockResolvedValueOnce(Response.json({ ...entry, manifest: { ...entry.manifest, identity: { ...entry.manifest.identity, novelId: "different-work" } } }));
  await expect(createServerChapterMediaFetcher(job)(file)).rejects.toThrow("identity");
  expect(nativeFetch).toHaveBeenCalledOnce();
});

it("returns null when no server is configured", async () => {
  settings.serverUrl = "";
  vi.mocked(readServerNovelSource).mockResolvedValue(null);
  await expect(createServerChapterMediaFetcher(job)(file)).resolves.toBeNull();
  expect(nativeFetch).not.toHaveBeenCalled();
});

it("falls back only when an installed plugin can fetch the missing HTTP asset", async () => {
  vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
  vi.mocked(nativeFetch).mockImplementation(async url => String(url).includes("/catalog/chapter?") ? Response.json(entry) : new Response(null, { status: 410 }));
  await expect(createServerChapterMediaFetcher(job)({ ...file, sourceUrl: "https://source.test/page.png" })).resolves.toBeNull();
  await expect(createServerChapterMediaFetcher(job)(file)).rejects.toThrow("410");
});

it("surfaces blocked or unregistered server access when no plugin source is available", async () => {
  vi.mocked(nativeFetch).mockResolvedValueOnce(Response.json(entry)).mockResolvedValueOnce(new Response(null, { status: 401 }));
  await expect(createServerChapterMediaFetcher(job)(file)).rejects.toThrow("401");
  expect(forgetContentDeviceRegistration).toHaveBeenCalledWith("http://origin", "device-key");
});

it("does not hide a native cancellation behind plugin fallback", async () => {
  vi.mocked(pluginManager.getPlugin).mockReturnValue({ id: "source-a" } as never);
  const reason = new DOMException("Request cancelled", "AbortError");
  vi.mocked(nativeFetch).mockRejectedValueOnce(reason);
  await expect(createServerChapterMediaFetcher(job)({ ...file, sourceUrl: "https://source.test/page.png" })).rejects.toBe(reason);
});

it("propagates cancellation during lazy lookup and ignores its late response", async () => {
  const controller = new AbortController();
  let finish!: (response: Response) => void;
  vi.mocked(nativeFetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = createServerChapterMediaFetcher(job, controller.signal)(file);
  await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledOnce());
  const reason = new Error("Repair cancelled");
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
  finish(Response.json(entry));
  await Promise.resolve();
  expect(nativeFetch).toHaveBeenCalledOnce();
});

it("propagates cancellation while reading an asset response body", async () => {
  const controller = new AbortController();
  vi.mocked(nativeFetch).mockResolvedValueOnce(Response.json(entry)).mockResolvedValueOnce(new Response(new ReadableStream(), { headers: { "Content-Length": "5" } }));
  const pending = createServerChapterMediaFetcher(job, controller.signal)(file);
  await vi.waitFor(() => expect(nativeFetch).toHaveBeenCalledTimes(2));
  const reason = new Error("Repair cancelled");
  const rejected = expect(pending).rejects.toBe(reason);
  controller.abort(reason);
  await rejected;
});

it("rejects an incomplete asset response before it can be stored", async () => {
  vi.mocked(nativeFetch).mockResolvedValueOnce(Response.json(entry)).mockResolvedValueOnce(new Response("bad", { headers: { "Content-Length": "5" } }));
  await expect(createServerChapterMediaFetcher(job)(file)).rejects.toThrow("size");
});
