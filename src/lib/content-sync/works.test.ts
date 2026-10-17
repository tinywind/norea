import { beforeEach, expect, it, vi } from "vitest";
import type { NovelMetadataV1 } from "../work-metadata";

vi.mock("../work-metadata", async original => ({
  ...await original<typeof import("../work-metadata")>(),
  listStoredNovelMetadata: vi.fn(), readStoredNovelMetadata: vi.fn(), readStoredNovelCover: vi.fn(),
  installStoredNovelMetadata: vi.fn(),
}));
vi.mock("../../db/queries/content-sync", () => ({ readContentSyncCache: vi.fn(), writeContentSyncCache: vi.fn() }));
vi.mock("../../db/work-metadata", async original => ({ ...await original<typeof import("../../db/work-metadata")>(), readWorkMetadataSyncFile: vi.fn(), readWorkMetadataSyncFiles: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { installStoredNovelMetadata, listStoredNovelMetadata, readStoredNovelMetadata, readStoredNovelCover } from "../work-metadata";
import { readContentSyncCache, writeContentSyncCache } from "../../db/queries/content-sync";
import { readWorkMetadataSyncFile, readWorkMetadataSyncFiles, storedNovelMetadataFingerprint } from "../../db/work-metadata";
import { syncWorkMetadata, contentWorkId, canPullWorkMetadata, recordInstalledWorkMetadata, recordDeletedWorkMetadata, runWorkMetadataSyncOperation, workMetadataFingerprint } from "./works";

const metadata = (name = "Book"): NovelMetadataV1 => ({
  schemaVersion: 1, identity: { pluginId: "example", novelPath: "/book" },
  novel: { name, author: "Author", artist: null, summary: "Summary", status: "Ongoing", rating: 4.5, genres: "Fantasy", isLocal: false },
  cover: { fileName: "cover.png", contentType: "image/png" },
  chapters: {},
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
  vi.mocked(readContentSyncCache).mockImplementation(async key => memory.get(key) ?? null);
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
  vi.mocked(readWorkMetadataSyncFile).mockImplementation(async identity => {
    const entry = local.find(entry => entry.metadata.identity.pluginId === identity.pluginId && entry.metadata.identity.novelPath === identity.novelPath);
    return entry ? { pluginId: identity.pluginId, path: identity.novelPath, directory: entry.directory,
      fingerprint: await storedNovelMetadataFingerprint(entry.metadata), revision: revisions.get(entry.directory) ?? 1 } : null;
  });
  vi.mocked(readStoredNovelMetadata).mockImplementation(async directory => structuredClone(local.find(entry => entry.directory === directory) ?? null));
  vi.mocked(readStoredNovelCover).mockImplementation(async directory => localCovers.has(directory) ? localCovers.get(directory)! : new Uint8Array([1, 2, 3]));
  vi.mocked(installStoredNovelMetadata).mockImplementation(async (value, cover, beforeInstall) => {
    const current = local.find(entry => entry.metadata.identity.pluginId === value.identity.pluginId && entry.metadata.identity.novelPath === value.identity.novelPath);
    if (await beforeInstall?.(current ?? null) === false) return null;
    const installed = { directory: current?.directory ?? `contents/example/${value.novel.name}-book`, metadata: structuredClone(value) };
    const coverBytes = cover ?? (current ? await readStoredNovelCover(current.directory, current.metadata) : null);
    if (!cover) installed.metadata.cover = current?.metadata.cover ?? null;
    revisions.set(installed.directory, (revisions.get(installed.directory) ?? (current ? 1 : 0)) + 1);
    local = [...local.filter(entry => entry !== current), installed];
    localCovers.set(installed.directory, coverBytes);
    return { ...installed, syncFile: (await readWorkMetadataSyncFile(value.identity))!, coverBytes };
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
  const chapters = { "1": "Opening", "2": "Not downloaded", "1000": "Latest chapter" };
  local = [{ directory: "contents/example/Book-book", metadata: { ...metadata(), chapters } }];
  await syncWorkMetadata("http://server", "device", true);
  expect(remote?.chapters).toEqual(chapters);
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
  local = []; memory.clear(); revisions.clear(); localCovers.clear();
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0]?.metadata.chapters).toEqual(chapters);
});

it("retains populated local fields during a sparse server catalog update", async () => {
  const saved = metadata();
  saved.novel.artist = "Saved artist";
  saved.chapters = { "1": "Opening" };
  local = [{ directory: "contents/example/Book-book", metadata: saved }];
  await syncWorkMetadata("http://server", "device", true);
  remote = {
    ...metadata("New title"),
    novel: { ...metadata("New title").novel, author: "", artist: " \t ", summary: null, status: "", genres: null, rating: null },
    chapters: { "2": "Second" },
  };
  sequence++;
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata).toEqual({
    ...saved, novel: { ...saved.novel, name: "New title" },
    chapters: { "1": "Opening", "2": "Second" },
  });
  expect(saved.novel.name).toBe("Book");
  expect(remote.novel.summary).toBeNull();

  remote = { ...remote, novel: { ...remote.novel, summary: "Updated summary", rating: 0 } };
  sequence++;
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata.novel).toEqual({ ...saved.novel, name: "New title", summary: "Updated summary", rating: 0 });
});

it("keeps local metadata after server work deletion and restores only on explicit rescan", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  const original = vi.mocked(nativeFetch).getMockImplementation()!;
  const id = await contentWorkId(metadata().identity);
  vi.mocked(nativeFetch).mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/works")) return Response.json({ items: Number(url.searchParams.get("after")) < 1 ? [{ id, sequence: 1, deleted: true, metadata: metadata(), hasCover: false }] : [], cursor: 1, hasMore: false });
    return original(input, init);
  });
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(0);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(local).toHaveLength(1);
  await syncWorkMetadata("http://server", "device", true, undefined, true);
  expect(puts).toBe(1);
  expect(nativeFetch).toHaveBeenCalledWith(`http://server/api/v1/works/${id}?restore=true`, expect.objectContaining({ method: "PUT" }));
});

