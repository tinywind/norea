import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./chapters", () => ({ fetchServerChapters: vi.fn(async () => []) }));
vi.mock("../../db/queries/content-sync", () => ({ cacheServerChapters: vi.fn() }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device") }));
vi.mock("./novel-source", () => ({ rememberServerNovelSource: vi.fn() }));
vi.mock("../work-metadata", async original => ({ ...await original<typeof import("../work-metadata")>(), installStoredNovelMetadata: vi.fn() }));
vi.mock("../../db/queries/novel", () => ({ findNovelBySource: vi.fn(async () => ({ id: 42 })) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { installStoredNovelMetadata, type NovelMetadataV1 } from "../work-metadata";
import { contentServerRequest } from "./client";
import { listServerWorks, openServerNovel, refreshServerNovel, serverCoverSource } from "./browse";
import { rememberServerNovelSource } from "./novel-source";
import { contentWorkId } from "./works";
import { findNovelBySource } from "../../db/queries/novel";

const metadata: NovelMetadataV1 = {
  schemaVersion: 1, identity: { pluginId: "source", novelPath: "/book" },
  novel: { name: "Book", cover: null, author: null, artist: null, summary: null, status: null, rating: null, genres: null, isLocal: false },
  cover: null,
};
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("window", new EventTarget()); });

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
  expect(installStoredNovelMetadata).toHaveBeenCalledWith(metadata, undefined, undefined);
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

it("accepts legacy covers whose metadata has no MIME type", async () => {
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

it("protects metadata installed concurrently while opening a new server work", async () => {
  const id = await contentWorkId(metadata.identity);
  vi.mocked(findNovelBySource).mockResolvedValueOnce(null);
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id, metadata, hasCover: false });
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (_metadata, _cover, guard) => {
    const current = { directory: "contents/source/Book", metadata };
    await guard!(current);
    return current;
  });
  await expect(openServerNovel("http://server", { id, sequence: 1, identity: metadata.identity, novel: metadata.novel, hasCover: false, chapterCount: 1 })).rejects.toThrow("installed while opening");
  expect(rememberServerNovelSource).not.toHaveBeenCalled();
});
