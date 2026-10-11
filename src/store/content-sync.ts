import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CatalogEntry } from "../lib/content-sync/native";
import type { WorkCatalogEntry } from "../lib/content-sync/works";
import { normalizeContentServerUrl } from "../lib/content-sync/client";

export type ContentSyncMode = "manual" | "periodic" | "changes";

interface ContentSyncStore {
  serverUrl: string;
  deviceName: string;
  syncMode: ContentSyncMode;
  syncIntervalMinutes: number;
  status: "idle" | "syncing" | "error";
  error: string | null;
  blocked: boolean;
  catalog: CatalogEntry[];
  works: WorkCatalogEntry[];
  deviceKey: string | null;
  setServerUrl: (url: string) => void;
  setDeviceName: (name: string) => void;
  setSyncMode: (mode: ContentSyncMode) => void;
  setSyncIntervalMinutes: (minutes: number) => void;
}

export const useContentSyncStore = create<ContentSyncStore>()(persist((set) => ({
  serverUrl: "", deviceName: "Norea", syncMode: "manual", syncIntervalMinutes: 15, status: "idle", error: null, blocked: false,
  catalog: [], works: [], deviceKey: null,
  setServerUrl: (value) => {
    const serverUrl = value.trim() ? normalizeContentServerUrl(value) : "";
    set((state) => serverUrl === state.serverUrl ? {} : ({
      serverUrl, deviceKey: null, catalog: [], works: [], error: null, blocked: false, status: "idle",
    }));
  },
  setDeviceName: (deviceName) => set({ deviceName: deviceName.trim() || "Norea" }),
  setSyncMode: (syncMode) => set({ syncMode }),
  setSyncIntervalMinutes: (minutes) => set({ syncIntervalMinutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : 15 }),
}), {
  name: "norea-content-server",
  version: 1,
  migrate: (persisted) => {
    const previous = persisted as { serverUrl?: string; deviceName?: string; autoSync?: boolean };
    return { serverUrl: previous.serverUrl ?? "", deviceName: previous.deviceName ?? "Norea",
      syncMode: previous.autoSync ? "changes" as const : "manual" as const, syncIntervalMinutes: 15 };
  },
  partialize: ({ serverUrl, deviceName, syncMode, syncIntervalMinutes }) => ({ serverUrl, deviceName, syncMode, syncIntervalMinutes }),
}));
