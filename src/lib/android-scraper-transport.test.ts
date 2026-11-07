import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { androidConfigureVpnDownloadWorker, androidScraperNavigate, androidWebviewExtract } from "./android-scraper";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), enabled: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../store/plugin-vpn", () => ({ usePluginVpnStore: { getState: () => ({ enabled: mocks.enabled }) } }));
vi.mock("./tauri-runtime", () => ({ isAndroidRuntime: () => true }));

const cursor = { routeGeneration: 7, nextRequestId: 42 };
const dns = { routeGeneration: 7, requestId: 42, host: "source.test", port: 443, kind: "dns", message: "VPN DNS lookup returned no address" };
let requests: Record<string, unknown>[];

beforeEach(() => {
  requests = [];
  mocks.enabled = true;
  mocks.invoke.mockReset().mockImplementation((command: string) => Promise.resolve(command.endsWith("cursor") ? cursor : dns));
  let nonce = 0;
  const request = (raw: string) => {
    const payload = JSON.parse(raw);
    requests.push(payload);
    const result = payload.method === "configureWorker"
      ? { ok: true, result: true }
      : { ok: false, error: "scraper: navigation failed (-8): net::ERR_TIMED_OUT" };
    window.__noreaAndroidScraperResolve?.(payload.id, JSON.stringify(result));
  };
  vi.stubGlobal("window", {
    setTimeout, clearTimeout,
    __NoreaAndroidBridge: {
      session: () => JSON.stringify({ sessionToken: "session", capabilities: ["vpn.worker"] }),
      nonce: () => `nonce-value-${++nonce}`,
    },
    __NoreaAndroidScraper: { navigate: request, extract: request, cancel: vi.fn() },
    __NoreaAndroidVpnWorkers: { request },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Android browser VPN diagnostics wiring", () => {
  it("delivers a matched DNS observation with the original navigation failure", async () => {
    await expect(androidScraperNavigate("source", "https://source.test", null))
      .rejects.toMatchObject({ code: "plugin-vpn-transport", failure: dns, cause: { message: expect.stringContaining("ERR_TIMED_OUT") } });
    expect(requests).toHaveLength(1);
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["plugin_vpn_transport_cursor", "plugin_vpn_transport_failure"]);
  });

  it("uses the configured worker range and generation for an extraction failure", async () => {
    mocks.enabled = false;
    const worker = { rangeId: "range-transport", slot: 6, generation: 87 } as const;
    await androidConfigureVpnDownloadWorker(worker, { sourceId: "source", profileId: "profile-a", proxyPort: 18080 });
    await expect(androidWebviewExtract("https://source.test/chapter", null, 1000, null, "source", "vpn:6:87"))
      .rejects.toMatchObject({ code: "plugin-vpn-transport", failure: dns });
    expect(requests.map(({ method }) => method)).toEqual(["configureWorker", "extract"]);
    expect(mocks.invoke.mock.calls).toEqual([
      ["plugin_vpn_transport_cursor", { worker }],
      ["plugin_vpn_transport_failure", { worker, cursor, url: "https://source.test/chapter" }],
    ]);
  });

  it("does not dispatch a navigation cancelled while its cursor is being read", async () => {
    let resolveCursor!: (value: typeof cursor) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { resolveCursor = resolve; }));
    const controller = new AbortController();
    const navigation = androidScraperNavigate("source", "https://source.test", null, { signal: controller.signal });
    controller.abort();
    await expect(navigation).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(0);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    resolveCursor(cursor);
    await Promise.resolve();
    expect(requests).toHaveLength(0);
  });
});
