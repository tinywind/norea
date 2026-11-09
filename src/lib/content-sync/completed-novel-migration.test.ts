import { beforeEach, expect, it, vi } from "vitest";
import type { PendingNovelMigration, WorkMigrationSnapshot } from "./novel-migration-types";

const mocks = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), write: vi.fn(), request: vi.fn(), deleted: vi.fn(), incoming: vi.fn() }));
vi.mock("../../db/queries/content-sync", () => ({
  listNovelMigrations: mocks.list, readContentSyncCache: mocks.read, writeContentSyncCache: mocks.write, saveNovelMigration: vi.fn(),
}));
vi.mock("./migration-feed-state", () => ({ listIncomingMigrations: mocks.incoming }));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: mocks.request }));
vi.mock("./works", () => ({
  contentWorkId: async (identity: { pluginId: string }) => identity.pluginId === "old" ? "source-work" : "target-work",
  recordDeletedWorkMetadata: mocks.deleted,
}));
vi.mock("./deletion-exclusions", () => ({
  runServerWorkDeletion: async (_server: string, _id: string, operation: () => Promise<unknown>) => operation(),
}));
import { buildCompletedNovelMigrationRequest, reconcileCompletedNovelMigrations, type CompletedNovelMigrationRequest } from "./completed-novel-migration";
import { ContentServerError } from "./client";

const sourceIdentity = { pluginId: "old", novelId: "original", novelPath: "/old" };
const targetIdentity = { pluginId: "new", novelId: "current", novelPath: "/new" };
const inventory = { body: { sha256: "a".repeat(64), bytes: 12 }, expectedAssetKeys: [], storedAssets: [] };
let job: PendingNovelMigration;
let source: WorkMigrationSnapshot;
let target: WorkMigrationSnapshot;
const cache = new Map<string, string>();
let failAfterCommit = false;
let lastRequest: CompletedNovelMigrationRequest | undefined;
beforeEach(() => {
  vi.clearAllMocks(); cache.clear(); failAfterCommit = false; lastRequest = undefined;
  source = { work: { id: "source-work", revision: "source-now", identity: sourceIdentity }, chapters: [
    { id: "old-one", revision: "source-one-now", chapterPath: "/old/1", chapterNumber: "1", complete: true, available: true },
    { id: "old-two", revision: "source-two-now", chapterPath: "/old/2", chapterNumber: "2", complete: true, available: true },
  ] };
  target = { work: { id: "target-work", revision: "target-now", identity: targetIdentity }, chapters: [
    { id: "new-one", revision: "target-one-now", chapterPath: "/new/first", chapterNumber: "1", complete: true, available: true },
    { id: "new-two", revision: "target-two-now", chapterPath: "/new/second", chapterNumber: "2", complete: true, available: true },
  ] };
  job = {
    version: 1, operationId: "legacy-operation", serverUrl: "http://server", source: sourceIdentity, target: targetIdentity,
    targetLocalNovelId: 900, status: "completed", attempts: 1, createdAt: 1, updatedAt: 2,
    chapters: [
      { sourceChapterPath: "/old/1", sourceChapterNumber: "1", targetChapterPath: "/new/first", targetChapterNumber: "346378", decision: "copy-source" },
      { sourceChapterPath: "/old/2", sourceChapterNumber: "2", targetChapterPath: "/new/second", targetChapterNumber: "346379",
        decision: "keep-target", expectedTargetInventory: inventory },
    ],
    request: { operationId: "legacy-operation", source: { revision: "source-before", chapters: [
      { id: "old-one", revision: "source-one-before" }, { id: "old-two", revision: "source-two-before" },
    ] }, target: { id: "target-work", revision: "target-before" }, mappings: [
      { sourceChapterId: "old-one", targetChapterId: "new-one", targetRevision: "target-one-before", decision: "copy-source" },
      { sourceChapterId: "old-two", targetChapterId: "new-two", targetRevision: "target-two-before", decision: "keep-target", expectedTargetInventory: inventory },
    ] },
  };
  mocks.incoming.mockResolvedValue([]);
  mocks.list.mockImplementation(async () => [structuredClone(job)]);
  mocks.read.mockImplementation(async key => cache.get(key) ?? null);
  mocks.write.mockImplementation(async (key, value) => { cache.set(key, value); });
  mocks.request.mockImplementation(async (_server, path, _token, method, body) => {
    if (path === "/capabilities") return { workMigrationReconcileVersion: 1 };
    if (path === "/works/source-work/migration-snapshot") return structuredClone(source);
    if (path === "/works/target-work/migration-snapshot") return structuredClone(target);
    if (path === "/works/source-work/migration-reconcile" && method === "POST") {
      const saved = [...cache.values()].map(value => JSON.parse(value)).find(value => value.request);
      expect(saved.request).toEqual(body);
      lastRequest = structuredClone(body);
      if (failAfterCommit) throw new Error("Response lost");
      return { operationId: body.current.operationId, deletedWork: {
        id: "source-work", deleted: true, metadata: { identity: sourceIdentity },
      } };
    }
    throw new Error("Unexpected request " + path);
  });
});

