import { afterEach, beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  localChange: undefined as (() => void) | undefined,
  metadataChange: undefined as (() => void) | undefined,
}));
vi.mock("../work-metadata", () => ({ subscribeWorkMetadataChanges: (listener: () => void) => {
  harness.metadataChange = listener;
  return () => { harness.metadataChange = undefined; };
} }));
vi.mock("../../db/content-sync-journal", () => ({ subscribeContentSyncChanges: (listener: () => void) => {
  harness.localChange = listener;
  return () => { harness.localChange = undefined; };
} }));
vi.mock("./sync", () => ({
  syncContentServer: vi.fn(),
  getContentSyncCursors: vi.fn(async () => ({ catalogCursor: 3, workCursor: 2 })),
}));
vi.mock("./client", () => ({ contentServerRequest: vi.fn() }));
import { useContentSyncStore } from "../../store/content-sync";
import { contentServerRequest } from "./client";
import { syncContentServer } from "./sync";
import { startContentServerSync } from "./scheduler";

let cleanup: (() => void) | undefined;
let page: EventTarget & { visibilityState: string };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("window", new EventTarget());
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", { onLine: true });
  useContentSyncStore.setState({ ...useContentSyncStore.getInitialState(), serverUrl: "http://server" });
  vi.mocked(syncContentServer).mockResolvedValue();
  vi.mocked(contentServerRequest).mockImplementation((_server, _path, _token, _method, _body, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("records local changes in manual mode without starting automatic requests", async () => {
  cleanup = startContentServerSync();
  harness.localChange?.();
  window.dispatchEvent(new Event("online"));
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(syncContentServer).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("runs periodic sync at the configured interval without reacting to local changes", async () => {
  useContentSyncStore.setState({ syncMode: "periodic", syncIntervalMinutes: 5 });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  harness.localChange?.();
  await vi.advanceTimersByTimeAsync(299_999);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncContentServer).toHaveBeenCalledTimes(2);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("coalesces local changes and queues a second pass for changes during a transfer", async () => {
  let release: () => void = () => undefined;
  vi.mocked(syncContentServer).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  useContentSyncStore.setState({ syncMode: "changes" });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  harness.localChange?.();
  harness.localChange?.();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1500);
  expect(syncContentServer).toHaveBeenCalledTimes(2);
  expect(contentServerRequest).toHaveBeenCalledOnce();
});

it("syncs a server notification using the saved cursors", async () => {
  useContentSyncStore.setState({ syncMode: "changes", deviceKey: "device-key" });
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ catalogCursor: 4, workCursor: 2 });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(10);
  expect(contentServerRequest).toHaveBeenCalledWith("http://server", "/changes?catalogAfter=3&workAfter=2&waitSeconds=20", "device-key", "GET", undefined, expect.any(AbortSignal));
  expect(syncContentServer).toHaveBeenCalledTimes(2);
});

it("syncs work-only server changes and local metadata changes", async () => {
  useContentSyncStore.setState({ syncMode: "changes", deviceKey: "device-key" });
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ catalogCursor: 3, workCursor: 3 });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(10);
  expect(syncContentServer).toHaveBeenCalledTimes(2);
  harness.metadataChange?.();
  await vi.advanceTimersByTimeAsync(1500);
  expect(syncContentServer).toHaveBeenCalledTimes(3);
});

it("cancels change waiting on manual mode, hiding, and disposal", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  const firstSignal = vi.mocked(contentServerRequest).mock.calls[0]![5]!;
  useContentSyncStore.getState().setSyncMode("manual");
  expect(firstSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  useContentSyncStore.getState().setSyncMode("changes");
  await vi.advanceTimersByTimeAsync(0);
  const secondSignal = vi.mocked(contentServerRequest).mock.calls[1]![5]!;
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(secondSignal.aborted).toBe(true);
  cleanup();
  expect(harness.localChange).toBeUndefined();
});

it("backs off failed automatic sync instead of retrying continuously", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  vi.mocked(syncContentServer).mockRejectedValue(new Error("offline"));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncContentServer).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3999);
  expect(syncContentServer).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncContentServer).toHaveBeenCalledTimes(3);
});

it("backs off change-wait failures even when ordinary sync succeeds", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  vi.mocked(contentServerRequest).mockRejectedValue(new Error("change endpoint unavailable"));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(contentServerRequest).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(contentServerRequest).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(3999);
  expect(contentServerRequest).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(contentServerRequest).toHaveBeenCalledTimes(3);
});