it("records an app-initiated work deletion without advancing past unseen changes or touching local files", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  const originalLocal = structuredClone(local);
  const id = await contentWorkId(metadata().identity);
  const key = "norea-content-works:http://server";
  const cursor = JSON.parse(memory.get(key)!).cursor;
  await recordDeletedWorkMetadata("http://server", { id, sequence: sequence + 10, metadata: metadata(), hasCover: false, deleted: true });
  const saved = JSON.parse(memory.get(key)!);
  expect(saved.cursor).toBe(cursor);
  expect(saved.deleted[id]).toBe(true);
  expect(saved.fingerprints[id]).toBeUndefined();
  expect(saved.fileVersions[JSON.stringify(["example", "/book"])]).toBeUndefined();
  remote = undefined;
  expect(await syncWorkMetadata("http://server", "device", true)).toEqual(new Set([id]));
  expect(puts).toBe(1);
  expect(local).toEqual(originalLocal);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
});

it("rejects invalid work deletion responses without changing the sync cache", async () => {
  const id = await contentWorkId(metadata().identity);
  await expect(recordDeletedWorkMetadata("http://server", { id, sequence: 1, metadata: metadata(), hasCover: false, deleted: false })).rejects.toThrow("deletion");
  await expect(recordDeletedWorkMetadata("http://server", { id: "other-work", sequence: 1, metadata: metadata(), hasCover: false, deleted: true })).rejects.toThrow("deletion");
  expect(writeContentSyncCache).not.toHaveBeenCalled();
});

