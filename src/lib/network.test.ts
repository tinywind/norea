import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NetworkUnavailableError, useNetworkStore, withNetworkRequest,
} from "./network";

beforeEach(() => useNetworkStore.setState({ connectivity: "online", revision: 1 }));
afterEach(() => useNetworkStore.setState({ connectivity: "online", revision: 1 }));

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
