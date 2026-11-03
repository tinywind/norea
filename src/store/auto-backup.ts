import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AutoBackupSchedule = "off" | "daily" | "weekly";

export const AUTO_BACKUP_SCHEDULES: readonly AutoBackupSchedule[] = ["off", "daily", "weekly"];
export const DEFAULT_AUTO_BACKUP_KEEP = 5;
export const AUTO_BACKUP_KEEP_OPTIONS = [3, 5, 10, 20] as const;
const MAX_AUTO_BACKUP_KEEP = 50;

export const AUTO_BACKUP_STORAGE_KEY = "auto-backup";

interface AutoBackupState {
  schedule: AutoBackupSchedule;
  /** Automatic backups kept in the folder; older ones are deleted. */
  keep: number;
  /** Unix ms of the last automatic backup that was written. */
  lastSuccessAt: number | null;
  lastFileName: string | null;
  /** Unix ms and reason of the last failed attempt, cleared by a success. */
  lastFailureAt: number | null;
  lastError: string | null;
  /** The last attempt failed because the storage folder could not be reached or written. */
  lastFailureFolderUnavailable: boolean;
  setSchedule: (schedule: AutoBackupSchedule) => void;
  setKeep: (keep: number) => void;
  recordSuccess: (at: number, fileName: string) => void;
  recordFailure: (at: number, error: string, folderUnavailable: boolean) => void;
  /** Forgets the last failure so the next check runs at once, after the user fixed its cause. */
  clearFailure: () => void;
}

export function normalizeAutoBackupSchedule(value: unknown): AutoBackupSchedule {
  return value === "daily" || value === "weekly" ? value : "off";
}

export function normalizeAutoBackupKeep(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AUTO_BACKUP_KEEP
    ? value
    : DEFAULT_AUTO_BACKUP_KEEP;
}

function timestampOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * RD15 automatic backup settings and the outcome of its last run. The folder
 * it writes to belongs to this device, so the entry is device state.
 */
export const useAutoBackupStore = create<AutoBackupState>()(
  persist(
    (set) => ({
      schedule: "off",
      keep: DEFAULT_AUTO_BACKUP_KEEP,
      lastSuccessAt: null,
      lastFileName: null,
      lastFailureAt: null,
      lastError: null,
      lastFailureFolderUnavailable: false,
      setSchedule: (schedule) => set({ schedule: normalizeAutoBackupSchedule(schedule) }),
      setKeep: (keep) => set({ keep: normalizeAutoBackupKeep(keep) }),
      recordSuccess: (lastSuccessAt, lastFileName) =>
        set({ lastSuccessAt, lastFileName, lastFailureAt: null, lastError: null, lastFailureFolderUnavailable: false }),
      recordFailure: (lastFailureAt, lastError, lastFailureFolderUnavailable) =>
        set({ lastFailureAt, lastError, lastFailureFolderUnavailable }),
      clearFailure: () => set({ lastFailureAt: null, lastError: null, lastFailureFolderUnavailable: false }),
    }),
    {
      name: AUTO_BACKUP_STORAGE_KEY,
      partialize: ({
        keep, lastError, lastFailureAt, lastFailureFolderUnavailable, lastFileName, lastSuccessAt, schedule,
      }) => ({
        keep, lastError, lastFailureAt, lastFailureFolderUnavailable, lastFileName, lastSuccessAt, schedule,
      }),
      merge: (persistedState, currentState) => {
        if (persistedState === null || typeof persistedState !== "object") return currentState;
        const persisted = persistedState as Record<string, unknown>;
        return {
          ...currentState,
          schedule: normalizeAutoBackupSchedule(persisted.schedule),
          keep: normalizeAutoBackupKeep(persisted.keep),
          lastSuccessAt: timestampOrNull(persisted.lastSuccessAt),
          lastFileName: textOrNull(persisted.lastFileName),
          lastFailureAt: timestampOrNull(persisted.lastFailureAt),
          lastError: textOrNull(persisted.lastError),
          lastFailureFolderUnavailable: persisted.lastFailureFolderUnavailable === true,
        };
      },
    },
  ),
);