it("advances past an in-flight work record whose cover and work were deleted", async () => {
  const id = await contentWorkId(metadata().identity);
  vi.mocked(nativeFetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/works")) return Response.json({ items: [{ id, sequence: 1, metadata: metadata(), hasCover: true }], cursor: 1, hasMore: false });
    return new Response(null, { status: 404 });
  });
  const deleted = await syncWorkMetadata("http://server", "device", true);
  expect(deleted.has(id)).toBe(true);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(JSON.parse([...memory.values()][0])).toMatchObject({ cursor: 1, deleted: { [id]: true } });
});

it("does not grant restore permission to active works during a rescan", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true, undefined, true);
  const writes = vi.mocked(nativeFetch).mock.calls.filter(([, init]) => init?.method === "PUT");
  expect(writes.length).toBeGreaterThan(0);
  expect(writes.every(([url]) => !String(url).includes("restore=true"))).toBe(true);
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

it("uploads a successful source refresh even when its metadata and cover are unchanged", async () => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  revisions.set(directory, 2);
  const fingerprint = await workMetadataFingerprint(local[0].metadata, new Uint8Array([1, 2, 3]));
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(false);
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(2);
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(true);
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(2);
});

it.each(["metadata", "cover"])("keeps an unchanged refresh pending after its %s upload fails", async failedPart => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  revisions.set(directory, 2);
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  vi.mocked(nativeFetch).mockImplementation((input, init) => {
    if (init?.method === "PUT" && String(input).endsWith("/cover") === (failedPart === "cover")) return Promise.resolve(new Response(null, { status: 503 }));
    return request(input, init);
  });
  await expect(syncWorkMetadata("http://server", "device", true)).rejects.toThrow("503");
  const fingerprint = await workMetadataFingerprint(local[0].metadata, new Uint8Array([1, 2, 3]));
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(false);
  vi.mocked(nativeFetch).mockImplementation(request);
  await syncWorkMetadata("http://server", "device", true);
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(true);
  expect(puts).toBe(failedPart === "cover" ? 3 : 2);
});

