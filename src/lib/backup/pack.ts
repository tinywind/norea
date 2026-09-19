import { invoke } from "@tauri-apps/api/core";
import { encodeBackupManifest, type BackupManifest } from "./format";

/**
 * Pack a {@link BackupManifest} into a zip on disk via the Rust
 * `backup_pack` IPC command. The archive carries the manifest only;
 * chapter bodies and media stay in chapter storage.
 */
export async function packBackup(
  manifest: BackupManifest,
  outputPath: string,
): Promise<void> {
  await invoke("backup_pack", {
    manifestJson: encodeBackupManifest(manifest),
    outputPath,
  });
}

export async function packBackupTempFile(
  manifest: BackupManifest,
): Promise<string> {
  return invoke<string>("backup_pack_temp_file", {
    manifestJson: encodeBackupManifest(manifest),
  });
}

export async function deleteBackupTempFile(path: string): Promise<void> {
  await invoke("backup_delete_temp_file", { path });
}

export async function packBackupBytes(
  manifest: BackupManifest,
): Promise<number[]> {
  return invoke<number[]>("backup_pack_bytes", {
    manifestJson: encodeBackupManifest(manifest),
  });
}
