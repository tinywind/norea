import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => (() => void))[],
  invalidateQueries: vi.fn<QueryClient["invalidateQueries"]>(),
  refetchQueries: vi.fn<QueryClient["refetchQueries"]>(),
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => (() => void)) => { mocks.effects.push(effect); },
}));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries, refetchQueries: mocks.refetchQueries }),
}));
vi.mock("../../db/client", () => ({ startWorkMetadataRecovery: vi.fn() }));
import { StorageRecoveryNotifications } from "./StorageRecovery";
import { useStorageRecoveryStore } from "../../store/storage-recovery";
import { notifyWorkMetadataChanges } from "../../lib/work-metadata";

let cleanup: () => void;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.effects = [];
  mocks.invalidateQueries.mockReset().mockResolvedValue(undefined);
  mocks.refetchQueries.mockReset().mockResolvedValue(undefined);
  useStorageRecoveryStore.setState({ status: "idle", error: null, progress: null });
  StorageRecoveryNotifications();
  cleanup = mocks.effects[0]!();
  mocks.invalidateQueries.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("refreshes visible work details and titles after a background metadata publication", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  mocks.invalidateQueries.mockImplementation((...args) => client.invalidateQueries(...args));
  mocks.refetchQueries.mockImplementation((...args) => client.refetchQueries(...args));
  let title = "Before refresh";
  const novel = new QueryObserver(client, { queryKey: ["novel", "detail", 7], queryFn: async () => ({ name: title }) });
  const chapters = new QueryObserver(client, { queryKey: ["novel", "detail", 7, "chapters"], queryFn: async () => [{ name: title }] });
  const unsubscribeNovel = novel.subscribe(() => undefined);
  const unsubscribeChapters = chapters.subscribe(() => undefined);
  try {
    await novel.refetch(); await chapters.refetch();
    title = "After refresh";
    notifyWorkMetadataChanges();
    await vi.advanceTimersByTimeAsync(100);
    expect(novel.getCurrentResult().data).toEqual({ name: "After refresh" });
    expect(chapters.getCurrentResult().data).toEqual([{ name: "After refresh" }]);
  } finally { unsubscribeNovel(); unsubscribeChapters(); client.clear(); }
});

it("refreshes the visible library after each recovered work without waiting for completion", async () => {
  useStorageRecoveryStore.setState({ status: "scanning", progress: {
    completedWorks: 1, totalWorks: 10, recoveredWorks: 1, recoveredChapters: 1000, skippedWorks: 0, currentWork: "First",
  } });
  await vi.advanceTimersByTimeAsync(100);
  expect(useStorageRecoveryStore.getState().status).toBe("scanning");
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", "library"] }, { cancelRefetch: false });
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["category", "counts"] }, { cancelRefetch: false });
  mocks.invalidateQueries.mockClear();
  useStorageRecoveryStore.setState({ progress: { ...useStorageRecoveryStore.getState().progress!, recoveredWorks: 2, completedWorks: 2 } });
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["novel", "library"] }, { cancelRefetch: false });
});

it("coalesces rapid results and stops notifications when unmounted", async () => {
  for (let count = 1; count <= 20; count++) useStorageRecoveryStore.setState({ status: "scanning", progress: {
    completedWorks: count, totalWorks: 20, recoveredWorks: count, recoveredChapters: count, skippedWorks: 0, currentWork: null,
  } });
  useStorageRecoveryStore.setState({ status: "complete" });
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.invalidateQueries.mock.calls.filter(([options]) => options?.queryKey?.[1] === "library")).toHaveLength(1);
  cleanup(); mocks.invalidateQueries.mockClear();
  useStorageRecoveryStore.setState({ status: "error", error: "Unavailable" });
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.invalidateQueries).not.toHaveBeenCalled();
});

it.each([false, true])("updates an open chapter list after recovery without reloading work metadata (pending read: %s)", async (pendingRead) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  mocks.invalidateQueries.mockImplementation((...args) => client.invalidateQueries(...args));
  mocks.refetchQueries.mockImplementation((...args) => client.refetchQueries(...args));
  let downloaded = false;
  let holdNextRead = false;
  let releaseRead!: () => void;
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const readChapters = vi.fn(async () => {
    const rows = [{ id: 1, isDownloaded: downloaded }];
    if (holdNextRead) { holdNextRead = false; await readGate; }
    return rows;
  });
  const readNovel = vi.fn(async () => ({ id: 7, name: "Stored work" }));
  const chapters = new QueryObserver(client, { queryKey: ["novel", "detail", 7, "chapters"], queryFn: readChapters });
  const novel = new QueryObserver(client, { queryKey: ["novel", "detail", 7], queryFn: readNovel });
  const unsubscribeChapters = chapters.subscribe(() => undefined);
  const unsubscribeNovel = novel.subscribe(() => undefined);
  try {
    await chapters.refetch(); await novel.refetch();
    expect(chapters.getCurrentResult().data?.[0]?.isDownloaded).toBe(false);
    readNovel.mockClear();
    if (pendingRead) { holdNextRead = true; void chapters.refetch(); }
    downloaded = true;
    useStorageRecoveryStore.setState({ status: "scanning", progress: {
      completedWorks: 1, totalWorks: 10, recoveredWorks: 1, recoveredChapters: 1, skippedWorks: 0, currentWork: "Stored work",
    } });
    await vi.advanceTimersByTimeAsync(100);
    expect(chapters.getCurrentResult().data?.[0]?.isDownloaded).toBe(true);
    expect(readNovel).not.toHaveBeenCalled();
    expect(useStorageRecoveryStore.getState().status).toBe("scanning");
    releaseRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(chapters.getCurrentResult().data?.[0]?.isDownloaded).toBe(true);
  } finally {
    releaseRead();
    unsubscribeChapters(); unsubscribeNovel(); client.clear();
  }
});
