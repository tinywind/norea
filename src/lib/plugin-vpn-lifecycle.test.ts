import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-vpn", () => ({
  restorePluginVpnConnection: vi.fn(),
}));

import { restorePluginVpnConnection, type PluginVpnStatus } from "./plugin-vpn";
import { startPluginVpnLifecycle } from "./plugin-vpn-lifecycle";

const restoreMock = vi.mocked(restorePluginVpnConnection);
const CONNECTED_STATUS: PluginVpnStatus = {
  error: null,
  phase: "connected",
  profile: { isVpnGateFinder: true, remoteHost: "203.0.113.10", requiresUsernamePassword: false },
  proxyPort: 43127,
  supported: true,
};

describe("plugin VPN app lifecycle", () => {
  let visibility: DocumentVisibilityState;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    visibility = "visible";
    const documentTarget = new EventTarget();
    Object.defineProperty(documentTarget, "visibilityState", { get: () => visibility });
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("window", new EventTarget());
    restoreMock.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
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
