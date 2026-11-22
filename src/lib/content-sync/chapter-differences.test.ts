import { beforeEach, expect, it, vi } from "vitest";
import type { ContentSyncChapter } from "../../db/queries/content-sync";
import type { ChapterPayloadSnapshot } from "../chapter-content/inventory";
import { applyChapterDifferences, inventoryHash, inventorySignature, scanChapterDifferences, type ChapterDifference } from "./chapter-differences";

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  inspect: vi.fn(),
  resolveDigests: vi.fn(),
  storageDir: vi.fn(),
  inventory: vi.fn(),
  catalog: vi.fn(),
  digests: vi.fn(),
  capabilities: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../../db/queries/content-sync", () => ({
  listContentSyncWorkChapters: mocks.rows,
  listContentSyncChapters: mocks.rows,
  contentIdentity: (...parts: string[]) => JSON.stringify(parts),
}));
vi.mock("../chapter-content/storage-platform", () => ({
  inspectChapterPayloadInventory: mocks.inspect,
  resolveChapterPayloadDigests: mocks.resolveDigests,
  chapterPayloadStorageDir: mocks.storageDir,
}));
vi.mock("./chapter-inventory", () => ({ fetchCleanupServerInventory: mocks.inventory }));
vi.mock("./chapters", () => ({
  fetchServerChapters: mocks.catalog,
  fetchServerChapterDigests: mocks.digests,
}));
vi.mock("./client", () => ({ contentServerRequest: mocks.request }));
vi.mock("./device", () => ({
  registerContentDevice: vi.fn(async () => "token"),
  getContentServerCapabilities: mocks.capabilities,
}));
vi.mock("./native", () => ({
  uploadContentChapter: mocks.upload,
  withContentChapterStage: async (input: { verifySource: () => Promise<void> }, run: (stage: string) => Promise<void>) => {
    await input.verifySource();
    return run("stage");
  },
}));
vi.mock("./sync", () => ({
  downloadServerChapterFromServer: mocks.download,
  runContentSyncOperation: (run: () => unknown) => run(),
}));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => ({ deviceName: "Device" }) } }));
vi.mock("../chapter-storage-resolution", () => ({ resolvedChapterStorageDir: () => "contents/source/work/1" }));

const novel = { id: 1, pluginId: "source", path: "/work" };
const source = { serverUrl: "https://server", workId: "work" };
const row: ContentSyncChapter = {
  chapterId: 1, novelId: 1, pluginId: "source", novelPath: "/work", sourceNovelId: "work",
  chapterPath: "/1", novelName: "Work", author: null, summary: null, isLocal: false, chapterName: "One", chapterNumber: "1",
  position: 1, page: "", contentType: "html", isDownloaded: true, mediaRepairNeeded: false, isDownloadQueued: false, contentBytes: 10, mediaBytes: 0,
};
const local: ChapterPayloadSnapshot = {
  body: { sha256: "a".repeat(64), bytes: 10 }, expectedAssetKeys: [], storedAssets: [],
  fingerprint: "original", contentBytes: 10, mediaBytes: 0, payloadBytes: 10, mediaComplete: true,
};
const remote = {
  serverUrl: source.serverUrl, id: "package", revision: "revision",
  identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/1" },
  inventory: { ...local, body: { sha256: "b".repeat(64), bytes: 12 } },
};

