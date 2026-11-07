import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAbortedError } from "./abort";
import { HttpStatusError } from "./http/status-error";
import {
  PluginVpnTransportError,
  withPluginVpnTransportDiagnostics,
  type PluginVpnTransportFailure,
} from "./plugin-vpn-transport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), enabled: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../store/plugin-vpn", () => ({ usePluginVpnStore: { getState: () => ({ enabled: mocks.enabled }) } }));

const url = "https://source.test/chapter?token=private";
const cursor = { routeGeneration: 7, nextRequestId: 42 };
const dns: PluginVpnTransportFailure = {
  routeGeneration: 7, requestId: 42, host: "source.test", port: 443,
  kind: "dns", message: "VPN DNS lookup returned no address",
};
const worker = { rangeId: "range-a", slot: 2, generation: 11 } as const;

beforeEach(() => {
  mocks.enabled = true;
  mocks.invoke.mockReset().mockImplementation((command: string) =>
    Promise.resolve(command === "plugin_vpn_transport_cursor" ? cursor : dns));
});

describe("VPN browser transport diagnostics", () => {
  it("does not inspect the proxy when foreground VPN routing is disabled", async () => {
    mocks.enabled = false;
    const run = vi.fn().mockResolvedValue("page");
    await expect(withPluginVpnTransportDiagnostics(url, null, run)).resolves.toBe("page");
    expect(run).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("captures the route before one browser attempt and preserves its original timeout", async () => {
    const error = new Error("scraper: navigation failed (-8): net::ERR_TIMED_OUT");
    const run = vi.fn(() => {
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("plugin_vpn_transport_cursor", { worker: null });
      return Promise.reject(error);
    });
    const result = await withPluginVpnTransportDiagnostics(url, null, run).catch(value => value);
    expect(result).toBeInstanceOf(PluginVpnTransportError);
    expect(result.cause).toBe(error);
    expect(result.failure).toEqual(dns);
    expect(result.message).toContain("VPN DNS failure observed for source.test:443");
    expect(result.message).toContain("net::ERR_TIMED_OUT");
    expect(result.message).not.toContain("private");
    expect(run).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenLastCalledWith("plugin_vpn_transport_failure", { worker: null, cursor, url });
  });

  it("uses the exact worker identity even when the foreground VPN is disabled", async () => {
    mocks.enabled = false;
    await expect(withPluginVpnTransportDiagnostics(url, worker, () => Promise.reject(new Error("Failed to fetch"))))
      .rejects.toMatchObject({ code: "plugin-vpn-transport", failure: dns });
    expect(mocks.invoke.mock.calls).toEqual([
      ["plugin_vpn_transport_cursor", { worker }],
      ["plugin_vpn_transport_failure", { worker, cursor, url }],
    ]);
  });

  it.each([403, 404, 429, 500])("preserves HTTP %s instead of replacing it with an unrelated DNS failure", async status => {
    const error = new HttpStatusError(status, "Server response after a network error");
    await expect(withPluginVpnTransportDiagnostics(url, null, () => Promise.reject(error))).rejects.toBe(error);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it.each([requestAbortedError(), new SyntaxError("Invalid chapter selector")])("preserves cancellation and parsing failures: %s", async error => {
    await expect(withPluginVpnTransportDiagnostics(url, null, () => Promise.reject(error))).rejects.toBe(error);
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it("does not inspect failures after a successful browser response", async () => {
    await expect(withPluginVpnTransportDiagnostics(url, null, () => Promise.resolve("page"))).resolves.toBe("page");
    expect(mocks.invoke).toHaveBeenCalledOnce();
  });

  it.each(["cursor", "failure"])("keeps the browser error if the %s diagnostic is unavailable", async stage => {
    const error = new Error("Failed to fetch");
    mocks.invoke.mockImplementation((command: string) => {
      if (command.endsWith(stage)) return Promise.reject(new Error("Diagnostic unavailable"));
      return Promise.resolve(cursor);
    });
    const run = vi.fn().mockRejectedValue(error);
    await expect(withPluginVpnTransportDiagnostics(url, null, run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps the browser error when native matching excludes a stale route or target", async () => {
    mocks.invoke.mockResolvedValueOnce(cursor).mockResolvedValueOnce(null);
    const error = new Error("net::ERR_TIMED_OUT");
    await expect(withPluginVpnTransportDiagnostics(url, null, () => Promise.reject(error))).rejects.toBe(error);
  });

  it("does not attribute proxy failures to overlapping attempts on the same route", async () => {
    const errorA = new Error("First browser timed out");
    const errorB = new Error("Second browser timed out");
    let rejectA!: (error: Error) => void;
    let rejectB!: (error: Error) => void;
    const runA = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectA = reject; }));
    const runB = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectB = reject; }));
    const first = withPluginVpnTransportDiagnostics(url, null, runA);
    await vi.waitFor(() => expect(runA).toHaveBeenCalledOnce());
    const second = withPluginVpnTransportDiagnostics(url, null, runB);
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(runB).toHaveBeenCalledOnce());
    rejectA(errorA);
    rejectB(errorB);
    expect(await settled).toEqual([{ status: "rejected", reason: errorA }, { status: "rejected", reason: errorB }]);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["plugin_vpn_transport_cursor", "plugin_vpn_transport_cursor"]);
  });

  it("keeps independent worker routes eligible for their own diagnostics", async () => {
    const otherWorker = { ...worker, rangeId: "range-b", slot: 3 } as const;
    const results = await Promise.allSettled([worker, otherWorker].map(owner =>
      withPluginVpnTransportDiagnostics(url, owner, () => Promise.reject(new Error("Failed to fetch")))));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBeInstanceOf(PluginVpnTransportError);
    }
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "plugin_vpn_transport_failure").map(([, args]) => args.worker))
      .toEqual([worker, otherWorker]);
  });

  it.each(["cursor", "failure"])("does not let an unresponsive %s diagnostic block the browser result", async stage => {
    vi.useFakeTimers();
    try {
      const error = new Error("net::ERR_TIMED_OUT");
      const run = vi.fn().mockRejectedValue(error);
      mocks.invoke.mockImplementation((command: string) => command.endsWith(stage)
        ? new Promise(() => {}) : Promise.resolve(cursor));
      const result = withPluginVpnTransportDiagnostics(url, null, run).catch(value => value);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toBe(error);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not add a transport observation after the caller cancels", async () => {
    const controller = new AbortController();
    const error = new Error("net::ERR_TIMED_OUT");
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "plugin_vpn_transport_failure") controller.abort();
      return Promise.resolve(command === "plugin_vpn_transport_cursor" ? cursor : dns);
    });
    await expect(withPluginVpnTransportDiagnostics(url, null, () => Promise.reject(error), controller.signal)).rejects.toBe(error);
  });
});
