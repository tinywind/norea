import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), request: vi.fn(), register: vi.fn(), exclusive: vi.fn(),
  values: new Map<string, string>(), server: "http://server", deviceName: "",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../i18n", () => ({ translate: (_locale: string, key: string) => key }));
vi.mock("../../store/appearance", () => ({ useAppearanceStore: { getState: () => ({ appLocale: "en" }) } }));
vi.mock("../../store/content-sync", () => ({
  useContentSyncStore: { getState: () => ({ serverUrl: mocks.server, deviceName: mocks.deviceName }) },
}));
vi.mock("../../db/client", () => ({
  getDb: async () => ({}), cancelWorkMetadataRecovery: vi.fn(),
  runExclusiveDatabaseOperation: mocks.exclusive,
}));
vi.mock("../tasks/main-tasks", () => ({ enqueueMainTask: ({ run }: { run: () => Promise<unknown> }) => ({ promise: run() }) }));
vi.mock("./sync", () => ({ runContentSyncOperation: (run: () => unknown) => run() }));
vi.mock("./storage-operation", () => ({ runContentStorageOperation: (run: () => unknown) => run() }));
vi.mock("./client", () => ({ contentServerRequest: mocks.request, normalizeContentServerUrl: (server: string) => server }));
vi.mock("./device", () => ({ registerContentDevice: mocks.register }));
import {
  defaultBackupDeviceName, listDeviceBackups, readDeviceSettings, replaceDeviceSettings,
  restoreDeviceBackup, uploadDeviceBackup,
} from "./device-backup";

const entry = { deviceName: "Test tablet", updatedAt: 1234, size: 2048, sha256: "a".repeat(64) };
const file = { path: "/cache/snapshot/backup.zip", size: entry.size, sha256: entry.sha256 };
const manifest = { format: "norea-device-backup", version: 1, deviceName: entry.deviceName, createdAt: 1000,
  settings: [{ key: "norea-content-server", value: "restored server settings" }, { key: "plugin-vpn-settings", value: "restored VPN settings" }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.values.clear(); mocks.server = "http://server"; mocks.deviceName = "";
  vi.stubGlobal("localStorage", {
    get length() { return mocks.values.size; },
    key: (index: number) => [...mocks.values.keys()][index] ?? null,
    getItem: (key: string) => mocks.values.get(key) ?? null,
    setItem: (key: string, value: string) => { mocks.values.set(key, value); },
    clear: () => mocks.values.clear(),
  });
  mocks.exclusive.mockImplementation((run: () => unknown) => run());
  mocks.register.mockResolvedValue("device-token");
  mocks.request.mockImplementation(async (_server, path) => path === "/capabilities"
    ? { apiVersion: 1, packageVersion: 1, authentication: "device-key", deviceBackupVersion: 1 }
    : { items: [entry] });
  mocks.invoke.mockImplementation(async command => {
    switch (command) {
      case "get_default_device_name": return entry.deviceName;
      case "device_backup_create":
      case "device_backup_download": return file;
      case "device_backup_upload": return entry;
      case "device_backup_inspect": return manifest;
      default: return undefined;
    }
  });
});
it("uses the platform device name without asking for a sync key", async () => {
  expect(await defaultBackupDeviceName()).toBe("Test tablet");
  mocks.deviceName = "Named phone";
  expect(await defaultBackupDeviceName()).toBe("Named phone");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});
it("lists every named backup with device authentication", async () => {
  expect(await listDeviceBackups("http://server")).toEqual([entry]);
  expect(mocks.request).toHaveBeenCalledWith("http://server", "/device-backups", "device-token", "GET", undefined, undefined);
});
it("does not send data to a server without the backup capability", async () => {
  mocks.request.mockResolvedValue({ apiVersion: 1, packageVersion: 1, authentication: "device-key" });
  await expect(uploadDeviceBackup("http://server")).rejects.toMatchObject({ code: "unsupported" });
  expect(mocks.register).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_create", expect.anything());
});
it("backs up all settings including source, server and VPN configuration with the complete native snapshot", async () => {
  mocks.values.set("plugin-v2:source", "source-settings");
  mocks.values.set("plugin-vpn-settings", "VPN-enabled");
  mocks.values.set("norea-content-device:http://server", "credential");
  expect(await uploadDeviceBackup("http://server")).toEqual(entry);
  expect(mocks.invoke).toHaveBeenCalledWith("device_backup_create", {
    deviceName: entry.deviceName, settings: readDeviceSettings(),
  });
  expect(mocks.exclusive).toHaveBeenCalledWith(expect.any(Function), { publishMetadata: false });
  expect(mocks.invoke).toHaveBeenCalledWith("device_backup_cleanup", { path: file.path });
});
it("rejects duplicate device rows", async () => {
  mocks.request.mockImplementation(async (_server, path) => path === "/capabilities"
    ? { apiVersion: 1, packageVersion: 1, authentication: "device-key", deviceBackupVersion: 1 }
    : { items: [entry, entry] });
  await expect(listDeviceBackups("http://server")).rejects.toMatchObject({ code: "invalidResponse" });
});
it("pins restores to the selected checksum and rolls settings back when native restore fails", async () => {
  mocks.values.set("old-setting", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "device_backup_restore") throw new Error("Invalid database");
    return normal(command, args);
  });
  const reload = vi.fn();
  await expect(restoreDeviceBackup("http://server", entry, undefined, reload)).rejects.toThrow("Invalid database");
  expect(mocks.invoke).toHaveBeenCalledWith("device_backup_download", {
    serverUrl: "http://server", deviceName: entry.deviceName, token: "device-token", sha256: entry.sha256,
  });
  expect(readDeviceSettings()).toEqual([{ key: "old-setting", value: "retained" }]);
  expect(reload).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledWith("device_backup_cleanup", { path: file.path });
});
it("rejects a mismatched archive identity before altering settings or database", async () => {
  mocks.values.set("old", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "device_backup_inspect" ? { ...manifest, deviceName: "Other phone" } : normal(command, args));
  await expect(restoreDeviceBackup("http://server", entry)).rejects.toMatchObject({ code: "invalidResponse" });
  expect(readDeviceSettings()).toEqual([{ key: "old", value: "retained" }]);
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_restore", expect.anything());
});
it("detects a server change before uploading a snapshot", async () => {
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    const result = await normal(command, args);
    if (command === "device_backup_create") mocks.server = "http://other";
    return result;
  });
  await expect(uploadDeviceBackup("http://server")).rejects.toMatchObject({ code: "changed" });
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_upload", expect.anything());
  expect(mocks.invoke).toHaveBeenCalledWith("device_backup_cleanup", { path: file.path });
});
it("validates settings before clearing the destination", () => {
  mocks.values.set("old", "retained");
  expect(() => replaceDeviceSettings([{ key: "same", value: "1" }, { key: "same", value: "2" }])).toThrow();
  expect(readDeviceSettings()).toEqual([{ key: "old", value: "retained" }]);
});
