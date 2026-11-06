import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { pluginVpnUrlTestPresentation } from "../components/PluginVpnSelectionPanel";
import { usePluginVpnUrlTestStore } from "../store/plugin-vpn-url-test";
import { useUserAgentStore } from "../store/user-agent";
import {
  cancelPluginVpnUrlTests,
  parsePluginVpnTestUrl,
  runPluginVpnUrlTests,
  type PluginVpnUrlTestResult,
  type PluginVpnUrlTestTarget,
} from "./plugin-vpn-url-test";

const targets: PluginVpnUrlTestTarget[] = [
  { host: "203.0.113.1", profile: { kind: "finder", candidateId: "a".repeat(64) } },
  { host: "203.0.113.2", profile: { kind: "saved", id: "saved-2", expectedHash: "b".repeat(64) } },
  { host: "vpn.example.net", profile: { kind: "manual", host: "vpn.example.net", expectedHash: "c".repeat(64) } },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePluginVpnUrlTestStore.setState({ url: "", run: null, progress: {}, results: {} });
  useUserAgentStore.setState({ userAgent: "NoreaTest/1.0" });
});

describe("plugin VPN URL test address", () => {
  it("accepts only absolute http and https addresses with a host", () => {
    expect(parsePluginVpnTestUrl("  https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(parsePluginVpnTestUrl("http://203.0.113.9:8080/")).toBe("http://203.0.113.9:8080/");
    for (const invalid of ["", "example.com", "ftp://example.com", "javascript:alert(1)", "https://user:pass@example.com/", `https://example.com/${"a".repeat(2048)}`]) {
      expect(parsePluginVpnTestUrl(invalid), invalid).toBeNull();
    }
  });
});

describe("plugin VPN URL test runner", () => {
  it("tests one host at a time with one call each and keeps the latest result per host", async () => {
    const pending = targets.map(() => deferred<PluginVpnUrlTestResult>());
    let calls = 0;
    vi.mocked(invoke).mockImplementation(() => pending[calls++]!.promise as Promise<never>);

    const run = runPluginVpnUrlTests([...targets, targets[0]!], "https://example.com/");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(usePluginVpnUrlTestStore.getState().progress).toEqual({
      "203.0.113.1": "testing", "203.0.113.2": "queued", "vpn.example.net": "queued",
    });
    expect(invoke).toHaveBeenLastCalledWith("plugin_vpn_test_profile_url", expect.objectContaining({
      profile: targets[0]!.profile, url: "https://example.com/", userAgent: "NoreaTest/1.0",
    }));

    pending[0]!.resolve({ kind: "ok", status: 200, elapsedMs: 120 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    pending[1]!.resolve({ kind: "cloudflareChallenge", status: 403, elapsedMs: 90 });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    pending[2]!.resolve({ kind: "credentialsRequired" });
    await expect(run).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledTimes(3);
    const state = usePluginVpnUrlTestStore.getState();
    expect(state.run).toBeNull();
    expect(state.progress).toEqual({});
    expect(state.results["203.0.113.1"]).toEqual({ outcome: { kind: "ok", status: 200, elapsedMs: 120 }, url: "https://example.com/" });
    expect(state.results["203.0.113.2"]?.outcome.kind).toBe("cloudflareChallenge");
    expect(state.results["vpn.example.net"]?.outcome.kind).toBe("credentialsRequired");
  });

  it("refuses a second run and an invalid address without calling the host", async () => {
    await expect(runPluginVpnUrlTests(targets, "example.com")).resolves.toBe(false);
    usePluginVpnUrlTestStore.setState({ run: { id: "vpn-url-test-busy", hosts: ["x"], cancelling: false } });
    await expect(runPluginVpnUrlTests(targets, "https://example.com/")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records a failed start as an error and continues with the next host", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce("VPN Gate profile is no longer available; refresh the server list")
      .mockResolvedValueOnce({ kind: "timedOut", stage: "connect" })
      .mockResolvedValueOnce({ kind: "httpError", status: 404, elapsedMs: 10 });
    await runPluginVpnUrlTests(targets, "https://example.com/");
    const { results } = usePluginVpnUrlTestStore.getState();
    expect(results["203.0.113.1"]?.outcome).toEqual({ kind: "error", message: "VPN Gate profile is no longer available; refresh the server list" });
    expect(results["203.0.113.2"]?.outcome).toEqual({ kind: "timedOut", stage: "connect" });
    expect(results["vpn.example.net"]?.outcome.kind).toBe("httpError");
  });

  it("cancels the running test, skips the rest, and keeps earlier results", async () => {
    usePluginVpnUrlTestStore.setState({
      results: { "203.0.113.2": { outcome: { kind: "ok", status: 200, elapsedMs: 5 }, url: "https://old.example/" } },
    });
    const first = deferred<PluginVpnUrlTestResult>();
    vi.mocked(invoke).mockImplementation((command) =>
      (command === "plugin_vpn_test_profile_url" ? first.promise : Promise.resolve(undefined)) as Promise<never>);

    const run = runPluginVpnUrlTests(targets, "https://example.com/");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    const runId = usePluginVpnUrlTestStore.getState().run!.id;
    await cancelPluginVpnUrlTests();
    expect(invoke).toHaveBeenLastCalledWith("plugin_vpn_cancel_url_test", { runId });
    first.resolve({ kind: "cancelled" });
    await run;

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "plugin_vpn_test_profile_url")).toHaveLength(1);
    const state = usePluginVpnUrlTestStore.getState();
    expect(state.run).toBeNull();
    expect(state.progress).toEqual({});
    expect(state.results["203.0.113.1"]).toBeUndefined();
    expect(state.results["203.0.113.2"]?.url).toBe("https://old.example/");
  });
});

describe("plugin VPN URL test presentation", () => {
  it("labels each result with its tone and keeps failure reasons", () => {
    expect(pluginVpnUrlTestPresentation({ kind: "ok", status: 200, elapsedMs: 1234 }, "en")).toEqual({
      key: "settings.data.pluginVpn.urlTest.result.ok", values: { status: 200, ms: "1,234" }, tone: "ok", detail: null,
    });
    expect(pluginVpnUrlTestPresentation({ kind: "cloudflareChallenge", status: 403, elapsedMs: 1 }, "en").tone).toBe("warn");
    expect(pluginVpnUrlTestPresentation({ kind: "connectionFailed", reason: "TLS handshake failed" }, "en")).toMatchObject({
      key: "settings.data.pluginVpn.urlTest.result.connectionFailed", tone: "danger", detail: "TLS handshake failed",
    });
    expect(pluginVpnUrlTestPresentation({ kind: "timedOut", stage: "request" }, "en").key).toBe("settings.data.pluginVpn.urlTest.result.requestTimedOut");
    expect(pluginVpnUrlTestPresentation({ kind: "inUse" }, "en").key).toBe("settings.data.pluginVpn.urlTest.result.inUse");
  });
});
