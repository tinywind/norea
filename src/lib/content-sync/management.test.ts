import { beforeEach, expect, it, vi } from "vitest";
import { contentServerRequest, ContentServerError } from "./client";
import { registerContentDevice } from "./device";
import { useContentSyncStore } from "../../store/content-sync";
import { findServerWork, loadServerChapterPage, deleteSelectedServerChapters, deleteServerWork } from "./management";
import { recordDeletedWorkMetadata, runWorkMetadataSyncOperation, type WorkCatalogEntry } from "./works";

vi.mock("./client", async importOriginal => ({ ...await importOriginal<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device") }));
vi.mock("./works", async original => ({ ...await original<typeof import("./works")>(), contentWorkId: vi.fn(async () => "work-id"), recordDeletedWorkMetadata: vi.fn() }));
const source = { serverUrl: "http://original-server", workId: "work-id" };
const identity = { pluginId: "plugin", novelId: "work", novelPath: "/work" };
const deletedWork = { id: "work-id", deleted: true, metadata: { identity } } as WorkCatalogEntry;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(contentServerRequest).mockReset();
  useContentSyncStore.setState({ serverUrl: "http://different-server", deviceName: "Tablet", lookupTimeoutSeconds: 3 });
});

it("only exposes a matching server work and treats an absent work as unavailable", async () => {
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id: "work-id", metadata: { identity } });
  expect(await findServerWork(source.serverUrl, identity)).toEqual(source);
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404));
  expect(await findServerWork(source.serverUrl, identity)).toBeNull();
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ id: "work-id", metadata: { identity: { ...identity, novelPath: "/other" } } });
  await expect(findServerWork(source.serverUrl, identity)).rejects.toThrow("identity");
});

it("loads one server page without loading local chapters or the rest of the catalog", async () => {
  const page = { items: [{ id: "server-only" }], total: 1500, hasMore: true };
  vi.mocked(contentServerRequest).mockResolvedValue(page);
  expect(await loadServerChapterPage(source, 100)).toBe(page);
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl,
    "/catalog/works/work-id/chapters?offset=100&limit=100", "device", "GET", undefined, undefined);
});

it("ends background work discovery at the configured deadline", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(registerContentDevice).mockImplementationOnce(() => new Promise(() => undefined));
    const discovery = expect(findServerWork(source.serverUrl, identity)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(3000);
    await discovery;
    expect(contentServerRequest).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("deletes only selected server IDs on the displayed server even when settings point elsewhere", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue(undefined);
  await deleteSelectedServerChapters(source, ["server-a", "server-b", "server-a"]);
  expect(registerContentDevice).toHaveBeenCalledWith(source.serverUrl, "Tablet");
  expect(vi.mocked(contentServerRequest).mock.calls).toEqual([
    [source.serverUrl, "/chapters/server-a", "device", "DELETE"],
    [source.serverUrl, "/chapters/server-b", "device", "DELETE"],
  ]);
});

it("accepts an already deleted chapter but stops on a real deletion failure", async () => {
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(404))
    .mockRejectedValueOnce(new ContentServerError(403));
  await expect(deleteSelectedServerChapters(source, ["gone", "blocked", "untouched"])).rejects.toMatchObject({ status: 403 });
  expect(contentServerRequest).toHaveBeenCalledTimes(2);
});

it("deletes a whole work on its displayed server and persists the returned tombstone", async () => {
  vi.mocked(contentServerRequest).mockResolvedValue(deletedWork);
  expect(await deleteServerWork(source)).toBe(deletedWork);
  expect(registerContentDevice).toHaveBeenCalledWith(source.serverUrl, "Tablet");
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl, "/works/work-id", "device", "DELETE");
  expect(recordDeletedWorkMetadata).toHaveBeenCalledExactlyOnceWith(source.serverUrl, deletedWork);
});

it("waits for an in-flight metadata operation before deleting and recording a whole work", async () => {
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const upload = runWorkMetadataSyncOperation(source.serverUrl, async () => { order.push("upload"); await blocked; });
  vi.mocked(contentServerRequest).mockResolvedValueOnce(deletedWork);
  const deletion = deleteServerWork(source);
  await vi.waitFor(() => expect(order).toEqual(["upload"]));
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
  release();
  await Promise.all([upload, deletion]);
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl, "/works/work-id", "device", "DELETE");
  expect(recordDeletedWorkMetadata).toHaveBeenCalledExactlyOnceWith(source.serverUrl, deletedWork);
});

it("expires a queued deletion without sending it later when synchronization finishes", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const upload = runWorkMetadataSyncOperation(source.serverUrl, () => blocked);
  try {
    const deletion = expect(deleteServerWork(source)).rejects.toThrow("Timed out waiting for content synchronization");
    await vi.advanceTimersByTimeAsync(30_000);
    await deletion;
    expect(registerContentDevice).not.toHaveBeenCalled();
    expect(contentServerRequest).not.toHaveBeenCalled();
    release();
    await upload;
    await runWorkMetadataSyncOperation(source.serverUrl, async () => undefined);
    expect(contentServerRequest).not.toHaveBeenCalled();
    expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
  } finally { release(); await upload; vi.useRealTimers(); }
});

it("stops the queue timer when deletion starts and leaves the HTTP request deadline independent", async () => {
  vi.useFakeTimers();
  let releaseUpload!: () => void;
  let finishDelete!: (entry: WorkCatalogEntry) => void;
  const upload = runWorkMetadataSyncOperation(source.serverUrl, () => new Promise<void>(resolve => { releaseUpload = resolve; }));
  const response = new Promise<WorkCatalogEntry>(resolve => { finishDelete = resolve; });
  vi.mocked(contentServerRequest).mockReturnValueOnce(response);
  const deletion = deleteServerWork(source);
  let settled = false;
  void deletion.then(() => { settled = true; }, () => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(29_000);
    releaseUpload();
    await upload;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl, "/works/work-id", "device", "DELETE");
    expect(settled).toBe(false);
    finishDelete(deletedWork);
    expect(await deletion).toBe(deletedWork);
  } finally {
    releaseUpload();
    finishDelete?.(deletedWork);
    await upload;
    await deletion.catch(() => undefined);
    vi.useRealTimers();
  }
});

it("does not record a local deletion when the server rejects it or confirms another work", async () => {
  vi.mocked(contentServerRequest).mockRejectedValueOnce(new ContentServerError(403));
  await expect(deleteServerWork(source)).rejects.toMatchObject({ status: 403 });
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ ...deletedWork, id: "other-work" });
  await expect(deleteServerWork(source)).rejects.toThrow("requested work deletion");
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ ...deletedWork, deleted: false });
  await expect(deleteServerWork(source)).rejects.toThrow("requested work deletion");
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
});
