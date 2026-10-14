import { invoke } from "@tauri-apps/api/core";
import { parseBackupManifest, type BackupManifest } from "./format";

interface UnpackedBackupRaw {
  manifest_json: string;
}

/** Read the current manifest-only backup archive from disk. */
export async function unpackBackup(inputPath: string): Promise<BackupManifest> {
  const result = await invoke<UnpackedBackupRaw>("backup_unpack", { inputPath });
  return parseBackupManifest(result.manifest_json);
}
