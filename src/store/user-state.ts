import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeContentServerUrl } from "../lib/content-sync/client";
import type { UserStateEpochMismatch } from "../lib/user-state/types";

export type UserStatePhase = "idle" | "syncing" | "error";

export interface UserStateRuntime {
  phase: UserStatePhase;
  error: string | null;
  blocked?: boolean;
  backgroundError?: string | null;
  backgroundBlocked?: boolean;
  revision: number;
  epochMismatch?: UserStateEpochMismatch;
}

export interface UserStateLocalRetentionConfig {
  pruneNonLibraryEnabled: boolean;
  pruneNonLibraryDays: number;
  stripTimestampsEnabled: boolean;
  stripTimestampsDays: number;
}

export const DEFAULT_USER_STATE_LOCAL_RETENTION: UserStateLocalRetentionConfig = {
  pruneNonLibraryEnabled: false,
  pruneNonLibraryDays: 90,
  stripTimestampsEnabled: false,
  stripTimestampsDays: 90,
};

export interface UserStateServerRetentionStatus {
  seedAllowed: boolean;
  seedCutoffAt: number | null;
}

export const USER_STATE_IDLE_RUNTIME: UserStateRuntime = {
  phase: "idle",
  error: null,
  revision: 0,
};

interface UserStateStore {
  enabledByServer: Record<string, true>;
  runtimeByServer: Record<string, UserStateRuntime>;
  retentionByServer?: Record<string, UserStateLocalRetentionConfig>;
  retentionStatusByServer?: Record<string, UserStateServerRetentionStatus>;
  setEnabled: (serverUrl: string, enabled: boolean) => void;
  setRuntime: (serverUrl: string, phase: UserStatePhase, error?: string | null, blocked?: boolean) => void;
  setBackgroundFailure?: (serverUrl: string, error: string | null, blocked?: boolean) => void;
  setEpochMismatch: (serverUrl: string, mismatch: UserStateEpochMismatch | null) => void;
  setRetention?: (serverUrl: string, patch: Partial<UserStateLocalRetentionConfig>) => void;
  setRetentionStatus?: (serverUrl: string, status: UserStateServerRetentionStatus | null) => void;
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

function normalizeDays(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 3650
    ? value
    : fallback;
}

function normalizeRetentionConfig(raw: unknown): UserStateLocalRetentionConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_USER_STATE_LOCAL_RETENTION };
  }
  const row = raw as Record<string, unknown>;
  return {
    pruneNonLibraryEnabled: row.pruneNonLibraryEnabled === true,
    pruneNonLibraryDays: normalizeDays(row.pruneNonLibraryDays, DEFAULT_USER_STATE_LOCAL_RETENTION.pruneNonLibraryDays),
    stripTimestampsEnabled: row.stripTimestampsEnabled === true,
    stripTimestampsDays: normalizeDays(row.stripTimestampsDays, DEFAULT_USER_STATE_LOCAL_RETENTION.stripTimestampsDays),
  };
}

function isDefaultRetentionConfig(cfg: UserStateLocalRetentionConfig): boolean {
  return !cfg.pruneNonLibraryEnabled &&
    !cfg.stripTimestampsEnabled &&
    cfg.pruneNonLibraryDays === DEFAULT_USER_STATE_LOCAL_RETENTION.pruneNonLibraryDays &&
    cfg.stripTimestampsDays === DEFAULT_USER_STATE_LOCAL_RETENTION.stripTimestampsDays;
}

function retentionConfigs(value: unknown): Record<string, UserStateLocalRetentionConfig> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, UserStateLocalRetentionConfig> = {};
  for (const [server, rawCfg] of Object.entries(value)) {
    try {
      const normalized = normalizeRetentionConfig(rawCfg);
      if (!isDefaultRetentionConfig(normalized)) {
        result[normalizeContentServerUrl(server)] = normalized;
      }
    } catch {
      // Ignore malformed server URLs.
    }
  }
  return result;
}

