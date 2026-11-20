import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserStateApplyEffects } from "./types";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), hasSendable: vi.fn(), active: vi.fn(), applyResume: vi.fn(),
  localListener: undefined as ((priority: "reading" | "normal") => void) | undefined,
  appliedListener: undefined as ((effects: UserStateApplyEffects) => void) | undefined,
}));
vi.mock("./sync", () => ({
  synchronizeUserState: mocks.sync,
  hasSendableUserStateChanges: mocks.hasSendable,
}));
vi.mock("../../db/user-state", () => ({
  setUserStateActiveServer: mocks.active,
  subscribeUserStateChanges: (listener: (priority: "reading" | "normal") => void) => {
    mocks.localListener = listener; return () => { mocks.localListener = undefined; };
  },
  subscribeUserStateApplied: (listener: (effects: UserStateApplyEffects) => void) => {
    mocks.appliedListener = listener; return () => { mocks.appliedListener = undefined; };
  },
}));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ applySharedResume: mocks.applyResume }) } }));
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { registerBeforeAppSuspend } from "../app-lifecycle";
import { ContentServerError } from "../content-sync/client";
import { useNetworkStore } from "../network";
import { getSyncRuntimeSnapshot, resetSyncRuntimeForTests } from "../tasks/sync-runtime";
import { requestUserStateFlush } from "./events";
import {
  startUserStateScheduler, USER_STATE_COMMAND_DEBOUNCE_MS, USER_STATE_POLL_MS, USER_STATE_READING_DEBOUNCE_MS,
} from "./scheduler";
import { UserStateProtocolError } from "./types";

let cleanup: (() => void) | undefined;
let documentTarget: EventTarget;
let browserWindow: EventTarget;
let environment: { visibilityState: "visible" | "hidden" };
let network: { onLine: boolean };
beforeEach(() => {
  resetSyncRuntimeForTests();
  vi.useFakeTimers(); vi.clearAllMocks();
  useContentSyncStore.setState({ serverUrl: "http://server", deviceName: "Tablet" });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {} });
  mocks.sync.mockResolvedValue(undefined);
  mocks.hasSendable.mockResolvedValue(false);
  documentTarget = new EventTarget(); browserWindow = new EventTarget();
  environment = { visibilityState: "visible" }; network = { onLine: true };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", {
    get visibilityState() { return environment.visibilityState; },
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
  });
  vi.stubGlobal("navigator", network);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  resetSyncRuntimeForTests();
  useNetworkStore.setState({ connectivity: "online", revision: -1 });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("performs no automatic traffic until this specific server is enabled", async () => {
  cleanup = startUserStateScheduler();
  mocks.localListener?.("reading");
  requestUserStateFlush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).not.toHaveBeenCalled();
  useUserStateStore.getState().setEnabled("http://other", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  useUserStateStore.getState().setEnabled("http://server", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("debounces reading state for 20 seconds but keeps commands and explicit flushes fast", async () => {
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  mocks.localListener?.("reading");
  await vi.advanceTimersByTimeAsync(USER_STATE_READING_DEBOUNCE_MS / 2);
  mocks.localListener?.("reading");
  await vi.advanceTimersByTimeAsync(USER_STATE_READING_DEBOUNCE_MS - 1);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  for (let index = 0; index < 20; index++) mocks.localListener?.("normal");
  await vi.advanceTimersByTimeAsync(USER_STATE_COMMAND_DEBOUNCE_MS - 1);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(3);

  mocks.localListener?.("reading");
  requestUserStateFlush();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(4);
});

it("polls at one minute only while visible and skips idle background flushes", async () => {
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(USER_STATE_POLL_MS - 1);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(USER_STATE_POLL_MS * 2);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
});

it("flushes on backgrounding and again when a final hidden reading write commits", async () => {
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  mocks.localListener?.("reading");

  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  mocks.localListener?.("reading");
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(3);

  environment.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(4);
});

it("projects shared resumes and invalidates local views without scheduling an echo", async () => {
  const queryClient = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };
  cleanup = startUserStateScheduler(queryClient);
  const effect = { novelId: 17, chapterId: 29, anchor: null, openedAt: 10 };
  mocks.appliedListener?.({ resumes: [effect] });
  mocks.appliedListener?.({ resumes: [] });
  await vi.advanceTimersByTimeAsync(150);
  expect(mocks.applyResume).toHaveBeenCalledExactlyOnceWith(effect);
  expect(queryClient.invalidateQueries.mock.calls).toEqual([
    [{ queryKey: ["novel"] }], [{ queryKey: ["chapter"] }], [{ queryKey: ["category"] }],
  ]);
  expect(mocks.sync).not.toHaveBeenCalled();
});

it("cancels its active operation on disable and cleans up subscriptions and timers", async () => {
  mocks.sync.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  const signal = mocks.sync.mock.calls[0][0].signal as AbortSignal;
  useUserStateStore.getState().setEnabled("http://server", false);
  await vi.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(true);
  cleanup(); cleanup = undefined;
  expect(mocks.localListener).toBeUndefined();
  expect(mocks.appliedListener).toBeUndefined();
  requestUserStateFlush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.active).toHaveBeenLastCalledWith(null);
});

it("keeps exponential failure backoff even while reading generates edits", async () => {
  mocks.sync.mockRejectedValue(new Error("server offline"));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  mocks.localListener?.("reading");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 20; index++) mocks.localListener?.("reading");
  await vi.advanceTimersByTimeAsync(3_999);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
});

