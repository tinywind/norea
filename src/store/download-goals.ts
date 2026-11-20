import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { NovelDownloadGoal } from "../db/queries/novel-download-goal";

/** Counts offered by the automatic policy shared by active library novels. */
export const AUTOMATIC_KEEP_AHEAD_CHOICES = [1, 3, 5, 10, 30] as const;
export const DEFAULT_AUTOMATIC_DOWNLOAD_GOAL = { kind: "keep_ahead", count: 3 } as const;

/** Active period options (days since last opened, or unlimited for the entire library including never-opened works). */
export const AUTOMATIC_ACTIVE_WINDOW_CHOICES = [7, 14, 30, "unlimited"] as const;
export type AutomaticActiveWindowChoice = (typeof AUTOMATIC_ACTIVE_WINDOW_CHOICES)[number];
export const DEFAULT_AUTOMATIC_ACTIVE_WINDOW: AutomaticActiveWindowChoice = 14;

/** Choices for keeping the last finished chapters of each novel when read chapters are removed; "off" disables cleanup, 0 deletes all read chapters. */
export const FINISHED_CHAPTER_KEEP_CHOICES = ["off", 0, 5, 10, 20] as const;
export type FinishedChapterKeepChoice = (typeof FINISHED_CHAPTER_KEEP_CHOICES)[number];

interface DownloadGoalSettings {
  /** The policy for future automatic work on active library novels that the user has not paused. */
  automaticGoal: NovelDownloadGoal;
  /** Active period for automatic downloads and download-goal cleanup protection. */
  automaticActiveWindow: AutomaticActiveWindowChoice;
  /** Lets automatic goal downloads run on a metered (mobile data) network. */
  automaticOnMobileData: boolean;
  /** The retired reader option has been carried into the global policy and explicit pauses. */
  legacyReadAheadMigrated: boolean;
  /** Finished chapters kept per novel when read chapters are removed automatically; "off" is off, 0 deletes all read chapters. */
  finishedChapterKeep: FinishedChapterKeepChoice;
  /** Marker separating legacy stored `0` (which meant "off") from explicit numeric `0` (keep 0 chapters). */
  finishedChapterKeepOffMigrated: boolean;
  /** The user accepted that, without a content server, removed chapters exist nowhere else. */
  finishedCleanupWithoutServer: boolean;
}

interface DownloadGoalSettingsStore extends DownloadGoalSettings {
  setAutomaticGoal: (goal: NovelDownloadGoal) => void;
  setAutomaticActiveWindow: (window: AutomaticActiveWindowChoice) => void;
  setAutomaticOnMobileData: (allowed: boolean) => void;
  completeLegacyReadAheadMigration: (goal: NovelDownloadGoal) => void;
  setFinishedChapterCleanup: (keep: FinishedChapterKeepChoice, withoutServer: boolean) => void;
}

function readAutomaticGoal(value: unknown): NovelDownloadGoal | null {
  if (value === null || typeof value !== "object") return null;
  const goal = value as Record<string, unknown>;
  if (goal.kind === "none" || goal.kind === "all_remaining" || goal.kind === "entire") return { kind: goal.kind };
  const count = AUTOMATIC_KEEP_AHEAD_CHOICES.find(choice => choice === goal.count);
  return goal.kind === "keep_ahead" && count !== undefined ? { kind: "keep_ahead", count } : null;
}

function normalizeAutomaticActiveWindow(value: unknown): AutomaticActiveWindowChoice {
  return AUTOMATIC_ACTIVE_WINDOW_CHOICES.find((choice) => choice === value) ?? DEFAULT_AUTOMATIC_ACTIVE_WINDOW;
}

function legacyAutomaticGoal(value: unknown): NovelDownloadGoal | null {
  if (value === 0) return { kind: "none" };
  const count = AUTOMATIC_KEEP_AHEAD_CHOICES.find(choice => choice === value);
  return count === undefined ? null : { kind: "keep_ahead", count };
}

function sameAutomaticGoal(left: NovelDownloadGoal, right: NovelDownloadGoal): boolean {
  return left.kind === right.kind && (left.kind !== "keep_ahead" || right.kind === "keep_ahead" && left.count === right.count);
}

