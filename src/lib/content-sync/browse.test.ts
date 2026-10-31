import { beforeEach, expect, it, vi } from "vitest";
import type Database from "@tauri-apps/plugin-sql";
vi.mock("./chapters", () => ({ fetchServerChapters: vi.fn(async () => []) }));
vi.mock("../../db/queries/content-sync", () => ({ cacheServerChapters: vi.fn(), readContentSyncCache: vi.fn(async () => null), writeContentSyncCache: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device") }));
vi.mock("./novel-source", () => ({ rememberServerNovelSource: vi.fn() }));
vi.mock("../work-metadata", async original => ({ ...await original<typeof import("../work-metadata")>(), installStoredNovelMetadata: vi.fn() }));
vi.mock("../../db/work-metadata", async original => ({
  ...await original<typeof import("../../db/work-metadata")>(),
  applyNovelMetadataToCache: vi.fn(), rememberStoredNovelMetadata: vi.fn(), scanStoredNovelChaptersToCache: vi.fn(),
}));
vi.mock("../../db/queries/novel", () => ({ findNovelBySource: vi.fn(async () => ({ id: 42 })) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("./works", async original => ({ ...await original<typeof import("./works")>(), recordInstalledWorkMetadata: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { installStoredNovelMetadata, type NovelMetadataV1 } from "../work-metadata";
import { contentServerRequest } from "./client";
import { listServerWorks, openServerNovel, refreshServerNovel, serverCoverSource } from "./browse";
import { rememberServerNovelSource } from "./novel-source";
import { contentWorkId, recordInstalledWorkMetadata } from "./works";
import { findNovelBySource } from "../../db/queries/novel";
import { applyNovelMetadataToCache, rememberStoredNovelMetadata, scanStoredNovelChaptersToCache } from "../../db/work-metadata";
import { fetchServerChapters } from "./chapters";
import { cacheServerChapters } from "../../db/queries/content-sync";
import { recordServerWorkDeletionExclusion } from "./deletion-exclusions";

const metadata: NovelMetadataV1 = {
  schemaVersion: 1, identity: { pluginId: "source", novelId: "book", novelPath: "/book" },
  novel: { name: "Book", author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false },
  cover: null,
  chapters: {},
};
const installed = {
  metadata, directory: "contents/source/book", coverBytes: null,
  syncFile: { pluginId: "source", path: "/book", directory: "contents/source/book", fingerprint: "installed", revision: 1 },
};
const rawSelect = vi.fn();
const rawExecute = vi.fn();
const rawDb = { select: rawSelect, execute: rawExecute } as unknown as Database;
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("window", new EventTarget());
  vi.mocked(installStoredNovelMetadata).mockReset().mockResolvedValue(installed);
  vi.mocked(findNovelBySource).mockReset().mockResolvedValue({ id: 42 } as Awaited<ReturnType<typeof findNovelBySource>>);
  vi.mocked(applyNovelMetadataToCache).mockReset().mockResolvedValue(42);
  vi.mocked(scanStoredNovelChaptersToCache).mockReset().mockResolvedValue(undefined);
  vi.mocked(rememberStoredNovelMetadata).mockReset().mockResolvedValue(undefined);
  rawSelect.mockReset().mockResolvedValue([]);
  rawExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
});

it.each(["response", "install"])("discards a server work deleted during its delayed %s", async phase => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: false });
  const remove = () => recordServerWorkDeletionExclusion("http://server", metadata.identity);
  const commit = vi.fn();
  if (phase === "response") vi.mocked(fetchServerChapters).mockImplementationOnce(async () => { await remove(); return []; });
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (phase === "install") await remove();
    if (await guard?.(null) === false) return null;
    commit();
    return installed;
  });
  await expect(refreshServerNovel({ serverUrl: "http://server", workId: id }, true)).rejects.toMatchObject({ status: 410 });
  expect(commit).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
});

it("queries a bounded page without fetching synchronization history", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ items: [], total: 0, hasMore: false });
  await listServerWorks("http://server", "device", "Book & title", "source", 40);
  expect(contentServerRequest).toHaveBeenCalledOnce();
  const path = vi.mocked(contentServerRequest).mock.calls[0]![1];
  expect(path).toBe("/catalog/works?q=Book+%26+title&offset=40&limit=40&source=source");
});

it("installs only the selected work and retains its origin for later downloads", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: false });
  expect(await refreshServerNovel({ serverUrl: "http://server", workId: id })).toBe(42);
  expect(contentServerRequest).toHaveBeenCalledOnce();
  expect(contentServerRequest).toHaveBeenCalledWith("http://server", `/works/${id}`, "device");
  expect(installStoredNovelMetadata).toHaveBeenCalledWith(metadata, undefined, expect.any(Function));
  expect(recordInstalledWorkMetadata).toHaveBeenCalledWith("http://server", installed, false);
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
});

