import { create } from "zustand";
import { persist } from "zustand/middleware";

interface PluginVpnSettings {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const usePluginVpnStore = create<PluginVpnSettings>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "plugin-vpn-settings",
      partialize: (state) => ({ enabled: state.enabled }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        enabled:
          persistedState !== null &&
          typeof persistedState === "object" &&
          "enabled" in persistedState &&
          persistedState.enabled === true,
      }),
    },
  ),
);
