import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), request: vi.fn(), register: vi.fn(), exclusive: vi.fn(),
  suspendVpn: vi.fn(), releaseVpn: vi.fn(),
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
vi.mock("../tasks/vpn-download-runtime", () => ({ suspendVpnDownloadsForRestore: mocks.suspendVpn }));
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
const manifest = { format: "norea-device-backup", version: 2, deviceName: entry.deviceName, createdAt: 1000,
  storageRoot: null,
  vpnVault: { index: { path: "saved-profiles/index.json", size: 90, sha256: "b".repeat(64) }, profiles: [] },
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
  mocks.suspendVpn.mockReset().mockResolvedValue(mocks.releaseVpn);
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
      case "device_backup_restore": return { id: "c".repeat(64), settings: manifest.settings };
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
it("keeps old settings until native commit and acknowledges the actual installed settings before reload", async () => {
  mocks.values.set("old-setting", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  let commit!: () => void;
  const pending = new Promise<void>(resolve => { commit = resolve; });
  const receipt = { id: "c".repeat(64), settings: [{ key: "native-setting", value: "committed snapshot" }] };
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "device_backup_restore") { await pending; return receipt; }
    if (command === "device_backup_restore_complete") {
      expect(args).toEqual({ restoreId: receipt.id });
      expect(readDeviceSettings()).toEqual(receipt.settings);
      return;
    }
    return normal(command, args);
  });
  const stopped = new Error("Reload boundary");
  const reload = () => { throw stopped; };
  const finished = expect(restoreDeviceBackup("http://server", entry, undefined, reload)).rejects.toBe(stopped);
  try {
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("device_backup_restore", { path: file.path }));
    expect(readDeviceSettings()).toEqual([{ key: "old-setting", value: "retained" }]);
  } finally { commit(); await finished; }
  expect(readDeviceSettings()).toEqual(receipt.settings);
  expect(mocks.invoke).toHaveBeenCalledWith("device_backup_restore_complete", { restoreId: receipt.id });
});
it.each(["settings", "acknowledgement", "uncertain-commit"] as const)("reloads behind the startup fence and preserves recovery files after %s failure", async phase => {
  mocks.values.set("old-setting", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "device_backup_restore" && phase === "uncertain-commit") throw new Error("IPC response was lost");
    if (command === "device_backup_restore_complete" || command === "device_backup_restore_check") throw new Error("Restore checkpoint is retained");
    return normal(command, args);
  });
  if (phase === "settings") {
    const original = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key === "plugin-vpn-settings") throw new Error("Storage quota exceeded");
      original(key, value);
    });
  }
  const stopped = new Error("Blocked reload boundary");
  const reload = vi.fn(() => { throw stopped; });
  await expect(restoreDeviceBackup("http://server", entry, undefined, reload)).rejects.toBe(stopped);
  expect(reload).toHaveBeenCalledOnce();
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_cleanup", expect.anything());
  if (phase === "settings") expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_restore_complete", expect.anything());
  if (phase === "acknowledgement") expect(readDeviceSettings()).toEqual(manifest.settings);
  if (phase === "uncertain-commit") expect(readDeviceSettings()).toEqual([{ key: "old-setting", value: "retained" }]);
});
it("rejects a mismatched archive identity before altering settings or database", async () => {
  mocks.values.set("old", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "device_backup_inspect" ? { ...manifest, deviceName: "Other phone" } : normal(command, args));
  await expect(restoreDeviceBackup("http://server", entry)).rejects.toMatchObject({ code: "invalidResponse" });
  expect(readDeviceSettings()).toEqual([{ key: "old", value: "retained" }]);
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_restore", expect.anything());
  expect(mocks.suspendVpn).not.toHaveBeenCalled();
});
it("releases the stopped-worker hold without taking database locks if the server changes during cleanup", async () => {
  mocks.values.set("old", "retained");
  mocks.suspendVpn.mockImplementationOnce(async () => { mocks.server = "http://other"; return mocks.releaseVpn; });
  await expect(restoreDeviceBackup("http://server", entry)).rejects.toMatchObject({ code: "changed" });
  expect(mocks.exclusive).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_restore", expect.anything());
  expect(readDeviceSettings()).toEqual([{ key: "old", value: "retained" }]);
  expect(mocks.releaseVpn).toHaveBeenCalledOnce();
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
it.each([1, 3])("rejects archive version %s without changing settings while transport remains version 1", async version => {
  mocks.values.set("old", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) =>
    command === "device_backup_inspect" ? { ...manifest, version } : normal(command, args));
  await expect(restoreDeviceBackup("http://server", entry)).rejects.toMatchObject({ code: "invalidResponse" });
  expect(readDeviceSettings()).toEqual([{ key: "old", value: "retained" }]);
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_restore", expect.anything());
});
it("rejects an invalid retained-vault inventory before native restore", async () => {
  mocks.values.set("old", "retained");
  const normal = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation(async (command, args) => command === "device_backup_inspect"
    ? { ...manifest, vpnVault: { ...manifest.vpnVault, profiles: [{ path: "../outside.ovpn", size: 1, sha256: "a".repeat(64) }] } }
    : normal(command, args));
  await expect(restoreDeviceBackup("http://server", entry)).rejects.toMatchObject({ code: "invalidResponse" });
  expect(readDeviceSettings()).toEqual([{ key: "old", value: "retained" }]);
  expect(mocks.invoke).not.toHaveBeenCalledWith("device_backup_restore", expect.anything());
});
