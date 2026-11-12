import { deleteUnshelvedNovelDownloads } from "./tasks/unshelved-novel-download-delete";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../db/queries/novel", () => ({ getNovelById: vi.fn(), setNovelInLibrary: vi.fn() }));
vi.mock("../db/queries/chapter", () => ({ getChapterById: vi.fn(), listChaptersByNovel: vi.fn() }));
vi.mock("../db/queries/content-deletion", () => ({ findLocalDeletionNovel: vi.fn(), deleteLocalNovelRecords: vi.fn(), listStoredDeletionNovelIds: vi.fn(), listDeletionDownloadedChapterIds: vi.fn(async () => []) }));
vi.mock("./tasks/unshelved-novel-download-delete", () => ({ deleteUnshelvedNovelDownloads: vi.fn() }));
vi.mock("./tasks/download-cache-delete", () => ({ deleteDownloadCache: vi.fn(), cancelNovelChapterDownloadWork: vi.fn() }));
vi.mock("./content-sync/management", () => ({ findServerWork: vi.fn(), deleteServerWork: vi.fn(), deleteSelectedServerChapters: vi.fn() }));
vi.mock("./content-sync/sync", () => ({ runContentSyncOperation: vi.fn((run: () => Promise<unknown>) => run()) }));
vi.mock("./content-sync/client", () => ({ contentServerRequest: vi.fn(), ContentServerError: class extends Error { constructor(public status: number) { super(String(status)); } } }));
vi.mock("./content-sync/deletion-exclusions", () => ({ setServerChapterDeletionExclusion: vi.fn() }));
vi.mock("./content-sync/works", () => ({ recordDeletedWorkMetadata: vi.fn() }));
vi.mock("./content-sync/device", () => ({ registerContentDevice: vi.fn(async () => "token") }));
vi.mock("../store/reader", () => ({ useReaderStore: { getState: () => ({ removeNovelReaderState: vi.fn() }) } }));
vi.mock("./novel-cover-storage", () => ({ clearNovelCoverDisplayCache: vi.fn() }));
vi.mock("./chapter-storage-transfer", () => ({ removeChapterStorageDirectory: vi.fn() }));
vi.mock("./download-goals/goal-service", () => ({ withdrawDownloadGoalWork: vi.fn() }));
vi.mock("./content-sync/storage-operation", () => ({ runWorkContentStorageOperation: (_p: string, _n: string, run: () => Promise<unknown>) => run() }));

import { getNovelById, setNovelInLibrary } from "../db/queries/novel";
import { getChapterById, listChaptersByNovel } from "../db/queries/chapter";
import { findLocalDeletionNovel, deleteLocalNovelRecords, listDeletionDownloadedChapterIds } from "../db/queries/content-deletion";
import { deleteDownloadCache } from "./tasks/download-cache-delete";
import { deleteServerWork, deleteSelectedServerChapters, findServerWork } from "./content-sync/management";
import { setServerChapterDeletionExclusion } from "./content-sync/deletion-exclusions";
import { recordDeletedWorkMetadata } from "./content-sync/works";
import { ContentServerError, contentServerRequest } from "./content-sync/client";
import { removeChapterStorageDirectory } from "./chapter-storage-transfer";
import { deletedDownloadChapterIds, prepareContentDeletion, runContentDeletion, matchDeletionChapter } from "./content-deletion";
import { runContentSyncOperation } from "./content-sync/sync";
import { withdrawDownloadGoalWork } from "./download-goals/goal-service";

const novel = { id: 12, pluginId: "source", sourceNovelId: "book-42", path: "/book/42", name: "Book", isLocal: false };
const source = { serverUrl: "http://chosen-server", workId: "work-42" };
const chapter = { id: 91, novelId: 12, path: "/chapter/9", name: "Nine", chapterNumber: "9", position: 9, isDownloaded: true };
const options = { local: false, server: false };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNovelById).mockResolvedValue(novel as never);
  vi.mocked(getChapterById).mockResolvedValue(chapter as never);
  vi.mocked(listChaptersByNovel).mockResolvedValue([chapter] as never);
  vi.mocked(findServerWork).mockResolvedValue(source);
  vi.mocked(deleteDownloadCache).mockResolvedValue({ workId: "delete", total: 1, deleted: 1, failed: 0, cancelled: false });
});

