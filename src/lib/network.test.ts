import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isHostNetworkConnected,
  NetworkUnavailableError,
  subscribeHostNetworkConnection,
  useNetworkStore,
  withNetworkRequest,
} from "./network";

beforeEach(() => useNetworkStore.setState({ connectivity: "online", revision: 1 }));
afterEach(() => {
  useNetworkStore.setState({ connectivity: "online", revision: 1 });
  vi.unstubAllGlobals();
});

describe("effective system connectivity", () => {
  it.each(["unknown", "offline", "limited"] as const)("does not admit requests while %s", async connectivity => {
    useNetworkStore.setState({ connectivity });
    const request = vi.fn();
    await expect(withNetworkRequest(undefined, request)).rejects.toBeInstanceOf(NetworkUnavailableError);
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["offline", "online"] as const)("cancels the old route when the new state is %s", async connectivity => {
    let activeSignal!: AbortSignal;
    const pending = withNetworkRequest(undefined, signal => {
      activeSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const checked = expect(pending).rejects.toBeInstanceOf(NetworkUnavailableError);
    useNetworkStore.setState({ connectivity, revision: 2 });
    expect(activeSignal.aborted).toBe(true);
    await checked;
  });

  it("keeps explicit cancellation distinct from an outage", async () => {
    const controller = new AbortController();
    const pending = withNetworkRequest(controller.signal, signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const checked = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    useNetworkStore.setState({ connectivity: "offline", revision: 2 });
    await checked;
  });

  it("ignores repeated snapshots and removes listeners after completion", async () => {
    let activeSignal!: AbortSignal;
    const result = await withNetworkRequest(undefined, async signal => {
      activeSignal = signal;
      useNetworkStore.setState({ connectivity: "online", revision: 1 });
      expect(signal.aborted).toBe(false);
      return "complete";
    });
    useNetworkStore.setState({ connectivity: "offline", revision: 2 });
    expect(activeSignal.aborted).toBe(false);
    expect(result).toBe("complete");
  });
});

describe("host network connection helpers", () => {
  it("reads native host connectivity in Tauri even when navigator.onLine is stale false", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { onLine: false });

    const changes: boolean[] = [];
    const unsubscribe = subscribeHostNetworkConnection((connected) => changes.push(connected));

    expect(isHostNetworkConnected()).toBe(true);
    useNetworkStore.setState({ connectivity: "limited", revision: 2 });
    expect(isHostNetworkConnected()).toBe(true);
    useNetworkStore.setState({ connectivity: "unknown", revision: 3 });
    expect(isHostNetworkConnected()).toBe(true);
    expect(changes).toEqual([]);

    useNetworkStore.setState({ connectivity: "offline", revision: 4 });
    expect(isHostNetworkConnected()).toBe(false);
    expect(changes).toEqual([false]);

    useNetworkStore.setState({ connectivity: "online", revision: 5 });
    expect(isHostNetworkConnected()).toBe(true);
    expect(changes).toEqual([false, true]);

    unsubscribe();
    useNetworkStore.setState({ connectivity: "offline", revision: 6 });
    expect(changes).toEqual([false, true]);
  });

  it("falls back to browser online/offline state outside Tauri", () => {
    const browserWindow = new EventTarget();
    const navigatorState = { onLine: false };
    vi.stubGlobal("window", browserWindow);
    vi.stubGlobal("navigator", navigatorState);

    const changes: boolean[] = [];
    const unsubscribe = subscribeHostNetworkConnection((connected) => changes.push(connected));

    expect(isHostNetworkConnected()).toBe(false);
    navigatorState.onLine = true;
    expect(isHostNetworkConnected()).toBe(true);

    browserWindow.dispatchEvent(new Event("offline"));
    browserWindow.dispatchEvent(new Event("online"));
    expect(changes).toEqual([false, true]);

    unsubscribe();
    browserWindow.dispatchEvent(new Event("offline"));
    expect(changes).toEqual([false, true]);
  });
});
