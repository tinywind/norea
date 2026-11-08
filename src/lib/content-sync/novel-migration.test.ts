import { beforeEach, expect, it, vi } from "vitest";
import { listNovelMigrations, saveNovelMigration } from "../../db/queries/content-sync";
import { ContentServerError, contentServerRequest } from "./client";
import { recordDeletedWorkMetadata } from "./works";
import { buildFinalizeNovelMigrationRequest, captureNovelMigrationSourceSnapshot, finalizePendingNovelMigrations } from "./novel-migration";
import type { PendingNovelMigration, WorkMigrationSnapshot } from "./novel-migration-types";

vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(), saveNovelMigration: vi.fn() }));
vi.mock("./client", async original => ({
  ...await original<typeof import("./client")>(), contentServerRequest: vi.fn(),
}));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "test-device") }));
vi.mock("./works", () => ({
  contentWorkId: vi.fn(async (identity: { pluginId: string }) => identity.pluginId === "a" ? "source-work" : "target-work"),
  recordDeletedWorkMetadata: vi.fn(),
}));
vi.mock("./deletion-exclusions", () => ({
  runServerWorkDeletion: vi.fn(async (_server: string, _id: string, operation: () => Promise<unknown>) => operation()),
}));

const server = "http://server";
const sourceIdentity = { pluginId: "a", novelId: "old-id", novelPath: "/old" };
const targetIdentity = { pluginId: "b", novelId: "new-id", novelPath: "/new" };
const inventory = { body: { sha256: "a".repeat(64), bytes: 12 }, expectedAssetKeys: [], storedAssets: [] };
const initialJob = (): PendingNovelMigration => ({
  version: 1, operationId: "7aa2418b-3806-4490-b3f6-e6054de1b8f0", serverUrl: server,
  source: sourceIdentity, target: targetIdentity, targetLocalNovelId: 2,
  chapters: [
    { sourceChapterPath: "/old/one", sourceChapterNumber: "1", targetChapterPath: "/new/first", targetChapterNumber: "9001", decision: "copy-source" },
    { sourceChapterPath: "/old/two", sourceChapterNumber: "2", targetChapterPath: "/new/second", targetChapterNumber: "9002", decision: "keep-target", expectedTargetInventory: inventory },
  ],
  sourceSnapshot: sourceSnapshot(),
  status: "pending", attempts: 0, createdAt: 1, updatedAt: 1,
});
const sourceSnapshot = (): WorkMigrationSnapshot => ({
  work: { id: "source-work", revision: "source-revision", identity: sourceIdentity },
  chapters: [
    { id: "old-one", revision: "old-r1", chapterPath: "/old/one", chapterNumber: "1", available: true, complete: true },
    { id: "old-two", revision: "old-r2", chapterPath: "/old/two", chapterNumber: "2", available: true, complete: true },
  ],
});
const targetSnapshot = (): WorkMigrationSnapshot => ({
  work: { id: "target-work", revision: "target-revision", identity: targetIdentity },
  chapters: [
    { id: "new-one", revision: "new-r1", chapterPath: "/new/first", chapterNumber: "9001", available: true, complete: true },
    { id: "new-two", revision: "new-r2", chapterPath: "/new/second", chapterNumber: "9002", available: true, complete: true },
    { id: "new-extra", revision: "new-r3", chapterPath: "/new/third", chapterNumber: "9003", available: true, complete: true },
  ],
});
let saved: PendingNovelMigration;
let source: WorkMigrationSnapshot;
let target: WorkMigrationSnapshot;
let postFailure: unknown;
const posts: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  saved = initialJob(); source = sourceSnapshot(); target = targetSnapshot(); postFailure = undefined; posts.length = 0;
  vi.mocked(listNovelMigrations).mockImplementation(async () => saved.status === "completed" ? [] : [structuredClone(saved)]);
  vi.mocked(saveNovelMigration).mockImplementation(async job => { saved = structuredClone(job); });
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path, _token, method, body) => {
    if (method === "POST") {
      expect(saved.request).toEqual(body);
      posts.push(structuredClone(body));
      if (postFailure) throw postFailure;
      return { operationId: saved.operationId, deletedWork: { id: "source-work", deleted: true, metadata: { identity: sourceIdentity } } } as never;
    }
    if (path === "/capabilities") return { workMigrationVersion: 1 } as never;
    if (path === "/works/source-work/migration-snapshot") return structuredClone(source) as never;
    if (path === "/works/target-work/migration-snapshot") return structuredClone(target) as never;
    throw new Error("Unexpected migration endpoint");
  });
});

it("persists the exact conditional request before finalization and preserves copied versus retained downloads", async () => {
  await finalizePendingNovelMigrations(server, "test-device");
  expect(posts).toEqual([{
    operationId: saved.operationId,
    source: { revision: "source-revision", chapters: [{ id: "old-one", revision: "old-r1" }, { id: "old-two", revision: "old-r2" }] },
    target: { id: "target-work", revision: "target-revision" },
    mappings: [
      { sourceChapterId: "old-one", targetChapterId: "new-one", targetRevision: "new-r1", decision: "copy-source" },
      { sourceChapterId: "old-two", targetChapterId: "new-two", targetRevision: "new-r2", decision: "keep-target", expectedTargetInventory: inventory },
    ],
  }]);
  expect(contentServerRequest).toHaveBeenCalledWith(server, "/works/source-work/finalize-migration", "test-device", "POST", posts[0], undefined, 300);
  expect(recordDeletedWorkMetadata).toHaveBeenCalledOnce();
  expect(saved.status).toBe("completed");
});

