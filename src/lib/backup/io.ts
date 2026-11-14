import { open, save } from "@tauri-apps/plugin-dialog";
import { packBackup } from "./pack";
import { applyBackupSnapshot, gatherBackupSnapshot } from "./snapshot";
import { unpackBackup } from "./unpack";

const ZIP_FILTER_NAME = "Norea Backup";

function zipFilter(): { name: string; extensions: string[] } {
  return { name: ZIP_FILTER_NAME, extensions: ["zip"] };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function localTimestamp(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = twoDigits(now.getMonth() + 1);
  const day = twoDigits(now.getDate());
  const hours = twoDigits(now.getHours());
  const minutes = twoDigits(now.getMinutes());
  const seconds = twoDigits(now.getSeconds());
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/** `norea-backup-yyyyMMddHHmmss.zip` is what the save dialog pre-fills. */
export function defaultBackupFilename(now: Date = new Date()): string {
  return `norea-backup-${localTimestamp(now)}.zip`;
}

/** `norea-auto-backup-yyyyMMddHHmmss.zip`, the only names automatic backup prunes. */
export function automaticBackupFilename(now: Date = new Date()): string {
  return `norea-auto-backup-${localTimestamp(now)}.zip`;
}

/**
 * Run the full export flow: file picker, DB snapshot, then zip pack.
 *
 * Resolves with the chosen path, or `null` if the user dismissed the
 * dialog. Errors thrown by `gatherBackupSnapshot` / `packBackup`
 * propagate to the caller for UI presentation.
 */
export async function exportBackupToFile(): Promise<string | null> {
  const path = await save({
    defaultPath: defaultBackupFilename(),
    filters: [zipFilter()],
  });
  if (!path) return null;
  const manifest = await gatherBackupSnapshot();
  await packBackup(manifest, path);
  return path;
}

/**
 * Run the full import flow: file picker, zip unpack, then DB and storage apply.
 *
 * Destructive; replaces the backup-managed database rows. The
 * caller is expected to confirm intent before invoking this.
 *
 * Resolves with the chosen path, or `null` if the user dismissed
 * the dialog.
 */
export async function importBackupFromFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    filters: [zipFilter()],
  });
  if (selected === null || Array.isArray(selected)) {
    return null;
  }
  const manifest = await unpackBackup(selected);
  await applyBackupSnapshot(manifest);
  return selected;
}
