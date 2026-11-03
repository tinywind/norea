import { invoke } from "@tauri-apps/api/core";
import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { useAutoBackupStore, type AutoBackupSchedule } from "../../store/auto-backup";
import { BackupFolderUnavailableError, publishAndroidAutoBackup } from "../android-storage";
import { describeError } from "../errors";
import { enqueueMainTask } from "../tasks/main-tasks";
import { isAndroidRuntime } from "../tauri-runtime";
import { encodeBackupManifest } from "./format";
import { automaticBackupFilename } from "./io";
import { deleteBackupTempFile, packBackupTempFile } from "./pack";
import { gatherBackupSnapshot } from "./snapshot";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A failed run waits this long before the next attempt, so it never loops. */
const FAILURE_RETRY_MS = HOUR_MS;
/** Matches `AUTO_BACKUP_FOLDER_UNAVAILABLE` in src-tauri/src/backup.rs. */
const DESKTOP_FOLDER_UNAVAILABLE = "backup_publish_auto: storage folder unavailable";

const SCHEDULE_INTERVAL_MS: Record<Exclude<AutoBackupSchedule, "off">, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
};

export interface AutoBackupDueState {
  schedule: AutoBackupSchedule;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

/** Whether a scheduled backup is overdue at `now` (Unix ms), including a missed run. */
export function isAutomaticBackupDue(state: AutoBackupDueState, now: number): boolean {
  if (state.schedule === "off") return false;
  if (state.lastFailureAt !== null && now - state.lastFailureAt < FAILURE_RETRY_MS) return false;
  return state.lastSuccessAt === null || now - state.lastSuccessAt >= SCHEDULE_INTERVAL_MS[state.schedule];
}

/**
 * Packs the portable backup and publishes it into `backups/` of the storage
 * folder, keeping the newest `keep` automatic backups. Resolves the file name.
 */
export async function writeAutomaticBackup(keep: number, now: Date = new Date()): Promise<string> {
  const fileName = automaticBackupFilename(now);
  const manifest = await gatherBackupSnapshot();
  if (isAndroidRuntime()) {
    const tempPath = await packBackupTempFile(manifest);
    try {
      await publishAndroidAutoBackup(tempPath, fileName, keep);
    } finally {
      await deleteBackupTempFile(tempPath).catch((error: unknown) =>
        console.warn("[backup:auto] temp file cleanup failed", error),
      );
    }
  } else {
    try {
      await invoke("backup_publish_auto", { manifestJson: encodeBackupManifest(manifest), fileName, keep });
    } catch (error) {
      const message = describeError(error);
      if (message.startsWith(DESKTOP_FOLDER_UNAVAILABLE)) {
        throw new BackupFolderUnavailableError(message, { cause: error });
      }
      throw error;
    }
  }
  return fileName;
}

let running: Promise<void> | null = null;

/**
 * Runs one automatic backup task when the schedule says it is overdue and
 * records the outcome. A failed task raises the "Backup failed" notification
 * through the task notifications. Concurrent calls share the running backup.
 */
export function runAutomaticBackupIfDue(now: number = Date.now()): Promise<void> {
  if (running) return running;
  const { keep, ...state } = useAutoBackupStore.getState();
  if (!isAutomaticBackupDue(state, now)) return Promise.resolve();
  running = (async () => {
    try {
      const fileName = await enqueueMainTask({
        kind: "backup.auto",
        priority: "background",
        title: translate(useAppearanceStore.getState().appLocale, "settings.backup.auto.task"),
        run: () => writeAutomaticBackup(keep, new Date(now)),
      }).promise;
      useAutoBackupStore.getState().recordSuccess(Date.now(), fileName);
    } catch (error) {
      useAutoBackupStore.getState().recordFailure(
        Date.now(),
        describeError(error),
        error instanceof BackupFolderUnavailableError,
      );
    } finally {
      running = null;
    }
  })();
  return running;
}
