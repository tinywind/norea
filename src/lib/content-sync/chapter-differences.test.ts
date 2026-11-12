import { beforeEach, expect, it, vi } from "vitest";
import type { ContentSyncChapter } from "../../db/queries/content-sync";
import type { ChapterPayloadSnapshot } from "../chapter-content/inventory";
import { applyChapterDifferences, inventorySignature, scanChapterDifferences } from "./chapter-differences";

const mocks = vi.hoisted(() => ({ rows: vi.fn(), inspect: vi.fn(), inventory: vi.fn(), catalog: vi.fn(),
  upload: vi.fn(), download: vi.fn(), request: vi.fn() }));
vi.mock("../../db/queries/content-sync", () => ({ listContentSyncWorkChapters: mocks.rows, listContentSyncChapters: mocks.rows, contentIdentity: (...parts: string[]) => JSON.stringify(parts) }));
vi.mock("../chapter-content/storage-platform", () => ({ inspectChapterPayloadInventory: mocks.inspect }));
vi.mock("./chapter-inventory", () => ({ fetchCleanupServerInventory: mocks.inventory }));
vi.mock("./chapters", () => ({ fetchServerChapters: mocks.catalog }));
vi.mock("./client", () => ({ contentServerRequest: mocks.request }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "token") }));
vi.mock("./native", () => ({ uploadContentChapter: mocks.upload,
  withContentChapterStage: async (input: { verifySource: () => Promise<void> }, run: (stage: string) => Promise<void>) => {
    await input.verifySource(); return run("stage");
  } }));
vi.mock("./sync", () => ({ downloadServerChapterFromServer: mocks.download, runContentSyncOperation: (run: () => unknown) => run() }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => ({ deviceName: "Device" }) } }));
vi.mock("../chapter-storage-resolution", () => ({ resolvedChapterStorageDir: () => "contents/source/work/1" }));
const novel = { id: 1, pluginId: "source", path: "/work" };
const source = { serverUrl: "https://server", workId: "work" };
const row: ContentSyncChapter = { chapterId: 1, novelId: 1, pluginId: "source", novelPath: "/work", sourceNovelId: "work",
  chapterPath: "/1", novelName: "Work", author: null, summary: null, isLocal: false, chapterName: "One", chapterNumber: "1",
  position: 1, page: "", contentType: "html", isDownloaded: true, mediaRepairNeeded: false, isDownloadQueued: false, contentBytes: 10, mediaBytes: 0 };
const local: ChapterPayloadSnapshot = { body: { sha256: "a".repeat(64), bytes: 10 }, expectedAssetKeys: [], storedAssets: [],
  fingerprint: "original", contentBytes: 10, mediaBytes: 0, payloadBytes: 10, mediaComplete: true };
const remote = { serverUrl: source.serverUrl, id: "package", revision: "revision", identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/1" },
  inventory: { ...local, body: { sha256: "b".repeat(64), bytes: 12 } } };
const difference = { chapter: row, local, remote };
beforeEach(() => {
  vi.resetAllMocks(); mocks.rows.mockResolvedValue([row]); mocks.inspect.mockResolvedValue(local);
  mocks.inventory.mockResolvedValue(remote); mocks.catalog.mockResolvedValue([{ chapterPath: "/1", chapterNumber: "1" }]);
  mocks.request.mockResolvedValue({ id: remote.id, revision: remote.revision, deleted: false, manifest: { identity: remote.identity } });
});
it("detects equal-size different bodies without uploading or downloading files", async () => {
  mocks.inventory.mockResolvedValue({ ...remote, inventory: { ...remote.inventory, body: { sha256: "b".repeat(64), bytes: 10 } } });
  const scan = await scanChapterDifferences(novel, source, new AbortController().signal);
  expect(scan.differences).toHaveLength(1); expect(scan.errors).toEqual([]);
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
});
it("does not mark absent local or server bodies as conflicting copies", async () => {
  mocks.inspect.mockResolvedValue({ ...local, body: null });
  expect((await scanChapterDifferences(novel, source, new AbortController().signal)).differences).toEqual([]);
  expect(mocks.inventory).not.toHaveBeenCalled();
});
it("continues a scan after a failed lookup and propagates cancellation", async () => {
  mocks.inventory.mockRejectedValue(new Error("Offline"));
  const scan = await scanChapterDifferences(novel, source, new AbortController().signal);
  expect(scan.errors).toHaveLength(1); expect(scan.checked).toBe(1);
  const controller = new AbortController(); controller.abort();
  await expect(scanChapterDifferences(novel, source, controller.signal)).rejects.toThrow();
});
it("skips every kept chapter even in a large plan", async () => {
  const result = await applyChapterDifferences(source, Array.from({ length: 237 }, () => ({ difference, action: "keep" })), vi.fn());
  expect(result).toEqual({ completed: [], errors: [] });
  expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.download).not.toHaveBeenCalled();
});
it("refuses a device copy changed after comparison", async () => {
  mocks.inspect.mockResolvedValue({ ...local, fingerprint: "edited" });
  const result = await applyChapterDifferences(source, [{ difference, action: "download" }], vi.fn());
  expect(result.errors).toHaveLength(1); expect(mocks.download).not.toHaveBeenCalled();
});
it("refuses a changed server revision", async () => {
  mocks.inventory.mockResolvedValue({ ...remote, revision: "changed" });
  const result = await applyChapterDifferences(source, [{ difference, action: "upload" }], vi.fn());
  expect(result.errors).toHaveLength(1); expect(mocks.upload).not.toHaveBeenCalled();
});
it("pins local replacement to the compared fingerprint and verifies the installed bytes", async () => {
  mocks.download.mockImplementation(async () => { mocks.inspect.mockResolvedValue({ ...local, ...remote.inventory }); });
  const result = await applyChapterDifferences(source, [{ difference, action: "download" }], vi.fn());
  expect(mocks.download).toHaveBeenCalledWith(expect.anything(), source.serverUrl, expect.objectContaining({ expectedLocalFingerprint: local.fingerprint }));
  expect(result.completed).toEqual([1]);
});
it("uploads only the explicitly requested copy and verifies what the server retained", async () => {
  mocks.upload.mockImplementation(async () => { mocks.inventory.mockResolvedValue({ ...remote, inventory: local }); });
  const result = await applyChapterDifferences(source, [{ difference, action: "upload" }], vi.fn());
  expect(mocks.upload).toHaveBeenCalledWith(expect.objectContaining({ conflictPolicy: "replace-server", chapterId: 1 }));
  expect(result.completed).toEqual([1]);
});
it("compares assets independently of ordering and includes differing media bytes", () => {
  const a = { ...local, storedAssets: [{ key: "media/a", sha256: "a".repeat(64), bytes: 1 }, { key: "media/b", sha256: "b".repeat(64), bytes: 2 }] };
  expect(inventorySignature(a)).toBe(inventorySignature({ ...a, storedAssets: [...a.storedAssets].reverse() }));
  expect(inventorySignature(a)).not.toBe(inventorySignature({ ...a, storedAssets: [{ ...a.storedAssets[0]!, bytes: 3 }, a.storedAssets[1]!] }));
});

it("rechecks the device immediately before capturing the upload snapshot", async () => {
  mocks.inspect.mockResolvedValueOnce(local).mockResolvedValue({ ...local, fingerprint: "edited-before-snapshot" });
  const result = await applyChapterDifferences(source, [{ difference, action: "upload" }], vi.fn());
  expect(result.errors).toHaveLength(1); expect(mocks.upload).not.toHaveBeenCalled();
});
