import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DownloadRecoveryAction = "pause" | "retry" | "resetSite" | "nextProfile";

export interface DownloadRecoveryPolicy {
  forbiddenAction: "pause" | "retry" | "resetSite";
  transientAction: "pause" | "retry" | "nextProfile";
  rateLimitAction: "pause" | "retry";
  notFoundAction: "skip" | "pause";
  maxRetries: number;
  retryDelaySeconds: number;
  maxProfileChanges: number;
  rotateFingerprintOnVpnChange: boolean;
}

interface DownloadRecoveryStore extends DownloadRecoveryPolicy {
  setPolicy: (patch: Partial<DownloadRecoveryPolicy>) => void;
}

export const DOWNLOAD_RECOVERY_SETTINGS_KEY = "download-recovery-settings";

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : fallback;
}

export function normalizeDownloadRecoveryPolicy(value: unknown): DownloadRecoveryPolicy {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    forbiddenAction: stored.forbiddenAction === "retry" || stored.forbiddenAction === "resetSite"
      ? stored.forbiddenAction : "pause",
    transientAction: stored.transientAction === "retry" || stored.transientAction === "nextProfile"
      ? stored.transientAction : "pause",
    rateLimitAction: stored.rateLimitAction === "retry" ? "retry" : "pause",
    notFoundAction: stored.notFoundAction === "pause" ? "pause" : "skip",
    maxRetries: boundedInteger(stored.maxRetries, 2, 0, 5),
    retryDelaySeconds: boundedInteger(stored.retryDelaySeconds, 30, 5, 3_600),
    maxProfileChanges: boundedInteger(stored.maxProfileChanges, 1, 0, 3),
    rotateFingerprintOnVpnChange: stored.rotateFingerprintOnVpnChange === true,
  };
}

export const useDownloadRecoveryStore = create<DownloadRecoveryStore>()(persist(
  (set) => ({
    ...normalizeDownloadRecoveryPolicy(null),
    setPolicy: (patch) => set((current) => normalizeDownloadRecoveryPolicy({ ...current, ...patch })),
  }),
  {
    name: DOWNLOAD_RECOVERY_SETTINGS_KEY,
    partialize: (state: DownloadRecoveryStore) => normalizeDownloadRecoveryPolicy(state),
    merge: (persisted, current) => ({ ...current, ...normalizeDownloadRecoveryPolicy(persisted) }),
  },
));

/** A policy snapshot without store actions or per-attempt recovery state. */
export function getDownloadRecoveryPolicy(): DownloadRecoveryPolicy {
  return normalizeDownloadRecoveryPolicy(useDownloadRecoveryStore.getState());
}
