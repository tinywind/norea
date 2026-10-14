import { beforeEach, expect, it, vi } from "vitest";
import { contentServerRequest, ContentServerError } from "./client";
import { registerContentDevice } from "./device";
import { useContentSyncStore } from "../../store/content-sync";
import { findServerWork, loadServerChapterPage, deleteSelectedServerChapters } from "./management";

vi.mock("./client", async importOriginal => ({ ...await importOriginal<typeof import("./client")>(), contentServerRequest: vi.fn() }));
vi.mock("./device", () => ({ registerContentDevice: vi.fn(async () => "device") }));
vi.mock("./works", () => ({ contentWorkId: vi.fn(async () => "work-id") }));
const source = { serverUrl: "http://original-server", workId: "work-id" };
const identity = { pluginId: "plugin", novelPath: "/work" };
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