it("keeps the legacy decision intact while reconciling exact paths to current storage numbers", () => {
  const request = buildCompletedNovelMigrationRequest(job, source, target, "new-operation");
  expect(request.legacyRequest).toEqual(job.request);
  expect(request.current.operationId).toBe("new-operation");
  expect(request.current.chapterDecisions?.map(chapter => chapter.targetChapterNumber)).toEqual(["1", "2"]);
  expect(request.current.mappings).toEqual([
    { sourceChapterId: "old-one", targetChapterId: "new-one", targetRevision: "target-one-now", decision: "copy-source" },
    { sourceChapterId: "old-two", targetChapterId: "new-two", targetRevision: "target-two-now", decision: "keep-target", expectedTargetInventory: inventory },
  ]);
  expect(job.chapters[0]!.targetChapterNumber).toBe("346378");
});

it("retains complete chapter decisions even when one old body is already absent", () => {
  source.chapters.pop();
  const request = buildCompletedNovelMigrationRequest(job, source, target, "new-operation");
  expect(request.current.mappings).toHaveLength(1);
  expect(request.current.chapterDecisions).toHaveLength(2);
});

it("refuses an unknown target path instead of treating an equal number as identity", () => {
  target.chapters[0]!.chapterPath = "/different-first";
  expect(() => buildCompletedNovelMigrationRequest(job, source, target, "new-operation")).toThrow("no longer present");
});

it("retains an extra source chapter that was never part of the approved move", () => {
  source.chapters.push({ id: "unexpected", revision: "now", chapterPath: "/old/extra", chapterNumber: "3", complete: true, available: true });
  expect(() => buildCompletedNovelMigrationRequest(job, source, target, "new-operation")).toThrow("not transferred");
});

it("persists and confirms the fresh request once, without modifying the completed legacy job", async () => {
  expect(await reconcileCompletedNovelMigrations("http://server", "token")).toBe(1);
  expect(lastRequest!.legacyRequest).toEqual(job.request);
  expect(mocks.deleted).toHaveBeenCalledTimes(1);
  mocks.request.mockClear();
  expect(await reconcileCompletedNovelMigrations("http://server", "token")).toBe(0);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(job.status).toBe("completed");
});

it("reuses the exact persisted request after a response is lost", async () => {
  failAfterCommit = true;
  await expect(reconcileCompletedNovelMigrations("http://server", "token")).rejects.toThrow("Response lost");
  const first = structuredClone(lastRequest);
  source.work.revision = "later";
  target.work.revision = "later";
  failAfterCommit = false;
  mocks.request.mockClear();
  await reconcileCompletedNovelMigrations("http://server", "token");
  expect(lastRequest).toEqual(first);
  expect(mocks.request.mock.calls.some(([, path]) => String(path).endsWith("/migration-snapshot"))).toBe(false);
});

it("does not re-create a retired source that is already missing", async () => {
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (...args) => {
    if (args[1] === "/works/source-work/migration-snapshot") throw new ContentServerError(404);
    return original(...args);
  });
  expect(await reconcileCompletedNovelMigrations("http://server", "token")).toBe(0);
  expect(lastRequest).toBeUndefined();
  expect([...cache.values()].map(value => JSON.parse(value).completed)).toEqual([true]);
});

it("preserves a conflict and reports it without changing any local migration decisions", async () => {
  const original = mocks.request.getMockImplementation()!;
  mocks.request.mockImplementation(async (...args) => {
    if (args[3] === "POST") throw new ContentServerError(409);
    return original(...args);
  });
  await expect(reconcileCompletedNovelMigrations("http://server", "token")).rejects.toMatchObject({ retryable: false });
  expect(mocks.deleted).not.toHaveBeenCalled();
  expect(job.chapters[0]!.targetChapterNumber).toBe("346378");
});


it("does not retire a migration that was explicitly revoked", async () => {
  mocks.incoming.mockResolvedValue([{ operationId: job.operationId, lineage: { active: false } }]);
  expect(await reconcileCompletedNovelMigrations("http://server", "token")).toBe(0);
  expect(mocks.request).not.toHaveBeenCalled();
});

it("preserves an exact current chapter's explicit null number", () => {
  source.chapters[0]!.chapterNumber = null;
  target.chapters[0]!.chapterNumber = null;
  const request = buildCompletedNovelMigrationRequest(job, source, target, "new-operation");
  expect(request.current.chapterDecisions![0]!.sourceChapterNumber).toBeNull();
  expect(request.current.chapterDecisions![0]!.targetChapterNumber).toBeNull();
});

it("honors a revocation explicitly linked to its legacy completed operation", async () => {
  mocks.incoming.mockResolvedValue([{ operationId: "reconciled-operation", lineage: { active: false, legacyOperationId: job.operationId } }]);
  expect(await reconcileCompletedNovelMigrations("http://server", "token")).toBe(0);
  expect(mocks.request).not.toHaveBeenCalled();
});