it("follows native host connectivity in Tauri even when navigator.onLine is stuck at false", async () => {
  mocks.sync.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const tauriWindow = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("window", tauriWindow);
  network.onLine = false;
  useNetworkStore.setState({ connectivity: "online", revision: 8 });
  useUserStateStore.getState().setEnabled("http://server", true);

  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  const firstSignal = mocks.sync.mock.calls[0][0].signal as AbortSignal;

  useNetworkStore.setState({ connectivity: "offline", revision: 9 });
  expect(firstSignal.aborted).toBe(true);
  mocks.localListener?.("reading");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  useNetworkStore.setState({ connectivity: "online", revision: 10 });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
});

it("pauses automatic retries while epochMismatch is active and resumes once cleared", async () => {
  mocks.sync.mockRejectedValueOnce(new Error("epoch changed"));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  useUserStateStore.getState().setEpochMismatch("http://server", {
    serverUrl: "http://server",
    localWorkspaceId: "ws-1",
    localEpoch: "ep-1",
    serverWorkspaceId: "ws-1",
    serverEpoch: "ep-2",
    headRevision: 0,
    detectedAt: 1000,
  });
  mocks.localListener?.("normal");
  requestUserStateFlush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  mocks.sync.mockResolvedValue(undefined);
  useUserStateStore.getState().setEpochMismatch("http://server", null);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
});

it("pauses retries immediately when synchronizeUserState emits epochMismatch during a failing sync", async () => {
  mocks.sync.mockImplementationOnce(async () => {
    useUserStateStore.getState().setEpochMismatch("http://server", {
      serverUrl: "http://server",
      localWorkspaceId: "ws-1",
      localEpoch: "ep-1",
      serverWorkspaceId: "ws-1",
      serverEpoch: "ep-2",
      headRevision: 0,
      detectedAt: 2000,
    });
    throw new Error("the server workspace changed; pending changes were retained");
  });
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  mocks.localListener?.("normal");
  requestUserStateFlush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  mocks.sync.mockResolvedValue(undefined);
  useUserStateStore.getState().setEpochMismatch("http://server", null);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
});

it("drains before-suspend hooks before checking sendable changes and skips background retries on failure", async () => {
  const order: string[] = [];
  const unregister = registerBeforeAppSuspend(async () => {
    order.push("suspend-hook");
  }, "drain");
  mocks.hasSendable.mockImplementation(async () => {
    order.push("check-sendable");
    return true;
  });
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  mocks.sync.mockRejectedValueOnce(new Error("background timeout"));
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual(["suspend-hook", "check-sendable"]);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  // No background retry loop while hidden.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  // Reconnecting while hidden does not wake sync either.
  network.onLine = false;
  browserWindow.dispatchEvent(new Event("offline"));
  network.onLine = true;
  browserWindow.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  unregister();
});