async function makeDifference(withFingerprint = true): Promise<ChapterDifference> {
  return {
    chapter: row,
    local: {
      bodyBytes: local.body!.bytes,
      bodySha256: local.body!.sha256,
      payloadHash: await inventoryHash(local),
      ...(withFingerprint ? { fingerprint: local.fingerprint } : {}),
    },
    remote: {
      serverUrl: remote.serverUrl,
      id: remote.id,
      revision: remote.revision,
      chapterPath: remote.identity.chapterPath,
      bodyBytes: remote.inventory.body!.bytes,
      bodySha256: remote.inventory.body!.sha256,
      payloadHash: await inventoryHash(remote.inventory),
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rows.mockResolvedValue([row]);
  mocks.inspect.mockResolvedValue(local);
  mocks.storageDir.mockReturnValue("contents/source/work/1");
  mocks.inventory.mockResolvedValue(remote);
  mocks.catalog.mockResolvedValue([{ chapterPath: "/1", chapterNumber: "1" }]);
  mocks.capabilities.mockResolvedValue({
    apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true, chapterDigestVersion: 1,
  });
  mocks.request.mockResolvedValue({ id: remote.id, revision: remote.revision, deleted: false, manifest: { identity: remote.identity } });
});

it("compares precomputed server and local payload hashes in bulk without per-chapter inventory HTTP calls", async () => {
  const localHash = await inventoryHash(local);
  const remoteHash = await inventoryHash({ ...local, body: { sha256: "b".repeat(64), bytes: 10 } });
  mocks.digests.mockResolvedValue([{
    id: remote.id, revision: remote.revision, chapterPath: "/1", chapterNumber: "1", position: 1, complete: true,
    payloadHash: remoteHash, bodySha256: "b".repeat(64), bodyBytes: 10,
  }]);
  mocks.resolveDigests.mockResolvedValue([{
    chapterId: 1, bodySha256: "a".repeat(64), bodyBytes: 10, payloadHash: localHash,
  }]);

  const scan = await scanChapterDifferences(novel, source, new AbortController().signal);
  expect(scan.differences).toHaveLength(1);
  expect(scan.differences[0]!.local.payloadHash).toBe(localHash);
  expect(scan.differences[0]!.remote.payloadHash).toBe(remoteHash);
  expect(scan.errors).toEqual([]);
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it("skips equal payload hashes and absent local or server bodies on bulk digest scans", async () => {
  const sharedHash = await inventoryHash(local);
  const row2 = { ...row, chapterId: 2, chapterPath: "/2", chapterNumber: "2", position: 2 };
  mocks.rows.mockResolvedValue([row, row2]);
  mocks.digests.mockResolvedValue([
    { id: "p1", revision: "r1", chapterPath: "/1", chapterNumber: "1", position: 1, complete: true, payloadHash: sharedHash, bodySha256: "a".repeat(64), bodyBytes: 10 },
    { id: "p2", revision: "r2", chapterPath: "/2", chapterNumber: "2", position: 2, complete: true, payloadHash: "f".repeat(64), bodySha256: "f".repeat(64), bodyBytes: 12 },
  ]);
  mocks.resolveDigests.mockResolvedValue([
    { chapterId: 1, bodySha256: "a".repeat(64), bodyBytes: 10, payloadHash: sharedHash },
    { chapterId: 2, bodySha256: null, bodyBytes: null, payloadHash: null },
  ]);

  const scan = await scanChapterDifferences(novel, source, new AbortController().signal);
  expect(scan.differences).toEqual([]);
  expect(scan.checked).toBe(2);
  expect(scan.errors).toEqual([]);
});

it("falls back to per-chapter inventory when the server does not advertise chapterDigestVersion", async () => {
  mocks.capabilities.mockResolvedValue({
    apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
  });
  mocks.inventory.mockResolvedValue({ ...remote, inventory: { ...remote.inventory, body: { sha256: "b".repeat(64), bytes: 10 } } });
  const scan = await scanChapterDifferences(novel, source, new AbortController().signal);
  expect(scan.differences).toHaveLength(1);
  expect(scan.errors).toEqual([]);
  expect(mocks.digests).not.toHaveBeenCalled();
  expect(mocks.inventory).toHaveBeenCalledTimes(1);
});

it("does not mark absent local bodies as conflicting copies in legacy mode", async () => {
  mocks.capabilities.mockResolvedValue({
    apiVersion: 1, packageVersion: 1, authentication: "device-key", personalStateSync: true,
  });
  mocks.inspect.mockResolvedValue({ ...local, body: null });
  expect((await scanChapterDifferences(novel, source, new AbortController().signal)).differences).toEqual([]);
  expect(mocks.inventory).not.toHaveBeenCalled();
});

it("continues a scan after per-chapter errors and propagates cancellation", async () => {
  mocks.digests.mockResolvedValue([{
    id: remote.id, revision: remote.revision, chapterPath: "/1", chapterNumber: "1", position: 1, complete: true,
    payloadHash: null, bodySha256: null, bodyBytes: null, error: "Chapter storage inventory is unavailable",
  }]);
  const scan = await scanChapterDifferences(novel, source, new AbortController().signal);
  expect(scan.errors).toHaveLength(1);
  expect(scan.checked).toBe(1);

  const controller = new AbortController();
  controller.abort();
  await expect(scanChapterDifferences(novel, source, controller.signal)).rejects.toThrow();
});

it("skips every kept chapter even in a large plan", async () => {
  const difference = await makeDifference();
  const result = await applyChapterDifferences(source, Array.from({ length: 237 }, () => ({ difference, action: "keep" })), vi.fn());
  expect(result).toEqual({ completed: [], errors: [] });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});

it("refuses a device copy changed after comparison", async () => {
  const difference = await makeDifference(false);
  mocks.inspect.mockResolvedValue({ ...local, body: { sha256: "e".repeat(64), bytes: 11 } });
  const result = await applyChapterDifferences(source, [{ difference, action: "download" }], vi.fn());
  expect(result.errors).toHaveLength(1);
  expect(mocks.download).not.toHaveBeenCalled();
});

it("refuses a changed server revision", async () => {
  const difference = await makeDifference();
  mocks.inventory.mockResolvedValue({ ...remote, revision: "changed" });
  const result = await applyChapterDifferences(source, [{ difference, action: "upload" }], vi.fn());
  expect(result.errors).toHaveLength(1);
  expect(mocks.upload).not.toHaveBeenCalled();
});

it("pins local replacement to the verified live fingerprint and verifies the installed bytes", async () => {
  const difference = await makeDifference(false);
  mocks.download.mockImplementation(async () => {
    mocks.inspect.mockResolvedValue({ ...local, ...remote.inventory });
  });
  const result = await applyChapterDifferences(source, [{ difference, action: "download" }], vi.fn());
  expect(mocks.download).toHaveBeenCalledWith(expect.anything(), source.serverUrl, expect.objectContaining({ expectedLocalFingerprint: local.fingerprint }));
  expect(result.completed).toEqual([1]);
});

it("uploads only the explicitly requested copy and verifies what the server retained", async () => {
  const difference = await makeDifference(false);
  mocks.upload.mockImplementation(async () => {
    mocks.inventory.mockResolvedValue({ ...remote, inventory: local });
  });
  const result = await applyChapterDifferences(source, [{ difference, action: "upload" }], vi.fn());
  expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ conflictPolicy: "replace-server", chapterId: 1 }));
  expect(result.completed).toEqual([1]);
});