it("replays the saved request after an ambiguous response without taking a new snapshot", async () => {
  postFailure = new Error("Response was lost");
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("original server copies were retained");
  expect(saved.status).toBe("failed");
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
  const first = structuredClone(saved.request);
  source.work.revision = "changed-after-success";
  target.work.revision = "changed-after-success";
  vi.mocked(contentServerRequest).mockClear();
  postFailure = undefined;
  await finalizePendingNovelMigrations(server, "test-device");
  expect(posts[1]).toEqual(first);
  expect(contentServerRequest).toHaveBeenCalledTimes(1);
  expect(saved.status).toBe("completed");
});

it("keeps the original protected after a conflict and retries only the same saved operation", async () => {
  postFailure = new ContentServerError(409);
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  const first = structuredClone(saved.request);
  expect(saved.status).toBe("blocked");
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  expect(posts).toEqual([first, first]);
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
});

it("does not finalize a source with a server-only chapter", async () => {
  source.chapters.push({ ...source.chapters[0]!, id: "server-only", chapterPath: "/old/missing", chapterNumber: "3" });
  saved.sourceSnapshot = structuredClone(source);
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("not transferred");
  expect(posts).toEqual([]);
  expect(saved.status).toBe("blocked");
});

it.each(["excluded", "no-local-copy", "missing-target", "incomplete-target"] as const)("retains the source when a mapping is %s", async mode => {
  if (mode === "excluded") saved.chapters[0]!.targetChapterPath = null;
  if (mode === "no-local-copy") saved.chapters[0]!.decision = null;
  if (mode === "missing-target") target.chapters.shift();
  if (mode === "incomplete-target") target.chapters[0]!.complete = false;
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  expect(posts).toEqual([]);
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
});

it("refuses many-to-one server cleanup even when local merge decisions allow it", () => {
  const job = initialJob();
  job.chapters[1]!.targetChapterPath = job.chapters[0]!.targetChapterPath;
  expect(() => buildFinalizeNovelMigrationRequest(job, source, target)).toThrow("Multiple original chapters");
});

it("resolves only an unambiguous recovered-folder alias and never guesses from the title", () => {
  source.chapters[0]!.chapterPath = "norea-folder:1";
  target.chapters[0]!.chapterPath = "norea-folder:9001";
  expect(buildFinalizeNovelMigrationRequest(saved, source, target).mappings[0]!.targetChapterId).toBe("new-one");
  saved.chapters.push({ ...saved.chapters[0]!, sourceChapterPath: "/different/path" });
  expect(() => buildFinalizeNovelMigrationRequest(saved, source, target)).toThrow("not transferred");
});

it("rejects a mismatched or partial snapshot before any destructive endpoint", async () => {
  target.work.identity = { ...targetIdentity, novelId: "another-work" };
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("does not match");
  expect(posts).toEqual([]);
});

it("leaves a durable pending job when the server has not upgraded", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ workMigrationVersion: undefined } as never);
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("Update the content server");
  expect(saved.status).toBe("blocked");
  expect(posts).toEqual([]);
});

it("captures the source baseline before the local merge without downloading chapter content", async () => {
  expect(await captureNovelMigrationSourceSnapshot(server, sourceIdentity)).toEqual(source);
  expect(contentServerRequest).toHaveBeenCalledWith(server, "/works/source-work/migration-snapshot", "test-device", "GET", undefined, undefined);
  expect(posts).toEqual([]);
});

it("allows preparation to continue offline without inventing a later source approval", async () => {
  vi.mocked(contentServerRequest).mockRejectedValue(new Error("Server offline"));
  expect(await captureNovelMigrationSourceSnapshot(server, sourceIdentity)).toBeUndefined();
  delete saved.sourceSnapshot;
  vi.mocked(contentServerRequest).mockClear();
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("unavailable before the local merge");
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(saved.status).toBe("blocked");
  expect(posts).toEqual([]);
});

it.each(["work", "same-chapter", "new-chapter"] as const)("retains A when its %s changes after preparation, including a kept B download", async change => {
  if (change === "work") source.work.revision = "new-source-metadata";
  if (change === "same-chapter") source.chapters[1]!.revision = "replaced-source-body";
  if (change === "new-chapter") source.chapters.push({
    ...source.chapters[0]!, id: "added-later", chapterPath: "/old/three", chapterNumber: "3",
  });
  const baseline = structuredClone(saved.sourceSnapshot);
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("changed after the merge was prepared");
  expect(saved.sourceSnapshot).toEqual(baseline);
  expect(saved.status).toBe("blocked");
  expect(posts).toEqual([]);
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
});

it("keeps blocked migrations visible without retrying their POST during automatic sync", async () => {
  saved.status = "blocked";
  saved.error = "The original changed after preparation.";
  await expect(finalizePendingNovelMigrations(server, "test-device", undefined, false)).rejects.toMatchObject({
    name: "PendingNovelMigrationError", retryable: false,
  });
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(saveNovelMigration).not.toHaveBeenCalled();
  expect(posts).toEqual([]);
});
