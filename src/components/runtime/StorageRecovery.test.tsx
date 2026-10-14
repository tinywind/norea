import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  effects: [] as (() => (() => void))[],
  invalidateQueries: vi.fn(async (_options: { queryKey: readonly unknown[]; refetchType?: string }, _config?: { cancelRefetch: boolean }) => undefined),
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => (() => void)) => { mocks.effects.push(effect); },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }));
vi.mock("../../db/client", () => ({ startWorkMetadataRecovery: vi.fn() }));
import { StorageRecoveryNotifications } from "./StorageRecovery";
import { useStorageRecoveryStore } from "../../store/storage-recovery";

let cleanup: () => void;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); mocks.effects = [];
  useStorageRecoveryStore.setState({ status: "idle", error: null, progress: null });
  StorageRecoveryNotifications();
  cleanup = mocks.effects[0]!();
  mocks.invalidateQueries.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

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
  expect(mocks.invalidateQueries.mock.calls.filter(([options]) => options.queryKey[1] === "library")).toHaveLength(1);
  cleanup(); mocks.invalidateQueries.mockClear();
  useStorageRecoveryStore.setState({ status: "error", error: "Unavailable" });
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.invalidateQueries).not.toHaveBeenCalled();
});
