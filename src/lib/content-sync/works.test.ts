import { beforeEach, expect, it, vi } from "vitest";
import type { NovelMetadataV1 } from "../work-metadata";

vi.mock("../work-metadata", async original => ({
  ...await original<typeof import("../work-metadata")>(),
  listStoredNovelMetadata: vi.fn(), readStoredNovelMetadata: vi.fn(), readStoredNovelCover: vi.fn(),
  installStoredNovelMetadata: vi.fn(),
}));
vi.mock("../../db/queries/content-sync", () => ({ readContentSyncStateCache: vi.fn(), writeContentSyncCache: vi.fn() }));
vi.mock("../../db/work-metadata", async original => ({ ...await original<typeof import("../../db/work-metadata")>(), readWorkMetadataSyncFiles: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { installStoredNovelMetadata, listStoredNovelMetadata, readStoredNovelMetadata, readStoredNovelCover } from "../work-metadata";
import { readContentSyncStateCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { readWorkMetadataSyncFiles, storedNovelMetadataFingerprint } from "../../db/work-metadata";
import { syncWorkMetadata, contentWorkId } from "./works";

const metadata = (name = "Book"): NovelMetadataV1 => ({
  schemaVersion: 1, identity: { pluginId: "example", novelPath: "/book" },
  novel: { name, cover: "https://example.com/cover.png", author: "Author", artist: null, summary: "Summary", status: "Ongoing", rating: 4.5, genres: "Fantasy", isLocal: false },
  cover: { fileName: "cover.png", contentType: "image/png", sourceUrl: "https://example.com/cover.png" },
});
const memory = new Map<string, string>();
const localCovers = new Map<string, Uint8Array | null>();
const revisions = new Map<string, number>();
let local: { directory: string; metadata: NovelMetadataV1 }[];
let remote: NovelMetadataV1 | undefined;
let remoteCover: Uint8Array | undefined;
let sequence: number;
let puts: number;
beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); localCovers.clear(); revisions.clear(); local = []; remote = undefined; remoteCover = undefined; sequence = 0; puts = 0;
  vi.stubGlobal("window", new EventTarget());
  vi.mocked(readContentSyncStateCache).mockImplementation(async key => memory.get(key) ?? null);
  vi.mocked(writeContentSyncCache).mockImplementation(async (key, value) => { memory.set(key, value); });
  vi.mocked(listStoredNovelMetadata).mockImplementation(async () => structuredClone(local));
  vi.mocked(readWorkMetadataSyncFiles).mockImplementation(async rescan => {
    if (rescan) {
      await listStoredNovelMetadata();
      for (const entry of local) revisions.set(entry.directory, (revisions.get(entry.directory) ?? 1) + 1);
    }
    return Promise.all(local.map(async entry => ({ pluginId: entry.metadata.identity.pluginId, path: entry.metadata.identity.novelPath,
      directory: entry.directory, fingerprint: await storedNovelMetadataFingerprint(entry.metadata), revision: revisions.get(entry.directory) ?? 1 })));
  });
  vi.mocked(readStoredNovelMetadata).mockImplementation(async directory => structuredClone(local.find(entry => entry.directory === directory) ?? null));
  vi.mocked(readStoredNovelCover).mockImplementation(async directory => localCovers.has(directory) ? localCovers.get(directory)! : new Uint8Array([1, 2, 3]));
  vi.mocked(installStoredNovelMetadata).mockImplementation(async (value, cover, beforeInstall) => {
    const current = local.find(entry => entry.metadata.identity.pluginId === value.identity.pluginId && entry.metadata.identity.novelPath === value.identity.novelPath);
    if (await beforeInstall?.(current ?? null) === false) return null;
    const installed = { directory: current?.directory ?? `contents/example/${value.novel.name}-book`, metadata: structuredClone(value) };
    revisions.set(installed.directory, (revisions.get(installed.directory) ?? (current ? 1 : 0)) + 1);
    local = [...local.filter(entry => entry !== current), installed];
    localCovers.set(installed.directory, cover ?? null);
    return installed;
  });
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
  expect(remote).not.toHaveProperty("chapters");
  expect(remote).not.toHaveProperty("updatedAt");
  expect(remote?.novel.rating).toBe(4.5);
  expect(remoteCover).toEqual(new Uint8Array([1, 2, 3]));
  expect(remote?.novel.author).toBe("Author");
  const changed = vi.fn();
  window.addEventListener("norea-content-state-changed", changed);
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(1);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it("does not traverse work files or read covers during an unchanged sync", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  await syncWorkMetadata("http://server", "device", true);
  vi.mocked(listStoredNovelMetadata).mockClear();
  vi.mocked(readStoredNovelMetadata).mockClear();
  vi.mocked(readStoredNovelCover).mockClear();
  await syncWorkMetadata("http://server", "device", true);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelCover).not.toHaveBeenCalled();
  expect(puts).toBe(1);
});

it("does not enumerate an empty local store during a normal sync", async () => {
  await syncWorkMetadata("http://server", "device", true);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelCover).not.toHaveBeenCalled();
});

