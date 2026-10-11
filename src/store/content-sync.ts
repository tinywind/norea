import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CatalogEntry } from "../lib/content-sync/native";
import type { ContentServerUser, ContentStateEntry } from "../lib/content-sync/client";

interface ContentSyncStore {
  serverUrl: string;
  deviceName: string;
  autoSync: boolean;
  status: "idle" | "syncing" | "error";
  error: string | null;
  catalog: CatalogEntry[];
  conflicts: ContentStateEntry[];
  user: ContentServerUser | null;
  token: string | null;
  setServerUrl: (url: string) => void;
  setDeviceName: (name: string) => void;
  setAutoSync: (enabled: boolean) => void;
}

export const useContentSyncStore = create<ContentSyncStore>()(persist((set) => ({
  serverUrl: "", deviceName: "Norea", autoSync: false, status: "idle", error: null,
  catalog: [], conflicts: [], user: null, token: null,
  setServerUrl: (serverUrl) => set((state) => serverUrl.trim().replace(/\/+$/, "") === state.serverUrl ? {} : ({
    serverUrl: serverUrl.trim().replace(/\/+$/, ""), user: null, token: null, conflicts: [], catalog: [], error: null, status: "idle",
  })),
  setDeviceName: (deviceName) => set({ deviceName: deviceName.trim() || "Norea" }),
  setAutoSync: (autoSync) => set({ autoSync }),
}), {
  name: "norea-content-server",
  partialize: ({ serverUrl, deviceName, autoSync }) => ({ serverUrl, deviceName, autoSync }),
}));
