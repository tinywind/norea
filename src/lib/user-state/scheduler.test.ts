import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UserStateApplyEffects } from "./types";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), active: vi.fn(), applyResume: vi.fn(),
  localListener: undefined as (() => void) | undefined,
  appliedListener: undefined as ((effects: UserStateApplyEffects) => void) | undefined,
}));
vi.mock("./sync", () => ({ synchronizeUserState: mocks.sync }));
vi.mock("../../db/user-state", () => ({
  setUserStateActiveServer: mocks.active,
  subscribeUserStateChanges: (listener: () => void) => { mocks.localListener = listener; return () => { mocks.localListener = undefined; }; },
  subscribeUserStateApplied: (listener: (effects: UserStateApplyEffects) => void) => { mocks.appliedListener = listener; return () => { mocks.appliedListener = undefined; }; },
}));
vi.mock("../../store/reader", () => ({ useReaderStore: { getState: () => ({ applySharedResume: mocks.applyResume }) } }));
import { useContentSyncStore } from "../../store/content-sync";
import { useUserStateStore } from "../../store/user-state";
import { startUserStateScheduler } from "./scheduler";

let cleanup: (() => void) | undefined;
let documentTarget: EventTarget;
let browserWindow: EventTarget;
let environment: { visibilityState: string };
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  useContentSyncStore.setState({ serverUrl: "http://server", deviceName: "Tablet" });
  useUserStateStore.setState({ enabledByServer: {}, runtimeByServer: {} });
  mocks.sync.mockResolvedValue(undefined);
  documentTarget = new EventTarget(); browserWindow = new EventTarget();
  environment = { visibilityState: "visible" };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("document", {
    get visibilityState() { return environment.visibilityState; },
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
  });
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("performs no automatic traffic until this specific server is enabled", async () => {
  cleanup = startUserStateScheduler();
  mocks.localListener?.();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).not.toHaveBeenCalled();
  useUserStateStore.getState().setEnabled("http://other", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).not.toHaveBeenCalled();
  useUserStateStore.getState().setEnabled("http://server", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("coalesces local edits and polls for other-device changes only while active", async () => {
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 20; index++) mocks.localListener?.();
  await vi.advanceTimersByTimeAsync(1499);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  environment.visibilityState = "hidden";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  environment.visibilityState = "visible";
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
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
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.active).toHaveBeenLastCalledWith(null);
});


it("keeps failure backoff when local reading keeps generating edits", async () => {
  mocks.sync.mockRejectedValue(new Error("server offline"));
  useUserStateStore.getState().setEnabled("http://server", true);
  cleanup = startUserStateScheduler();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  mocks.localListener?.();
  await vi.advanceTimersByTimeAsync(1999);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 20; index++) mocks.localListener?.();
  await vi.advanceTimersByTimeAsync(3999);
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.sync).toHaveBeenCalledTimes(3);
});