it("compares assets in codepoint order independently of input ordering and includes differing media bytes", async () => {
  const a = {
    ...local,
    expectedAssetKeys: ["media/a.png", "media/Z.png", "media/B.png"],
    storedAssets: [
      { key: "media/a.png", sha256: "a".repeat(64), bytes: 1 },
      { key: "media/Z.png", sha256: "b".repeat(64), bytes: 2 },
      { key: "media/B.png", sha256: "c".repeat(64), bytes: 3 },
    ],
  };
  expect(inventorySignature(a)).toBe(inventorySignature({
    ...a,
    expectedAssetKeys: [...a.expectedAssetKeys].reverse(),
    storedAssets: [...a.storedAssets].reverse(),
  }));
  // Codepoint order places uppercase before lowercase: media/B.png < media/Z.png < media/a.png.
  const parsed = JSON.parse(inventorySignature(a)) as [unknown, string[], [string, string, number][]];
  expect(parsed[1]).toEqual(["media/B.png", "media/Z.png", "media/a.png"]);
  expect(parsed[2].map(item => item[0])).toEqual(["media/B.png", "media/Z.png", "media/a.png"]);
  expect(await inventoryHash(a)).not.toBe(await inventoryHash({
    ...a,
    storedAssets: [{ ...a.storedAssets[0]!, bytes: 9 }, ...a.storedAssets.slice(1)],
  }));
});

it("rechecks the device immediately before capturing the upload snapshot", async () => {
  const difference = await makeDifference();
  mocks.inspect.mockResolvedValueOnce(local).mockResolvedValue({ ...local, fingerprint: "edited-before-snapshot" });
  const result = await applyChapterDifferences(source, [{ difference, action: "upload" }], vi.fn());
  expect(result.errors).toHaveLength(1);
  expect(mocks.upload).not.toHaveBeenCalled();
});
