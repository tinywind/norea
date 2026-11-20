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
vi.mock("../../db/queries/content-sync", () => ({ listNovelMigrations: vi.fn(async () => []) }));
vi.mock("./sync", () => ({
  abortActiveContentSync: vi.fn(),
  syncContentServer: vi.fn(),
  syncReceivedWorkMigrations: vi.fn(),
  getContentSyncCursors: vi.fn(async () => ({ catalogCursor: 3, workCursor: 2 })),
}));
vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), contentServerRequest: vi.fn() }));
import { useContentSyncStore } from "../../store/content-sync";
import { ContentServerError, contentServerRequest } from "./client";
import { getContentSyncCursors, syncContentServer, syncReceivedWorkMigrations } from "./sync";
import { startContentServerSync } from "./scheduler";
import { listNovelMigrations } from "../../db/queries/content-sync";
import { PendingNovelMigrationError } from "./novel-migration";
import { PendingIncomingMigrationError } from "./migration-feed";
import { WorkMetadataChangedOutsideCacheError } from "./works";
import { useNetworkStore } from "../network";
import { notifyChapterDownloadsSettled } from "../tasks/chapter-download-activity";
import {
  markDeferredContentUploadDueToDownload,
  resetSyncRuntimeForTests,
} from "../tasks/sync-runtime";