it("reads only the changed work on an incremental upload", async () => {
  const other = metadata("Other"); other.identity.novelPath = "/other";
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }, { directory: "contents/example/Other-other", metadata: other }];
  await syncWorkMetadata("http://server", "device", true);
  await syncWorkMetadata("http://server", "device", true);
  local[0].metadata.novel.name = "Changed locally";
  vi.mocked(listStoredNovelMetadata).mockClear();
  vi.mocked(readStoredNovelMetadata).mockClear();
  vi.mocked(readStoredNovelCover).mockClear();
  await syncWorkMetadata("http://server", "device", true);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelMetadata).toHaveBeenCalledExactlyOnceWith("contents/example/Book-book");
  expect(readStoredNovelCover).toHaveBeenCalledExactlyOnceWith("contents/example/Book-book", local[0].metadata);
  expect(remote?.novel.name).toBe("Changed locally");
});

it("retries a cover upload after metadata publication succeeds but cover publication fails", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  let fail = true;
  vi.mocked(nativeFetch).mockImplementation((input, init) => {
    if (fail && String(input).endsWith("/cover") && init?.method === "PUT") return Promise.resolve(new Response(null, { status: 503 }));
    return request(input, init);
  });
  await expect(syncWorkMetadata("http://server", "device", true)).rejects.toThrow("503");
  fail = false;
  await syncWorkMetadata("http://server", "device", true);
  expect(remoteCover).toEqual(new Uint8Array([1, 2, 3]));
  expect(puts).toBe(2);
});

it("uploads changed cover bytes with an unchanged metadata document", async () => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  await syncWorkMetadata("http://server", "device", true);
  localCovers.set(directory, new Uint8Array([7, 8]));
  revisions.set(directory, 2);
  await syncWorkMetadata("http://server", "device", true);
  expect(remoteCover).toEqual(new Uint8Array([7, 8]));
});

it("retains a local change made while an upload is in flight for the next sync", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  let edit = true;
  vi.mocked(nativeFetch).mockImplementation(async (input, init) => {
    if (edit && String(input).endsWith("/cover") && init?.method === "PUT") {
      edit = false;
      local[0].metadata.novel.name = "Edited during upload";
      localCovers.set(local[0].directory, new Uint8Array([9]));
      revisions.set(local[0].directory, 2);
    }
    return request(input, init);
  });
  await syncWorkMetadata("http://server", "device", true);
  await syncWorkMetadata("http://server", "device", true);
  expect(remote?.novel.name).toBe("Edited during upload");
  expect(remoteCover).toEqual(new Uint8Array([9]));
  expect(puts).toBe(2);
});

it("reads authoritative files and covers on an explicit rescan", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  await syncWorkMetadata("http://server", "device", true);
  localCovers.set(local[0].directory, new Uint8Array([9]));
  vi.mocked(listStoredNovelMetadata).mockClear();
  await syncWorkMetadata("http://server", "device", true, undefined, true);
  expect(listStoredNovelMetadata).toHaveBeenCalledOnce();
  expect(remoteCover).toEqual(new Uint8Array([9]));
});

it("does not reread or upload a remotely installed work in the next unchanged sync", async () => {
  remote = metadata(); remoteCover = new Uint8Array([4, 5, 6]); sequence = 2;
  await syncWorkMetadata("http://server", "device", false);
  vi.mocked(readStoredNovelMetadata).mockClear();
  vi.mocked(readStoredNovelCover).mockClear();
  await syncWorkMetadata("http://server", "device", true);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelMetadata).not.toHaveBeenCalled();
  expect(readStoredNovelCover).not.toHaveBeenCalled();
  expect(puts).toBe(0);
});

