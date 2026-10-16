import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueryFilters } from "@tanstack/react-query";
import type { TaskEvent } from "../../lib/tasks/scheduler";

interface AvailabilityQuery {
  enabled: boolean;
  queryKey: readonly ["novel", "library", "batch-download", number[]];
  queryFn: (context: { signal: AbortSignal }) => Promise<boolean>;
}
const mocks = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | undefined>,
  queries: [] as AvailabilityQuery[],
  cancelQueries: vi.fn(async (_filters: QueryFilters): Promise<void> => undefined),
  invalidateQueries: vi.fn(async (_filters: QueryFilters): Promise<void> => undefined),
  targets: vi.fn(async (_ids: Iterable<number>, _signal?: AbortSignal) => true),
  taskListener: undefined as ((event: TaskEvent) => void) | undefined,
  queueListener: undefined as (() => void) | undefined,
  metadataListener: undefined as (() => void) | undefined,
}));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => (() => void) | undefined) => mocks.effects.push(effect),
  useMemo: (get: () => unknown) => get(),
}));
const queryClient = { cancelQueries: mocks.cancelQueries, invalidateQueries: mocks.invalidateQueries };
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => queryClient,
  useQuery: (query: AvailabilityQuery) => {
    mocks.queries.push(query);
    return { data: true };
  },
}));
vi.mock("../../db/content-sync-journal", () => ({
  subscribeContentSyncChanges: (listener: () => void) => {
    mocks.metadataListener = listener;
    return () => { mocks.metadataListener = undefined; };
  },
}));
vi.mock("../../lib/tasks/chapter-download-activity", () => ({
  subscribeChapterDownloadsSettled: (listener: () => void) => {
    mocks.queueListener = listener;
    return () => { mocks.queueListener = undefined; };
  },
}));
vi.mock("../../lib/tasks/scheduler", () => ({
  taskScheduler: {
    subscribeEvents: (listener: (event: TaskEvent) => void) => {
      mocks.taskListener = listener;
      return () => { mocks.taskListener = undefined; };
    },
  },
}));
vi.mock("./library-batch-download", () => ({
  hasLibraryBatchDownloadTargets: mocks.targets,
}));
import { useLibraryDownloadAvailability } from "./use-library-download-availability";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cancelQueries.mockReset().mockResolvedValue(undefined);
  mocks.invalidateQueries.mockReset().mockResolvedValue(undefined);
  mocks.targets.mockReset().mockResolvedValue(true);
  vi.useFakeTimers();
  mocks.effects.length = 0;
  mocks.queries.length = 0;
  mocks.taskListener = undefined;
  mocks.queueListener = undefined;
  mocks.metadataListener = undefined;
});
afterEach(() => vi.useRealTimers());

function downloadEvent(novelId: number, status: string, previousStatus: string | null): TaskEvent {
  return { task: { kind: "chapter.download", status, subject: { novelId } }, previousStatus } as TaskEvent;
}

it("keys availability to the current selection and skips inactive or empty pages", async () => {
  useLibraryDownloadAvailability(new Set([8, 2]), true);
  const first = mocks.queries[0]!;
  expect(first.enabled).toBe(true);
  expect(first.queryKey).toEqual(["novel", "library", "batch-download", [2, 8]]);
  const signal = new AbortController().signal;
  await first.queryFn({ signal });
  expect(mocks.targets).toHaveBeenCalledWith([2, 8], signal);

  useLibraryDownloadAvailability(new Set([9]), true);
  expect(mocks.queries[1]!.queryKey[3]).toEqual([9]);
  useLibraryDownloadAvailability(new Set([9]), false);
  expect(mocks.queries[2]!.enabled).toBe(false);
  expect(mocks.effects[2]!()).toBeUndefined();
  useLibraryDownloadAvailability(new Set(), true);
  expect(mocks.queries[3]!.enabled).toBe(false);
  expect(mocks.effects[3]!()).toBeUndefined();
  expect(mocks.taskListener).toBeUndefined();
});

it("refreshes after cancellation, completion, queue removal and metadata changes without polling progress", async () => {
  useLibraryDownloadAvailability(new Set([7]), true);
  const cleanup = mocks.effects[0]!()!;
  mocks.taskListener!(downloadEvent(8, "cancelled", "queued"));
  mocks.taskListener!(downloadEvent(7, "running", "running"));
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.invalidateQueries).not.toHaveBeenCalled();

  mocks.taskListener!(downloadEvent(7, "cancelled", "queued"));
  mocks.taskListener!(downloadEvent(7, "succeeded", "running"));
  mocks.taskListener!(downloadEvent(7, "failed", "running"));
  mocks.queueListener!();
  mocks.metadataListener!();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.cancelQueries).toHaveBeenCalledExactlyOnceWith({
    queryKey: ["novel", "library", "batch-download", [7]], exact: true,
  });
  expect(mocks.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
    queryKey: ["novel", "library", "batch-download", [7]], exact: true,
  });

  mocks.queueListener!();
  cleanup();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.invalidateQueries).toHaveBeenCalledOnce();
  expect(mocks.taskListener).toBeUndefined();
  expect(mocks.queueListener).toBeUndefined();
  expect(mocks.metadataListener).toBeUndefined();
});

it("restarts a delayed initial query when a previously checked work leaves the queue", async () => {
  const { QueryClient, QueryObserver } = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.cancelQueries.mockImplementation(filters => client.cancelQueries(filters));
  mocks.invalidateQueries.mockImplementation(filters => client.invalidateQueries(filters));
  let releaseInitial!: (available: boolean) => void;
  let initialSignal: AbortSignal | undefined;
  mocks.targets.mockImplementationOnce((_ids, signal) => {
    initialSignal = signal;
    return new Promise<boolean>(resolve => { releaseInitial = resolve; });
  });

  useLibraryDownloadAvailability(new Set([7, 8]), true);
  const query = mocks.queries[0]!;
  const observer = new QueryObserver(client, query);
  const unsubscribe = observer.subscribe(() => undefined);
  const cleanup = mocks.effects[0]!()!;
  try {
    expect(mocks.targets).toHaveBeenCalledOnce();
    expect(client.getQueryData(query.queryKey)).toBeUndefined();
    expect(client.getQueryState(query.queryKey)?.fetchStatus).toBe("fetching");

    mocks.queueListener!();
    await vi.advanceTimersByTimeAsync(100);

    expect(initialSignal?.aborted).toBe(true);
    expect(mocks.targets).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(query.queryKey)).toBe(true);
    releaseInitial(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(query.queryKey)).toBe(true);
  } finally {
    cleanup();
    unsubscribe();
    client.clear();
  }
});