let cleanup: (() => void) | undefined;
let page: EventTarget & { visibilityState: string };
beforeEach(() => {
  resetSyncRuntimeForTests();
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(listNovelMigrations).mockResolvedValue([]);
  vi.stubGlobal("window", new EventTarget());
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", { onLine: true });
  useContentSyncStore.setState({ ...useContentSyncStore.getInitialState(), serverUrl: "http://server" });
  vi.mocked(syncContentServer).mockReset().mockResolvedValue();
  vi.mocked(syncReceivedWorkMigrations).mockReset().mockResolvedValue({ applied: 0, pending: 0 });
  vi.mocked(getContentSyncCursors).mockReset().mockResolvedValue({ catalogCursor: 3, workCursor: 2 });
  vi.mocked(contentServerRequest).mockImplementation((_server, _path, _token, _method, _body, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  resetSyncRuntimeForTests();
  useNetworkStore.setState({ connectivity: "online", revision: -1 });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps ordinary synchronization manual while local changes are recorded", async () => {
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

it.each(["manual", "periodic", "changes"] as const)("retries deferred uploads after queue settlement only in changes mode (%s)", async syncMode => {
  useContentSyncStore.setState({ syncMode });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(syncContentServer).mockClear();
  notifyChapterDownloadsSettled();
  notifyChapterDownloadsSettled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(syncContentServer).toHaveBeenCalledTimes(syncMode === "changes" ? 1 : 0);
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

it("sends overrideAfter when supported and wakes sync when overrideCursor advances", async () => {
  vi.mocked(getContentSyncCursors).mockResolvedValueOnce({ catalogCursor: 3, workCursor: 2, overrideCursor: 7 });
  useContentSyncStore.setState({ syncMode: "changes", deviceKey: "device-key" });
  vi.mocked(contentServerRequest).mockResolvedValueOnce({ catalogCursor: 3, workCursor: 2, overrideCursor: 8 });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(10);
  expect(contentServerRequest).toHaveBeenCalledWith(
    "http://server",
    "/changes?catalogAfter=3&workAfter=2&overrideAfter=7&waitSeconds=20",
    "device-key",
    "GET",
    undefined,
    expect.any(AbortSignal),
  );
  expect(syncContentServer).toHaveBeenCalledTimes(2);
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

it("resumes an approved unfinished migration once after restart without enabling automatic sync", async () => {
  vi.mocked(listNovelMigrations).mockResolvedValue([{ status: "failed" }] as never);
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledOnce();
  expect(useContentSyncStore.getState().syncMode).toBe("manual");
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(syncContentServer).toHaveBeenCalledOnce();
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("does not automatically retry a migration requiring conflict review", async () => {
  vi.mocked(listNovelMigrations).mockResolvedValue([{ status: "blocked" }] as never);
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("ignores a stale pending-migration lookup after the server changes", async () => {
  let resolve!: (jobs: never[]) => void;
  vi.mocked(listNovelMigrations).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  cleanup = startContentServerSync();
  useContentSyncStore.setState({ serverUrl: "http://other" });
  resolve([{ status: "pending" }] as never);
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("does not repeatedly retry a blocked migration while normal change watching continues", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  vi.mocked(syncContentServer).mockRejectedValue(new PendingNovelMigrationError(1, "Review the original", false));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).toHaveBeenCalledExactlyOnceWith(true, false, false);
  expect(contentServerRequest).toHaveBeenCalledOnce();
});

it("receives only migration events at manual startup and every thirty seconds without status flicker", async () => {
  const changes: string[] = [];
  const unsubscribe = useContentSyncStore.subscribe(state => { changes.push(state.status); });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  harness.localChange?.(); harness.metadataChange?.(); notifyChapterDownloadsSettled();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
  expect(syncContentServer).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
  expect(changes).toEqual([]);
  unsubscribe();
});

it("cancels incoming work when disconnected, receives on reconnect, and aborts on disposal", async () => {
  vi.mocked(syncReceivedWorkMigrations).mockImplementation(signal => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  const first = vi.mocked(syncReceivedWorkMigrations).mock.calls[0]![0]!;
  vi.stubGlobal("navigator", { onLine: false });
  window.dispatchEvent(new Event("offline"));
  expect(first.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(1);
  vi.stubGlobal("navigator", { onLine: true });
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
  const second = vi.mocked(syncReceivedWorkMigrations).mock.calls[1]![0]!;
  cleanup(); cleanup = undefined;
  expect(second.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
  expect(useContentSyncStore.getState().error).toBeNull();
});

it("does not poll a hidden manual client and resumes when it becomes visible", async () => {
  page.visibilityState = "hidden";
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncReceivedWorkMigrations).not.toHaveBeenCalled();
  page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledOnce();
});

it("ignores stale incoming results after changing servers and passes cancellation to the old request", async () => {
  let release!: (result: { applied: number; pending: number; error?: string; retryable?: boolean }) => void;
  vi.mocked(syncReceivedWorkMigrations).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  const first = vi.mocked(syncReceivedWorkMigrations).mock.calls[0]![0]!;
  useContentSyncStore.getState().setServerUrl("http://other");
  useContentSyncStore.setState({ status: "error", error: "An unrelated operation failed" });
  expect(first.aborted).toBe(true);
  release({ applied: 0, pending: 1, error: "Old server review", retryable: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
  expect(useContentSyncStore.getState().error).toBe("An unrelated operation failed");
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("waits for an aborted manual receipt before starting the newly selected change watcher", async () => {
  let release!: (result: { applied: number; pending: number }) => void;
  vi.mocked(syncReceivedWorkMigrations).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  const signal = vi.mocked(syncReceivedWorkMigrations).mock.calls[0]![0]!;
  useContentSyncStore.getState().setSyncMode("changes");
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).not.toHaveBeenCalled();
  release({ applied: 0, pending: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledOnce();
  expect(contentServerRequest).toHaveBeenCalledOnce();
});

it("finishes the approved outgoing resume before receiving manual migration events", async () => {
  let release!: () => void;
  vi.mocked(listNovelMigrations).mockResolvedValue([{ status: "failed" }] as never);
  vi.mocked(syncContentServer).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(syncContentServer).toHaveBeenCalledOnce();
  expect(syncReceivedWorkMigrations).not.toHaveBeenCalled();
  release(); await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(syncContentServer).toHaveBeenCalledOnce();
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
});

it("backs off manual transport failures up to sixty seconds and clears only its own error", async () => {
  vi.mocked(syncReceivedWorkMigrations).mockRejectedValue(new Error("Incoming network unavailable"));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(useContentSyncStore.getState()).toMatchObject({ status: "error", error: "Incoming network unavailable" });
  for (const [index, delay] of [2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(index + 2);
  }
  vi.mocked(syncReceivedWorkMigrations).mockResolvedValue({ applied: 0, pending: 0 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(useContentSyncStore.getState()).toMatchObject({ status: "idle", error: null });
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("shows manual conflict review without fast retries and keeps polling for later lineage events", async () => {
  vi.mocked(syncReceivedWorkMigrations).mockResolvedValue({ applied: 0, pending: 1, error: "Review the chapter mapping", retryable: false });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(useContentSyncStore.getState().status).toBe("error");
  expect(useContentSyncStore.getState().error).toContain("Review the chapter mapping");
  await vi.advanceTimersByTimeAsync(29_999);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("does not overwrite or clear an unrelated full-sync error during manual incoming polls", async () => {
  useContentSyncStore.setState({ status: "error", error: "Upload storage is full" });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(useContentSyncStore.getState().error).toBe("Upload storage is full");
  vi.mocked(syncReceivedWorkMigrations).mockResolvedValue({ applied: 0, pending: 1, error: "Review migration", retryable: false });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(useContentSyncStore.getState().error).toBe("Upload storage is full");
});

it("keeps change watching without rapidly retrying a nonretryable incoming conflict", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  vi.mocked(syncContentServer).mockRejectedValue(new PendingIncomingMigrationError(1, "Review incoming", false));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).toHaveBeenCalledExactlyOnceWith(true, false, false);
  expect(contentServerRequest).toHaveBeenCalledOnce();
});

it("retries a pending incoming transfer with backoff while leaving ordinary manual sync disabled", async () => {
  vi.mocked(syncReceivedWorkMigrations).mockResolvedValueOnce({ applied: 0, pending: 1, error: "A transfer can resume", retryable: true });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(useContentSyncStore.getState().error).toContain("A transfer can resume");
  await vi.advanceTimersByTimeAsync(1999);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
  expect(useContentSyncStore.getState()).toMatchObject({ status: "idle", error: null });
  expect(syncContentServer).not.toHaveBeenCalled();
});

it("follows native host connectivity in Tauri even when navigator.onLine is stuck at false", async () => {
  vi.mocked(syncReceivedWorkMigrations).mockImplementation(signal => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const tauriWindow = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("window", tauriWindow);
  vi.stubGlobal("navigator", { onLine: false });
  useNetworkStore.setState({ connectivity: "online", revision: 8 });

  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(1);
  const first = vi.mocked(syncReceivedWorkMigrations).mock.calls[0]![0]!;

  useNetworkStore.setState({ connectivity: "offline", revision: 9 });
  expect(first.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(1);

  useNetworkStore.setState({ connectivity: "online", revision: 10 });
  await vi.advanceTimersByTimeAsync(0);
  expect(syncReceivedWorkMigrations).toHaveBeenCalledTimes(2);
});

it("flushes pending local uploads on hide without polling or retrying in background", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(syncContentServer).mockClear();
  vi.mocked(contentServerRequest).mockClear();

  // Idle hide triggers neither a sync nor /changes waiting.
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();

  // A pending local upload flushes at 0ms when hiding, then stops without retry loops if it fails.
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(syncContentServer).mockReset().mockRejectedValue(new Error("background upload failed"));
  vi.mocked(contentServerRequest).mockClear();
  harness.localChange?.();
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("triggers background download settlement sync only when deferred or local uploads exist", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  page.visibilityState = "hidden";
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);

  notifyChapterDownloadsSettled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(syncContentServer).not.toHaveBeenCalled();

  markDeferredContentUploadDueToDownload();
  notifyChapterDownloadsSettled();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("does not wake on reconnect while hidden and stops auto-retries on 403 or outside-cache conflicts", async () => {
  useContentSyncStore.setState({ syncMode: "changes" });
  page.visibilityState = "hidden";
  cleanup = startContentServerSync();
  vi.stubGlobal("navigator", { onLine: false });
  window.dispatchEvent(new Event("offline"));
  vi.stubGlobal("navigator", { onLine: true });
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).not.toHaveBeenCalled();

  vi.mocked(syncContentServer).mockRejectedValue(new ContentServerError(403, "Blocked"));
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(syncContentServer).toHaveBeenCalledTimes(1);

  vi.mocked(syncContentServer).mockReset().mockRejectedValue(new WorkMetadataChangedOutsideCacheError(["work-1"]));
  useContentSyncStore.getState().setSyncMode("periodic");
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
});

it("ignores spoofed Android View.VISIBLE state while the native activity is paused", async () => {
  const androidWindow = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {},
    __NoreaAndroidBridge: {},
    __NoreaAndroidTasks: { isAppActive: () => false },
  });
  vi.stubGlobal("window", androidWindow);
  page.visibilityState = "visible";
  useContentSyncStore.setState({ syncMode: "changes" });
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(syncContentServer).not.toHaveBeenCalled();
  expect(contentServerRequest).not.toHaveBeenCalled();
});

it("keeps Android pending background upload continuously true across deferred download settlement without a false dip", async () => {
  const hints: boolean[] = [];
  const setPendingBackgroundUpload = vi.fn((pending: boolean) => { hints.push(pending); });
  Object.assign(window, {
    __NoreaAndroidTasks: { setPendingBackgroundUpload },
  });
  let finishUpload!: () => void;
  vi.mocked(syncContentServer).mockImplementationOnce(
    () => new Promise<void>((resolve) => { finishUpload = resolve; }),
  );
  useContentSyncStore.setState({ syncMode: "changes" });
  page.visibilityState = "hidden";
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);

  markDeferredContentUploadDueToDownload();
  notifyChapterDownloadsSettled();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  // Hint must stay continuously true with zero intermediate false transition before upload finishes.
  expect(hints).toEqual([true]);

  finishUpload();
  await vi.advanceTimersByTimeAsync(0);
  expect(hints).toEqual([true, false]);
});

it("suppresses local upload hints and suspend flushes after 403 until manual sync succeeds or app resumes", async () => {
  const hints: boolean[] = [];
  const setPendingBackgroundUpload = vi.fn((pending: boolean) => { hints.push(pending); });
  Object.assign(window, {
    __NoreaAndroidTasks: { setPendingBackgroundUpload },
  });
  useContentSyncStore.setState({ syncMode: "changes" });
  vi.mocked(syncContentServer).mockRejectedValueOnce(new ContentServerError(403, "Blocked"));
  cleanup = startContentServerSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(1);

  hints.length = 0;
  harness.localChange?.();
  notifyChapterDownloadsSettled();
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(syncContentServer).toHaveBeenCalledTimes(1);
  expect(hints).toEqual([]);

  // Returning to foreground resets the block guard and tries once; manual recovery also clears it.
  vi.mocked(syncContentServer).mockRejectedValueOnce(new ContentServerError(403, "Blocked"));
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncContentServer).toHaveBeenCalledTimes(2);

  vi.mocked(syncContentServer).mockResolvedValue(undefined);
  useContentSyncStore.setState({ status: "syncing", error: null, blocked: false });
  useContentSyncStore.setState({ status: "idle", error: null, blocked: false });
  harness.localChange?.();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(syncContentServer).toHaveBeenCalledTimes(3);
});