it("requires another upload for a refresh completed during an unchanged metadata upload", async () => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  revisions.set(directory, 2);
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  let refresh = true;
  vi.mocked(nativeFetch).mockImplementation((input, init) => {
    if (refresh && String(input).endsWith("/cover") && init?.method === "PUT") {
      refresh = false;
      revisions.set(directory, 3);
    }
    return request(input, init);
  });
  await syncWorkMetadata("http://server", "device", true);
  const fingerprint = await workMetadataFingerprint(local[0].metadata, new Uint8Array([1, 2, 3]));
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(false);
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(3);
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(true);
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

it("acknowledges the actual revision when a removed work retains its old sync journal", async () => {
  remote = metadata(); remoteCover = new Uint8Array([4]); sequence = 2;
  revisions.set("contents/example/Book-book", 40);
  await syncWorkMetadata("http://server", "device", false);
  expect(revisions.get("contents/example/Book-book")).toBe(41);
  await syncWorkMetadata("http://server", "device", true);
  expect(puts).toBe(0);
});

it("accepts a later server revision after an opened work records its remote installation", async () => {
  local = [{ directory: "contents/example/Book-book", metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  const opened = metadata("Opened server revision");
  await runWorkMetadataSyncOperation("http://server", async () => {
    const stored = await installStoredNovelMetadata(opened, new Uint8Array([1, 2, 3]));
    await recordInstalledWorkMetadata("http://server", stored!, true);
  });
  remote = metadata("Newest server revision"); sequence++;
  await syncWorkMetadata("http://server", "device", true);
  expect(local[0].metadata.novel.name).toBe("Newest server revision");
  expect(remote.novel.name).toBe("Newest server revision");
  expect(puts).toBe(1);
});

it("cancels a queued work lookup before the active metadata transfer finishes", async () => {
  let release!: () => void;
  const active = runWorkMetadataSyncOperation("http://server", () => new Promise<void>(resolve => { release = resolve; }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const controller = new AbortController();
  const lookup = vi.fn(async () => true);
  const waiting = runWorkMetadataSyncOperation("http://server/", lookup, controller.signal);
  controller.abort();
  try {
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(lookup).not.toHaveBeenCalled();
  } finally { release(); await active; }
  await runWorkMetadataSyncOperation("http://server", async () => undefined);
  expect(lookup).not.toHaveBeenCalled();
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

it("protects a refreshed local document until its newer metadata is uploaded", async () => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  local[0].metadata.novel.summary = "Refreshed source summary";
  revisions.set(directory, 2);
  const fingerprint = await workMetadataFingerprint(local[0].metadata, new Uint8Array([1, 2, 3]));
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(false);
  await syncWorkMetadata("http://server", "device", true);
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(remote?.novel.summary).toBe("Refreshed source summary");
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(local[0].metadata.identity), fingerprint)).toBe(true);
});

it("keeps an unchanged source refresh that completed during a remote cover download", async () => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  remote = metadata("Remote edit"); sequence++;
  const request = vi.mocked(nativeFetch).getMockImplementation()!;
  vi.mocked(nativeFetch).mockImplementation((input, init) => {
    if (String(input).endsWith("/cover") && init?.method === "GET") revisions.set(directory, 2);
    return request(input, init);
  });
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata.novel.name).toBe("Book");
  await syncWorkMetadata("http://server", "device", true);
  expect(remote?.novel.name).toBe("Book");
  expect(puts).toBe(2);
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
  expect(Object.keys(saved).sort()).toEqual(["cursor", "deleted", "fileVersions", "fingerprints"]);
  expect(Object.keys(saved.fingerprints)).toHaveLength(100);
});

it.each([false, true])("installs only the latest metadata and cover revision of each work (separate pages: %s)", async (separatePages) => {
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
  expect(installStoredNovelMetadata).toHaveBeenCalledOnce();
  expect(vi.mocked(nativeFetch).mock.calls.filter(([input]) => String(input).endsWith("/cover"))).toHaveLength(1);
  expect(listStoredNovelMetadata).not.toHaveBeenCalled();
  expect(JSON.parse([...memory.values()][0]).cursor).toBe(3);
  await syncWorkMetadata("http://server", "device", true);
  expect(vi.mocked(nativeFetch).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it.each([false, true])("does not replay an old missing-cover revision over an acknowledged upload (separate pages: %s)", async separatePages => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  const id = await contentWorkId(metadata().identity);
  const latest = metadata("Latest server title");
  const entries = [
    { id, sequence: 1, metadata: metadata("Obsolete title"), hasCover: false },
    { id, sequence: 2, metadata: metadata(), hasCover: true },
    { id, sequence: 3, metadata: latest, hasCover: true },
  ];
  vi.mocked(nativeFetch).mockClear().mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/cover")) return new Response(new Uint8Array([1, 2, 3]));
    const after = Number(url.searchParams.get("after"));
    const items = entries.filter(entry => entry.sequence > after).slice(0, separatePages ? 1 : entries.length);
    const cursor = items.at(-1)?.sequence ?? after;
    return Response.json({ items, cursor, hasMore: cursor < 3 });
  });
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata).toEqual(latest);
  expect(installStoredNovelMetadata).toHaveBeenCalledOnce();
  expect(vi.mocked(nativeFetch).mock.calls.filter(([input]) => String(input).endsWith("/cover"))).toHaveLength(1);
  expect(Object.keys(JSON.parse([...memory.values()][0]).fileVersions)).toHaveLength(1);
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(latest.identity),
    await workMetadataFingerprint(latest, new Uint8Array([1, 2, 3])))).toBe(true);
  await syncWorkMetadata("http://server", "device", true);
  expect(vi.mocked(nativeFetch).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
});

