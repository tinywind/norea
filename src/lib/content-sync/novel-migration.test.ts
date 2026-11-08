import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readStoredNovelMetadata, readStoredNovelCover } from "../work-metadata";
import { listNovelMigrations, saveNovelMigration } from "../../db/queries/content-sync";
import { ContentServerError, contentServerRequest } from "./client";
import { recordDeletedWorkMetadata } from "./works";
import { buildFinalizeNovelMigrationRequest, captureNovelMigrationSourceSnapshot, captureNovelMigrationTargetMetadata, finalizePendingNovelMigrations } from "./novel-migration";
import type { CopyWorkMigrationChapterRequest, NovelMigrationTargetMetadata, PendingNovelMigration, WorkMigrationSnapshot } from "./novel-migration-types";

vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(), saveNovelMigration: vi.fn() }));
vi.mock("./client", async original => ({
  ...await original<typeof import("./client")>(), contentServerRequest: vi.fn(),
}));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "test-device") }));
vi.mock("../work-metadata", async original => ({
  ...await original<typeof import("../work-metadata")>(), readStoredNovelMetadata: vi.fn(), readStoredNovelCover: vi.fn(),
}));
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
const targetMetadata = (): NovelMigrationTargetMetadata => ({
  novel: { name: "Fresh target", author: "Fresh author", artist: null, summary: "Fresh summary", status: "Complete", genres: null, rating: 0, isLocal: false },
  cover: { fileName: "cover.jpg", contentType: "image/jpeg" }, coverSha256: "b".repeat(64),
});
const initialJob = (): PendingNovelMigration => ({
  version: 1, operationId: "7aa2418b-3806-4490-b3f6-e6054de1b8f0", serverUrl: server,
  source: sourceIdentity, target: targetIdentity, targetLocalNovelId: 2,
  chapters: [
    { sourceChapterPath: "/old/one", sourceChapterNumber: "1", targetChapterPath: "/new/first", targetChapterNumber: "9001", decision: "copy-source", targetChapter: { name: "Fresh first", position: 1, page: "1" } },
    { sourceChapterPath: "/old/two", sourceChapterNumber: "2", targetChapterPath: "/new/second", targetChapterNumber: "9002", decision: "keep-target", expectedTargetInventory: inventory, targetChapter: { name: "Fresh second", position: 2, page: "1" } },
  ],
  sourceSnapshot: sourceSnapshot(), targetMetadata: targetMetadata(),
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
  work: {
    id: "target-work", revision: "target-revision", identity: targetIdentity,
    metadata: { schemaVersion: 1, identity: targetIdentity, novel: targetMetadata().novel, cover: targetMetadata().cover, chapters: {} },
    coverSha256: targetMetadata().coverSha256,
  },
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
const coverDeletes: unknown[] = [];
let coverDeleteFailure: unknown;
const copyRequests: CopyWorkMigrationChapterRequest[] = [];
let copyFailure: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  saved = initialJob(); source = sourceSnapshot(); target = targetSnapshot(); postFailure = undefined; posts.length = 0; coverDeletes.length = 0; coverDeleteFailure = undefined; copyRequests.length = 0; copyFailure = undefined;
  vi.mocked(listNovelMigrations).mockImplementation(async () => saved.status === "completed" ? [] : [structuredClone(saved)]);
  vi.mocked(saveNovelMigration).mockImplementation(async job => { saved = structuredClone(job); });
  vi.mocked(contentServerRequest).mockImplementation(async (_server, path, _token, method, body) => {
    if (method === "DELETE" && path === "/works/target-work/cover") {
      expect(body).toEqual({ revision: target.work.revision });
      coverDeletes.push(structuredClone(body));
      target.work.metadata!.cover = null;
      target.work.coverSha256 = null;
      target.work.revision = "target-without-cover";
      if (coverDeleteFailure) throw coverDeleteFailure;
      return { id: "target-work", deleted: false, hasCover: false, metadata: structuredClone(target.work.metadata) } as never;
    }
    if (method === "POST" && path === "/works/source-work/migration-copy") {
      expect(saved.pendingCopyRequest).toEqual(body);
      const request = body as CopyWorkMigrationChapterRequest;
      copyRequests.push(structuredClone(request));
      let copied = target.chapters.find(chapter => chapter.chapterPath === request.target.chapter.chapterPath);
      if (!copied) {
        copied = { id: "copied-one", revision: "copied-r1", chapterPath: request.target.chapter.chapterPath, chapterNumber: request.target.chapter.chapterNumber, available: true, complete: true };
        target.chapters.push(copied); target.work.revision = "after-copy";
      }
      if (copyFailure) throw copyFailure;
      return { entry: { id: copied.id } } as never;
    }
    if (method === "POST") {
      expect(saved.request).toEqual(body);
      posts.push(structuredClone(body));
      if (postFailure) throw postFailure;
      return { operationId: saved.operationId, deletedWork: { id: "source-work", deleted: true, metadata: { identity: sourceIdentity } } } as never;
    }
    if (path === "/capabilities") return { workMigrationVersion: 1, workCoverDeletionVersion: 1, workMigrationLineageVersion: 1, workMigrationCopyVersion: 1 } as never;
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
    chapterDecisions: initialJob().chapters.map(({ sourceChapterPath, sourceChapterNumber, targetChapterPath, targetChapterNumber }) => ({ sourceChapterPath, sourceChapterNumber, targetChapterPath, targetChapterNumber })),
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
  if (mode === "missing-target") target.chapters.splice(1, 1);
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
  expect(buildFinalizeNovelMigrationRequest(saved, source, target).mappings[0]).toMatchObject({ targetChapterId: "new-one" });
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

it("returns no proof offline and never invents a later source approval", async () => {
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


it.each(["author", "cover-bytes", "missing-proof"] as const)("retains the source when the uploaded target %s differs from the captured fresh result", async mismatch => {
  const captured = structuredClone(saved.targetMetadata);
  if (mismatch === "author") target.work.metadata!.novel.author = "Stale target author";
  if (mismatch === "cover-bytes") target.work.coverSha256 = "c".repeat(64);
  if (mismatch === "missing-proof") delete target.work.metadata;
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  expect(posts).toEqual([]);
  expect(coverDeletes).toEqual([]);
  expect(saved.status).toBe("blocked");
  expect(saved.targetMetadata).toEqual(captured);
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
});

it("blocks an old unsubmitted migration without target metadata proof", async () => {
  delete saved.targetMetadata;
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("target metadata");
  expect(saved.status).toBe("blocked");
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
});

it("preserves the exact retry of an already submitted migration without new metadata proof", async () => {
  saved.request = buildFinalizeNovelMigrationRequest(saved, source, target);
  delete saved.targetMetadata;
  const submitted = structuredClone(saved.request);
  await finalizePendingNovelMigrations(server, "test-device");
  expect(contentServerRequest).toHaveBeenCalledTimes(1);
  expect(posts).toEqual([submitted]);
  expect(saved.status).toBe("completed");
});

it("conditionally removes a stale server cover only when the fresh target metadata has no cover", async () => {
  saved.targetMetadata = { ...targetMetadata(), cover: null, coverSha256: null };
  await finalizePendingNovelMigrations(server, "test-device");
  expect(coverDeletes).toEqual([{ revision: "target-revision" }]);
  expect(saved.request!.target).toEqual({ id: "target-work", revision: "target-without-cover" });
  expect(target.work.coverSha256).toBeNull();
  expect(saved.status).toBe("completed");
});

it("recovers a lost cover-deletion response without deleting a later cover using an old revision", async () => {
  saved.targetMetadata = { ...targetMetadata(), cover: null, coverSha256: null };
  coverDeleteFailure = new Error("Response was lost");
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  expect(posts).toEqual([]);
  expect(saved.status).toBe("failed");
  expect(saved.request).toBeUndefined();
  coverDeleteFailure = undefined;
  await finalizePendingNovelMigrations(server, "test-device");
  expect(coverDeletes).toHaveLength(1);
  expect(posts).toHaveLength(1);
  expect(saved.status).toBe("completed");
});

it("does not clear a different target metadata revision just because its cover is unwanted", async () => {
  saved.targetMetadata = { ...targetMetadata(), cover: null, coverSha256: null };
  target.work.metadata!.novel.author = "Another device's newer author";
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  expect(coverDeletes).toEqual([]);
  expect(posts).toEqual([]);
});

it("captures the actual freshly stored target metadata and cover digest", async () => {
  const metadata = structuredClone(target.work.metadata!);
  const body = new Uint8Array([1, 2, 3]);
  vi.mocked(readStoredNovelMetadata).mockResolvedValue({ directory: "contents/b/new-id", metadata });
  vi.mocked(readStoredNovelCover).mockResolvedValue(body);
  expect(await captureNovelMigrationTargetMetadata({
    ...metadata.novel, pluginId: "b", sourceNovelId: "new-id", path: "/new", cover: "https://new.test/cover.jpg",
  })).toEqual({ novel: metadata.novel, cover: metadata.cover, coverSha256: createHash("sha256").update(body).digest("hex") });
});

it("rejects a target proof whose local metadata changed after the fresh source result", async () => {
  const metadata = structuredClone(target.work.metadata!);
  vi.mocked(readStoredNovelMetadata).mockResolvedValue({ directory: "contents/b/new-id", metadata });
  await expect(captureNovelMigrationTargetMetadata({
    ...metadata.novel, author: "Latest parsed author", pluginId: "b", sourceNovelId: "new-id", path: "/new", cover: "https://new.test/cover.jpg",
  })).rejects.toThrow("changed");
});


it("retains a new cover installed after an ambiguous cover removal", async () => {
  saved.targetMetadata = { ...targetMetadata(), cover: null, coverSha256: null };
  coverDeleteFailure = new Error("Response was lost");
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("pending");
  expect(saved.targetCoverDeletionRevision).toBe("target-revision");
  target.work.metadata!.cover = { fileName: "cover.png", contentType: "image/png" };
  target.work.coverSha256 = "c".repeat(64);
  target.work.revision = "later-cover";
  coverDeleteFailure = undefined;
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("target changed");
  expect(coverDeletes).toHaveLength(1);
  expect(posts).toEqual([]);
  expect(target.work.coverSha256).toBe("c".repeat(64));
  expect(saved.status).toBe("blocked");
});

it("sends an explicit deletion for a deliberately excluded server chapter", async () => {
  saved.chapters[0] = { sourceChapterPath: "/old/one", sourceChapterNumber: "1", targetChapterPath: null, targetChapterNumber: null, decision: null };
  source.chapters[0]!.complete = false; source.chapters[0]!.available = false;
  saved.sourceSnapshot = structuredClone(source);
  await finalizePendingNovelMigrations(server, "test-device");
  expect(saved.request!.mappings[0]).toEqual({ sourceChapterId: "old-one", decision: "delete-source" });
  expect(saved.request!.chapterDecisions![0]).toEqual({ sourceChapterPath: "/old/one", sourceChapterNumber: "1", targetChapterPath: null, targetChapterNumber: null });
  expect(saved.status).toBe("completed");
});
it("preserves decisions for metadata-only and local-only chapters in the frozen request", () => {
  saved.chapters.push({ sourceChapterPath: "/old/metadata-only", sourceChapterNumber: "3", targetChapterPath: "/new/third", targetChapterNumber: "9003", decision: null });
  saved.chapters.push({ sourceChapterPath: "/old/local-only", sourceChapterNumber: "4", targetChapterPath: null, targetChapterNumber: null, decision: null });
  const request = buildFinalizeNovelMigrationRequest(saved, source, target);
  expect(request.chapterDecisions).toHaveLength(4);
  expect(request.chapterDecisions![2]).toEqual({ sourceChapterPath: "/old/metadata-only", sourceChapterNumber: "3", targetChapterPath: "/new/third", targetChapterNumber: "9003" });
  expect(request.chapterDecisions![3]!.targetChapterPath).toBeNull();
  expect(request.mappings).toHaveLength(2);
});
it("keeps the source when the server cannot persist and propagate full migration decisions", async () => {
  const original = vi.mocked(contentServerRequest).getMockImplementation()!;
  vi.mocked(contentServerRequest).mockImplementation(async (...args) => args[1] === "/capabilities" ? { workMigrationVersion: 1, workCoverDeletionVersion: 1 } as never : original(...args));
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("Update the content server");
  expect(posts).toEqual([]); expect(saved.status).toBe("blocked");
});

it("copies a server-only original chapter into its approved target before finalizing", async () => {
  target.chapters.shift();
  await finalizePendingNovelMigrations(server, "test-device");
  expect(copyRequests).toEqual([{
    decision: "copy-source", source: { revision: "source-revision", chapter: { id: "old-one", revision: "old-r1" } },
    target: { id: "target-work", revision: "target-revision", chapter: { chapterPath: "/new/first", chapterNumber: "9001", name: "Fresh first", position: 1, page: "1" }, expectedChapter: null },
  }]);
  expect(saved.request!.target.revision).toBe("after-copy");
  expect(saved.request!.mappings[0]).toMatchObject({ targetChapterId: "copied-one", targetRevision: "copied-r1", decision: "copy-source" });
  expect(saved.pendingCopyRequest).toBeUndefined();
  expect(saved.status).toBe("completed");
});
it("replays a persisted copy request after its response was lost without rebasing its revisions", async () => {
  target.chapters.shift(); copyFailure = new Error("Copy response lost");
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("Copy response lost");
  const persisted = structuredClone(saved.pendingCopyRequest);
  expect(persisted).toBeDefined(); expect(posts).toEqual([]);
  copyFailure = undefined;
  await finalizePendingNovelMigrations(server, "test-device");
  expect(copyRequests).toEqual([persisted, persisted]);
  expect(saved.status).toBe("completed");
});
it("never interprets an old undecided migration as approval to copy a server chapter", async () => {
  target.chapters.shift(); saved.chapters[0]!.decision = null;
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("not transferred");
  expect(copyRequests).toEqual([]); expect(posts).toEqual([]);
});
it("requires the server copy capability before transferring a missing target body", async () => {
  target.chapters.shift();
  const original = vi.mocked(contentServerRequest).getMockImplementation()!;
  vi.mocked(contentServerRequest).mockImplementation(async (...args) => args[1] === "/capabilities" ? { workMigrationVersion: 1, workCoverDeletionVersion: 1, workMigrationLineageVersion: 1 } as never : original(...args));
  await expect(finalizePendingNovelMigrations(server, "test-device")).rejects.toThrow("Update the content server");
  expect(copyRequests).toEqual([]); expect(posts).toEqual([]);
});

it.each(["workMigrationLineageVersion", "workMigrationCopyVersion", "workCoverDeletionVersion"] as const)("requires %s before capturing a baseline for a new local merge", async capability => {
  vi.mocked(contentServerRequest).mockResolvedValue({ workMigrationVersion: 1, workMigrationLineageVersion: 1, workMigrationCopyVersion: 1, workCoverDeletionVersion: 1, [capability]: undefined } as never);
  await expect(captureNovelMigrationSourceSnapshot(server, sourceIdentity)).rejects.toThrow("Update the content server before merging works");
  expect(contentServerRequest).toHaveBeenCalledTimes(1);
  expect(contentServerRequest).toHaveBeenCalledWith(server, "/capabilities", "test-device", "GET", undefined, undefined);
});

it("discards A's server body while retaining an explicit reading-state destination without a B body", async () => {
  saved.chapters[0] = { ...saved.chapters[0]!, decision: null, discardSourceContent: true };
  target.chapters = target.chapters.filter(chapter => chapter.id !== "new-one");
  target.work.metadata!.chapters = { "9001": "Fresh first", "9002": "Fresh second" };
  const request = buildFinalizeNovelMigrationRequest(saved, source, target);
  expect(request.mappings[0]).toEqual({ sourceChapterId: "old-one", decision: "delete-source" });
  expect(request.chapterDecisions?.[0]).toEqual({
    sourceChapterPath: "/old/one", sourceChapterNumber: "1", targetChapterPath: "/new/first", targetChapterNumber: "9001",
    discardSourceContent: true,
  });
  expect(await finalizePendingNovelMigrations(server, "token")).toBe(true);
  expect(copyRequests).toEqual([]);
  expect(saved.status).toBe("completed");
});

it("rejects a discard flag that still asks to copy source bytes", () => {
  const job = initialJob();
  job.chapters[0]!.discardSourceContent = true;
  expect(() => buildFinalizeNovelMigrationRequest(job, sourceSnapshot(), targetSnapshot())).toThrow(/inconsistent/);
});
