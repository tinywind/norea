import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-vpn", () => ({ getPluginVpnStatus: vi.fn() }));
vi.mock("./plugin-vpn-lifecycle", () => ({ requestPluginVpnRecovery: vi.fn() }));

import { usePluginVpnStore } from "../store/plugin-vpn";
import { getPluginVpnStatus, type PluginVpnStatus } from "./plugin-vpn";
import { requestPluginVpnRecovery } from "./plugin-vpn-lifecycle";
import {
  isPluginVpnUnavailableError,
  PLUGIN_VPN_READY_TIMEOUT_MS,
  waitForPluginVpnReady,
} from "./plugin-vpn-traffic";

const statusMock = vi.mocked(getPluginVpnStatus);
const recoveryMock = vi.mocked(requestPluginVpnRecovery);
const CONNECTED: PluginVpnStatus = {
  phase: "connected", error: null, proxyPort: 43127, supported: true,
  profile: { isVpnGateFinder: true, remoteHost: "203.0.113.1", requiresUsernamePassword: false },
};
const RECONNECTING: PluginVpnStatus = { ...CONNECTED, phase: "reconnecting" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  usePluginVpnStore.getState().setEnabled(true);
  statusMock.mockReset().mockResolvedValue(RECONNECTING);
  recoveryMock.mockReset();
});
afterEach(() => {
  usePluginVpnStore.getState().setEnabled(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("plugin VPN traffic readiness", () => {
  it("leaves explicitly disabled traffic alone without native IPC", async () => {
    usePluginVpnStore.getState().setEnabled(false);
    await expect(waitForPluginVpnReady()).resolves.toBe(false);
    expect(statusMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permits a confirmed connected tunnel without a recovery delay", async () => {
    statusMock.mockResolvedValue(CONNECTED);
    await expect(waitForPluginVpnReady()).resolves.toBe(false);
    expect(recoveryMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits through a 50-second outage instead of using a direct route", async () => {
    const settled = vi.fn();
    const pending = waitForPluginVpnReady().then(settled);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(settled).not.toHaveBeenCalled();
    expect(recoveryMock).toHaveBeenCalled();
    statusMock.mockResolvedValue(CONNECTED);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disabled", "error", "connecting", "disconnecting"] as const)(
    "does not mistake an enabled %s state for a usable direct route", async (phase) => {
      statusMock.mockResolvedValue({ ...CONNECTED, phase });
      const settled = vi.fn();
      const pending = waitForPluginVpnReady().then(settled);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).not.toHaveBeenCalled();
      statusMock.mockResolvedValue(CONNECTED);
      await vi.advanceTimersByTimeAsync(500);
      await pending;
      expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("fails with a typed error at the shared deadline and releases timers", async () => {
    const pending = waitForPluginVpnReady();
    const checked = expect(pending).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
    await vi.advanceTimersByTimeAsync(PLUGIN_VPN_READY_TIMEOUT_MS);
    await checked;
    const queries = statusMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(statusMock).toHaveBeenCalledTimes(queries);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled native status query too", async () => {
    statusMock.mockImplementation(() => new Promise(() => undefined));
    const checked = expect(waitForPluginVpnReady()).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
    await vi.advanceTimersByTimeAsync(PLUGIN_VPN_READY_TIMEOUT_MS);
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors an already exhausted retry deadline", async () => {
    const checked = expect(waitForPluginVpnReady(undefined, Date.now() - 1))
      .rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an already cancelled request before probing the native state", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForPluginVpnReady(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(statusMock).not.toHaveBeenCalled();
  });

  it("cancels immediately even with a native status query in flight", async () => {
    let complete!: (status: PluginVpnStatus) => void;
    statusMock.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const pending = waitForPluginVpnReady(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    complete(RECONNECTING);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the wait immediately after explicit Off", async () => {
    const pending = waitForPluginVpnReady();
    await vi.advanceTimersByTimeAsync(0);
    usePluginVpnStore.getState().setEnabled(false);
    await expect(pending).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not cancel sibling media waits when one task is cancelled", async () => {
    const controller = new AbortController();
    const first = waitForPluginVpnReady(controller.signal);
    const second = waitForPluginVpnReady();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    statusMock.mockResolvedValue(CONNECTED);
    await vi.advanceTimersByTimeAsync(500);
    await expect(second).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ ...CONNECTED, supported: false }, { ...CONNECTED, profile: null, phase: "disabled" as const }])(
    "fails closed when no usable VPN is available", async (status) => {
      statusMock.mockResolvedValue(status);
      await expect(waitForPluginVpnReady()).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not treat a failed status lookup as permission to fetch directly", async () => {
    statusMock.mockRejectedValue(new Error("bridge unavailable"));
    await expect(waitForPluginVpnReady()).rejects.toSatisfy(isPluginVpnUnavailableError);
    expect(vi.getTimerCount()).toBe(0);
  });
});
