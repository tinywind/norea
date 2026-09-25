import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("./plugin-vpn", () => ({
  restorePluginVpnConnection: vi.fn(),
  startPluginVpnStatusListener: vi.fn(),
}));

import {
  restorePluginVpnConnection,
  startPluginVpnStatusListener,
  type PluginVpnStatus,
  type PluginVpnStatusEvent,
} from "./plugin-vpn";
import { startPluginVpnLifecycle } from "./plugin-vpn-lifecycle";

const restoreMock = vi.mocked(restorePluginVpnConnection);
const statusListenerMock = vi.mocked(startPluginVpnStatusListener);
const CONNECTED_STATUS: PluginVpnStatus = {
  error: null,
  phase: "connected",
  profile: { isVpnGateFinder: true, remoteHost: "203.0.113.10", requiresUsernamePassword: false },
  proxyPort: 43127,
  supported: true,
};

const ERROR_STATUS: PluginVpnStatus = {
  ...CONNECTED_STATUS,
  error: "OpenVPN connection failed (CONNECTION_TIMEOUT)",
  phase: "error",
};

describe("plugin VPN app lifecycle", () => {
  let visibility: DocumentVisibilityState;
  let stop: (() => void) | undefined;
  let emitStatus: ((event: PluginVpnStatusEvent) => void) | undefined;
  let unlisten: Mock<() => void>;

  beforeEach(() => {
    visibility = "visible";
    const documentTarget = new EventTarget();
    Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", new EventTarget());
    restoreMock.mockReset().mockResolvedValue(null);
    unlisten = vi.fn<() => void>();
    statusListenerMock.mockReset().mockImplementation(async (onEvent) => {
      emitStatus = onEvent;
      return unlisten;
    });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    emitStatus = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("checks startup and visible resume signals but ignores hidden focus events", async () => {
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    expect(restoreMock).toHaveBeenCalledTimes(1);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    window.dispatchEvent(new Event("norea-app-resumed"));
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(4);
  });

  it("coalesces overlapping resume events and reports one confirmed recovery", async () => {
    let complete!: (status: PluginVpnStatus) => void;
    restoreMock.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const onRestored = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored, onError: vi.fn() });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("norea-app-resumed"));
    expect(restoreMock).toHaveBeenCalledTimes(1);

    complete(CONNECTED_STATUS);
    await Promise.resolve();
    expect(onRestored).toHaveBeenCalledExactlyOnceWith(CONNECTED_STATUS);
  });

  it("reports a recovery failure and allows the next resume to retry", async () => {
    const error = new Error("network unavailable");
    restoreMock.mockRejectedValueOnce(error);
    const onError = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError });
    await Promise.resolve();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);

    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("retries a failed recovery with backoff and reports the failure once", async () => {
    vi.useFakeTimers();
    const error = new Error("OpenVPN authentication failed");
    restoreMock
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(CONNECTED_STATUS);
    const onError = vi.fn();
    const onRestored = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored, onError });
    await vi.advanceTimersByTimeAsync(0);
    expect(restoreMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(restoreMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(restoreMock).toHaveBeenCalledTimes(3);

    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onRestored).toHaveBeenCalledExactlyOnceWith(CONNECTED_STATUS);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(3);
  });

  it("restores immediately when the running session reports an error", async () => {
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await Promise.resolve();
    expect(restoreMock).toHaveBeenCalledTimes(1);

    emitStatus?.({ kind: "reconnecting", status: ERROR_STATUS });
    expect(restoreMock).toHaveBeenCalledTimes(1);
    emitStatus?.({ kind: "error", status: ERROR_STATUS });
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("stops retrying once there is nothing left to restore", async () => {
    vi.useFakeTimers();
    restoreMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(null);
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it("cancels scheduled retries and the status listener on teardown", async () => {
    vi.useFakeTimers();
    restoreMock.mockRejectedValue(new Error("network unavailable"));
    stop = startPluginVpnLifecycle({ onRestored: vi.fn(), onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    stop = undefined;

    await vi.advanceTimersByTimeAsync(120_000);
    emitStatus?.({ kind: "error", status: ERROR_STATUS });
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("removes resume listeners and ignores completion after teardown", async () => {
    let complete!: (status: PluginVpnStatus) => void;
    restoreMock.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const onRestored = vi.fn();
    stop = startPluginVpnLifecycle({ onRestored, onError: vi.fn() });
    stop();
    complete(CONNECTED_STATUS);
    await Promise.resolve();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("norea-app-resumed"));
    expect(onRestored).not.toHaveBeenCalled();
    expect(restoreMock).toHaveBeenCalledTimes(1);
  });
});