export const useUserStateStore = create<UserStateStore>()(persist((set) => ({
  enabledByServer: {},
  runtimeByServer: {},
  retentionByServer: {},
  retentionStatusByServer: {},
  setEnabled: (serverUrl, enabled) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const next = { ...state.enabledByServer };
      if (enabled) next[server] = true;
      else delete next[server];
      return { enabledByServer: next };
    });
  },
  setRuntime: (serverUrl, phase, error = null, blocked = false) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const prev = state.runtimeByServer[server];
      const keepMismatch = prev?.epochMismatch;
      const keepBackgroundError = prev?.backgroundError;
      return {
        runtimeByServer: {
          ...state.runtimeByServer,
          [server]: {
            phase,
            error,
            revision: (prev?.revision ?? 0) + 1,
            ...(blocked ? { blocked: true } : {}),
            ...(keepBackgroundError ? {
              backgroundError: keepBackgroundError,
              ...(prev?.backgroundBlocked ? { backgroundBlocked: true } : {}),
            } : {}),
            ...(keepMismatch ? { epochMismatch: keepMismatch } : {}),
          },
        },
      };
    });
  },
  setBackgroundFailure: (serverUrl, error, blocked = false) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const prev = state.runtimeByServer[server];
      if (error === null) {
        if (!prev?.backgroundError) return state;
        const { backgroundError: _bgErr, backgroundBlocked: _bgBlk, ...rest } = prev;
        return {
          runtimeByServer: {
            ...state.runtimeByServer,
            [server]: { ...rest, revision: prev.revision + 1 },
          },
        };
      }
      const { backgroundError: _prevBgErr, backgroundBlocked: _prevBgBlk, ...prevRest } =
        prev ?? USER_STATE_IDLE_RUNTIME;
      return {
        runtimeByServer: {
          ...state.runtimeByServer,
          [server]: {
            ...prevRest,
            backgroundError: error,
            ...(blocked ? { backgroundBlocked: true } : {}),
            revision: (prev?.revision ?? 0) + 1,
          },
        },
      };
    });
  },
  setEpochMismatch: (serverUrl, mismatch) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const prev = state.runtimeByServer[server];
      if (mismatch === null) {
        if (!prev?.epochMismatch) return state;
        const { epochMismatch: _omitted, ...rest } = prev;
        return {
          runtimeByServer: {
            ...state.runtimeByServer,
            [server]: { ...rest, revision: prev.revision + 1 },
          },
        };
      }
      return {
        runtimeByServer: {
          ...state.runtimeByServer,
          [server]: {
            ...(prev ?? USER_STATE_IDLE_RUNTIME),
            epochMismatch: mismatch,
            revision: (prev?.revision ?? 0) + 1,
          },
        },
      };
    });
  },
  setRetention: (serverUrl, patch) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const prev = state.retentionByServer?.[server] ?? DEFAULT_USER_STATE_LOCAL_RETENTION;
      const merged = normalizeRetentionConfig({ ...prev, ...patch });
      const next = { ...(state.retentionByServer ?? {}) };
      if (isDefaultRetentionConfig(merged)) delete next[server];
      else next[server] = merged;
      return { retentionByServer: next };
    });
  },
  setRetentionStatus: (serverUrl, status) => {
    const server = normalizeContentServerUrl(serverUrl);
    set((state) => {
      const next = { ...(state.retentionStatusByServer ?? {}) };
      if (status === null) delete next[server];
      else next[server] = status;
      return { retentionStatusByServer: next };
    });
  },
}), {
  name: "norea-user-state",
  version: 1,
  partialize: ({ enabledByServer, retentionByServer }) => {
    const savedRetention = retentionConfigs(retentionByServer);
    return {
      enabledByServer,
      ...(Object.keys(savedRetention).length > 0 ? { retentionByServer: savedRetention } : {}),
    };
  },
  merge: (saved, current) => {
    const obj = saved !== null && typeof saved === "object" ? saved as Record<string, unknown> : undefined;
    return {
      ...current,
      enabledByServer: enabledServers(obj?.enabledByServer),
      retentionByServer: retentionConfigs(obj?.retentionByServer),
    };
  },
}));
