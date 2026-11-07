import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { VpnDownloadChallengePolicy, VpnDownloadMode } from "../lib/tasks/vpn-download-types";

interface VpnDownloadSettings {
  mode: VpnDownloadMode;
  workerCount: number;
  captchaPolicy: VpnDownloadChallengePolicy;
  cloudflarePolicy: VpnDownloadChallengePolicy;
  resumeAfterRestart: boolean;
  /** Lease tested VPN Gate servers without an O verdict; off means approved (O) profiles only. */
  useTestedServers: boolean;
}

interface VpnDownloadStore extends VpnDownloadSettings {
  setMode: (mode: VpnDownloadMode) => void;
  setWorkerCount: (count: number) => void;
  setCaptchaPolicy: (policy: VpnDownloadChallengePolicy) => void;
  setCloudflarePolicy: (policy: VpnDownloadChallengePolicy) => void;
  setResumeAfterRestart: (resume: boolean) => void;
  setUseTestedServers: (use: boolean) => void;
}

export function normalizeVpnDownloadSettings(value: unknown): VpnDownloadSettings {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    mode: stored.mode === "single" || stored.mode === "parallel" ? stored.mode : "off",
    workerCount: 1,
    captchaPolicy: "pause",
    cloudflarePolicy: "pause",
    resumeAfterRestart: stored.resumeAfterRestart !== false,
    useTestedServers: stored.useTestedServers !== false,
  };
}

export const useVpnDownloadStore = create<VpnDownloadStore>()(persist(
  (set) => ({
    ...normalizeVpnDownloadSettings(null),
    setMode: (mode) => set({ mode }),
    setWorkerCount: () => set({ workerCount: 1 }),
    setCaptchaPolicy: (captchaPolicy) => set({ captchaPolicy }),
    setCloudflarePolicy: (cloudflarePolicy) => set({ cloudflarePolicy }),
    setResumeAfterRestart: (resumeAfterRestart) => set({ resumeAfterRestart }),
    setUseTestedServers: (useTestedServers) => set({ useTestedServers }),
  }),
  {
    name: "vpn-download-settings",
    partialize: ({ mode, workerCount, captchaPolicy, cloudflarePolicy, resumeAfterRestart, useTestedServers }) =>
      ({ mode, workerCount, captchaPolicy, cloudflarePolicy, resumeAfterRestart, useTestedServers }),
    merge: (persisted, current) => ({ ...current, ...normalizeVpnDownloadSettings(persisted) }),
  },
));
