import { open, save } from "@tauri-apps/plugin-dialog";
import {
  copyAndroidContentUriToTempFile,
  deleteAndroidContentUriTempFile,
  readAndroidContentUriBytes,
  writeAndroidContentUriFile,
} from "../android-storage";
import { restoreChapterContentStorageMirror } from "../chapter-content-storage";
import { MAX_BACKUP_ARCHIVE_BYTES } from "../performance-budgets";
import { isAndroidRuntime } from "../tauri-runtime";
import { deleteBackupTempFile, packBackup, packBackupTempFile } from "./pack";
import { applyBackupSnapshot, gatherBackupSnapshot } from "./snapshot";
import type { BackupManifest } from "./format";
import { unpackBackup, unpackBackupBytes } from "./unpack";

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
  if (isAndroidRuntime() && path.startsWith("content://")) {
    const tempPath = await packBackupTempFile(manifest);
    try {
      await writeAndroidContentUriFile(path, tempPath, "application/zip");
    } finally {
      try {
        await deleteBackupTempFile(tempPath);
      } catch (error) {
        console.warn("[backup] temp file cleanup failed", error);
      }
    }
  } else {
    await packBackup(manifest, path);
  }
  return path;
}

/**
 * Run the full import flow: file picker, zip unpack, DB apply, then
 * storage-folder content restore.
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
    // `multiple: false` should never resolve with an array, but the
    // dialog plugin's union type forces us to narrow.
    return null;
  }
  const manifest =
    isAndroidRuntime() && selected.startsWith("content://")
      ? await unpackAndroidBackupContentUri(selected)
      : await unpackBackup(selected);
  await applyBackupSnapshot(manifest);
  await restoreChapterContentStorageMirror({
    chapterIds: new Set(
      manifest.chapters
        .filter((chapter) => chapter.content === null)
        .map((chapter) => chapter.id),
    ),
    contentOnly: true,
  });
  return selected;
}

async function unpackAndroidBackupContentUri(
  uri: string,
): Promise<BackupManifest> {
  const tempFile = await copyAndroidContentUriToTempFile(
    uri,
    MAX_BACKUP_ARCHIVE_BYTES,
  );
  if (tempFile) {
    try {
      return await unpackBackup(tempFile.path);
    } finally {
      await deleteAndroidContentUriTempFile(tempFile);
    }
  }
  return unpackBackupBytes(await readAndroidContentUriBytes(uri));
}
