import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../tauri-runtime";

/** Why automatic goal work is paused. Explicit downloads never wait for these. */
export type DownloadGoalPause = "restore" | "storage" | "metered" | "battery";

export interface DownloadBudgetStatus {
  metered: boolean;
  powerSave: boolean;
  /** Null where the platform has no free-space query; no storage check applies then. */
  freeBytes: number | null;
}

export const MIN_AUTOMATIC_DOWNLOAD_FREE_BYTES = 1024 ** 3;

const UNKNOWN_STATUS: DownloadBudgetStatus = { metered: false, powerSave: false, freeBytes: null };

export async function readDownloadBudgetStatus(): Promise<DownloadBudgetStatus> {
  if (!isTauriRuntime()) return UNKNOWN_STATUS;
  try {
    return await invoke<DownloadBudgetStatus>("download_budget_status");
  } catch (error) {
    console.warn("[download-goals] could not read the download budget:", error);
    return UNKNOWN_STATUS;
  }
}

export function automaticDownloadPause(input: {
  heldAfterRestore: boolean;
  status: DownloadBudgetStatus;
  allowMobileData: boolean;
  /** "Allow once": lifts the network and battery budgets until the app restarts. */
  allowedOnce: boolean;
}): DownloadGoalPause | null {
  if (input.heldAfterRestore) return "restore";
  if (input.status.freeBytes !== null && input.status.freeBytes < MIN_AUTOMATIC_DOWNLOAD_FREE_BYTES) return "storage";
  if (input.allowedOnce) return null;
  if (input.status.metered && !input.allowMobileData) return "metered";
  if (input.status.powerSave) return "battery";
  return null;
}

const RESTORE_HOLD_KEY = "download-goals-held-after-restore";

/** Device restores mark goals held, so restored goals start no work until the user resumes. */
export function holdDownloadGoalsAfterRestore(): void {
  localStorage.setItem(RESTORE_HOLD_KEY, "1");
}

export function isDownloadGoalRestoreHoldSet(): boolean {
  try {
    return globalThis.localStorage?.getItem(RESTORE_HOLD_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearDownloadGoalRestoreHold(): void {
  try {
    globalThis.localStorage?.removeItem(RESTORE_HOLD_KEY);
  } catch (error) {
    console.warn("[download-goals] could not clear the restore hold:", error);
  }
}
