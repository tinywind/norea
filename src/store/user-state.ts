import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeContentServerUrl } from "../lib/content-sync/client";

export type UserStatePhase = "idle" | "syncing" | "error";

export interface UserStateRuntime {
  phase: UserStatePhase;
  error: string | null;
  revision: number;
}

export const USER_STATE_IDLE_RUNTIME: UserStateRuntime = {
  phase: "idle",
  error: null,
  revision: 0,
};

interface UserStateStore {
  enabledByServer: Record<string, true>;
  runtimeByServer: Record<string, UserStateRuntime>;
  setEnabled: (serverUrl: string, enabled: boolean) => void;
  setRuntime: (serverUrl: string, phase: UserStatePhase, error?: string | null) => void;
}

function enabledServers(value: unknown): Record<string, true> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, true> = {};
  for (const [server, enabled] of Object.entries(value)) {
    if (enabled !== true) continue;
    try {
      result[normalizeContentServerUrl(server)] = true;
    } catch {
      // A malformed saved address cannot enable sharing.
    }
  }
  return result;
}

export const useUserStateStore = create<UserStateStore>()(persist((set) => ({
  enabledByServer: {},
  runtimeByServer: {},
  setEnabled: (serverUrl, enabled) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const next = { ...state.enabledByServer };
      if (enabled) next[server] = true;
      else delete next[server];
      return { enabledByServer: next };
    });
  },
  setRuntime: (serverUrl, phase, error = null) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => ({
      runtimeByServer: {
        ...state.runtimeByServer,
        [server]: {
          phase,
          error,
          revision: (state.runtimeByServer[server]?.revision ?? 0) + 1,
        },
      },
    }));
  },
}), {
  name: "norea-user-state",
  version: 1,
  partialize: ({ enabledByServer }) => ({ enabledByServer }),
  merge: (saved, current) => ({
    ...current,
    enabledByServer: enabledServers(
      saved !== null && typeof saved === "object" && "enabledByServer" in saved
        ? saved.enabledByServer
        : undefined,
    ),
  }),
}));
