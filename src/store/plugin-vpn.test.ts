import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugin VPN connection intent", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("restores only the enabled flag across app restarts", async () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const first = (await import("./plugin-vpn")).usePluginVpnStore;
    first.getState().setEnabled(true);
    expect(JSON.parse(values.get("plugin-vpn-settings")!)).toEqual({
      state: { enabled: true },
      version: 0,
    });
    vi.resetModules();
    const restarted = (await import("./plugin-vpn")).usePluginVpnStore;
    expect(restarted.getState().enabled).toBe(true);
    restarted.getState().setEnabled(false);
    vi.resetModules();
    expect((await import("./plugin-vpn")).usePluginVpnStore.getState().enabled).toBe(false);
  });

  it.each([null, {}, { enabled: "true" }, { enabled: false }])(
    "does not enable VPN from invalid or disabled settings: %j",
    async (state) => {
      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => JSON.stringify({ state, version: 0 }),
          setItem: vi.fn(),
          removeItem: vi.fn(),
        },
      });
      expect((await import("./plugin-vpn")).usePluginVpnStore.getState().enabled).toBe(false);
    },
  );
});
