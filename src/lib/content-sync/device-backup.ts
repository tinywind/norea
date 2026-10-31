import { invoke } from "@tauri-apps/api/core";
import { translate } from "../../i18n";
import { useAppearanceStore } from "../../store/appearance";
import { cancelWorkMetadataRecovery, getDb, runExclusiveDatabaseOperation } from "../../db/client";
import { useContentSyncStore } from "../../store/content-sync";
import { enqueueMainTask } from "../tasks/main-tasks";
import { contentServerRequest, normalizeContentServerUrl } from "./client";
import { registerContentDevice, type ContentCapabilities } from "./device";
import { runContentStorageOperation } from "./storage-operation";
import { runContentSyncOperation } from "./sync";

export interface DeviceBackupEntry {
  deviceName: string;
  updatedAt: number;
  size: number;
  sha256: string;
}
export interface DeviceSetting { key: string; value: string }
interface BackupFile { path: string; size: number; sha256: string }
interface DeviceBackupManifest {
  format: "norea-device-backup";
  version: 1;
  deviceName: string;
  createdAt: number;
  settings: DeviceSetting[];
}
export type DeviceBackupPhase = "preparing" | "uploading" | "downloading" | "restoring";
export class DeviceBackupError extends Error {
  constructor(public code: "unsupported" | "changed" | "invalidResponse" | "busy" | "invalidName") { super(code); }
}
let inFlight = false;

function assertServer(server: string): void {
  if (useContentSyncStore.getState().serverUrl !== server) throw new DeviceBackupError("changed");
}
export async function defaultBackupDeviceName(): Promise<string> {
  const name = useContentSyncStore.getState().deviceName || await invoke<string>("get_default_device_name");
  if (!name.trim() || name.trim() !== name || [...name].length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new DeviceBackupError("invalidName");
  }
  return name;
}
function validEntry(value: unknown): value is DeviceBackupEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as DeviceBackupEntry;
  return typeof entry.deviceName === "string" && entry.deviceName.length > 0 &&
    Number.isSafeInteger(entry.updatedAt) && entry.updatedAt >= 0 &&
    Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= 512 * 1024 * 1024 &&
    typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256);
}
async function access(server: string, signal?: AbortSignal): Promise<string> {
  assertServer(server);
  const capabilities = await contentServerRequest<ContentCapabilities & { deviceBackupVersion?: number }>(server, "/capabilities", undefined, "GET", undefined, signal);
  assertServer(server);
  if (capabilities.apiVersion !== 1 || capabilities.packageVersion !== 1 || capabilities.authentication !== "device-key" || capabilities.deviceBackupVersion !== 1) {
    throw new DeviceBackupError("unsupported");
  }
  const token = await registerContentDevice(server, useContentSyncStore.getState().deviceName, signal);
  assertServer(server);
  return token;
}
export async function listDeviceBackups(serverUrl: string, signal?: AbortSignal): Promise<DeviceBackupEntry[]> {
  const server = normalizeContentServerUrl(serverUrl);
  const token = await access(server, signal);
  const response = await contentServerRequest<{ items: unknown[] }>(server, "/device-backups", token, "GET", undefined, signal);
  assertServer(server);
  if (!Array.isArray(response.items) || !response.items.every(validEntry) ||
      new Set(response.items.map(entry => entry.deviceName)).size !== response.items.length) {
    throw new DeviceBackupError("invalidResponse");
  }
  return response.items;
}
export function readDeviceSettings(): DeviceSetting[] {
  const settings: DeviceSetting[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value !== null) settings.push({ key, value });
  }
  return settings.sort((a, b) => a.key.localeCompare(b.key));
}
export function replaceDeviceSettings(settings: readonly DeviceSetting[]): void {
  if (settings.some(entry => typeof entry.key !== "string" || typeof entry.value !== "string") ||
      new Set(settings.map(entry => entry.key)).size !== settings.length) {
    throw new DeviceBackupError("invalidResponse");
  }
  localStorage.clear();
  for (const { key, value } of settings) {
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error("Device settings could not be saved.");
  }
}
async function cleanup(path: string): Promise<void> {
  await invoke("device_backup_cleanup", { path }).catch(error => console.warn("[device-backup] temporary file cleanup failed", error));
}
async function exclusive<T>(kind: "backup.export" | "backup.restore", action: () => Promise<T>): Promise<T> {
  return runContentSyncOperation(() => enqueueMainTask({
    kind, title: translate(useAppearanceStore.getState().appLocale, kind === "backup.export" ? "deviceBackup.upload" : "deviceBackup.restore"),
    run: () => runContentStorageOperation(async () => {
      await getDb();
      return runExclusiveDatabaseOperation(action, { publishMetadata: false });
    }),
  }).promise);
}
export async function uploadDeviceBackup(serverUrl: string, onPhase?: (phase: DeviceBackupPhase) => void): Promise<DeviceBackupEntry> {
  if (inFlight) throw new DeviceBackupError("busy");
  inFlight = true;
  let file: BackupFile | undefined;
  try {
    const server = normalizeContentServerUrl(serverUrl);
    const deviceName = await defaultBackupDeviceName();
    const token = await access(server);
    onPhase?.("preparing");
    file = await exclusive("backup.export", async () => {
      assertServer(server);
      return invoke<BackupFile>("device_backup_create", { deviceName, settings: readDeviceSettings() });
    });
    assertServer(server);
    onPhase?.("uploading");
    const entry = await invoke<DeviceBackupEntry>("device_backup_upload", { serverUrl: server, deviceName, token, path: file.path });
    assertServer(server);
    if (!validEntry(entry) || entry.deviceName !== deviceName || entry.sha256 !== file.sha256 || entry.size !== file.size) {
      throw new DeviceBackupError("invalidResponse");
    }
    return entry;
  } finally {
    if (file) await cleanup(file.path);
    inFlight = false;
  }
}

/** Keep the storage and database barriers held until the new WebView starts. */
export async function restoreDeviceBackup(
  serverUrl: string, entry: DeviceBackupEntry, onPhase?: (phase: DeviceBackupPhase) => void,
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  if (inFlight) throw new DeviceBackupError("busy");
  if (!validEntry(entry)) throw new DeviceBackupError("invalidResponse");
  inFlight = true;
  let file: BackupFile | undefined;
  try {
    const server = normalizeContentServerUrl(serverUrl);
    const token = await access(server);
    onPhase?.("downloading");
    file = await invoke<BackupFile>("device_backup_download", { serverUrl: server, deviceName: entry.deviceName, token, sha256: entry.sha256 });
    assertServer(server);
    const manifest = await invoke<DeviceBackupManifest>("device_backup_inspect", { path: file.path });
    if (manifest.format !== "norea-device-backup" || manifest.version !== 1 || manifest.deviceName !== entry.deviceName ||
        !Array.isArray(manifest.settings)) throw new DeviceBackupError("invalidResponse");
    onPhase?.("restoring");
    const path = file.path;
    await exclusive("backup.restore", async () => {
      assertServer(server);
      cancelWorkMetadataRecovery();
      const previous = readDeviceSettings();
      try {
        replaceDeviceSettings(manifest.settings);
        await invoke("device_backup_restore", { path });
      } catch (error) {
        replaceDeviceSettings(previous);
        throw error;
      }
      await cleanup(path);
      file = undefined;
      reload();
      await new Promise<never>(() => {});
    });
  } finally {
    if (file) await cleanup(file.path);
    inFlight = false;
  }
}