it("unregisters without deleting either copy by default", async () => {
  const plan = await prepareContentDeletion({ kind: "library", ids: [12, 12], title: "Remove", serverUrl: source.serverUrl }, options);
  const results = await runContentDeletion(plan);
  expect(results.map(result => result.status)).toEqual(["succeeded"]);
  expect(setNovelInLibrary).toHaveBeenCalledExactlyOnceWith(12, false);
  expect(withdrawDownloadGoalWork).toHaveBeenCalledExactlyOnceWith([12]);
  expect(deleteDownloadCache).not.toHaveBeenCalled();
  expect(deleteServerWork).not.toHaveBeenCalled();
});

it("runs a server work deletion without waiting for the content synchronization queue", async () => {
  const entry = { id: source.workId, deleted: true } as never;
  vi.mocked(deleteServerWork).mockResolvedValueOnce(entry);
  let release!: () => void;
  vi.mocked(runContentSyncOperation).mockImplementationOnce(async run => {
    await new Promise<void>(resolve => { release = resolve; });
    return run();
  });
  const actions = await prepareContentDeletion({ kind: "server-work", source, title: "Remove" }, options);
  let result: Awaited<ReturnType<typeof runContentDeletion>> | undefined;
  const deletion = runContentDeletion(actions).then(value => { result = value; });
  try {
    await vi.waitFor(() => expect(result).toEqual([{ id: "server-work", status: "succeeded", deletedWork: entry }]), { timeout: 100 });
  } finally {
    release?.();
    await deletion;
    vi.mocked(runContentSyncOperation).mockReset().mockImplementation(run => run());
  }
});

it.each(["library", "chapter", "novel", "all"] as const)("finishes %s device removal while unrelated content synchronization is still pending", async kind => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(runContentSyncOperation).mockImplementation(async run => { await gate; return run(); });
  const request = kind === "library"
    ? { kind: "library" as const, ids: [12], title: "Remove", serverUrl: source.serverUrl }
    : { kind: "downloads" as const, scope: kind, ids: kind === "chapter" ? [91] : [12], title: "Remove", serverUrl: source.serverUrl };
  const actions = await prepareContentDeletion(request, { local: true, server: false });
  let result: Awaited<ReturnType<typeof runContentDeletion>> | undefined;
  const deletion = runContentDeletion(actions).then(value => { result = value; });
  try {
    await vi.waitFor(() => expect(result?.map(value => value.status)).toEqual(
      kind === "library" ? ["succeeded", "succeeded"] : ["succeeded"],
    ), { timeout: 150 });
    if (kind === "library") {
      expect(deleteUnshelvedNovelDownloads).toHaveBeenCalledExactlyOnceWith(novel);
      expect(deleteDownloadCache).not.toHaveBeenCalled();
    } else expect(deleteDownloadCache).toHaveBeenCalledExactlyOnceWith({
      scope: kind,
      targetIds: kind === "all" ? [] : kind === "chapter" ? [91] : [12],
      title: "Remove",
    });
    expect(deleteServerWork).not.toHaveBeenCalled();
    expect(deleteSelectedServerChapters).not.toHaveBeenCalled();
    if (kind === "library") expect(setNovelInLibrary).toHaveBeenCalledExactlyOnceWith(12, false);
  } finally {
    release();
    await deletion;
    vi.mocked(runContentSyncOperation).mockReset().mockImplementation(run => run());
  }
});

it("keeps selected server chapter deletion serialized with content synchronization", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(runContentSyncOperation).mockImplementationOnce(async run => { await gate; return run(); });
  vi.mocked(contentServerRequest).mockResolvedValue({ id: source.workId, metadata: { identity: { pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path } } });
  const actions = await prepareContentDeletion({ kind: "server-chapters", source, title: "Remove", chapters: [{ ...chapter, id: "remote", chapterPath: chapter.path }] as never }, options);
  const deletion = runContentDeletion(actions);
  try {
    await vi.waitFor(() => expect(runContentSyncOperation).toHaveBeenCalledOnce());
    expect(deleteSelectedServerChapters).not.toHaveBeenCalled();
  } finally { release(); await deletion; }
  expect(deleteSelectedServerChapters).toHaveBeenCalledExactlyOnceWith(source, ["remote"]);
});

