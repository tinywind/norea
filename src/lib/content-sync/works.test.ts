import { beforeEach, expect, it, vi } from "vitest";
import type { NovelMetadataV1 } from "../work-metadata";

vi.mock("../work-metadata", () => ({
  listStoredNovelMetadata: vi.fn(), readStoredNovelCover: vi.fn(),
  installStoredNovelMetadata: vi.fn(), parseNovelMetadata: (value: unknown) => value,
}));
vi.mock("../../db/queries/content-sync", () => ({ readContentSyncCache: vi.fn(), writeContentSyncCache: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { installStoredNovelMetadata, listStoredNovelMetadata, readStoredNovelCover } from "../work-metadata";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { syncWorkMetadata, contentWorkId } from "./works";

const metadata = (name = "Book"): NovelMetadataV1 => ({
  schemaVersion: 1, identity: { pluginId: "example", novelPath: "/book" },
  novel: { name, cover: "https://example.com/cover.png", author: "Author", artist: null, summary: "Summary", status: "Ongoing", genres: "Fantasy", isLocal: false },
  chapters: [{ path: "/first", name: "First", chapterNumber: "1", position: 1, page: "1", contentType: "html", releaseTime: null, directory: "1-First" }],
  cover: { fileName: "cover.png", contentType: "image/png", sourceUrl: "https://example.com/cover.png" }, updatedAt: 10,
});
const memory = new Map<string, string>();
let local: { directory: string; metadata: NovelMetadataV1 }[];
let remote: NovelMetadataV1 | undefined;
let remoteCover: Uint8Array | undefined;
let sequence: number;
let puts: number;
beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); local = []; remote = undefined; remoteCover = undefined; sequence = 0; puts = 0;
  vi.stubGlobal("window", new EventTarget());
  vi.mocked(readContentSyncCache).mockImplementation(async key => memory.get(key) ?? null);
  vi.mocked(writeContentSyncCache).mockImplementation(async (key, value) => { memory.set(key, value); });
  vi.mocked(listStoredNovelMetadata).mockImplementation(async () => structuredClone(local));
  vi.mocked(readStoredNovelCover).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(installStoredNovelMetadata).mockImplementation(async (value, _cover, beforeInstall) => { await beforeInstall?.(); local = [{ directory: "contents/example/Book-book", metadata: structuredClone(value) }]; });
  vi.mocked(nativeFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/cover")) {
      if (init?.method === "PUT") { remoteCover = new Uint8Array(await new Response(init.body).arrayBuffer()); sequence++; return Response.json({}); }
      return remoteCover ? new Response(Uint8Array.from(remoteCover).buffer) : new Response(null, { status: 404 });
    }
    if (init?.method === "PUT") { remote = JSON.parse(String(init.body)); sequence++; puts++; return Response.json({ id: await contentWorkId(remote!.identity), sequence, metadata: remote, hasCover: !!remoteCover }); }
    if (url.pathname.endsWith("/works")) return Response.json({ items: remote && Number(url.searchParams.get("after")) < sequence ? [{ id: await contentWorkId(remote.identity), sequence, metadata: remote, hasCover: !!remoteCover }] : [], cursor: sequence, hasMore: false });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
});

it("uploads metadata and cover without any downloaded chapter and skips unchanged uploads", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  expect(remote?.chapters[0].path).toBe("/first");
  expect(remoteCover).toEqual(new Uint8Array([1, 2, 3]));
  expect(remote?.novel.author).toBe("Author");
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(1);
});

it("installs a server work and cover before any chapter download", async () => {
  remote = metadata(); remoteCover = new Uint8Array([4, 5, 6]); sequence = 2;
  const changed = vi.fn(); window.addEventListener("norea-content-state-changed", changed);
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata.novel.name).toBe("Book");
  expect(installStoredNovelMetadata).toHaveBeenCalledWith(remote, remoteCover, expect.any(Function));
  expect(puts).toBe(0);
  expect(changed).toHaveBeenCalledTimes(1);
});

it("preserves a local metadata edit when an older remote update arrives", async () => {
  remote = metadata(); sequence = 1;
  await syncWorkMetadata("http://server", "device", true);
  local[0].metadata.novel.name = "Locally edited";
  remote = metadata("Remote older edit"); sequence++;
  await syncWorkMetadata("http://server", "device", true);
  expect(local[0].metadata.novel.name).toBe("Locally edited");
  expect(remote?.novel.name).toBe("Locally edited");
});

it("does not advance the cursor or install metadata when its cover download fails", async () => {
  remote = metadata(); remoteCover = new Uint8Array([4]); sequence = 1;
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  vi.mocked(nativeFetch).mockImplementation((input, init) => String(input).endsWith("/cover") ? Promise.resolve(new Response(null, { status: 503 })) : request(input, init));
  await expect(syncWorkMetadata("http://server", "device", false)).rejects.toThrow("503");
  expect(local).toEqual([]);
  expect([...memory.values()].some(value => JSON.parse(value).cursor > 0)).toBe(false);
});

it("preserves edits made while the remote cover is downloading", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  remote = metadata("Remote edit"); sequence++;
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  vi.mocked(nativeFetch).mockImplementation(async (input, init) => {
    if (String(input).endsWith("/cover") && init?.method === "GET") local[0].metadata.novel.name = "Edited during download";
    return request(input, init);
  });
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata.novel.name).toBe("Edited during download");
});

it("saves each installed baseline before a later item in the page fails", async () => {
  const first = metadata();
  const second = metadata("Second"); second.identity.novelPath = "/second";
  const firstId = await contentWorkId(first.identity);
  vi.mocked(nativeFetch).mockImplementation(async input => {
    const url = String(input);
    if (url.endsWith(`/works/${firstId}/cover`)) return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith("/cover")) return new Response(null, { status: 503 });
    return Response.json({ items: [
      { id: firstId, sequence: 1, metadata: first, hasCover: true },
      { id: await contentWorkId(second.identity), sequence: 2, metadata: second, hasCover: true },
    ], cursor: 2, hasMore: false });
  });
  await expect(syncWorkMetadata("http://server", "device", false)).rejects.toThrow("503");
  const saved = JSON.parse([...memory.values()][0]);
  expect(saved.cursor).toBe(0);
  expect(saved.fingerprints[firstId]).toEqual(expect.any(String));
  expect(local[0].metadata).toEqual(first);
});
