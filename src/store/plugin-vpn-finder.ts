import { create } from "zustand";
import type { PluginVpnServerProtocol } from "../lib/plugin-vpn";

export type PluginVpnFinderSort = "ping" | "score" | "speed";

export interface PluginVpnFinderFilters {
  countryCode: string;
  hideFailed: boolean;
  protocol: "" | PluginVpnServerProtocol;
  search: string;
  sort: PluginVpnFinderSort;
}

export const DEFAULT_PLUGIN_VPN_FINDER_FILTERS: PluginVpnFinderFilters = {
  countryCode: "",
  hideFailed: true,
  protocol: "",
  search: "",
  sort: "score",
};

interface PluginVpnFinderState {
  filters: PluginVpnFinderFilters;
  setFilters: (filters: Partial<PluginVpnFinderFilters>) => void;
}

/** The finder's search conditions, kept for the app session across finder closes and page changes. */
export const usePluginVpnFinderStore = create<PluginVpnFinderState>()((set) => ({
  filters: DEFAULT_PLUGIN_VPN_FINDER_FILTERS,
  setFilters: (filters) =>
    set((state) => ({ filters: { ...state.filters, ...filters } })),
}));