it("does not publish a work when its cover fails to download", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(contentServerRequest).mockResolvedValue({ id, metadata, hasCover: true });
  vi.mocked(nativeFetch).mockResolvedValue(new Response(null, { status: 503 }));
  await expect(refreshServerNovel({ serverUrl: "http://server", workId: id })).rejects.toThrow("503");
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
});

it("rejects a different work returned by the server before publishing files", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: "wrong", metadata, hasCover: false });
  await expect(refreshServerNovel({ serverUrl: "http://server", workId: "requested" })).rejects.toThrow("identity");
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
});

it("detects an image MIME type when the response uses application/octet-stream", async () => {
  vi.mocked(nativeFetch).mockResolvedValue(new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "application/octet-stream" } }));
  expect(await serverCoverSource("http://server", "device", "work")).toBe("data:image/jpeg;base64,/9j/");
});

it("opens an existing local work without overwriting edits or deleting locally known chapters", async () => {
  const id = await contentWorkId(metadata.identity);
  expect(await openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: true, chapterCount: 1 })).toBe(42);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
});

it("opens a concurrently indexed work without overwriting its metadata or acknowledging the stale server response", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  rawSelect.mockResolvedValue([{ id: 42, sourceNovelId: "book" }]);
  const publish = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    const current = { directory: "contents/source/book", metadata };
    if (await guard!(current, rawDb) === false) return null;
    publish();
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).resolves.toBe(42);
  expect(publish).not.toHaveBeenCalled();
  expect(applyNovelMetadataToCache).not.toHaveBeenCalled();
  expect(scanStoredNovelChaptersToCache).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
});

it("reindexes a work omitted by device restore from its preserved original files and opens it immediately", async () => {
  const id = await contentWorkId(metadata.identity);
  const original = {
    directory: "contents/source/book",
    metadata: { ...metadata, novel: { ...metadata.novel, name: "Preserved local title", summary: "Original local details" }, chapters: { "1": "Existing chapter" } },
  };
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  const publish = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (await guard!(original, rawDb) === false) return null;
    publish();
    return installed;
  });
  const work = { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 };
  await expect(openServerNovel("http://server", work)).resolves.toBe(42);
  expect(publish).not.toHaveBeenCalled();
  expect(applyNovelMetadataToCache).toHaveBeenCalledWith(rawDb, original.metadata, original.directory);
  expect(scanStoredNovelChaptersToCache).toHaveBeenCalledWith(rawDb, 42, original.directory);
  expect(rememberStoredNovelMetadata).toHaveBeenCalledWith(rawDb, original.directory, original.metadata);
  expect(rawExecute).toHaveBeenCalledWith("DELETE FROM work_metadata_dirty WHERE plugin_id=$1 AND path=$2", ["source", "/book"]);
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
  expect(cacheServerChapters).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).toHaveBeenCalledWith(42, { serverUrl: "http://server", workId: id });
  // The next open reuses the recovered DB row instead of repeating the failed install.
  await expect(openServerNovel("http://server", work)).resolves.toBe(42);
  expect(installStoredNovelMetadata).toHaveBeenCalledOnce();
  expect(contentServerRequest).toHaveBeenCalledOnce();
});

it("rolls back preserved-file indexing when a work is deleted during chapter inspection", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(scanStoredNovelChaptersToCache).mockImplementationOnce(async () => {
    await recordServerWorkDeletionExclusion("http://server", metadata.identity);
  });
  const publish = vi.fn();
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    // Real installStoredNovelMetadata runs this guard in runDatabaseTransaction;
    // a thrown deletion error must escape so that transaction rolls back.
    if (await guard!({ directory: "contents/source/book", metadata }, rawDb) === false) return null;
    publish();
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).rejects.toMatchObject({ status: 410 });
  expect(publish).not.toHaveBeenCalled();
  expect(rememberStoredNovelMetadata).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
});

it("does not report preserved-file recovery as successful when original chapter inspection fails", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(scanStoredNovelChaptersToCache).mockRejectedValueOnce(new Error("Storage permission unavailable"));
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (await guard!({ directory: "contents/source/book", metadata }, rawDb) === false) return null;
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).rejects.toThrow("Storage permission unavailable");
  expect(rememberStoredNovelMetadata).not.toHaveBeenCalled();
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).not.toHaveBeenCalled();
});

it("continues normal installation when neither the work index nor original files exist", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    if (await guard!(null, rawDb) === false) return null;
    return installed;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).resolves.toBe(42);
  expect(applyNovelMetadataToCache).not.toHaveBeenCalled();
  expect(recordInstalledWorkMetadata).toHaveBeenCalledWith("http://server", installed, false);
  expect(cacheServerChapters).toHaveBeenCalledWith(42, []);
});

it("reads server covers with a caller signal on WebViews without AbortSignal.any", async () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, "any")!;
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
  try {
    vi.mocked(nativeFetch).mockResolvedValue(new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } }));
    await expect(serverCoverSource("http://server", "device", "work", new AbortController().signal))
      .resolves.toBe("data:image/jpeg;base64,/9j/");
  } finally {
    Object.defineProperty(AbortSignal, "any", original);
  }
});