it("retries only failed device removal after the library step has already succeeded", async () => {
  vi.mocked(deleteUnshelvedNovelDownloads).mockRejectedValueOnce(new Error("device storage unavailable"));
  const actions = await prepareContentDeletion({ kind: "library", ids: [12], title: "Remove", serverUrl: source.serverUrl }, { local: true, server: false });
  const first = await runContentDeletion(actions);
  expect(first).toEqual([
    { id: "library:12", status: "succeeded" },
    { id: "device:12", status: "failed", error: "device storage unavailable" },
  ]);
  vi.mocked(runContentSyncOperation).mockRejectedValueOnce(new Error("Timed out waiting for content synchronization. Retry after synchronization finishes."));
  const retried = await runContentDeletion(actions, first);
  expect(retried.map(result => result.status)).toEqual(["succeeded", "succeeded"]);
  expect(setNovelInLibrary).toHaveBeenCalledExactlyOnceWith(12, false);
  expect(withdrawDownloadGoalWork).toHaveBeenCalledExactlyOnceWith([12]);
  expect(deleteUnshelvedNovelDownloads).toHaveBeenCalledTimes(2);
  expect(deletedDownloadChapterIds(actions, retried)).toEqual([]);
  vi.mocked(runContentSyncOperation).mockReset().mockImplementation(run => run());
});

it("keeps successful sides complete and retries only the failed server deletion", async () => {
  vi.mocked(deleteServerWork).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: source.workId, deleted: true } as never);
  const plan = await prepareContentDeletion({ kind: "library", ids: [12], title: "Remove", serverUrl: source.serverUrl }, { local: true, server: true });
  const first = await runContentDeletion(plan);
  expect(first.map(result => result.status)).toEqual(["succeeded", "succeeded", "failed"]);
  const second = await runContentDeletion(plan, first);
  expect(second.every(result => result.status === "succeeded")).toBe(true);
  expect(setNovelInLibrary).toHaveBeenCalledOnce();
  expect(deleteUnshelvedNovelDownloads).toHaveBeenCalledOnce();
  expect(deleteServerWork).toHaveBeenCalledTimes(2);
});

it.each(["library", "server-work"] as const)("retries only local persistence after %s server deletion succeeds", async kind => {
  const entry = { id: source.workId, deleted: true };
  vi.mocked(deleteServerWork).mockImplementationOnce(async (_source, onDeleted) => {
    onDeleted?.(entry as never);
    throw new Error("disk busy");
  });
  const request = kind === "library"
    ? { kind, ids: [12], serverUrl: source.serverUrl, title: "Remove" }
    : { kind, source, title: "Remove" };
  const plan = await prepareContentDeletion(request, { local: false, server: true });
  const first = await runContentDeletion(plan);
  expect(first.at(-1)?.status).toBe("failed");
  const retried = await runContentDeletion(plan, first);
  expect(retried.at(-1)).toMatchObject({ status: "succeeded", deletedWork: entry });
  expect(deleteServerWork).toHaveBeenCalledOnce();
  expect(recordDeletedWorkMetadata).toHaveBeenCalledExactlyOnceWith(source.serverUrl, entry);
});

it("treats native partial deletion as a failure", async () => {
  vi.mocked(deleteDownloadCache).mockResolvedValueOnce({ workId: "delete", total: 2, deleted: 1, failed: 1, cancelled: false });
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [91], title: "Delete", serverUrl: "" }, options);
  expect((await runContentDeletion(plan))[0]).toMatchObject({ status: "failed", error: expect.any(String) });
});

it("uses the captured server and plugin-owned identity to delete incomplete server copies", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: "server-chapter", deleted: false, complete: false,
    manifest: { identity: { pluginId: "source", novelId: "book-42", novelPath: "/book/42", chapterPath: chapter.path }, chapter } });
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [91], title: "Delete", serverUrl: source.serverUrl }, { ...options, server: true });
  expect((await runContentDeletion(plan)).every(result => result.status === "succeeded")).toBe(true);
  expect(contentServerRequest).toHaveBeenCalledWith(source.serverUrl, expect.stringContaining("includeUnavailable=true"), "token");
  expect(deleteSelectedServerChapters).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: source.serverUrl }), ["server-chapter"]);
});

it("refuses a remote chapter belonging to another plugin-owned work", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: "wrong", manifest: { identity: { pluginId: "source", novelId: "other", novelPath: novel.path, chapterPath: chapter.path }, chapter } });
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [91], title: "Delete", serverUrl: source.serverUrl }, { ...options, server: true });
  expect((await runContentDeletion(plan)).at(-1)?.status).toBe("failed");
  expect(deleteSelectedServerChapters).not.toHaveBeenCalled();
});

