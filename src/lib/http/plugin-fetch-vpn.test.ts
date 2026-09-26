import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../tauri-runtime", () => ({
  isAndroidRuntime: vi.fn(() => false),
  isWindowsRuntime: vi.fn(() => true),
}));

import { invoke } from "@tauri-apps/api/core";
import { usePluginVpnStore } from "../../store/plugin-vpn";
import type { PluginVpnStatus } from "../plugin-vpn";
import { PLUGIN_VPN_READY_TIMEOUT_MS } from "../plugin-vpn-traffic";
import { appFetchText } from "./app-fetch";
import { pluginFetch } from "./plugin-fetch";

const invokeMock = vi.mocked(invoke);
let phase: PluginVpnStatus["phase"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  usePluginVpnStore.getState().setEnabled(true);
  phase = "reconnecting";
  invokeMock.mockReset().mockImplementation(async (command) => {
    if (command === "plugin_vpn_status") return {
      phase, error: null, proxyPort: 43127, supported: true,
      profile: { isVpnGateFinder: true, remoteHost: "203.0.113.1", requiresUsernamePassword: false },
    };
    if (command === "webview_fetch") return {
      status: 200, statusText: "OK", headers: { "content-type": "text/plain" },
      bodyBase64: btoa("ready"), finalUrl: "https://source.test/",
    };
    throw new Error(`Unexpected native call: ${command}`);
  });
});
afterEach(() => {
  usePluginVpnStore.getState().setEnabled(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("source HTTP VPN boundary", () => {
  it("waits for VPN readiness before starting the browser request timeout", async () => {
    const deadline = Date.now() + PLUGIN_VPN_READY_TIMEOUT_MS;
    const request = pluginFetch("https://source.test/", {
      sourceId: "fixture-source", scraperExecutor: "pool:0", vpnReadyDeadline: deadline,
    });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(invokeMock.mock.calls.every(([command]) => command === "plugin_vpn_status")).toBe(true);
    phase = "connected";
    await vi.advanceTimersByTimeAsync(500);
    expect(await (await request).text()).toBe("ready");
    const fetch = invokeMock.mock.calls.find(([command]) => command === "webview_fetch");
    expect(fetch?.[1]).toMatchObject({ sourceId: "fixture-source", queue: "pool:0", timeoutMs: 30_000 });
    expect(JSON.stringify(fetch?.[1])).not.toContain("vpnReadyDeadline");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts source network work after readiness expires", async () => {
    const checked = expect(pluginFetch("https://source.test/"))
      .rejects.toMatchObject({ code: "plugin-vpn-unavailable" });
    await vi.advanceTimersByTimeAsync(PLUGIN_VPN_READY_TIMEOUT_MS);
    await checked;
    expect(invokeMock.mock.calls.every(([command]) => command === "plugin_vpn_status")).toBe(true);
  });

  it("cancels readiness without touching a scraper executor that has not started", async () => {
    const controller = new AbortController();
    const request = pluginFetch("https://source.test/", { signal: controller.signal, scraperExecutor: "pool:0" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock.mock.calls.every(([command]) => command === "plugin_vpn_status")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not route app-owned repository HTTP through the source VPN gate", async () => {
    invokeMock.mockReset()
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce({ status: 200, statusText: "OK", headers: {}, url: "https://repo.test/", rid: 11 })
      .mockResolvedValueOnce([...new TextEncoder().encode("[]"), 1]);
    await expect(appFetchText("https://repo.test/")).resolves.toBe("[]");
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "plugin:http|fetch", "plugin:http|fetch_send", "plugin:http|fetch_read_body",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
