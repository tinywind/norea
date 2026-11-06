import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PluginVpnUrlTestOutcome } from "../lib/plugin-vpn-url-test";

export type PluginVpnUrlTestProgress = "queued" | "testing";

export interface PluginVpnUrlTestRecord {
  outcome: PluginVpnUrlTestOutcome;
  url: string;
}

export interface PluginVpnUrlTestRun {
  id: string;
  /** Hosts in test order; the ones still queued or testing are in `progress`. */
  hosts: readonly string[];
  cancelling: boolean;
}

interface PluginVpnUrlTestState {
  /** The last URL typed, remembered on this device. */
  url: string;
  run: PluginVpnUrlTestRun | null;
  progress: Readonly<Record<string, PluginVpnUrlTestProgress>>;
  /** The latest finished result per host, for this app session. */
  results: Readonly<Record<string, PluginVpnUrlTestRecord>>;
  setUrl: (url: string) => void;
}

/**
 * Batch URL test state shared by the VPN Gate finder and the saved profile
 * manager, so both show the latest result for the same host.
 */
export const usePluginVpnUrlTestStore = create<PluginVpnUrlTestState>()(
  persist(
    (set) => ({
      url: "",
      run: null,
      progress: {},
      results: {},
      setUrl: (url) => set({ url }),
    }),
    {
      name: "plugin-vpn-url-test",
      partialize: (state) => ({ url: state.url }),
      version: 1,
    },
  ),
);
