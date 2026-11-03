import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Choices for the keep-ahead goal applied to active library novels; 0 means off. */
export const DEFAULT_KEEP_AHEAD_CHOICES = [0, 1, 3, 5, 10] as const;
export type DefaultKeepAheadChoice = (typeof DEFAULT_KEEP_AHEAD_CHOICES)[number];
export const DEFAULT_KEEP_AHEAD: DefaultKeepAheadChoice = 3;

interface DownloadGoalSettings {
  /** Chapters kept downloaded ahead of the reading position for active library novels without their own goal. */
  defaultKeepAhead: DefaultKeepAheadChoice;
  /** Lets automatic goal downloads run on a metered (mobile data) network. */
  automaticOnMobileData: boolean;
}

interface DownloadGoalSettingsStore extends DownloadGoalSettings {
  setDefaultKeepAhead: (count: number) => void;
  setAutomaticOnMobileData: (allowed: boolean) => void;
}

function normalizeDefaultKeepAhead(value: unknown): DefaultKeepAheadChoice {
  return DEFAULT_KEEP_AHEAD_CHOICES.find((choice) => choice === value) ?? DEFAULT_KEEP_AHEAD;
}

export function normalizeDownloadGoalSettings(value: unknown): DownloadGoalSettings {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    defaultKeepAhead: normalizeDefaultKeepAhead(stored.defaultKeepAhead),
    automaticOnMobileData: stored.automaticOnMobileData === true,
  };
}

export const DOWNLOAD_GOAL_SETTINGS_KEY = "download-goal-settings";

export const useDownloadGoalSettingsStore = create<DownloadGoalSettingsStore>()(persist(
  (set) => ({
    ...normalizeDownloadGoalSettings(null),
    setDefaultKeepAhead: (count) => set({ defaultKeepAhead: normalizeDefaultKeepAhead(count) }),
    setAutomaticOnMobileData: (automaticOnMobileData) => set({ automaticOnMobileData }),
  }),
  {
    name: DOWNLOAD_GOAL_SETTINGS_KEY,
    partialize: ({ defaultKeepAhead, automaticOnMobileData }) => ({ defaultKeepAhead, automaticOnMobileData }),
    merge: (persisted, current) => ({ ...current, ...normalizeDownloadGoalSettings(persisted) }),
  },
));