it("stops infinite foreground retry loops on 403 or protocol errors", async () => {
  mocks.sync.mockRejectedValue(new ContentServerError(403, "Blocked"));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  mocks.sync.mockReset().mockRejectedValue(new UserStateProtocolError("incompatible"));
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  environment.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("keeps Android pending background upload hint continuously true across suspend flush and sync handoff", async () => {
  const hints: boolean[] = [];
  const setPendingBackgroundUpload = vi.fn((pending: boolean) => { hints.push(pending); });
  Object.assign(browserWindow, {
    __NoreaAndroidTasks: { setPendingBackgroundUpload },
  });
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  hints.length = 0;

  let finishBackgroundSync!: () => void;
  mocks.hasSendable.mockResolvedValue(true);
  mocks.sync.mockImplementationOnce(
    () => new Promise<void>((resolve) => { finishBackgroundSync = resolve; }),
  );

  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  // Hint stays true without any false dip before synchronizeUserState finishes.
  expect(hints).toEqual([true]);
  expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(true);

  finishBackgroundSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(hints).toEqual([true, false]);
  expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);
});

it("skips suspend flushes and avoids waking Android FGS after 403 or non-retryable errors until resume or config change", async () => {
  const hints: boolean[] = [];
  const setPendingBackgroundUpload = vi.fn((pending: boolean) => { hints.push(pending); });
  Object.assign(browserWindow, {
    __NoreaAndroidTasks: { setPendingBackgroundUpload },
  });
  mocks.hasSendable.mockResolvedValue(true);
  mocks.sync.mockRejectedValueOnce(new ContentServerError(403, "Blocked"));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  hints.length = 0;
  mocks.hasSendable.mockClear();

  // Subsequent local edits and screen-off transitions must not raise the pending-upload hint or flush.
  mocks.localListener?.("reading");
  requestUserStateFlush();
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.hasSendable).not.toHaveBeenCalled();
  expect(hints).toEqual([]);
  expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);

  // Returning to foreground clears nonRetryableStopped and allows one fresh attempt.
  mocks.sync.mockRejectedValueOnce(new Error("This content server does not support shared user changes. Update the server before sharing."));
  environment.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  // Another non-retryable error (unsupported server) again suppresses background suspend flushes.
  hints.length = 0;
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  expect(mocks.hasSendable).not.toHaveBeenCalled();
  expect(hints).toEqual([]);
  expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);

  // Switching to a new enabled server resets nonRetryableStopped via restart().
  mocks.sync.mockResolvedValue(undefined);
  environment.visibilityState = "visible";
  useContentSyncStore.setState({ serverUrl: "http://server-2" });
  useUserStateStore.getState().setEnabled("http://server-2", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
});

it("resumes scheduling after a manual sync recovers from 403 and suppresses flushes after a manual 403 block", async () => {
  const hints: boolean[] = [];
  const setPendingBackgroundUpload = vi.fn((pending: boolean) => { hints.push(pending); });
  Object.assign(browserWindow, {
    __NoreaAndroidTasks: { setPendingBackgroundUpload },
  });
  mocks.hasSendable.mockResolvedValue(true);
  mocks.sync.mockRejectedValueOnce(new ContentServerError(403, "Blocked"));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);

  // Manual Sync Now in Settings succeeds while staying in foreground (syncing -> idle).
  mocks.sync.mockResolvedValue(undefined);
  useUserStateStore.getState().setRuntime("http://server", "syncing");
  useUserStateStore.getState().setRuntime("http://server", "idle");

  // Local edits and suspend flush work again without needing a foreground hide/resume cycle.
  hints.length = 0;
  mocks.localListener?.("reading");
  expect(hints).toEqual([true]);
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(2);

  // Returning to foreground and hitting a manual 403 suppresses subsequent edits and suspend flushes.
  environment.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(3);

  hints.length = 0;
  mocks.hasSendable.mockClear();
  useUserStateStore.getState().setRuntime("http://server", "error", "HTTP 403", true);
  mocks.localListener?.("normal");
  requestUserStateFlush();
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
  expect(mocks.hasSendable).not.toHaveBeenCalled();
  expect(hints).toEqual([]);
  expect(getSyncRuntimeSnapshot().hasPendingBackgroundUpload).toBe(false);
});
