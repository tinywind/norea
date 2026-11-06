import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("keeps the typed address and the latest results across app restarts, but not a run in progress", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  const results = { "203.0.113.1": { outcome: { kind: "httpError" as const, status: 403, elapsedMs: 120 }, url: "https://example.com/" } };
  const first = (await import("./plugin-vpn-url-test")).usePluginVpnUrlTestStore;
  first.setState({ url: "https://example.com/", results, run: { id: "run", hosts: ["203.0.113.2"], cancelling: false },
    progress: { "203.0.113.2": "testing" } });
  vi.resetModules();
  const restarted = (await import("./plugin-vpn-url-test")).usePluginVpnUrlTestStore.getState();
  expect(restarted).toMatchObject({ url: "https://example.com/", results, run: null, progress: {} });
});
