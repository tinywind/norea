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
  /** The retired reader option "Download next chapter in advance" has been turned into goals. */
  legacyReadAheadMigrated: boolean;
}

interface DownloadGoalSettingsStore extends DownloadGoalSettings {
  setDefaultKeepAhead: (count: number) => void;
  setAutomaticOnMobileData: (allowed: boolean) => void;
  completeLegacyReadAheadMigration: (defaultKeepAhead: number) => void;
}

function normalizeDefaultKeepAhead(value: unknown): DefaultKeepAheadChoice {
  return DEFAULT_KEEP_AHEAD_CHOICES.find((choice) => choice === value) ?? DEFAULT_KEEP_AHEAD;
}

export function normalizeDownloadGoalSettings(value: unknown): DownloadGoalSettings {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    defaultKeepAhead: normalizeDefaultKeepAhead(stored.defaultKeepAhead),
    automaticOnMobileData: stored.automaticOnMobileData === true,
    legacyReadAheadMigrated: stored.legacyReadAheadMigrated === true,
  };
}

export const DOWNLOAD_GOAL_SETTINGS_KEY = "download-goal-settings";

/** Whether the default keep-ahead was ever saved, so an earlier setting must not replace it. */
export function isDefaultKeepAheadStored(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(DOWNLOAD_GOAL_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const state = parsed !== null && typeof parsed === "object" ? (parsed as { state?: unknown }).state : null;
    return state !== null && typeof state === "object" &&
      DEFAULT_KEEP_AHEAD_CHOICES.some((choice) => choice === (state as Record<string, unknown>).defaultKeepAhead);
  } catch {
    return false;
  }
}

export const useDownloadGoalSettingsStore = create<DownloadGoalSettingsStore>()(persist(
  (set) => ({
    ...normalizeDownloadGoalSettings(null),
    setDefaultKeepAhead: (count) => set({ defaultKeepAhead: normalizeDefaultKeepAhead(count) }),
    setAutomaticOnMobileData: (automaticOnMobileData) => set({ automaticOnMobileData }),
    completeLegacyReadAheadMigration: (count) =>
      set({ defaultKeepAhead: normalizeDefaultKeepAhead(count), legacyReadAheadMigrated: true }),
  }),
  {
    name: DOWNLOAD_GOAL_SETTINGS_KEY,
    partialize: ({ defaultKeepAhead, automaticOnMobileData, legacyReadAheadMigrated }) =>
      ({ defaultKeepAhead, automaticOnMobileData, legacyReadAheadMigrated }),
    merge: (persisted, current) => ({ ...current, ...normalizeDownloadGoalSettings(persisted) }),
  },
));