it("retains a cover-only local edit immediately after remote installation", async () => {
  remote = metadata(); remoteCover = new Uint8Array([4]); sequence = 2;
  const install = vi.mocked(installStoredNovelMetadata).getMockImplementation()!;
  vi.mocked(installStoredNovelMetadata).mockImplementationOnce(async (...args) => {
    const stored = await install(...args);
    if (stored) {
      localCovers.set(stored.directory, new Uint8Array([9]));
      revisions.set(stored.directory, (revisions.get(stored.directory) ?? 0) + 1);
    }
    return stored;
  });
  await syncWorkMetadata("http://server", "device", false);
  await syncWorkMetadata("http://server", "device", true);
  expect(localCovers.get(local[0].directory)).toEqual(new Uint8Array([9]));
  expect(remoteCover).toEqual(new Uint8Array([9]));
  expect(puts).toBe(1);
});

it("rejects a changed server selection outside the work installation transaction", async () => {
  remote = metadata(); sequence = 1;
  let changed = false;
  let transactionFailed = false;
  const install = vi.mocked(installStoredNovelMetadata).getMockImplementation()!;
  vi.mocked(installStoredNovelMetadata).mockImplementation(async (...args) => {
    changed = true;
    try { return await install(...args); }
    catch (error) { transactionFailed = true; throw error; }
  });
  await expect(syncWorkMetadata("http://server", "device", true, () => {
    if (changed) throw new Error("Content server changed");
  })).rejects.toThrow("Content server changed");
  expect(transactionFailed).toBe(false);
  expect(local).toEqual([]);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
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

it("rejects inferred work identities instead of merging folder-name aliases", async () => {
  remote = { ...metadata(), identity: { pluginId: "example", novelPath: "norea-folder:Book-book" } };
  sequence = 1;
  await expect(syncWorkMetadata("http://server", "device", false)).rejects.toThrow();
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
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

it("uses the local file index and checkpoints a work page instead of every installed work", async () => {
  const entries = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const value = metadata(`Book ${index}`); value.identity.novelPath = `/book-${index}`;
    return { id: await contentWorkId(value.identity), sequence: index + 1, metadata: value, hasCover: false };
  }));
  vi.mocked(nativeFetch).mockResolvedValue(Response.json({ items: entries, cursor: 100, hasMore: false }));
  await syncWorkMetadata("http://server", "device", false);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(installStoredNovelMetadata).toHaveBeenCalledTimes(100);
  expect(writeContentSyncCache).toHaveBeenCalledTimes(1);
  const saved = JSON.parse([...memory.values()][0]);
  expect(Object.keys(saved).sort()).toEqual(["cursor", "fileVersions", "fingerprints"]);
  expect(Object.keys(saved.fingerprints)).toHaveLength(100);
});

it.each([false, true])("installs successive metadata and cover revisions of the same work (separate pages: %s)", async (separatePages) => {
  const first = metadata();
  const latest = metadata("Latest revision");
  const id = await contentWorkId(first.identity);
  const entries = [
    { id, sequence: 1, metadata: first, hasCover: false },
    { id, sequence: 2, metadata: first, hasCover: true },
    { id, sequence: 3, metadata: latest, hasCover: true },
  ];
  const cover = new Uint8Array([8, 9]);
  vi.mocked(nativeFetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/cover")) return new Response(cover);
    const after = Number(url.searchParams.get("after"));
    const items = entries.filter(entry => entry.sequence > after).slice(0, separatePages ? 1 : 3);
    const cursor = items.at(-1)?.sequence ?? after;
    return Response.json({ items, cursor, hasMore: cursor < 3 });
  });
  await syncWorkMetadata("http://server", "device", false);
  expect(local).toHaveLength(1);
  expect(local[0].metadata).toEqual(latest);
  expect(localCovers.get(local[0].directory)).toEqual(cover);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(JSON.parse([...memory.values()][0]).cursor).toBe(3);
  await syncWorkMetadata("http://server", "device", true);
  expect(vi.mocked(nativeFetch).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});