it("preserves local work when server deletion fails and retains its directory for a file-removal retry", async () => {
  const entry = { id: source.workId, deleted: true, metadata: { identity: { pluginId: novel.pluginId, novelId: novel.sourceNovelId, novelPath: novel.path } } };
  vi.mocked(deleteServerWork).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(entry as never);
  vi.mocked(findLocalDeletionNovel).mockResolvedValue(novel as never);
  vi.mocked(removeChapterStorageDirectory).mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValue(undefined);
  const plan = await prepareContentDeletion({ kind: "server-work", source, title: "Book" }, { ...options, local: true });
  const first = await runContentDeletion(plan);
  expect(deleteLocalNovelRecords).not.toHaveBeenCalled();
  const second = await runContentDeletion(plan, first);
  expect(second.map(result => result.status)).toEqual(["succeeded", "failed"]);
  expect(deleteLocalNovelRecords).toHaveBeenCalledExactlyOnceWith(novel, { recordUserStateRemoval: true });
  vi.mocked(findLocalDeletionNovel).mockResolvedValue(null);
  expect((await runContentDeletion(plan, second)).every(result => result.status === "succeeded")).toBe(true);
  expect(deleteServerWork).toHaveBeenCalledTimes(2);
  expect(removeChapterStorageDirectory).toHaveBeenLastCalledWith("contents/source/book-42");
});

it("matches exact paths or unique numeric sequences and rejects ambiguous chapter numbers", () => {
  const rows = [{ ...chapter, id: 1, path: "old", chapterNumber: "9.0" }];
  expect(matchDeletionChapter(rows, { chapterPath: "new", chapterNumber: "9" })).toBe(rows[0]);
  expect(matchDeletionChapter(rows, { chapterPath: "missing", chapterNumber: "8" })).toBeNull();
  expect(() => matchDeletionChapter([...rows, { ...rows[0]!, id: 2 }], { chapterPath: "new", chapterNumber: "9" })).toThrow("ambiguous");
});


it("keeps native all-scope cancellation and deletion even with no complete works", async () => {
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "all", title: "All", serverUrl: "" }, options);
  await runContentDeletion(plan);
  expect(deleteDownloadCache).toHaveBeenCalledExactlyOnceWith({ scope: "all", targetIds: [], title: "All" });
});

it("includes incomplete chapters in paired work download deletion", async () => {
  vi.mocked(listChaptersByNovel).mockResolvedValue([{ ...chapter, isDownloaded: false, mediaRepairNeeded: true }] as never);
  vi.mocked(contentServerRequest).mockResolvedValue({ id: "incomplete", deleted: false, complete: false,
    manifest: { identity: { pluginId: "source", novelId: "book-42", novelPath: novel.path, chapterPath: chapter.path }, chapter } });
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "novel", ids: [12], title: "Delete", serverUrl: source.serverUrl }, { ...options, server: true });
  await runContentDeletion(plan);
  expect(deleteSelectedServerChapters).toHaveBeenCalledWith({ serverUrl: source.serverUrl }, ["incomplete"]);
});


it("retries exclusion persistence even when the already-deleted remote chapter returns 404", async () => {
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id: "remote", deleted: false,
    manifest: { identity: { pluginId: "source", novelId: "book-42", novelPath: novel.path, chapterPath: chapter.path }, chapter } }).mockRejectedValueOnce(new ContentServerError(404));
  vi.mocked(setServerChapterDeletionExclusion).mockRejectedValueOnce(new Error("disk busy")).mockResolvedValue(undefined);
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [91], title: "Delete", serverUrl: source.serverUrl }, { ...options, server: true });
  const first = await runContentDeletion(plan);
  expect(first.at(-1)?.status).toBe("failed");
  const retried = await runContentDeletion(plan, first);
  expect(retried.every(result => result.status === "succeeded")).toBe(true);
  expect(setServerChapterDeletionExclusion).toHaveBeenCalledTimes(2);
  expect(deleteSelectedServerChapters).toHaveBeenCalledOnce();
});

it("does not retain a rejected work identity for a destructive retry", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue({ id: "wrong-work", metadata: { identity: { pluginId: "other", novelId: "other", novelPath: "other" } } });
  const plan = await prepareContentDeletion({ kind: "server-chapters", source, title: "Delete", chapters: [{ ...chapter, id: "remote", chapterPath: chapter.path }] as never }, { ...options, local: true });
  const first = await runContentDeletion(plan);
  const second = await runContentDeletion(plan, first);
  expect(first.every(result => result.status === "failed")).toBe(true);
  expect(second.every(result => result.status === "failed")).toBe(true);
  expect(contentServerRequest).toHaveBeenCalledTimes(2);
  expect(deleteSelectedServerChapters).not.toHaveBeenCalled();
  expect(deleteDownloadCache).not.toHaveBeenCalled();
});

