import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { VpnDownloadChallengePolicy, VpnDownloadMode } from "../lib/tasks/vpn-download-types";

interface VpnDownloadSettings {
  mode: VpnDownloadMode;
  workerCount: number;
  captchaPolicy: VpnDownloadChallengePolicy;
  cloudflarePolicy: VpnDownloadChallengePolicy;
}

interface VpnDownloadStore extends VpnDownloadSettings {
  setMode: (mode: VpnDownloadMode) => void;
  setWorkerCount: (count: number) => void;
  setCaptchaPolicy: (policy: VpnDownloadChallengePolicy) => void;
  setCloudflarePolicy: (policy: VpnDownloadChallengePolicy) => void;
}

export function normalizeVpnDownloadSettings(value: unknown): VpnDownloadSettings {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    mode: stored.mode === "single" || stored.mode === "parallel" ? stored.mode : "off",
    workerCount: typeof stored.workerCount === "number" && Number.isFinite(stored.workerCount)
      ? Math.max(1, Math.min(2, Math.floor(stored.workerCount))) : 2,
    captchaPolicy: stored.captchaPolicy === "nextProfile" ? "nextProfile" : "pause",
    cloudflarePolicy: stored.cloudflarePolicy === "nextProfile" ? "nextProfile" : "pause",
  };
}

export const useVpnDownloadStore = create<VpnDownloadStore>()(persist(
  (set) => ({
    ...normalizeVpnDownloadSettings(null),
    setMode: (mode) => set({ mode }),
    setWorkerCount: (workerCount) => set({ workerCount: normalizeVpnDownloadSettings({ workerCount }).workerCount }),
    setCaptchaPolicy: (captchaPolicy) => set({ captchaPolicy }),
    setCloudflarePolicy: (cloudflarePolicy) => set({ cloudflarePolicy }),
  }),
  {
    name: "vpn-download-settings",
    partialize: ({ mode, workerCount, captchaPolicy, cloudflarePolicy }) => ({ mode, workerCount, captchaPolicy, cloudflarePolicy }),
    merge: (persisted, current) => ({ ...current, ...normalizeVpnDownloadSettings(persisted) }),
  },
));