it("retains a source refresh completed while later history pages are loading", async () => {
  const directory = "contents/example/Book-book";
  local = [{ directory, metadata: metadata() }];
  await syncWorkMetadata("http://server", "device", true);
  const id = await contentWorkId(metadata().identity);
  vi.mocked(nativeFetch).mockClear().mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/cover")) return new Response(new Uint8Array([1, 2, 3]));
    const after = Number(url.searchParams.get("after"));
    if (after === 0) return Response.json({ items: [{ id, sequence: 1, metadata: metadata("Obsolete"), hasCover: false }], cursor: 1, hasMore: true });
    revisions.set(directory, 2);
    return Response.json({ items: [{ id, sequence: 2, metadata: metadata("Server title"), hasCover: true }], cursor: 2, hasMore: false });
  });
  await syncWorkMetadata("http://server", "device", false);
  expect(local[0].metadata.novel.name).toBe("Book");
  expect(await canPullWorkMetadata("http://server", await readWorkMetadataSyncFile(metadata().identity),
    await workMetadataFingerprint(metadata(), new Uint8Array([1, 2, 3])))).toBe(false);
  expect(JSON.parse([...memory.values()][0]).cursor).toBe(2);
});

it("keeps the previous cursor after an installation fails across gathered pages and retries unfinished works", async () => {
  const first = metadata();
  const second = metadata("Second"); second.identity.novelPath = "/second";
  const firstId = await contentWorkId(first.identity);
  const secondId = await contentWorkId(second.identity);
  const entries = [
    { id: firstId, sequence: 1, metadata: first, hasCover: true },
    { id: secondId, sequence: 2, metadata: second, hasCover: true },
  ];
  let failSecondCover = true;
  vi.mocked(nativeFetch).mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/cover")) {
      return failSecondCover && url.pathname.includes(secondId)
        ? new Response(null, { status: 503 }) : new Response(new Uint8Array([1, 2, 3]));
    }
    const after = Number(url.searchParams.get("after"));
    const items = entries.filter(entry => entry.sequence > after).slice(0, 1);
    const cursor = items.at(-1)?.sequence ?? after;
    return Response.json({ items, cursor, hasMore: cursor < 2 });
  });
  await expect(syncWorkMetadata("http://server", "device", false)).rejects.toThrow("503");
  expect(local).toHaveLength(1);
  const incomplete = JSON.parse([...memory.values()][0]);
  expect(incomplete.cursor).toBe(0);
  expect(incomplete.fingerprints[firstId]).toEqual(expect.any(String));
  expect(incomplete.fileVersions[JSON.stringify([first.identity.pluginId, first.identity.novelPath])]).toEqual(expect.any(String));

  failSecondCover = false;
  vi.mocked(installStoredNovelMetadata).mockClear();
  await syncWorkMetadata("http://server", "device", false);
  expect(local).toHaveLength(2);
  expect(installStoredNovelMetadata).toHaveBeenCalledExactlyOnceWith(second, new Uint8Array([1, 2, 3]), expect.any(Function));
  expect(JSON.parse([...memory.values()][0]).cursor).toBe(2);
});

it("does not install gathered history or advance the cursor after cancellation between pages", async () => {
  const id = await contentWorkId(metadata().identity);
  let cancelled = false;
  vi.mocked(nativeFetch).mockImplementation(async input => {
    const after = Number(new URL(String(input)).searchParams.get("after"));
    if (after === 0) return Response.json({ items: [{ id, sequence: 1, metadata: metadata("Obsolete"), hasCover: false }], cursor: 1, hasMore: true });
    cancelled = true;
    return Response.json({ items: [{ id, sequence: 2, metadata: metadata(), hasCover: true }], cursor: 2, hasMore: false });
  });
  await expect(syncWorkMetadata("http://server", "device", false, () => {
    if (cancelled) throw new Error("Content sync cancelled");
  })).rejects.toThrow("Content sync cancelled");
  expect(installStoredNovelMetadata).not.toHaveBeenCalled();
  expect(writeContentSyncCache).not.toHaveBeenCalled();
});
