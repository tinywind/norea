import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeContentServerUrl } from "../lib/content-sync/client";

export type ContentSyncMode = "manual" | "periodic" | "changes";

interface ContentSyncStore {
  serverUrl: string;
  deviceName: string;
  syncMode: ContentSyncMode;
  syncIntervalMinutes: number;
  lookupTimeoutSeconds: number;
  status: "idle" | "syncing" | "error";
  progress: { completed: number; total: number; uploaded: number; failed: number } | null;
  error: string | null;
  blocked: boolean;
  deviceKey: string | null;
  setServerUrl: (url: string) => void;
  setDeviceName: (name: string) => void;
  setSyncMode: (mode: ContentSyncMode) => void;
  setSyncIntervalMinutes: (minutes: number) => void;
  setLookupTimeoutSeconds: (seconds: number) => void;
}

export const useContentSyncStore = create<ContentSyncStore>()(persist((set) => ({
  serverUrl: "", deviceName: "Norea", syncMode: "manual", syncIntervalMinutes: 15, status: "idle", error: null, blocked: false,
  deviceKey: null, progress: null,
  lookupTimeoutSeconds: 3,
  setServerUrl: (value) => {
    const serverUrl = value.trim() ? normalizeContentServerUrl(value) : "";
    set((state) => serverUrl === state.serverUrl ? {} : ({
      serverUrl, deviceKey: null, error: null, blocked: false, status: "idle", progress: null,
    }));
  },
  setDeviceName: (deviceName) => set({ deviceName: deviceName.trim() || "Norea" }),
  setSyncMode: (syncMode) => set({ syncMode }),
  setSyncIntervalMinutes: (minutes) => set({ syncIntervalMinutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : 15 }),
  setLookupTimeoutSeconds: (seconds) => set({ lookupTimeoutSeconds: Number.isFinite(seconds) ? Math.min(120, Math.max(1, Math.round(seconds))) : 3 }),
}), {
  name: "norea-content-server",
  version: 1,
  partialize: ({ serverUrl, deviceName, syncMode, syncIntervalMinutes, lookupTimeoutSeconds }) => ({ serverUrl, deviceName, syncMode, syncIntervalMinutes, lookupTimeoutSeconds }),
}));
