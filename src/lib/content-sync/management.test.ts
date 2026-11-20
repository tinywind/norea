import { beforeEach, expect, it, vi } from "vitest";
import { contentServerRequest, ContentServerError } from "./client";
import { getContentServerCapabilities, registerContentDevice } from "./device";
import { useContentSyncStore } from "../../store/content-sync";
import { findServerWork, loadServerChapterPage, deleteSelectedServerChapters, deleteServerWork } from "./management";
import { recordDeletedWorkMetadata, runWorkMetadataSyncOperation, type WorkCatalogEntry } from "./works";

vi.mock("./client", async importOriginal => ({ ...await importOriginal<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./device", () => ({
  registerContentDevice: vi.fn(async () => "device"),
  getContentServerCapabilities: vi.fn(),
  forgetContentServerCapabilities: vi.fn(),
}));
vi.mock("./works", async original => ({ ...await original<typeof import("./works")>(), contentWorkId: vi.fn(async () => "work-id"), recordDeletedWorkMetadata: vi.fn() }));
const source = { serverUrl: "http://original-server", workId: "work-id" };
const identity = { pluginId: "plugin", novelId: "work", novelPath: "/work" };
const deletedWork = { id: "work-id", deleted: true, metadata: { identity } } as WorkCatalogEntry;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(contentServerRequest).mockReset();
  vi.mocked(getContentServerCapabilities).mockReset().mockResolvedValue({} as never);
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

it("uses catalog detail for identity-only discovery when advertised", async () => {
  vi.mocked(getContentServerCapabilities).mockResolvedValue({ workCatalogSummaryVersion: 1 } as never);
  vi.mocked(contentServerRequest).mockResolvedValue({ id: source.workId, identity });
  expect(await findServerWork(source.serverUrl, identity)).toEqual(source);
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl, "/catalog/works/work-id", "device", "GET", undefined, expect.any(AbortSignal));
});

it("sends only a conditional DELETE when advertised and accepts 404 on retry", async () => {
  vi.mocked(getContentServerCapabilities).mockResolvedValue({ workDeleteIdentityCheckVersion: 1 } as never);
  vi.mocked(contentServerRequest).mockResolvedValueOnce(deletedWork).mockRejectedValueOnce(new ContentServerError(404));
  expect(await deleteServerWork(source, undefined, identity)).toBe(deletedWork);
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl,
    "/works/work-id?pluginId=plugin&novelPath=%2Fwork&novelId=work", "device", "DELETE", {}, undefined, 30,
    { headers: { "Content-Type": "application/vnd.norea.work-identity-delete+json" } });
  expect(await deleteServerWork(source, undefined, identity)).toBeNull();
  expect(recordDeletedWorkMetadata).toHaveBeenCalledOnce();
});

it("gives legacy identity verification at least 30 seconds before sending an ordinary DELETE", async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(contentServerRequest)
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve({ id: source.workId, metadata: { identity } }), 5000)))
      .mockResolvedValueOnce(deletedWork);
    const deletion = deleteServerWork(source, undefined, identity);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(deletion).resolves.toBe(deletedWork);
    expect(vi.mocked(contentServerRequest).mock.calls.map(call => call[3])).toEqual(["GET", "DELETE"]);
  } finally { vi.useRealTimers(); }
});

it("treats a conditional mismatch as a refusal and falls back safely after an older server rejects the media type", async () => {
  vi.mocked(getContentServerCapabilities).mockResolvedValueOnce({ workDeleteIdentityCheckVersion: 1 } as never)
    .mockResolvedValueOnce({ workDeleteIdentityCheckVersion: 1 } as never);
  vi.mocked(contentServerRequest)
    .mockRejectedValueOnce(new ContentServerError(409, undefined, "work-identity-mismatch"))
    .mockRejectedValueOnce(new ContentServerError(415))
    .mockResolvedValueOnce({ id: source.workId, metadata: { identity: { ...identity, novelId: "different" } } });
  await expect(deleteServerWork(source, undefined, identity)).rejects.toThrow("identity");
  await expect(deleteServerWork(source, undefined, identity)).rejects.toThrow("identity");
  expect(vi.mocked(contentServerRequest).mock.calls.map(call => call[3])).toEqual(["DELETE", "DELETE", "GET"]);
  expect(recordDeletedWorkMetadata).not.toHaveBeenCalled();
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

it("exposes a successful remote deletion before local persistence so its caller can retry without another DELETE", async () => {
  vi.mocked(contentServerRequest).mockResolvedValueOnce(deletedWork);
  const captured = vi.fn();
  vi.mocked(recordDeletedWorkMetadata).mockImplementationOnce(async () => {
    expect(captured).toHaveBeenCalledExactlyOnceWith(deletedWork);
    throw new Error("Cache unavailable");
  });

  await expect(deleteServerWork(source, captured)).rejects.toThrow("Cache unavailable");
  expect(contentServerRequest).toHaveBeenCalledExactlyOnceWith(source.serverUrl, "/works/work-id", "device", "DELETE");
  expect(captured).toHaveBeenCalledOnce();
});

it("deletes and records a work while another metadata operation is still running", async () => {
  let release!: () => void;
  let started = false;
  const upload = runWorkMetadataSyncOperation(source.serverUrl, async () => {
    started = true;
    await new Promise<void>(resolve => { release = resolve; });
  });
  await vi.waitFor(() => expect(started).toBe(true));
  vi.mocked(contentServerRequest).mockResolvedValueOnce(deletedWork);
  let result: WorkCatalogEntry | null | undefined;
  const deletion = deleteServerWork(source).then(entry => { result = entry; });
  try {
    await vi.waitFor(() => expect(result).toBe(deletedWork), { timeout: 100 });
    expect(recordDeletedWorkMetadata).toHaveBeenCalledExactlyOnceWith(source.serverUrl, deletedWork);
  } finally { release(); await Promise.all([upload, deletion]); }
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