function normalizeFinishedChapterKeep(value: unknown, migrated: boolean): FinishedChapterKeepChoice {
  if (value === "off") return "off";
  if (value === 0) return migrated ? 0 : "off";
  return FINISHED_CHAPTER_KEEP_CHOICES.find((choice) => choice === value) ?? "off";
}

export function normalizeDownloadGoalSettings(value: unknown): DownloadGoalSettings {
  const stored = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const migrated = stored.finishedChapterKeepOffMigrated === true;
  return {
    automaticGoal: readAutomaticGoal(stored.automaticGoal) ?? legacyAutomaticGoal(stored.defaultKeepAhead) ?? { ...DEFAULT_AUTOMATIC_DOWNLOAD_GOAL },
    automaticActiveWindow: normalizeAutomaticActiveWindow(stored.automaticActiveWindow),
    automaticOnMobileData: stored.automaticOnMobileData === true,
    legacyReadAheadMigrated: stored.legacyReadAheadMigrated === true,
    finishedChapterKeep: normalizeFinishedChapterKeep(stored.finishedChapterKeep, migrated),
    finishedChapterKeepOffMigrated: true,
    finishedCleanupWithoutServer: stored.finishedCleanupWithoutServer === true,
  };
}

export const DOWNLOAD_GOAL_SETTINGS_KEY = "download-goal-settings";

/** A saved global policy, including the earlier keep-ahead setting, takes precedence over the retired reader option. */
export function isAutomaticDownloadGoalStored(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(DOWNLOAD_GOAL_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const value = parsed !== null && typeof parsed === "object" ? (parsed as { state?: unknown }).state : null;
    if (value === null || typeof value !== "object") return false;
    const state = value as Record<string, unknown>;
    return readAutomaticGoal(state.automaticGoal) !== null || legacyAutomaticGoal(state.defaultKeepAhead) !== null;
  } catch {
    return false;
  }
}

export const useDownloadGoalSettingsStore = create<DownloadGoalSettingsStore>()(persist(
  (set) => ({
    ...normalizeDownloadGoalSettings(null),
    setAutomaticGoal: (value) => set(state => {
      const automaticGoal = readAutomaticGoal(value) ?? { ...DEFAULT_AUTOMATIC_DOWNLOAD_GOAL };
      return sameAutomaticGoal(state.automaticGoal, automaticGoal) ? state : { automaticGoal };
    }),
    setAutomaticActiveWindow: (value) => set(state => {
      const automaticActiveWindow = normalizeAutomaticActiveWindow(value);
      return state.automaticActiveWindow === automaticActiveWindow ? state : { automaticActiveWindow };
    }),
    setAutomaticOnMobileData: (automaticOnMobileData) => set({ automaticOnMobileData }),
    completeLegacyReadAheadMigration: (value) => set(state => {
      const goal = readAutomaticGoal(value) ?? { ...DEFAULT_AUTOMATIC_DOWNLOAD_GOAL };
      return { automaticGoal: sameAutomaticGoal(state.automaticGoal, goal) ? state.automaticGoal : goal, legacyReadAheadMigrated: true };
    }),
    setFinishedChapterCleanup: (keep, withoutServer) =>
      set({
        finishedChapterKeep: normalizeFinishedChapterKeep(keep, true),
        finishedChapterKeepOffMigrated: true,
        finishedCleanupWithoutServer: withoutServer,
      }),
  }),
  {
    name: DOWNLOAD_GOAL_SETTINGS_KEY,
    partialize: ({
      automaticGoal,
      automaticActiveWindow,
      automaticOnMobileData,
      legacyReadAheadMigrated,
      finishedChapterKeep,
      finishedChapterKeepOffMigrated,
      finishedCleanupWithoutServer,
    }) => ({
      automaticGoal,
      automaticActiveWindow,
      automaticOnMobileData,
      legacyReadAheadMigrated,
      finishedChapterKeep,
      finishedChapterKeepOffMigrated,
      finishedCleanupWithoutServer,
    }),
    merge: (persisted, current) => ({ ...current, ...normalizeDownloadGoalSettings(persisted) }),
  },
));
