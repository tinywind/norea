import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), defaultStatus: vi.fn(), recovery: vi.fn(), online: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./plugin-vpn", () => ({ getPluginVpnStatus: mocks.defaultStatus, isRetryablePluginVpnError: () => true }));
vi.mock("./plugin-vpn-lifecycle", () => ({ requestPluginVpnRecovery: mocks.recovery }));
vi.mock("./tauri-runtime", () => ({ isAndroidRuntime: () => true }));
vi.mock("./network", () => ({
  requireNetworkOnline: () => { if (!mocks.online) throw new Error("offline"); },
  isNetworkOnline: () => mocks.online,
  useNetworkStore: { subscribe: () => () => undefined },
  NetworkUnavailableError: class extends Error {},
}));
import { waitForPluginVpnReady } from "./plugin-vpn-traffic";
import { registerVpnDownloadWorkerContext } from "./tasks/vpn-worker-context";

const worker = { rangeId: "range-a", slot: 0, generation: 11 } as const;
let release: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.online = true;
  release = registerVpnDownloadWorkerContext(worker);
  mocks.invoke.mockResolvedValue({ supported: true, worker, phase: "connected", proxyPort: 12345, error: null });
});
afterEach(() => { release(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("VPN worker traffic readiness", () => {
  it("validates slot nine against its exact native owner and rejects traffic after cleanup", async () => {
    const last = { ...worker, slot: 9 } as const;
    const unregister = registerVpnDownloadWorkerContext(last);
    try {
      mocks.invoke.mockResolvedValue({ supported: true, worker: last, phase: "connected", proxyPort: 12354, error: null });
      await expect(waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:9:11")).resolves.toBe(false);
      expect(mocks.invoke).toHaveBeenCalledWith("plugin_vpn_download_worker_status", { worker: last });
      unregister();
      await expect(waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:9:11")).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
    } finally { unregister(); }
  });
  it("uses the enrolled worker even when the default VPN is disabled", async () => {
    await expect(waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:0:11")).resolves.toBe(false);
    expect(mocks.invoke).toHaveBeenCalledWith("plugin_vpn_download_worker_status", { worker });
    expect(mocks.defaultStatus).not.toHaveBeenCalled();
    expect(mocks.recovery).not.toHaveBeenCalled();
  });

  it("never treats a different generation's connected state as ready", async () => {
    mocks.invoke.mockResolvedValue({ supported: true, worker: { ...worker, generation: 12 }, phase: "connected" });
    await expect(waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:0:11")).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
  });

  it("waits only for its own reconnect without triggering default-profile recovery", async () => {
    mocks.invoke.mockResolvedValueOnce({ supported: true, worker, phase: "reconnecting" })
      .mockResolvedValueOnce({ supported: true, worker, phase: "connected" });
    const pending = waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:0:11");
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toBe(true);
    expect(mocks.recovery).not.toHaveBeenCalled();
  });

  it("fails closed after its context is released and retains actionable native errors", async () => {
    mocks.invoke.mockResolvedValue({ supported: true, worker, phase: "error", error: "The approved profile was revoked" });
    await expect(waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:0:11")).rejects.toThrow(/revoked/);
    release();
    mocks.invoke.mockClear();
    await expect(waitForPluginVpnReady(undefined, Date.now() + 1000, "vpn:0:11")).rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
