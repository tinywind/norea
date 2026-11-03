import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterCleanupCandidate } from "../../db/queries/chapter-cleanup";
import type { ChapterCleanupFilters } from "../chapter-cleanup";
import { approveChapterCleanupTargets, chapterCleanupProtectedCounts, previewChapterCleanup } from "../chapter-cleanup";
import { ContentServerError } from "../content-sync/client";
import { runChapterCleanup } from "./chapter-cleanup";

const mocks = vi.hoisted(() => ({
  candidates: vi.fn(), reconcile: vi.fn(), inspect: vi.fn(), remove: vi.fn(), fetch: vi.fn(),
  cancel: vi.fn(), discard: vi.fn(), queueWait: vi.fn(), writesWait: vi.fn(),
  state: { serverUrl: "https://server" },
}));
vi.mock("../../db/queries/chapter-cleanup", () => ({ listChapterCleanupCandidates: mocks.candidates, reconcileCleanedChapter: mocks.reconcile }));
vi.mock("../../store/content-sync", () => ({ useContentSyncStore: { getState: () => mocks.state } }));
vi.mock("../chapter-content/storage-platform", () => ({ inspectChapterPayloadInventory: mocks.inspect, deleteChapterPayload: mocks.remove }));
vi.mock("../content-sync/chapter-inventory", () => ({ cleanupServerUrl: (_candidate: unknown, fallback: string) => fallback, fetchCleanupServerInventory: mocks.fetch }));
vi.mock("../chapter-download-writes", () => ({ waitForChapterDownloadWrites: mocks.writesWait, withChapterDownloadDeletion: (_ids: number[], fn: () => unknown) => fn() }));
vi.mock("../content-sync/storage-operation", () => ({ runWorkContentStorageOperation: (_plugin: string, _path: string, fn: () => unknown) => fn() }));
vi.mock("./chapter-download", () => ({ cancelChapterDownloadTasks: mocks.cancel, discardQueuedChapterDownloads: mocks.discard, waitForChapterDownloadQueueMutations: mocks.queueWait }));
vi.mock("../tauri-runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("./scheduler", () => ({ taskScheduler: {} }));
const candidate = {
  identity: { novel: { id: 1, pluginId: "source", sourceNovelId: "work", path: "/work", name: "Work" }, chapter: { id: 3, name: "Chapter", position: 2, chapterNumber: "2", contentType: "html" } },
  novelPath: "/work", chapterPath: "/chapter", novelName: "Work", chapterName: "Chapter", serverSource: null, storageAmbiguous: false, unread: false,
} as ChapterCleanupCandidate;
const body = { sha256: "a".repeat(64), bytes: 3 };
const expectedAssetKeys = Array.from({ length: 10 }, (_, i) => `media/${i}`);
const asset = (key: string) => ({ key, sha256: "b".repeat(64), bytes: 4 });
const snapshot = { fingerprint: "fingerprint", payloadBytes: 35, contentBytes: 3, mediaBytes: 32, mediaComplete: false, body, expectedAssetKeys, storedAssets: expectedAssetKeys.slice(0, 8).map(asset) };
const empty = { ...snapshot, fingerprint: "empty", payloadBytes: 0, contentBytes: 0, mediaBytes: 0, body: null, storedAssets: [] };
const server = { serverUrl: "https://server", id: "package", revision: "revision", identity: { pluginId: "source", novelId: "work", novelPath: "/work", chapterPath: "/chapter" }, inventory: { body, expectedAssetKeys, storedAssets: expectedAssetKeys.slice(2).map(asset) } };
const filters = (mode: ChapterCleanupFilters["server"]): ChapterCleanupFilters => ({ server: mode, reading: "read", categories: { mode: "selected", ids: [10] } });

beforeEach(() => {
  vi.clearAllMocks(); mocks.state.serverUrl = "https://server";
  mocks.candidates.mockImplementation(async (_filter, options) => options.chapterId ? [candidate] : options.afterId ? [] : [candidate]);
  mocks.inspect.mockResolvedValue(snapshot); mocks.fetch.mockResolvedValue(server); mocks.reconcile.mockResolvedValue(1);
  mocks.remove.mockResolvedValue({ snapshot: empty, errors: [] });
  mocks.cancel.mockResolvedValue(undefined); mocks.queueWait.mockResolvedValue(undefined); mocks.writesWait.mockResolvedValue(undefined);
});

describe("cleanup preview", () => {
  it("skips local server provenance when the stored payload changed", async () => {
    mocks.candidates.mockImplementation(async (_selection, options) => options.afterId ? [] : [{ ...candidate, localServerFingerprint: "old" }]);
    expect(await previewChapterCleanup(filters("any"))).toMatchObject({ targets: [], skipped: { changed: 1 } });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("uses no server requests in any mode and freezes the selected filters and target list", async () => {
    const input = filters("any");
    const result = await previewChapterCleanup(input);
    if (input.categories.mode === "selected") (input.categories.ids as number[]).push(11);
    expect(result.filters.categories).toEqual({ mode: "selected", ids: [10] });
    expect(Object.isFrozen(result.targets)).toBe(true);
    expect(result).toMatchObject({ checked: 1, workCount: 1, payloadBytes: 35 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("pins candidate identity and storage evidence against later mutation", async () => {
    const mutableCandidate = structuredClone(candidate);
    const mutableSnapshot = structuredClone(snapshot);
    mocks.candidates.mockImplementation(async (_filter, options) => options.afterId ? [] : [mutableCandidate]);
    mocks.inspect.mockResolvedValue(mutableSnapshot);
    const preview = await previewChapterCleanup(filters("any"));
    mutableCandidate.identity.chapter.id = 999;
    mutableSnapshot.fingerprint = "changed";
    expect(preview.targets[0]?.candidate.identity.chapter.id).toBe(3);
    expect(preview.targets[0]?.snapshot.fingerprint).toBe("fingerprint");
  });
  it("accepts equal 8/10 coverage but rejects containment when missing assets differ", async () => {
    expect((await previewChapterCleanup(filters("server-coverage"))).targets).toHaveLength(1);
    expect(await previewChapterCleanup(filters("server-contains-local"))).toMatchObject({ targets: [], skipped: { "not-contained": 1 } });
  });
  it("skips unknown server state rather than treating it as any", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));
    expect(await previewChapterCleanup(filters("server-present"))).toMatchObject({ targets: [], skipped: { "server-error": 1 } });
  });
  it.each([[404, "server-missing"], [409, "server-conflict"], [401, "server-auth"]] as const)("keeps server status %i distinct", async (status, reason) => {
    mocks.fetch.mockRejectedValue(new ContentServerError(status));
    expect((await previewChapterCleanup(filters("server-present"))).skipped).toEqual({ [reason]: 1 });
  });
  it("rejects a server setting changed during preview", async () => {
    mocks.fetch.mockImplementation(async () => { mocks.state.serverUrl = "https://other"; return server; });
    await expect(previewChapterCleanup(filters("server-present"))).rejects.toThrow("settings changed");
  });
});

describe("cleanup ambiguous storage", () => {
  it("skips a shared directory before inspecting payloads", async () => {
    mocks.candidates.mockImplementation(async (_selection, options) => options.afterId ? [] : [{ ...candidate, storageAmbiguous: true }]);
    expect(await previewChapterCleanup(filters("any"))).toMatchObject({ targets: [], skipped: { "ambiguous-storage": 1 } });
    expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it("skips a directory that becomes shared immediately before deletion", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    let calls = 0;
    mocks.candidates.mockImplementation(async () => [{ ...candidate, storageAmbiguous: ++calls === 3 }]);
    expect(await runChapterCleanup(preview)).toMatchObject({ deleted: 0, skipped: 1, results: [{ reason: "ambiguous-storage" }] });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("cleanup approval", () => {
  it("leaves unread and goal-kept chapters out until the user includes each kind", async () => {
    const other = { ...candidate, identity: { ...candidate.identity, chapter: { ...candidate.identity.chapter, id: 4 } }, unread: true };
    const kept = { ...candidate, identity: { ...candidate.identity, novel: { ...candidate.identity.novel, id: 2 }, chapter: { ...candidate.identity.chapter, id: 5 } } };
    mocks.candidates.mockImplementation(async (_filter, options) => options.afterId ? [] : [candidate, other, kept]);
    const preview = await previewChapterCleanup({ ...filters("any"), reading: "all" });
    const goalKept = new Set([5]);
    expect(chapterCleanupProtectedCounts(preview, goalKept)).toEqual({ unread: 1, goalKept: 1 });
    const ids = (approval: Parameters<typeof approveChapterCleanupTargets>[2]) =>
      approveChapterCleanupTargets(preview, goalKept, approval).targets.map(target => target.candidate.identity.chapter.id);
    expect(ids({ includeUnread: false, includeGoalKept: false })).toEqual([3]);
    expect(ids({ includeUnread: true, includeGoalKept: false })).toEqual([3, 4]);
    expect(ids({ includeUnread: true, includeGoalKept: true })).toEqual([3, 4, 5]);
    expect(approveChapterCleanupTargets(preview, goalKept, { includeUnread: false, includeGoalKept: false }))
      .toMatchObject({ workCount: 1, payloadBytes: 35 });
  });
});

describe("cleanup execution", () => {
  it("rechecks reading and category eligibility and never deletes an excluded target", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    mocks.candidates.mockResolvedValue([]);
    const result = await runChapterCleanup(preview);
    expect(result).toMatchObject({ skipped: 1, deleted: 0, results: [{ chapterId: 3, status: "skipped", reason: "changed" }] });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("checks eligibility again immediately before deletion and does not expand the confirmed target list", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    let calls = 0;
    mocks.candidates.mockImplementation(async (_selection, options) => {
      expect(options.chapterId).toBe(3);
      return ++calls === 3 ? [] : [candidate];
    });
    expect(await runChapterCleanup(preview)).toMatchObject({ total: 1, skipped: 1, deleted: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("skips a chapter marked unread after the preview approved it as read", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    mocks.candidates.mockResolvedValue([{ ...candidate, unread: true }]);
    expect(await runChapterCleanup(preview)).toMatchObject({ skipped: 1, deleted: 0, results: [{ chapterId: 3, reason: "changed" }] });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects a changed saved server association", async () => {
    const preview = await previewChapterCleanup(filters("server-present"));
    mocks.candidates.mockResolvedValue([{ ...candidate, serverSource: '{"serverUrl":"https://other","workId":"work"}' }]);
    expect(await runChapterCleanup(preview)).toMatchObject({ skipped: 1, deleted: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects a changed fingerprint", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    mocks.inspect.mockResolvedValue({ ...snapshot, fingerprint: "new" });
    expect(await runChapterCleanup(preview)).toMatchObject({ skipped: 1, deleted: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("rejects changed server revision and settings", async () => {
    const preview = await previewChapterCleanup(filters("server-present"));
    mocks.fetch.mockResolvedValue({ ...server, revision: "new" });
    expect(await runChapterCleanup(preview)).toMatchObject({ skipped: 1, deleted: 0 });
    mocks.state.serverUrl = "https://other";
    expect(await runChapterCleanup(preview)).toMatchObject({ skipped: 1, deleted: 0 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("reconciles native deletion even when cancellation occurs during deletion", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    const controller = new AbortController();
    mocks.remove.mockImplementation(async () => { controller.abort(); return { snapshot: empty, errors: [] }; });
    const result = await runChapterCleanup(preview, { signal: controller.signal });
    expect(mocks.reconcile).toHaveBeenCalledWith(candidate, empty);
    expect(result).toMatchObject({ deleted: 1, cancelled: 0, bytesFreed: 35 });
  });
  it("reconciles remaining actual bytes and reports a partial native deletion as failed", async () => {
    const preview = await previewChapterCleanup(filters("any"));
    const remaining = { ...empty, payloadBytes: 7, mediaBytes: 7 };
    mocks.remove.mockResolvedValue({ snapshot: remaining, errors: [{ path: "media.zip", message: "permission denied" }] });
    const result = await runChapterCleanup(preview);
    expect(mocks.reconcile).toHaveBeenCalledWith(candidate, remaining);
    expect(result).toMatchObject({ failed: 1, bytesFreed: 28, results: [{ status: "failed", reason: "permission denied" }] });
  });
});

it("reconciles a partial native mutation that throws", async () => {
  const preview = await previewChapterCleanup(filters("any"));
  const remaining = { ...empty, payloadBytes: 7, mediaBytes: 7 };
  mocks.remove.mockRejectedValue(new Error("native deletion failed"));
  mocks.inspect.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(remaining);
  const result = await runChapterCleanup(preview);
  expect(mocks.reconcile).toHaveBeenCalledWith(candidate, remaining);
  expect(result).toMatchObject({ failed: 1, cancelled: 0, bytesFreed: 28, results: [{ reason: "Error: native deletion failed" }] });
});

it("reports mutation failure even if cancellation arrives during a failing delete", async () => {
  const preview = await previewChapterCleanup(filters("any"));
  const controller = new AbortController();
  mocks.remove.mockImplementation(async () => { controller.abort(); throw new Error("write failed"); });
  mocks.inspect.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(empty);
  const result = await runChapterCleanup(preview, { signal: controller.signal });
  expect(mocks.reconcile).toHaveBeenCalledWith(candidate, empty);
  expect(result).toMatchObject({ failed: 1, cancelled: 0, bytesFreed: 35, results: [{ reason: "Error: write failed" }] });
});

it("keeps the original failure when reinspection cannot determine the remaining files", async () => {
  const preview = await previewChapterCleanup(filters("any"));
  mocks.remove.mockRejectedValue(new Error("delete failed"));
  mocks.inspect.mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error("inspection failed"));
  const result = await runChapterCleanup(preview);
  expect(mocks.reconcile).not.toHaveBeenCalled();
  expect(result).toMatchObject({ failed: 1, bytesFreed: 0 });
  expect(result.results[0]?.reason).toContain("delete failed");
  expect(result.results[0]?.reason).toContain("inspection failed");
});

it("reinspects and retries reconciliation after a database failure", async () => {
  const preview = await previewChapterCleanup(filters("any"));
  mocks.reconcile.mockRejectedValueOnce(new Error("database failed")).mockResolvedValueOnce(1);
  mocks.inspect.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(empty);
  const result = await runChapterCleanup(preview);
  expect(mocks.reconcile).toHaveBeenCalledTimes(2);
  expect(mocks.reconcile).toHaveBeenLastCalledWith(candidate, empty);
  expect(result).toMatchObject({ failed: 1, bytesFreed: 35, results: [{ reason: "Error: database failed" }] });
});

it("preserves native deletion errors if the first database reconciliation also throws", async () => {
  const preview = await previewChapterCleanup(filters("any"));
  const remaining = { ...empty, payloadBytes: 7, mediaBytes: 7 };
  mocks.remove.mockResolvedValue({ snapshot: remaining, errors: [{ path: "media.zip", message: "permission denied" }] });
  mocks.reconcile.mockRejectedValueOnce(new Error("database failed")).mockResolvedValueOnce(1);
  mocks.inspect.mockResolvedValueOnce(snapshot).mockResolvedValueOnce(remaining);
  const result = await runChapterCleanup(preview);
  expect(result.results[0]?.reason).toContain("permission denied");
  expect(result.results[0]?.reason).toContain("database failed");
  expect(result).toMatchObject({ failed: 1, bytesFreed: 28 });
});