it("captures a work's downloaded chapters before deleting them and reports them once deleted", async () => {
  vi.mocked(listDeletionDownloadedChapterIds).mockResolvedValue([91, 92]);
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "novel", ids: [12], title: "Delete", serverUrl: "" }, options);
  const results = await runContentDeletion(plan);
  expect(listDeletionDownloadedChapterIds).toHaveBeenCalledExactlyOnceWith([12]);
  expect(vi.mocked(listDeletionDownloadedChapterIds).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(deleteDownloadCache).mock.invocationCallOrder[0]!);
  expect(deletedDownloadChapterIds(plan, results)).toEqual([91, 92]);
});

it("reports every downloaded chapter after deleting all downloads and the chosen chapters", async () => {
  vi.mocked(listDeletionDownloadedChapterIds).mockResolvedValue([91, 93]);
  const all = await prepareContentDeletion({ kind: "downloads", scope: "all", title: "All", serverUrl: "" }, options);
  expect(deletedDownloadChapterIds(all, await runContentDeletion(all))).toEqual([91, 93]);
  expect(listDeletionDownloadedChapterIds).toHaveBeenCalledExactlyOnceWith();
  const chapters = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [91], title: "One", serverUrl: "" }, options);
  expect(deletedDownloadChapterIds(chapters, await runContentDeletion(chapters))).toEqual([91]);
});

it("reports no deleted chapters while the device deletion has not succeeded", async () => {
  vi.mocked(listDeletionDownloadedChapterIds).mockResolvedValue([91, 92]);
  vi.mocked(deleteDownloadCache).mockRejectedValueOnce(new Error("busy"));
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "novel", ids: [12], title: "Delete", serverUrl: "" }, options);
  const first = await runContentDeletion(plan);
  expect(deletedDownloadChapterIds(plan, first)).toEqual([]);
  vi.mocked(listDeletionDownloadedChapterIds).mockResolvedValue([92]);
  expect(deletedDownloadChapterIds(plan, await runContentDeletion(plan, first))).toEqual([91, 92]);
});

it("deletes chosen chapter downloads in ordered chunks and retries only a failed chunk", async () => {
  const ids = Array.from({ length: 450 }, (_, index) => index + 1);
  vi.mocked(getChapterById).mockImplementation(async id => ({ ...chapter, id, name: `C${id}`, position: id }) as never);
  vi.mocked(deleteDownloadCache).mockResolvedValueOnce({ workId: "delete", total: 200, deleted: 200, failed: 0, cancelled: false })
    .mockRejectedValueOnce(new Error("download cache: failed to delete 3 chapters"));
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [...ids].reverse(), title: "Delete", serverUrl: "" }, options);
  expect(plan.map(action => [action.side, action.name, action.downloadedChapterIds])).toEqual([
    ["device", "C1 – C200", ids.slice(0, 200)],
    ["device", "C201 – C400", ids.slice(200, 400)],
    ["device", "C401 – C450", ids.slice(400)],
  ]);
  const first = await runContentDeletion(plan);
  expect(vi.mocked(deleteDownloadCache).mock.calls.map(([call]) => call.targetIds)).toEqual([ids.slice(0, 200), ids.slice(200, 400), ids.slice(400)]);
  expect(deleteDownloadCache).toHaveBeenCalledWith({ scope: "chapter", targetIds: ids.slice(0, 200), title: "Delete" });
  expect(first.map(result => result.status)).toEqual(["succeeded", "failed", "succeeded"]);
  expect(first[1]?.error).toContain("failed to delete 3 chapters");
  expect(deletedDownloadChapterIds(plan, first)).toEqual([...ids.slice(0, 200), ...ids.slice(400)]);

  vi.mocked(deleteDownloadCache).mockClear();
  const retried = await runContentDeletion(plan, first);
  expect(vi.mocked(deleteDownloadCache).mock.calls.map(([call]) => call.targetIds)).toEqual([ids.slice(200, 400)]);
  expect(deletedDownloadChapterIds(plan, retried)).toHaveLength(450);
});

it("keeps one server deletion per chapter beside the chunked device deletion", async () => {
  vi.mocked(getChapterById).mockImplementation(async id => ({ ...chapter, id, name: `C${id}`, position: id }) as never);
  const plan = await prepareContentDeletion({ kind: "downloads", scope: "chapter", ids: [3, 1, 2], title: "Delete", serverUrl: source.serverUrl }, { ...options, server: true });
  expect(plan.map(action => action.id)).toEqual(["device:chapters:0", "server:1", "server:2", "server:3"]);
  expect(plan[0]).toMatchObject({ name: "C1 – C3", downloadedChapterIds: [1, 2, 3] });
});
