import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { notifyChapterDownloadsSettled } from "../../lib/tasks/chapter-download-activity";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  client: undefined as QueryClient | undefined,
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => harness.effects.push(effect),
  useMemo: (factory: () => unknown) => factory(),
  useRef: () => ({ current: null }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => harness.client,
  useQuery: () => ({}),
  useInfiniteQuery: () => ({ data: { pages: [] } }),
}));

import { useLibraryQuery } from "./use-library-query";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  harness.effects.length = 0;
  harness.client?.clear();
});

it.each([
  { active: true, settledBeforeEntry: false },
  { active: false, settledBeforeEntry: false },
  { active: true, settledBeforeEntry: true },
])("refreshes repair tags and works (active: $active, settled before entry: $settledBeforeEntry)", async ({ active, settledBeforeEntry }) => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  harness.client = client;
  let needsRepair = true;
  const summaryKey = ["novel", "library", "summary", { categoryId: 2 }] as const;
  const repairKey = ["novel", "library", { categoryId: 2, repairNeededOnly: true, limit: 100 }] as const;
  const ordinaryKey = ["novel", "library", { categoryId: 2, repairNeededOnly: false }] as const;
  const summaryQuery = vi.fn(async () => ({ repairNeededNovels: Number(needsRepair) }));
  const repairQuery = vi.fn(async () => needsRepair ? [7] : []);
  const ordinaryQuery = vi.fn(async () => [7, 8]);
  cleanups.push(
    new QueryObserver(client, { queryKey: summaryKey, queryFn: summaryQuery }).subscribe(() => undefined),
    new QueryObserver(client, { queryKey: repairKey, queryFn: repairQuery }).subscribe(() => undefined),
    new QueryObserver(client, { queryKey: ordinaryKey, queryFn: ordinaryQuery }).subscribe(() => undefined),
  );
  await vi.waitFor(() => expect(client.getQueryData(repairKey)).toEqual([7]));

  if (settledBeforeEntry) {
    useLibraryQuery(false, { categoryId: 2, repairNeededOnly: true }, "nameAsc");
    for (const effect of harness.effects.splice(0)) effect();
    needsRepair = false;
  }
  useLibraryQuery(active, { categoryId: 2, repairNeededOnly: true }, "nameAsc");
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  if (!settledBeforeEntry) {
    needsRepair = false;
    notifyChapterDownloadsSettled();
  }
  if (active) {
    await vi.waitFor(() => {
      expect(client.getQueryData(summaryKey)).toEqual({ repairNeededNovels: 0 });
      expect(client.getQueryData(repairKey)).toEqual([]);
    });
  } else {
    expect(summaryQuery).toHaveBeenCalledTimes(1);
    expect(repairQuery).toHaveBeenCalledTimes(1);
  }
  expect(ordinaryQuery).toHaveBeenCalledTimes(1);
  for (const cleanup of cleanups.splice(0)) cleanup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  notifyChapterDownloadsSettled();
  expect(invalidate).not.toHaveBeenCalled();
});
